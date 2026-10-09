"""Independent native source library. Synchronous handlers run in FastAPI's pool.

The reverse proxy authenticates /monai, as for the existing DICOM endpoints.
Storage is local-only and every path component is server-generated.
"""
import contextlib
import csv
import datetime
import hashlib
import json
import logging
import os
import re
import shutil
import sqlite3
import tempfile
import threading
import time
import uuid
import zipfile
from pathlib import Path

import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field
from monailabel.utils.others.nifti_manifest import import_roots, resolve_image, parse_manifest
from monailabel.utils.others.nifti_groups import ensure_groups, with_group, group_for, assign_group, validate_group, group_name
from fastapi.responses import StreamingResponse
from monailabel.utils.others.nifti_source import (
    MAX_VOXEL_BYTES, NiftiError, read_nifti, align_mask, write_mask,
)

router = APIRouter(prefix='/nifti-images', tags=['Native NIfTI'])
WORK_LOCK = threading.BoundedSemaphore(1)
logger = logging.getLogger(__name__)
MANIFEST_LOCK = threading.Lock()


class ManifestCase(BaseModel):
    image: str = ''
    segmentations: list[str] = Field(default_factory=list, max_length=256)
    manifestId: str | None = None
    caseId: str | None = None
    base: str | None = None
    unit: str | None = None
    modality: str = 'CT'


@router.get('/manifest/roots')
def manifest_roots():
    enabled()
    return {'roots': [str(p) for p in import_roots()]}


@router.post('/manifest/preview')
def preview_manifest(file: UploadFile = File(...), base: str = Form(None), unit: str = Form(None), modality: str = Form('OT')):
    enabled()
    try:
        if modality not in ('CT', 'MR', 'OT') or unit not in (None, '', 'mm', 'm', 'um'): raise ValueError('导入默认类型或空间单位无效。')
        rows = parse_manifest(file.file.read(5 * 1024 ** 2 + 1), file.filename or '')
        for row in rows:
            try:
                for path in [row['image'], *row['segmentations']]: resolve_image(path, base)
                row['status'] = 'ready'
            except ValueError as error:
                row.update(status='invalid', error=str(error))
        manifest = {'id': uuid.uuid4().hex, 'name': file.filename, 'revision': 0, 'items': rows, 'unit': unit or None, 'modality': modality, 'base': base or (str(import_roots()[0]) if import_roots() else '')}
        with database() as db:
            db.execute('INSERT INTO case_manifests VALUES (?,?)', (manifest['id'], json.dumps(manifest)))
        return manifest
    except (ValueError, UnicodeError, csv.Error) as error:
        raise HTTPException(422, str(error)) from error


@router.post('/manifest/open')
def open_manifest_case(case: ManifestCase):
    enabled()
    selected = None
    if case.manifestId:
        manifest = read_manifest(case.manifestId)
        selected = next((r for r in manifest['items'] if r['caseId'] == case.caseId), None)
        if selected is None: raise HTTPException(404, '清单病例不存在。')
        case.image, case.segmentations, case.base = selected['image'], selected['segmentations'], manifest['base']
        case.modality = selected.get('modality', manifest.get('modality', case.modality))
        case.unit = manifest.get('unit') or case.unit
    try:
        paths = [resolve_image(p, case.base) for p in [case.image, *case.segmentations]]
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    if not MANIFEST_LOCK.acquire(blocking=False): raise HTTPException(429, '另一例清单图像正在导入，请稍后重试。')
    try:
        with open(paths[0], 'rb') as stream:
            descriptor = upload_source(UploadFile(file=stream, filename=paths[0].name), case.unit, case.modality)
        imported, errors, imported_files = [], [], {}
        for file_ref, path in zip(case.segmentations, paths[1:]):
            try:
                digest = hashlib.sha256()
                with open(path, 'rb') as stream:
                    while chunk := stream.read(1024 * 1024): digest.update(chunk)
                key = hashlib.sha256((str(path) + ':' + digest.hexdigest()).encode()).hexdigest()
                with database() as db:
                    db.execute('CREATE TABLE IF NOT EXISTS manifest_imports (source TEXT, hash TEXT, masks TEXT, PRIMARY KEY(source,hash))')
                    previous = db.execute('SELECT masks FROM manifest_imports WHERE source=? AND hash=?', (descriptor['sourceId'], key)).fetchone()
                if previous:
                    ids = json.loads(previous['masks'])
                    imported.extend(ids)
                    imported_files[file_ref] = ids
                    continue
                with open(path, 'rb') as stream:
                    records = save_masks(descriptor['sourceId'], UploadFile(file=stream, filename=path.name),
                        label=path.name, maskId=None, expectedVersion=0, raw=False, labelOnly=True,
                        geometryHash=descriptor['geometryHash'], provenance='{}')['items']
                ids = [record['maskId'] for record in records]
                with database() as db:
                    db.execute('INSERT INTO manifest_imports VALUES (?,?,?)', (descriptor['sourceId'], key, json.dumps(ids)))
                imported.extend(ids)
                imported_files[file_ref] = ids
            except (HTTPException, NiftiError, OSError) as error:
                errors.append({'file': path.name, 'message': str(getattr(error, 'detail', error))})
        if selected is not None:
            with database() as db:
                db.execute('BEGIN IMMEDIATE')
                manifest = json.loads(db.execute('SELECT metadata FROM case_manifests WHERE id=?', (case.manifestId,)).fetchone()[0])
                selected = next(r for r in manifest['items'] if r['caseId'] == case.caseId)
                selected['sourceId'] = descriptor['sourceId']
                for finding in selected['findings']:
                    finding['maskIds'] = list(dict.fromkeys(mid for p in finding['segmentations'] for mid in imported_files.get(p, [])))
                manifest['revision'] += 1
                db.execute('UPDATE case_manifests SET metadata=? WHERE id=?', (json.dumps(manifest), case.manifestId))
        return {'descriptor': descriptor, 'maskIds': imported, 'errors': errors, 'manifest': manifest if selected is not None else None}
    finally:
        MANIFEST_LOCK.release()


@router.get('/manifests/{manifest_id}')
def read_manifest(manifest_id: str):
    enabled()
    checked_id(manifest_id)
    with database() as db:
        row = db.execute('SELECT metadata FROM case_manifests WHERE id=?', (manifest_id,)).fetchone()
    if not row: raise HTTPException(404, '清单不存在。')
    return json.loads(row[0])


class FindingBinding(BaseModel):
    caseId: str
    findingId: str
    statementIds: list[str] = Field(default_factory=list, max_length=256)
    expectedRevision: int


@router.put('/manifests/{manifest_id}/binding')
def bind_finding(manifest_id: str, binding: FindingBinding):
    enabled()
    checked_id(manifest_id)
    with database() as db:
        db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT metadata FROM case_manifests WHERE id=?', (manifest_id,)).fetchone()
        if not row: raise HTTPException(404, '清单不存在。')
        manifest = json.loads(row[0])
        if manifest['revision'] != binding.expectedRevision: raise HTTPException(409, '清单已更新，请刷新后重试。')
        case = next((c for c in manifest['items'] if c['caseId'] == binding.caseId), None)
        finding = next((f for f in case['findings'] if f['id'] == binding.findingId), None) if case else None
        if not finding: raise HTTPException(404, 'Finding 不属于当前病例。')
        allowed = {s['id'] for r in case['reports'] for s in r['statements']}
        if any(s not in allowed for s in binding.statementIds): raise HTTPException(422, '报告语句不属于当前病例。')
        finding['statementIds'] = list(dict.fromkeys(binding.statementIds))
        manifest['revision'] += 1
        db.execute('UPDATE case_manifests SET metadata=? WHERE id=?', (json.dumps(manifest), manifest_id))
    return manifest


def enabled(name='ENABLE_NIFTI_LIBRARY'):
    if os.environ.get(name, 'false').lower() not in ('1', 'true', 'yes'):
        raise HTTPException(404, detail={'code': 'NIFTI_DISABLED', 'message': 'This NIfTI capability is disabled.'})


@contextlib.contextmanager
def work(operation='mask'):
    started = time.monotonic()
    if not WORK_LOCK.acquire(blocking=False):
        logger.info('nifti operation=%s status=busy', operation)
        raise HTTPException(429, detail={'code': 'NIFTI_BUSY', 'message': 'Another NIfTI operation is running. Retry shortly.'})
    try:
        yield
    except NiftiError as exc:
        logger.info('nifti operation=%s status=invalid code=%s', operation, exc.code)
        raise HTTPException(422, detail={'code': exc.code, 'message': str(exc)}) from exc
    except Exception as exc:
        logger.info('nifti operation=%s status=failed type=%s', operation, type(exc).__name__)
        raise
    finally:
        logger.info('nifti operation=%s elapsed_seconds=%.3f', operation, time.monotonic() - started)
        WORK_LOCK.release()


def root():
    directory = Path(os.environ.get('NIFTI_IMAGES_DIR', '/code/nifti_images'))
    directory.mkdir(parents=True, exist_ok=True)
    return directory


@contextlib.contextmanager
def database():
    connection = sqlite3.connect(root() / 'index.sqlite3', timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA journal_mode=WAL')
    connection.execute('PRAGMA foreign_keys=ON')
    connection.executescript('''
      CREATE TABLE IF NOT EXISTS case_manifests (id TEXT PRIMARY KEY, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL,
        metadata TEXT NOT NULL, created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS masks (source TEXT NOT NULL, id TEXT NOT NULL,
        version INTEGER NOT NULL, metadata TEXT NOT NULL, created TEXT NOT NULL,
        PRIMARY KEY(source,id,version), FOREIGN KEY(source) REFERENCES sources(id));
      CREATE TABLE IF NOT EXISTS mask_restores (source TEXT NOT NULL, id TEXT NOT NULL,
        request TEXT NOT NULL, requested INTEGER NOT NULL, base INTEGER NOT NULL, version INTEGER NOT NULL,
        PRIMARY KEY(source,id,request));
      CREATE TABLE IF NOT EXISTS segmentation_groups (source TEXT NOT NULL, id TEXT NOT NULL,
        metadata TEXT NOT NULL, PRIMARY KEY(source,id), FOREIGN KEY(source) REFERENCES sources(id));
      CREATE TABLE IF NOT EXISTS segmentation_group_members (source TEXT NOT NULL, mask_id TEXT NOT NULL,
        group_id TEXT NOT NULL, PRIMARY KEY(source,mask_id),
        FOREIGN KEY(source,group_id) REFERENCES segmentation_groups(source,id));
    ''')
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def checked_id(value):
    if not re.fullmatch(r'[a-f0-9]{32}', value):
        raise HTTPException(404, 'Unknown NIfTI identity.')
    return value


def get_source(source_id):
    checked_id(source_id)
    with database() as db:
        row = db.execute('SELECT metadata FROM sources WHERE id=?', (source_id,)).fetchone()
    if not row:
        raise HTTPException(404, 'NIfTI source not found.')
    return json.loads(row['metadata'])


def source_path(source_id, meta=None):
    meta = meta or get_source(source_id)
    return root() / checked_id(source_id) / ('source.' + meta['format'])


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sync_directory(directory):
    if os.name == 'posix':
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def name(value):
    return str(value or 'Untitled').replace('\\', '/').rsplit('/', 1)[-1][:200]


def display_name(value):
    return ''.join(c for c in str(value or 'Untitled') if ord(c) >= 32)[:200]


def stage_upload(upload, directory):
    path = directory / 'upload'
    total = 0
    with open(path, 'wb') as output:
        while True:
            chunk = upload.file.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_VOXEL_BYTES + 2 * 1024 * 1024:
                raise HTTPException(413, 'Compressed file exceeds upload limit.')
            output.write(chunk)
        output.flush()
        os.fsync(output.fileno())
    return path


def immutable_file(path, filename, media_type, headers=None):
    response = FileResponse(path, filename=filename, media_type=media_type, headers=headers)
    prefix = os.environ.get('NIFTI_ACCEL_REDIRECT_PREFIX')
    if not prefix:
        return response
    # Only registered immutable files under the library root can be delegated.
    relative = path.resolve().relative_to(root().resolve()).as_posix()
    if not path.is_file():
        raise HTTPException(404, 'NIfTI file is unavailable.')
    delegated = dict(response.headers)
    delegated['X-Accel-Redirect'] = prefix.rstrip('/') + '/' + relative
    return Response(headers=delegated, media_type=media_type)


@router.post('')
def upload_source(file: UploadFile = File(...), unit: str = Form(None), modality: str = Form('OT')):
    enabled()
    if modality not in ('CT', 'MR', 'OT'):
        raise HTTPException(422, 'Choose CT, MR or generic intensity.')
    with work('upload'), tempfile.TemporaryDirectory(prefix='.upload-', dir=root()) as temp:
        staged = stage_upload(file, Path(temp))
        parse_started = time.monotonic()
        meta, pixels = read_nifti(staged, unit)
        logger.info('nifti operation=parse elapsed_seconds=%.3f working_bytes=%d',
                    time.monotonic() - parse_started, pixels.nbytes)
        del pixels
        with database() as db:
            db.execute('BEGIN IMMEDIATE')
            existing = db.execute('SELECT metadata FROM sources WHERE hash=?', (meta['contentHash'],)).fetchone()
            if existing:
                return json.loads(existing['metadata'])
            identity = uuid.uuid4().hex
            meta.update(sourceType='nifti', sourceId=identity, name=name(file.filename), modality=modality,
                        created=now(), provenance={'originalName': name(file.filename), 'transforms': []},
                        capabilities={'viewing': True, 'serverSave': True, 'editing': True,
                                      'ai': os.environ.get('ENABLE_NIFTI_AI', 'false').lower() == 'true', 'pacsExport': False})
            final = root() / identity
            final.mkdir()
            try:
                os.replace(staged, final / ('source.' + meta['format']))
                sync_directory(final)
                sync_directory(root())
                db.execute('INSERT INTO sources VALUES (?,?,?,?)', (identity, meta['contentHash'], json.dumps(meta), meta['created']))
                db.commit()
            except Exception:
                shutil.rmtree(final)
                raise
        return meta


@router.get('')
def list_sources(offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=100)):
    enabled()
    with database() as db:
        rows = db.execute('SELECT metadata FROM sources ORDER BY created DESC LIMIT ? OFFSET ?', (limit, offset)).fetchall()
        total = db.execute('SELECT count(*) FROM sources').fetchone()[0]
    return {'items': [json.loads(row['metadata']) for row in rows], 'total': total, 'offset': offset, 'limit': limit}


@router.get('/{source_id}/metadata')
def metadata(source_id: str):
    enabled()
    meta = get_source(source_id)
    meta['capabilities']['streamingViewing'] = os.environ.get('ENABLE_NIFTI_STREAMING', 'false').lower() == 'true'
    return meta


def streaming_call(action):
    from monailabel.utils.others.nifti_stream import StreamError
    enabled()
    enabled('ENABLE_NIFTI_STREAMING')
    try:
        return action()
    except StreamError as error:
        raise HTTPException(error.status, detail={'code': error.code, 'message': str(error)}) from error


@router.post('/{source_id}/stream/prepare')
def prepare_stream(source_id: str):
    from monailabel.utils.others.nifti_stream import cache
    def prepare():
        meta = get_source(source_id)
        state = cache().prepare(meta, source_path(source_id, meta))
        return Response(json.dumps(state), status_code=200 if state['state'] == 'ready' else 202,
                        media_type='application/json', headers={'Cache-Control': 'no-store'})
    return streaming_call(prepare)


@router.get('/{source_id}/stream')
def stream_status(source_id: str):
    from monailabel.utils.others.nifti_stream import cache
    return streaming_call(lambda: cache().status(get_source(source_id)))


@router.get('/{source_id}/frames/{index}')
def stream_frame(source_id: str, index: int):
    from monailabel.utils.others.nifti_stream import cache
    def frame():
        meta = get_source(source_id)
        path, manifest = cache().frame(meta, source_path(source_id, meta), index)
        headers = {'Content-Length': str(path.stat().st_size), 'Cache-Control': 'private, max-age=3600',
                   'ETag': '"' + manifest['frames'][index]['sha256'] + '"',
                   'X-Nifti-Cache-Key': manifest['cacheKey'], 'X-Nifti-Frame': str(index)}
        prefix = os.environ.get('NIFTI_STREAM_ACCEL_REDIRECT_PREFIX')
        if prefix:
            headers['X-Accel-Redirect'] = prefix.rstrip('/') + '/' + path.resolve().relative_to(cache().root).as_posix()
            headers.pop('Content-Length', None)  # Nginx supplies the delegated file's length.
            return Response(headers=headers, media_type='application/gzip')
        return FileResponse(path, media_type='application/gzip', headers=headers)
    return streaming_call(frame)


@router.get('/{source_id}/file')
def download_source(source_id: str):
    enabled()
    meta = get_source(source_id)
    filename = re.sub(r'(?i)\.nii(?:\.gz)?$', '', name(meta['name'])) + '.' + meta['format']
    return immutable_file(source_path(source_id, meta), filename=filename, media_type='application/octet-stream',
                        headers={'Cache-Control': 'private, max-age=3600', 'ETag': '"' + meta['contentHash'] + '"'})


@router.get('/{source_id}/masks')
def list_masks(source_id: str):
    enabled()
    get_source(source_id)
    with database() as db:
        db.execute('BEGIN IMMEDIATE')
        ensure_groups(db, source_id)
        rows = db.execute('''SELECT m.metadata,latest.first_created,latest.version_count FROM masks m JOIN
          (SELECT id,max(version) v,min(created) first_created,count(*) version_count FROM masks WHERE source=? GROUP BY id) latest
          ON latest.id=m.id AND latest.v=m.version WHERE source=? ORDER BY latest.first_created,m.id''', (source_id, source_id)).fetchall()
        items = [with_group(db, source_id, dict(json.loads(row['metadata']), firstCreated=row['first_created'], versionCount=row['version_count'])) for row in rows]
    return {'items': items}


@router.get('/{source_id}/masks/history')
def mask_history(source_id: str, offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500), maskId: str = Query(None)):
    """Immutable saved versions; this is not a whole-case checkpoint ledger."""
    enabled()
    get_source(source_id)
    if maskId:
        mask_record(source_id, maskId)
    with database() as db:
        db.execute('BEGIN IMMEDIATE')
        ensure_groups(db, source_id)
        total = db.execute('SELECT count(*) FROM masks WHERE source=? AND (? IS NULL OR id=?)', (source_id, maskId, maskId)).fetchone()[0]
        rows = db.execute('''SELECT m.metadata, latest.v FROM masks m JOIN
          (SELECT id,max(version) v FROM masks WHERE source=? GROUP BY id) latest
          ON latest.id=m.id WHERE source=? AND (? IS NULL OR m.id=?)
          ORDER BY m.created DESC,m.id,m.version DESC LIMIT ? OFFSET ?''',
          (source_id, source_id, maskId, maskId, limit, offset)).fetchall()
        items = [with_group(db, source_id, dict(json.loads(row['metadata']), latestVersion=row['v'])) for row in rows]
    return {'items': items, 'total': total}


@router.post('/{source_id}/masks')
def save_masks(source_id: str, file: UploadFile = File(...), label: str = Form('Mask'),
               maskId: str = Form(None), expectedVersion: int = Form(0), raw: bool = Form(False),
               labelOnly: bool = Form(False), geometryHash: str = Form(None), provenance: str = Form('{}')):
    enabled()
    enabled('ENABLE_NIFTI_EDITING')
    source = get_source(source_id)
    if geometryHash != source['geometryHash']:
        raise HTTPException(409, 'Mask geometry identity differs from source.')
    try:
        if len(provenance) > 4096:
            raise ValueError()
        provenance_data = json.loads(provenance)
        requested_group = validate_group(provenance_data.get('segmentationSet'))
        original_label = provenance_data.get('originalLabel', 1)
        derived_from = provenance_data.get('derivedFrom')
        if derived_from is not None and (not isinstance(derived_from, dict) or
                set(derived_from) != {'maskId', 'version'} or not isinstance(derived_from['maskId'], str) or
                type(derived_from['version']) is not int or derived_from['version'] < 1):
            raise ValueError()
        display_color = provenance_data.get('displayColor')
        if display_color is not None and (not isinstance(display_color, list) or len(display_color) != 4 or
                any(type(v) is not int or not 0 <= v <= 255 for v in display_color) or display_color[3] != 255):
            raise ValueError()
        if type(original_label) is not int or not 0 < original_label <= 4294967295:
            raise ValueError()
    except (ValueError, TypeError, AttributeError) as exc:
        raise HTTPException(422, 'Invalid mask provenance.') from exc
    if derived_from is not None:
        mask_record(source_id, derived_from['maskId'], derived_from['version'])
    with work(), tempfile.TemporaryDirectory(prefix='.mask-', dir=root()) as temp:
        staged = stage_upload(file, Path(temp))
        transform = np.eye(4, dtype=int).tolist()
        if raw:
            if staged.stat().st_size != source['count']:
                raise HTTPException(422, 'Binary seed byte length differs from source.')
            data = np.fromfile(staged, dtype=np.uint8).reshape(tuple(reversed(source['dimensions'])))
            if (data > 1).any():
                raise HTTPException(422, 'Raw masks must be binary.')
        else:
            mask_meta, data = read_nifti(staged, source['unit'], mask=True)
            data, transform = align_mask(data, mask_meta, source)
        values = np.unique(data)
        values = values[values != 0]
        if len(values) == 0:
            if not labelOnly:
                raise HTTPException(422, 'Empty mask requires an explicit label-only draft.')
            values = np.array([1])
        if len(values) > 256:
            raise HTTPException(422, 'Import at most 256 independent labels per file.')
        if maskId and len(values) != 1:
            raise HTTPException(422, 'Updating an existing group requires one binary mask.')
        results, committed = [], []
        try:
            with database() as db:
                db.execute('BEGIN IMMEDIATE')
                ensure_groups(db, source_id)
                inherited_group = group_for(db, source_id, derived_from['maskId']) if derived_from else None
                batch_group = requested_group or inherited_group or {
                    'id': uuid.uuid4().hex, 'name': group_name(file.filename) if not raw else '手工分割',
                    'kind': 'manual' if raw else 'import', **({'sourceFile': name(file.filename)} if not raw else {})}
                for value in values:
                    mid = checked_id(maskId) if maskId else uuid.uuid4().hex
                    previous = db.execute('SELECT max(version) FROM masks WHERE source=? AND id=?', (source_id, mid)).fetchone()[0] or 0
                    if maskId and previous != expectedVersion:
                        raise HTTPException(409, 'Mask version changed; reload before saving.')
                    existing_group = group_for(db, source_id, mid)
                    if existing_group and requested_group and existing_group['id'] != requested_group['id']:
                        raise HTTPException(409, '已有目标不能通过保存被移动到另一组。')
                    assigned_group = assign_group(db, source_id, mid, existing_group or batch_group)
                    mask_root = root() / source_id / 'masks' / mid
                    # A crash before SQL commit can leave an unindexed immutable version.
                    # Keep it for recovery and allocate a fresh version, never overwrite it.
                    disk_versions = [int(p.name) for p in mask_root.iterdir() if p.is_dir() and p.name.isdigit()] if mask_root.exists() else []
                    version = max([previous, *disk_versions]) + 1
                    record = dict(maskId=mid, version=version, sourceId=source_id, geometryHash=source['geometryHash'],
                                  name=display_name(label) + (f' / {int(value)}' if len(values) > 1 else ''),
                                  originalLabel=int(value), originalFile=name(file.filename), alignment=transform,
                                  labelOnly=not bool(np.any(data)), created=now(), segmentationSet=assigned_group)
                    if raw:
                        record.update(originalLabel=original_label,
                                      originalFile=name(provenance_data.get('originalFile', file.filename)),
                                      importAlignment=provenance_data.get('alignment'))
                    if previous:
                        prior = json.loads(db.execute('SELECT metadata FROM masks WHERE source=? AND id=? AND version=?', (source_id, mid, previous)).fetchone()[0])
                        for field in ('originalLabel', 'originalFile', 'alignment', 'importAlignment', 'derivedFrom'):
                            if field in prior:
                                record[field] = prior[field]
                        if display_color is None and 'displayColor' in prior:
                            record['displayColor'] = prior['displayColor']
                    if display_color is not None:
                        record['displayColor'] = display_color
                    if derived_from is not None and not previous:
                        record['derivedFrom'] = derived_from
                    stage_dir = Path(temp) / mid
                    stage_dir.mkdir()
                    write_mask(stage_dir / 'mask.nii.gz', (data == value).astype(np.uint8), source)
                    (stage_dir / 'metadata.json').write_text(json.dumps(record), encoding='utf-8')
                    for file_path in stage_dir.iterdir():
                        with open(file_path, 'r+b') as persisted:
                            os.fsync(persisted.fileno())
                    sync_directory(stage_dir)
                    target = root() / source_id / 'masks' / mid / str(version)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(stage_dir, target)
                    for directory in [target.parent, target.parent.parent, target.parent.parent.parent]:
                        sync_directory(directory)
                    committed.append(target)
                    db.execute('INSERT INTO masks VALUES (?,?,?,?,?)', (source_id, mid, version, json.dumps(record), record['created']))
                    results.append(record)
                db.commit()
        except Exception:
            for path in committed:
                shutil.rmtree(path)
            raise
        return {'items': results}


def mask_record(source_id, mask_id, version=None):
    get_source(source_id)
    checked_id(mask_id)
    with database() as db:
        db.execute('BEGIN IMMEDIATE')
        ensure_groups(db, source_id)
        row = db.execute('SELECT metadata FROM masks WHERE source=? AND id=? AND (? IS NULL OR version=?) ORDER BY version DESC LIMIT 1',
                         (source_id, mask_id, version, version)).fetchone()
        record = with_group(db, source_id, json.loads(row['metadata'])) if row else None
    if not row:
        raise HTTPException(404, 'Mask version not found.')
    return record, root() / source_id / 'masks' / mask_id / str(record['version']) / 'mask.nii.gz'


@router.get('/{source_id}/masks/{mask_id}')
def download_mask(source_id: str, mask_id: str, version: int = Query(None, ge=1)):
    enabled()
    record, path = mask_record(source_id, mask_id, version)
    return immutable_file(path, filename=name(record['name']) + '.nii.gz', media_type='application/gzip')


class RestoreMask(BaseModel):
    version: int = Field(gt=0, strict=True)
    expectedVersion: int = Field(gt=0, strict=True)
    requestId: str = Field(pattern=r'^[a-f0-9-]{32,36}$')


@router.post('/{source_id}/masks/{mask_id}/restore')
def restore_mask(source_id: str, mask_id: str, operation: RestoreMask):
    """Append a restore to the same identity; retries never append a second version."""
    enabled()
    enabled('ENABLE_NIFTI_EDITING')
    chosen, original = mask_record(source_id, mask_id, operation.version)
    target = None
    with work(), tempfile.TemporaryDirectory(prefix='.restore-', dir=root()) as temp:
        try:
            with database() as db:
                db.execute('BEGIN IMMEDIATE')
                repeated = db.execute('SELECT * FROM mask_restores WHERE source=? AND id=? AND request=?',
                                      (source_id, mask_id, operation.requestId)).fetchone()
                if repeated:
                    if (repeated['requested'], repeated['base']) != (operation.version, operation.expectedVersion):
                        raise HTTPException(409, 'Restore request identity was reused for another operation.')
                    record = json.loads(db.execute('SELECT metadata FROM masks WHERE source=? AND id=? AND version=?',
                                        (source_id, mask_id, repeated['version'])).fetchone()[0])
                    return {'item': with_group(db, source_id, record), 'replayed': True}
                latest = json.loads(db.execute('SELECT metadata FROM masks WHERE source=? AND id=? ORDER BY version DESC LIMIT 1',
                                   (source_id, mask_id)).fetchone()[0])
                if latest['version'] != operation.expectedVersion:
                    raise HTTPException(409, '标注已有更新版本，请刷新历史后再恢复。')
                if operation.version == latest['version']:
                    raise HTTPException(409, '所选版本已经是最新保存版本。')
                mask_root = root() / source_id / 'masks' / mask_id
                disk = [int(p.name) for p in mask_root.iterdir() if p.is_dir() and p.name.isdigit()]
                version = max([latest['version'], *disk]) + 1
                record = dict(chosen, version=version, created=now(), name=latest['name'],
                              restoredFrom=operation.version, parentVersion=latest['version'], operation='restore')
                # Copy lineage belongs to the annotation, not the selected point in time.
                if 'derivedFrom' in latest:
                    record['derivedFrom'] = latest['derivedFrom']
                stage = Path(temp) / 'version'
                stage.mkdir()
                shutil.copyfile(original, stage / 'mask.nii.gz')
                (stage / 'metadata.json').write_text(json.dumps(record), encoding='utf-8')
                for file_path in stage.iterdir():
                    with open(file_path, 'r+b') as persisted:
                        os.fsync(persisted.fileno())
                sync_directory(stage)
                target = mask_root / str(version)
                os.replace(stage, target)
                sync_directory(mask_root)
                db.execute('INSERT INTO masks VALUES (?,?,?,?,?)', (source_id, mask_id, version, json.dumps(record), record['created']))
                db.execute('INSERT INTO mask_restores VALUES (?,?,?,?,?,?)',
                           (source_id, mask_id, operation.requestId, operation.version, operation.expectedVersion, version))
                db.commit()
            return {'item': record, 'replayed': False}
        except Exception:
            if target is not None and target.exists():
                shutil.rmtree(target)
            raise


@router.get('/{source_id}/export')
def export_masks(source_id: str):
    enabled()
    masks = list_masks(source_id)['items']
    fd, filename = tempfile.mkstemp(suffix='.zip', dir=root())
    os.close(fd)
    try:
        with zipfile.ZipFile(filename, 'w', compression=zipfile.ZIP_STORED) as archive:
            manifest = []
            for mask in masks:
                record, path = mask_record(source_id, mask['maskId'], mask['version'])
                member = mask['maskId'] + '.nii.gz'
                archive.write(path, member)
                manifest.append(record | {'file': member})
            archive.writestr('manifest.json', json.dumps({'source': get_source(source_id), 'masks': manifest}))
    except Exception:
        Path(filename).unlink(missing_ok=True)
        raise
    return FileResponse(filename, filename='nifti-masks.zip', media_type='application/zip',
                        background=BackgroundTask(Path(filename).unlink, missing_ok=True))


@router.post('/{source_id}/infer')
def infer_native(source_id: str, params: str = Form(...), nn_seed: UploadFile = File(None)):
    enabled()
    enabled('ENABLE_NIFTI_AI')
    from monailabel.utils.others.nifti_context import validate_context, validate_prompts, read_seed
    from monailabel.utils.others.nn_context import bind_context, finish_context, invalidate_context
    from monailabel.utils.others.model_runtime import NN_SESSION_LOCK, get_nn_session, prepare_nn_image
    if len(params) > 2 * 1024 * 1024:
        raise HTTPException(413, 'Prompt metadata is too large.')
    try:
        request_data = json.loads(params)
    except ValueError as exc:
        raise HTTPException(422, 'Invalid prompt JSON.') from exc
    if not isinstance(request_data, dict):
        raise HTTPException(422, 'Expected prompt object.')
    source = get_source(source_id)
    context = request_data.get('nn_context')
    shape, mask_order, prompt_order = validate_context(context, source)
    validate_prompts(request_data, prompt_order, shape)
    with work('infer'), NN_SESSION_LOCK:
        seed = read_seed(nn_seed.file if nn_seed else None, shape, mask_order)
        model_started = time.monotonic()
        session = get_nn_session()
        logger.info('nifti operation=model_session elapsed_seconds=%.3f', time.monotonic() - model_started)
        started = time.monotonic()
        try:
            identity = 'native-nifti:' + source_id + ':' + source['geometryHash']
            if getattr(session, '_ohif_series_uid', None) != identity:
                _, image = read_nifti(source_path(source_id, source), source['unit'])
                prepare_nn_image(session, identity, image[None])
            # Include authoritative source identity in the session key, not the client study alias.
            binding_context = context | {'seriesUID': identity}
            bind_context(session, binding_context, seed)
            for sign, include in [('pos', True), ('neg', False)]:
                for point in request_data.get(sign + '_points', []):
                    session.add_point_interaction(tuple(point[::-1]), include_interaction=include)
                for low, high in request_data.get(sign + '_boxes', []):
                    box = [[a, b + 1] for a, b in zip(low[::-1], high[::-1])]
                    session.add_bbox_interaction(box, include_interaction=include)
                for kind in ('scribbles', 'lassos'):
                    for points in request_data.get(sign + '_' + kind, []):
                        # Existing contour rasterizers use native IJK indices.
                        from monailabel.utils.others.helper import clean_and_densify_polyline, get_scanline_filled_points_3d
                        dense = clean_and_densify_polyline(points)
                        if kind == 'lassos':
                            dense = get_scanline_filled_points_3d(dense)
                        coords = np.rint(np.asarray(dense)).astype(int)
                        if coords.ndim != 2 or coords.shape[1] != 3:
                            raise HTTPException(422, 'Invalid rasterized contour.')
                        if (coords < 0).any() or (coords >= np.array(shape[::-1])).any():
                            raise HTTPException(422, 'Contour extends beyond the image.')
                        prompt_mask = np.zeros(shape, dtype=np.uint8)
                        prompt_mask[coords[:, 2], coords[:, 1], coords[:, 0]] = 1
                        fn = session.add_lasso_interaction if kind == 'lassos' else session.add_scribble_interaction
                        fn(prompt_mask, include_interaction=include)
            prediction = session.target_buffer
            if hasattr(prediction, 'detach'):
                prediction = prediction.detach().cpu().numpy()
            prediction = np.asarray(prediction)
            if list(prediction.shape) != shape or not np.isin(prediction, [0, 1]).all():
                raise HTTPException(502, 'AI returned an invalid binary grid.')
            result = np.ascontiguousarray(prediction[mask_order], dtype=np.uint8).tobytes()
            echo = finish_context(session, binding_context) | {
                'seriesUID': context['seriesUID'], 'sourceId': source_id, 'sourceType': 'nifti',
                'geometryHash': source['geometryHash'],
            }
        except Exception:
            invalidate_context(session)
            raise
    boundary = 'nifti-' + uuid.uuid4().hex
    meta = json.dumps({'nn_context': echo, 'mask_shape': shape, 'flipped': False,
                       'nninter_elapsed': round(time.monotonic() - started, 3)})
    prefix = (f'--{boundary}\r\nContent-Disposition: form-data; name="meta"\r\nContent-Type: application/json\r\n\r\n{meta}\r\n'
              f'--{boundary}\r\nContent-Disposition: form-data; name="seg"\r\nContent-Type: application/octet-stream\r\n\r\n').encode()
    return StreamingResponse(iter((prefix, result, f'\r\n--{boundary}--\r\n'.encode())),
                             media_type='multipart/form-data; boundary=' + boundary)
