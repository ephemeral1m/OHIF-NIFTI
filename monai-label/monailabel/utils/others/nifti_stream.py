"""Rebuildable, immutable native NIfTI frame cache. Never writes to the library."""
import concurrent.futures
import gzip
import hashlib
import json
import logging
import os
import shutil
import threading
import time
import uuid
from pathlib import Path

import numpy as np
from monailabel.utils.others.nifti_source import read_nifti

logger = logging.getLogger(__name__)
VERSION = 1


class StreamError(Exception):
    def __init__(self, code, message, status=503):
        super().__init__(message)
        self.code, self.status = code, status


def atomic(path, data):
    temp = path.with_name('.' + path.name + '-' + uuid.uuid4().hex)
    try:
        with temp.open('wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def wire_dtype(data):
    """Pack float32 only when every original IEEE bit survives the round trip."""
    if data.dtype.kind == 'f' and data.dtype.itemsize == 4:
        flat = data.reshape(-1)
        for start in range(0, flat.size, 1024 * 1024):
            values = flat[start:start + 1024 * 1024]
            if (values < -32768).any() or (values > 32767).any():
                break
            restored = values.astype('<i2').astype(values.dtype)
            if not np.array_equal(values.view('u4'), restored.view('u4')):
                break
        else:
            return np.dtype('<i2')
    return data.dtype.newbyteorder('<')


class FrameCache:
    def __init__(self, directory, limit=10 * 1024 ** 3, retention=600):
        self.root = Path(directory).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.limit, self.retention = limit, retention
        self.lock = threading.RLock()
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix='nifti-stream')
        self.jobs, self.errors, self.pins, self.frame_locks = {}, {}, {}, {}
        self.reserved = {}
        # This service runs one cache executor. A restarted process can discard
        # its interrupted, unpublished generations before accounting capacity.
        for orphan in self.root.glob('.building-*'):
            if orphan.is_dir() and not orphan.is_symlink() and orphan.resolve().parent == self.root:
                shutil.rmtree(orphan)

    @staticmethod
    def key(meta):
        return hashlib.sha256(f"{VERSION}:{meta['contentHash']}:{meta['geometryHash']}".encode()).hexdigest()

    def _manifest(self, meta):
        key = self.key(meta)
        folder = self.root / key
        try:
            manifest = json.loads((folder / 'manifest.json').read_text())
            expected = int(np.prod(meta['dimensions'])) * np.dtype(manifest['wireDtype']).itemsize
            if (manifest['version'] != VERSION or manifest['cacheKey'] != key
                    or manifest['contentHash'] != meta['contentHash']
                    or manifest['geometryHash'] != meta['geometryHash']
                    or manifest['workingDtype'] != meta['workingDtype'] or manifest['preScaled'] is not True
                    or manifest['voxelToLPS'] != meta['voxelToLPS'] or manifest['unit'] != meta['unit']
                    or manifest['dimensions'] != meta['dimensions']
                    or len(manifest['frames']) != meta['dimensions'][2]
                    or np.dtype(manifest['wireDtype']).str not in ('|u1', '|i1', '<u2', '<i2', '<f4')
                    or any(f['bytes'] != expected // meta['dimensions'][2]
                           or len(f['sha256']) != 64 or any(c not in '0123456789abcdef' for c in f['sha256'])
                           for f in manifest['frames'])
                    or (folder / 'voxels.raw').stat().st_size != expected):
                return None
            os.utime(folder, None)
            return {**manifest, 'sourceId': meta['sourceId']}
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def status(self, meta):
        with self.lock:
            manifest = self._manifest(meta)
            if manifest:
                return {'state': 'ready', 'descriptor': manifest}
            key = self.key(meta)
            job = self.jobs.get(key)
            if job and not job.done():
                return {'state': 'preparing' if job.running() else 'queued'}
            if key in self.errors:
                return {'state': 'failed', 'error': self.errors[key]}
            return {'state': 'missing'}

    def prepare(self, meta, path):
        with self.lock:
            state = self.status(meta)
            if state['state'] in ('ready', 'preparing', 'queued'):
                return state
            key = self.key(meta)
            pending = sum(not job.done() for job in self.jobs.values())
            if pending >= 4:
                raise StreamError('NIFTI_STREAM_BUSY', '原图缓存准备队列繁忙，请稍后重试。', 429)
            self.errors.pop(key, None)
            self.jobs[key] = self.executor.submit(self._build, dict(meta), Path(path))
            return {'state': 'queued'}

    def _capacity(self, extra, protected):
        folders = [p for p in self.root.iterdir() if p.is_dir() and len(p.name) == 64 and all(c in '0123456789abcdef' for c in p.name)]
        sizes = {p: sum(f.stat().st_size for f in p.rglob('*') if f.is_file()) for p in folders}
        used = sum(sizes.values()) + sum(self.reserved.values())
        for folder in sorted(folders, key=lambda p: p.stat().st_mtime):
            if used + extra <= self.limit:
                return
            if folder.name == protected or self.pins.get(folder.name) or time.time() - folder.stat().st_mtime < self.retention:
                continue
            # Only generated cache keys immediately below the configured cache root.
            if folder.resolve().parent != self.root:
                continue
            shutil.rmtree(folder)
            used -= sizes[folder]
            self.jobs.pop(folder.name, None)
            self.errors.pop(folder.name, None)
            self.frame_locks = {k: v for k, v in self.frame_locks.items() if k[0] != folder.name}
        if used + extra > self.limit:
            raise StreamError('NIFTI_STREAM_CAPACITY', '浏览缓存容量不足，请稍后重试或增加缓存预算。', 507)

    def _build(self, expected, path):
        key = self.key(expected)
        temp = self.root / ('.building-' + key + '-' + uuid.uuid4().hex)
        started = time.monotonic()
        try:
            actual, pixels = read_nifti(path, expected['unit'])
            if any(actual[k] != expected[k] for k in ('contentHash', 'geometryHash', 'dimensions', 'workingDtype')):
                raise StreamError('NIFTI_STREAM_IDENTITY', '原图内容或几何与登记记录不一致。', 409)
            dtype = wire_dtype(pixels)
            with self.lock:
                required = pixels.size * dtype.itemsize * 2 + 1024 ** 2
                self._capacity(required, key)
                self.reserved[key] = required
            temp.mkdir()
            frames = []
            with (temp / 'voxels.raw').open('wb') as raw:
                for plane in pixels:
                    payload = np.ascontiguousarray(plane, dtype=dtype).tobytes()
                    raw.write(payload)
                    frames.append({'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()})
                raw.flush()
                os.fsync(raw.fileno())
            manifest = dict(version=VERSION, cacheKey=key, contentHash=actual['contentHash'],
                            geometryHash=actual['geometryHash'], dimensions=actual['dimensions'],
                            workingDtype=actual['workingDtype'], wireDtype=dtype.str,
                            preScaled=True, voxelToLPS=actual['voxelToLPS'], unit=actual['unit'],
                            preparationSeconds=round(time.monotonic() - started, 3), frames=frames)
            atomic(temp / 'manifest.json', json.dumps(manifest).encode())
            with self.lock:
                committed_bytes = sum(p.stat().st_size for p in temp.iterdir() if p.is_file())
                self._capacity(max(0, committed_bytes - self.reserved[key]), key)
                target = self.root / key
                if target.exists():
                    shutil.rmtree(target)
                os.replace(temp, target)
                self.reserved.pop(key, None)
                self.errors.pop(key, None)
            logger.info('nifti operation=stream_prepare elapsed_seconds=%.3f wire_bytes=%d frames=%d',
                        time.monotonic() - started, pixels.size * dtype.itemsize, len(frames))
        except Exception as error:
            with self.lock:
                self.errors[key] = {'code': getattr(error, 'code', 'NIFTI_STREAM_PREPARE'),
                                    'message': str(error) if isinstance(error, StreamError) else '原图缓存准备失败，请重试。'}
            logger.warning('nifti operation=stream_prepare status=failed type=%s', type(error).__name__)
        finally:
            with self.lock:
                self.reserved.pop(key, None)
            if temp.exists():
                shutil.rmtree(temp)

    def frame(self, meta, source_path, index):
        if not 0 <= index < meta['dimensions'][2]:
            raise StreamError('NIFTI_STREAM_INDEX', '切片索引超出原图范围。', 404)
        key = self.key(meta)
        with self.lock:
            manifest = self._manifest(meta)
            if not manifest:
                self.prepare(meta, source_path)
                raise StreamError('NIFTI_STREAM_NOT_READY', '原图缓存正在准备，请重试。', 425)
            self.pins[key] = self.pins.get(key, 0) + 1
            lock = self.frame_locks.setdefault((key, index), threading.Lock())
        try:
            with lock:
                folder = self.root / key
                target, sidecar = folder / f'{index}.gz', folder / f'{index}.json'
                if target.exists() and sidecar.exists():
                    try:
                        record = json.loads(sidecar.read_text())
                        if (record['rawHash'] == manifest['frames'][index]['sha256']
                                and hashlib.sha256(target.read_bytes()).hexdigest() == record['gzipHash']):
                            return target, manifest
                    except (OSError, ValueError, KeyError):
                        pass
                frame = manifest['frames'][index]
                with (folder / 'voxels.raw').open('rb') as raw:
                    raw.seek(index * frame['bytes'])
                    payload = raw.read(frame['bytes'])
                if hashlib.sha256(payload).hexdigest() != frame['sha256']:
                    with self.lock:
                        shutil.rmtree(folder)
                        self.jobs.pop(key, None)
                        self.prepare(meta, source_path)
                    raise StreamError('NIFTI_STREAM_CACHE_CORRUPT', '浏览缓存正在重新生成，请重试。')
                compressed = gzip.compress(payload, compresslevel=1, mtime=0)
                with self.lock:
                    self._capacity(len(compressed) + 1024, key)
                    atomic(target, compressed)
                    atomic(sidecar, json.dumps({'rawHash': frame['sha256'],
                                            'gzipHash': hashlib.sha256(compressed).hexdigest()}).encode())
                logger.info('nifti operation=stream_frame frame=%d bytes=%d', index, len(compressed))
                return target, manifest
        finally:
            with self.lock:
                self.pins[key] -= 1
                if (self.root / key).exists():
                    os.utime(self.root / key, None)

    def close(self):
        self.executor.shutdown(wait=True)


_instances, _lock = {}, threading.Lock()


def cache():
    directory = str(Path(os.environ.get('NIFTI_STREAM_CACHE_DIR', '/code/nifti_stream_cache')).resolve())
    with _lock:
        if directory not in _instances:
            _instances[directory] = FrameCache(directory, int(os.environ.get('NIFTI_STREAM_CACHE_MAX_BYTES', 10 * 1024 ** 3)))
        return _instances[directory]
