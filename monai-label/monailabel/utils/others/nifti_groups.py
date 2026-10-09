"""Logical segmentation groups, independent of voxel storage and runtime labelmaps."""
import json
import re
import uuid


def group_name(filename):
    stem = re.sub(r'(?i)\.nii(?:\.gz)?$', '', filename or 'Imported masks')
    return (stem.rsplit('__', 1)[-1] + ' · 原始标注')[:200]


def validate_group(value):
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) - {'id', 'name', 'kind', 'sourceFile'}:
        raise ValueError('Invalid segmentation group.')
    if not isinstance(value.get('id'), str) or not re.fullmatch(r'[a-f0-9]{32}', value['id']):
        raise ValueError('Invalid segmentation group identity.')
    if not isinstance(value.get('name'), str) or not value['name'].strip() or len(value['name']) > 200:
        raise ValueError('Invalid segmentation group name.')
    if value.get('kind') not in ('import', 'manual', 'copy', 'legacy'):
        raise ValueError('Invalid segmentation group kind.')
    if 'sourceFile' in value and (not isinstance(value['sourceFile'], str) or len(value['sourceFile']) > 255):
        raise ValueError('Invalid segmentation group source.')
    return dict(value)


def store_group(db, source, group):
    db.execute('INSERT OR IGNORE INTO segmentation_groups VALUES (?,?,?)',
               (source, group['id'], json.dumps(group)))
    return json.loads(db.execute('SELECT metadata FROM segmentation_groups WHERE source=? AND id=?',
                                (source, group['id'])).fetchone()[0])


def group_for(db, source, mask_id):
    row = db.execute('''SELECT g.metadata FROM segmentation_group_members m JOIN segmentation_groups g
      ON g.source=m.source AND g.id=m.group_id WHERE m.source=? AND m.mask_id=?''', (source, mask_id)).fetchone()
    return json.loads(row[0]) if row else None


def assign_group(db, source, mask_id, group):
    group = store_group(db, source, group)
    db.execute('INSERT OR IGNORE INTO segmentation_group_members VALUES (?,?,?)', (source, mask_id, group['id']))
    return group_for(db, source, mask_id)


def ensure_groups(db, source):
    """Backfill only from recorded import batches or explicit copy lineage, never names.

    Mask IDs, immutable versions and files remain untouched. Unknown provenance
    receives its own group rather than silently merging same-named files.
    """
    if not db.execute('''SELECT 1 FROM masks m LEFT JOIN segmentation_group_members g
        ON g.source=m.source AND g.mask_id=m.id WHERE m.source=? AND g.mask_id IS NULL LIMIT 1''', (source,)).fetchone():
        return
    rows = db.execute('''SELECT m.id,m.metadata FROM masks m JOIN
      (SELECT id,min(version) v FROM masks WHERE source=? GROUP BY id) first
      ON m.id=first.id AND m.version=first.v WHERE m.source=? ORDER BY m.created,m.id''', (source, source)).fetchall()
    records = {row['id']: json.loads(row['metadata']) for row in rows}
    if not records:
        return
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='manifest_imports'").fetchone():
        batches = db.execute('SELECT hash,masks FROM manifest_imports WHERE source=? ORDER BY hash', (source,)).fetchall()
        for batch in batches:
            ids = [mid for mid in json.loads(batch['masks']) if mid in records]
            if not ids:
                continue
            # Prefer an already registered group from this exact import batch.
            existing = next((group_for(db, source, mid) for mid in ids if group_for(db, source, mid)), None)
            file = records[ids[0]].get('originalFile', '')
            group = existing or {'id': uuid.uuid5(uuid.NAMESPACE_URL, source + ':import:' + batch['hash']).hex,
                                 'name': group_name(file), 'kind': 'import', 'sourceFile': file}
            for mid in ids:
                assign_group(db, source, mid, group)
    pending = {mid: rec for mid, rec in records.items() if not group_for(db, source, mid)}
    # First settle roots and explicit groups; copies inherit regardless of sort order.
    while pending:
        progressed = False
        for mid, rec in list(pending.items()):
            parent = rec.get('derivedFrom', {}).get('maskId')
            group = rec.get('segmentationSet') or (group_for(db, source, parent) if parent else None)
            if not group and parent in pending:
                continue
            group = group or {'id': uuid.uuid5(uuid.NAMESPACE_URL, source + ':legacy:' + mid).hex,
                              'name': (rec.get('name') or '未确认来源的标注')[:200], 'kind': 'legacy'}
            assign_group(db, source, mid, group)
            del pending[mid]
            progressed = True
        if not progressed:  # Defensive recovery for corrupt/cyclic historical lineage.
            mid = next(iter(pending))
            assign_group(db, source, mid, {'id': uuid.uuid5(uuid.NAMESPACE_URL, source + ':legacy:' + mid).hex,
                                          'name': '未确认来源的标注', 'kind': 'legacy'})
            del pending[mid]


def with_group(db, source, record):
    group = group_for(db, source, record['maskId'])
    return dict(record, segmentationSet=group) if group else record
