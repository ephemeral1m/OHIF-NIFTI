"""Native selected-mask protocol v2; DICOM v1 validation remains unchanged."""
import math
import numpy as np
from monailabel.utils.others.nn_context import fail, remap_prompts
from monailabel.utils.others.nifti_source import MAX_VOXEL_BYTES


def validate_context(context, source):
    if not isinstance(context, dict) or context.get('version') != 2 or context.get('sourceType') != 'nifti':
        fail('NN_PROTOCOL_REQUIRED', 'Native NIfTI requires matching viewer/backend protocol v2.')
    if context.get('sourceId') != source['sourceId'] or context.get('geometryHash') != source['geometryHash']:
        fail('NN_INVALID_GEOMETRY', 'Selected mask belongs to another NIfTI source.', 422)
    for key in ('seriesUID', 'segmentationId', 'requestId'):
        if not isinstance(context.get(key), str) or not 0 < len(context[key]) <= 512:
            fail('NN_INVALID_CONTEXT', f'Invalid {key}.', 422)
    for key in ('segmentIndex', 'revision', 'generation'):
        if type(context.get(key)) is not int or context[key] < (1 if key == 'segmentIndex' else 0):
            fail('NN_INVALID_CONTEXT', f'Invalid {key}.', 422)
    shape = list(reversed(source['dimensions']))
    if context.get('shape') != shape or math.prod(shape) > MAX_VOXEL_BYTES:
        fail('NN_INVALID_GEOMETRY', 'Seed grid differs from the original image.', 422)
    expected = {'source': 'IJK', 'model': 'ZYX', 'physical': 'LPS-mm'}
    if context.get('gridConvention') != expected:
        fail('NN_INVALID_GEOMETRY', 'Unknown source/model coordinate convention.', 422)
    orders = []
    for key in ('maskOrder', 'promptOrder'):
        order = context.get(key)
        if not isinstance(order, list) or any(type(i) is not int for i in order) or order not in (list(range(shape[0])), list(reversed(range(shape[0])))):
            fail('NN_INVALID_GEOMETRY', 'Unsupported slice mapping.', 422)
        orders.append(order)
    return shape, *orders


def validate_prompts(params, order, shape):
    from monailabel.utils.others.nn_context import PROMPT_KEYS
    if sum(len(params.get(k, [])) for k in PROMPT_KEYS if isinstance(params.get(k, []), list)) > 1024:
        fail('NN_INVALID_PROMPT', 'Too many prompts in one request.', 422)
    remap_prompts(params, order, shape)
    return params


def read_seed(stream, shape, order):
    if stream is None:
        return None
    size = math.prod(shape)
    raw = stream.read(size + 1)
    if len(raw) != size:
        fail('NN_INVALID_SEED', 'Seed byte length differs from source.', 422)
    data = np.frombuffer(raw, np.uint8).reshape(shape)
    if (data > 1).any():
        fail('NN_INVALID_SEED', 'Seed must be binary.', 422)
    return np.ascontiguousarray(data[np.argsort(order)])
