"""Read-only comparison of a ReX source, derived finding files and stored masks."""
import argparse
import gzip
import hashlib
import json
import struct
import urllib.request
from pathlib import Path

import numpy as np


def decode(raw):
    raw = gzip.decompress(raw) if raw[:2] == b'\x1f\x8b' else raw
    endian = '<' if struct.unpack_from('<i', raw)[0] == 348 else '>'
    dims = struct.unpack_from(endian + '8h', raw, 40)
    assert struct.unpack_from(endian + 'h', raw, 70)[0] == 2
    offset = int(struct.unpack_from(endian + 'f', raw, 108)[0])
    shape = dims[1:1 + dims[0]]
    pixels = np.frombuffer(raw, np.uint8, offset=offset)
    assert pixels.size == np.prod(shape)
    return shape, pixels


def sha(pixels):
    return hashlib.sha256(pixels.tobytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--case', default='valid_254_a_2')
    parser.add_argument('--source-id', default='fdabe0b021d2410e967a64e038ca4c9f')
    parser.add_argument('--api', default='http://127.0.0.1:1026/monai/nifti-images')
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[3]
    package = json.loads((project / 'local-data/rexgroundingct/development-sample.json').read_text('utf8'))
    case = next(c for c in package['cases'] if c['name'] == args.case + '.nii.gz')
    raw_path = Path(case['annotation']['file']['localPath'])
    shape, raw = decode(raw_path.read_bytes())
    findings = raw.reshape(-1, shape[0])
    records, expected = [], {}
    for index in range(shape[0]):
        pixels = np.ascontiguousarray(findings[:, index])
        name = f'{args.case}__finding_{index}.nii.gz'
        derived_shape, derived = decode((project / 'local-data/rexgroundingct/derived-masks' / name).read_bytes())
        assert tuple(shape[1:]) == derived_shape and np.array_equal(pixels, derived)
        labels = []
        for value in np.unique(pixels):
            if value == 0:
                continue
            binary = (pixels == value).astype(np.uint8)
            expected[(name, int(value))] = sha(binary)
            labels.append({'label': int(value), 'voxels': int(binary.sum()), 'sha256': sha(binary)})
        records.append({'finding': index, 'voxels': int(np.count_nonzero(pixels)), 'sha256': sha(pixels), 'labels': labels})
    def get(path):
        with urllib.request.urlopen(args.api + '/' + args.source_id + path, timeout=60) as response:
            return response.read()
    saved = []
    for item in json.loads(get('/masks'))['items']:
        key = (item.get('originalFile'), item.get('originalLabel'))
        if key not in expected:
            continue
        stored_shape, pixels = decode(get(f"/masks/{item['maskId']}?version={item['version']}"))
        digest = sha(pixels)
        saved.append({'maskId': item['maskId'], 'version': item['version'], 'file': key[0], 'label': key[1],
                      'sha256': digest, 'voxels': int(np.count_nonzero(pixels)),
                      'sliceHashes': [sha(frame) for frame in pixels.reshape(stored_shape[2], -1)],
                      'matchesOriginal': stored_shape == tuple(shape[1:]) and digest == expected[key]})
    result = {'case': args.case, 'sourcePath': str(raw_path), 'shape': shape, 'findings': records,
              'identicalFindingPairs': [[a['finding'], b['finding']] for i, a in enumerate(records)
                                       for b in records[i+1:] if a['sha256'] == b['sha256']],
              'savedMasks': saved, 'allStoredMatchOriginal': len(saved) == len(expected) and all(s['matchesOriginal'] for s in saved)}
    output = project / 'local-data/acceptance' / (args.case + '-mask-audit.json')
    output.write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps({k: v for k, v in result.items() if k not in ('findings', 'savedMasks')}))
    print('Stored masks:', len(saved), 'Unique binary masks:', len(set(expected.values())))


if __name__ == '__main__':
    main()
