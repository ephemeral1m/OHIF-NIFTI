"""Fully validate selected 4D masks and derive per-finding 3D entity-label masks.

Stream the interleaved finding axis to bound memory. Keep paired CT header/grid,
preserve label values, and verify each decompressed exported payload by SHA-256.
"""
import argparse
import contextlib
import gzip
import hashlib
import json
import math
import struct
from pathlib import Path

import numpy as np
from prepare import PROJECT, dump, geometry, stem


def read_header(path):
    with gzip.open(path, 'rb') as stream:
        return stream.read(352)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=PROJECT / 'local-data/rexgroundingct')
    args = parser.parse_args()
    package = json.loads((args.output / 'development-sample.json').read_text(encoding='utf-8'))
    finding_index = {finding['findingId']: finding for finding in package['findings']}
    out = args.output / 'derived-masks'
    out.mkdir(exist_ok=True)
    result = {'scope': 'five_selected_cases_only', 'cases': [], 'warnings': [], 'passed': False}
    for case in package['cases']:
        original_mask = Path(case['annotation']['file']['localPath'])
        original_image = Path(case['image']['localPath'])
        image_header = read_header(original_image)
        image_meta = geometry.parse_header(image_header)
        header = bytearray(image_header)
        endian = image_meta['endian']
        struct.pack_into(endian + 'h', header, 70, 2)
        struct.pack_into(endian + 'h', header, 72, 8)
        struct.pack_into(endian + 'f', header, 108, 352.)
        struct.pack_into(endian + '2f', header, 112, 1., 0.)
        header[348:352] = b'\0' * 4
        targets = [finding_index[fid] for fid in case['findingIds']]
        count = len(targets)
        voxels = math.prod(image_meta['dimensions'])
        hashes = [hashlib.sha256() for _ in targets]
        histograms = [np.zeros(256, dtype=np.int64) for _ in targets]
        paths = [out / (stem(case['name']) + '__finding_' + str(f['sourceIndex']) + '.nii.gz') for f in targets]
        with contextlib.ExitStack() as stack:
            readers = stack.enter_context(gzip.open(original_mask, 'rb'))
            raw_header = readers.read(352)
            mask_endian = '<' if struct.unpack_from('<i', raw_header)[0] == 348 else '>'
            dims = struct.unpack_from(mask_endian + '8h', raw_header, 40)
            assert list(dims[1:5]) == [count, *image_meta['dimensions']]
            assert struct.unpack_from(mask_endian + 'h', raw_header, 70)[0] == 2
            slope, intercept = struct.unpack_from(mask_endian + '2f', raw_header, 112)
            if slope == 0 or math.isnan(slope): slope, intercept = 1., 0.
            assert slope == 1 and intercept == 0
            offset = int(struct.unpack_from(mask_endian + 'f', raw_header, 108)[0])
            assert 352 <= offset <= 1024 * 1024
            assert len(readers.read(offset - 352)) == offset - 352
            writers = [stack.enter_context(gzip.open(path, 'wb', compresslevel=1)) for path in paths]
            for writer in writers: writer.write(header)
            remaining = voxels
            while remaining:
                n = min(remaining, 512 * 512)
                data = readers.read(n * count)
                assert len(data) == n * count, 'Truncated original mask'
                block = np.frombuffer(data, dtype=np.uint8).reshape(n, count)
                for index, writer in enumerate(writers):
                    values = np.ascontiguousarray(block[:, index])
                    histograms[index] += np.bincount(values, minlength=256)
                    hashes[index].update(values.tobytes())
                    writer.write(values.tobytes())
                remaining -= n
            assert readers.read(1) == b'', 'Unexpected trailing mask voxels'
        checked = []
        for index, (finding, path) in enumerate(zip(targets, paths)):
            labels = np.flatnonzero(histograms[index][1:]) + 1
            foreground = int(histograms[index][1:].sum())
            expected = finding['declaredForegroundVoxels']
            assert expected is None or foreground == expected, (finding['findingId'], foreground, expected)
            with gzip.open(path, 'rb') as reader:
                meta = geometry.parse_header(reader.read(352), mask=True)
                assert meta['geometryHash'] == image_meta['geometryHash']
                digest, decoded_bytes = hashlib.sha256(), 0
                while block := reader.read(4 * 1024 * 1024):
                    digest.update(block)
                    decoded_bytes += len(block)
            assert decoded_bytes == voxels
            assert digest.hexdigest() == hashes[index].hexdigest()
            record = {'findingId': finding['findingId'], 'sourceFindingIndex': finding['sourceIndex'],
                'path': str(path.resolve()), 'relativePath': path.relative_to(args.output).as_posix(),
                'labels': labels.tolist(), 'entityCount': len(labels), 'foregroundVoxels': foreground,
                'geometryHash': meta['geometryHash'], 'voxelSha256': digest.hexdigest(),
                'fileSha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                'declaredEntityCount': finding['declaredEntityCount']}
            if finding['declaredEntityCount'] is not None and len(labels) != finding['declaredEntityCount']:
                result['warnings'].append({'code':'DECLARED_ENTITY_COUNT_DIFFERS_FROM_PRESENT_LABELS', **record})
            finding['maskRef'].update(observedEntityLabels=labels.tolist(), observedForegroundVoxels=foreground,
                derived3DMask=record, observedEntityCount=len(labels))
            checked.append(record)
        case['annotation']['derivedFindingMasks'] = checked
        case['annotation']['samplePayloadValidated'] = True
        result['cases'].append({'caseId': case['caseId'], 'name': case['name'],
            'originalMaskSha256': hashlib.sha256(original_mask.read_bytes()).hexdigest(),
            'sourceImageHeaderSha256': hashlib.sha256(image_header).hexdigest(),
            'originalMaskGzipCrcPassed': True, 'targets': checked})
        print(case['name'], len(checked), 'findings: pixels, labels, gzip CRC and derived roundtrip verified', flush=True)
    result['passed'] = True
    result['conversion'] = 'Extract first finding axis without spatial permutation or interpolation; inherit paired CT geometry, preserve entity values.'
    dump(args.output / 'development-sample.json', package)
    dump(args.output / 'sample-validation.json', result)
    print(json.dumps({'passed':True,'cases':len(result['cases']), 'findings':sum(len(c['targets']) for c in result['cases']), 'warnings':len(result['warnings'])}))


if __name__ == '__main__':
    main()
