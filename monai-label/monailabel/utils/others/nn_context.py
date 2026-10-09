"""Selected-mask protocol. No model loading; callers hold NN_SESSION_LOCK.

Pixel order is established by DICOM SOP references, never InstanceNumber or the
algorithm that originally created the mask. A failed transaction consumes its
token, so the next request must seed from the browser's unchanged mask.
"""
import math
import secrets

import numpy as np
from fastapi import HTTPException

# Leave multipart/header headroom below the existing nginx 500M limit.
MAX_SEED_BYTES = 480 * 1024 * 1024
PROMPT_KEYS = tuple(f'{sign}_{kind}' for sign in ('pos', 'neg')
                    for kind in ('points', 'boxes', 'lassos', 'scribbles'))


def fail(code, message, status=409):
    raise HTTPException(status_code=status, detail={'code': code, 'message': message})


def validate_context(context, series_uid):
    if not isinstance(context, dict) or context.get('version') != 1:
        fail('NN_PROTOCOL_REQUIRED', 'Please update both viewer and MONAI for selected-mask editing.')
    for key in ('seriesUID', 'segmentationId', 'requestId'):
        if not isinstance(context.get(key), str) or not 0 < len(context[key]) <= 512:
            fail('NN_INVALID_CONTEXT', f'Invalid {key}.', 422)
    if context['seriesUID'] != series_uid:
        fail('NN_INVALID_CONTEXT', 'Selected mask belongs to another series.', 422)
    for key in ('segmentIndex', 'revision', 'generation'):
        value = context.get(key)
        if type(value) is not int or value < (1 if key == 'segmentIndex' else 0):
            fail('NN_INVALID_CONTEXT', f'Invalid {key}.', 422)
    shape = context.get('shape')
    if (not isinstance(shape, list) or len(shape) != 3 or
            any(type(v) is not int or v <= 0 for v in shape) or math.prod(shape) > MAX_SEED_BYTES):
        fail('NN_INVALID_GEOMETRY', 'Invalid or oversized mask dimensions.', 422)
    if any(not isinstance(context.get(name), list) or len(context[name]) != shape[0]
           for name in ('slices', 'promptSlices')):
        fail('NN_INVALID_GEOMETRY', 'Missing DICOM slice references.', 422)
    return context


def invalidate_context(session):
    if session is not None:
        session._ohif_nn_binding = None


def bind_context(session, context, seed):
    key = (context['seriesUID'], context['segmentationId'], context['segmentIndex'])
    binding = getattr(session, '_ohif_nn_binding', None)
    if seed is None and (not binding or binding['key'] != key or
                         binding['generation'] != context['generation'] or
                         not context.get('sessionToken') or
                         binding['token'] != context['sessionToken']):
        fail('NN_RESYNC_REQUIRED', 'AI session changed; synchronize the current mask again.')
    invalidate_context(session)
    if seed is not None:
        session.add_initial_seg_interaction(seed, run_prediction=False)


def finish_context(session, context):
    token = secrets.token_hex(24)
    session._ohif_nn_binding = {
        'key': (context['seriesUID'], context['segmentationId'], context['segmentIndex']),
        'generation': context['generation'], 'token': token,
    }
    return {key: context[key] for key in
            ('version', 'seriesUID', 'segmentationId', 'segmentIndex', 'requestId', 'revision', 'generation')} | {'sessionToken': token}


def source_geometry(dicom_filenames, series_uid):
    from pydicom import dcmread
    slices = []
    for filename in dicom_filenames:
        ds = dcmread(filename, stop_before_pixels=True)
        if str(ds.SeriesInstanceUID) != series_uid or int(getattr(ds, 'NumberOfFrames', 1)) != 1:
            fail('NN_INVALID_GEOMETRY', 'Only matching single-frame source slices are supported.', 422)
        slices.append(dict(sopInstanceUID=str(ds.SOPInstanceUID),
                           rows=int(ds.Rows), columns=int(ds.Columns),
                           position=list(map(float, ds.ImagePositionPatient)),
                           orientation=list(map(float, ds.ImageOrientationPatient)),
                           spacing=list(map(float, ds.PixelSpacing))))
    return slices


def geometry_mapping(context, source, shape):
    if list(shape) != context['shape'] or len(source) != shape[0]:
        fail('NN_INVALID_GEOMETRY', 'Mask dimensions differ from source DICOM.', 422)
    source_by_uid = {s['sopInstanceUID']: (i, s) for i, s in enumerate(source)}
    if len(source_by_uid) != len(source):
        fail('NN_INVALID_GEOMETRY', 'Duplicate source DICOM references.', 422)
    order = []
    for supplied in context['slices']:
        if not isinstance(supplied, dict) or supplied.get('sopInstanceUID') not in source_by_uid:
            fail('NN_INVALID_GEOMETRY', 'Unknown mask DICOM reference.', 422)
        index, actual = source_by_uid[supplied['sopInstanceUID']]
        if actual['rows'] != shape[1] or actual['columns'] != shape[2]:
            fail('NN_INVALID_GEOMETRY', 'Source pixel dimensions differ.', 422)
        for name, length in (('position', 3), ('orientation', 6), ('spacing', 2)):
            try:
                value = np.asarray(supplied[name], dtype=float)
                valid = value.shape == (length,) and np.isfinite(value).all() and np.allclose(value, actual[name], rtol=0, atol=1e-3)
            except (KeyError, ValueError, TypeError):
                valid = False
            if not valid:
                fail('NN_INVALID_GEOMETRY', f'DICOM {name} does not match the selected mask.', 422)
        order.append(index)
    if len(set(order)) != len(source):
        fail('NN_INVALID_GEOMETRY', 'Duplicate or incomplete mask slice references.', 422)
    if order not in (list(range(len(source))), list(reversed(range(len(source))))):
        fail('NN_INVALID_GEOMETRY', 'Mask slice order is unsupported by the existing draft format.', 422)
    try:
        prompt_order = [source_by_uid[uid][0] for uid in context['promptSlices']]
    except (KeyError, TypeError):
        fail('NN_INVALID_GEOMETRY', 'Unknown prompt DICOM reference.', 422)
    # Custom tools report IJK in the source volume order. Only native forward /
    # reverse slice axes are accepted; silently guessing a resampling is unsafe.
    if prompt_order not in (list(range(len(source))), list(reversed(range(len(source))))):
        fail('NN_INVALID_GEOMETRY', 'Prompt volume has an unsupported slice ordering.', 422)
    return order, prompt_order


def read_seed(filename, context, order):
    if filename is None:
        return None
    size = math.prod(context['shape'])
    with open(filename, 'rb') as stream:
        raw = stream.read(size + 1)
    if len(raw) != size:
        fail('NN_INVALID_SEED', 'Mask byte length does not match dimensions.', 422)
    seed = np.frombuffer(raw, dtype=np.uint8).reshape(context['shape'])
    if np.any(seed > 1):
        fail('NN_INVALID_SEED', 'Only a binary selected-mask seed is accepted.', 422)
    # order maps frontend slice index -> backend slice index.
    return np.ascontiguousarray(seed[np.argsort(order)])


def remap_prompts(data, prompt_order, shape):
    def point(value):
        if not isinstance(value, (list, tuple)) or len(value) != 3:
            fail('NN_INVALID_PROMPT', 'Invalid prompt point.', 422)
        try:
            x, y, z = map(float, value)
        except (TypeError, ValueError):
            fail('NN_INVALID_PROMPT', 'Invalid prompt coordinates.', 422)
        if not all(math.isfinite(v) and 0 <= v <= limit - 1
                   for v, limit in zip((x, y, z), reversed(shape))):
            fail('NN_INVALID_PROMPT', 'Prompt is outside the source image.', 422)
        if len(prompt_order) > 1 and prompt_order[0] > prompt_order[-1]:
            z = shape[0] - 1 - z
        return [round(x), round(y), round(z)]
    for key in PROMPT_KEYS:
        values = data.get(key, [])
        if not isinstance(values, list):
            fail('NN_INVALID_PROMPT', 'Invalid prompt list.', 422)
        mapped = []
        for value in values:
            if key.endswith('_points'):
                mapped.append(point(value))
                continue
            if not isinstance(value, list) or not value or (key.endswith('_boxes') and len(value) != 2):
                fail('NN_INVALID_PROMPT', 'Invalid contour or box.', 422)
            points = [point(p) for p in value]
            if key.endswith('_boxes'):
                points = [list(map(min, zip(*points))), list(map(max, zip(*points)))]
            mapped.append(points)
        data[key] = mapped
