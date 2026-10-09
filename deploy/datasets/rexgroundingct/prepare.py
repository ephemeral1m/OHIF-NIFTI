"""Build a read-only, versioned data inventory for future OHIF Case manifests.

No source is moved or imported into the running server. Image checks read headers;
full voxel integrity is deliberately a separate, explicitly sampled operation.
"""
import argparse
import collections
import concurrent.futures
import csv
import datetime
import gzip
import hashlib
import importlib.util
import json
import math
import re
import struct
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('native_geometry', PROJECT / 'monai-label/monailabel/utils/others/nifti_source.py')
geometry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(geometry)
RELEASES = ['dataset.json', 'MICCAI_challenge_dataset.json', 'MLHC_dataset_version.json']


def dump(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')


def jsonl(path, rows):
    with path.open('w', encoding='utf-8') as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + '\n')


def normalized(text):
    return re.sub(r'[^a-z0-9]+', ' ', text.lower()).strip()


def stem(name):
    return name.removesuffix('.nii.gz').removesuffix('.nii')


def case_id(name):
    return 'rexgroundingct:case:' + stem(name)


def safe_float(value):
    return value if math.isfinite(value) else None


def inspect(path, is_image):
    try:
        with path.open('rb') as raw:
            compressed = raw.read(2) == b'\x1f\x8b'
            raw.seek(0)
            if compressed:
                with gzip.GzipFile(fileobj=raw) as stream:
                    header = stream.read(352)
            else:
                header = raw.read(352)
        if len(header) != 352:
            raise ValueError('Truncated header')
        endian = '<' if struct.unpack_from('<i', header)[0] == 348 else '>'
        if struct.unpack_from(endian + 'i', header)[0] != 348 or header[344:348] != b'n+1\0':
            raise ValueError('Not single-file NIfTI-1')
        dims = struct.unpack_from(endian + '8h', header, 40)
        if not 1 <= dims[0] <= 7 or min(dims[1:dims[0]+1]) < 1:
            raise ValueError('Invalid dimensions')
        shape = list(dims[1:dims[0]+1])
        dtype, bitpix = struct.unpack_from(endian + '2h', header, 70)
        slope, intercept = struct.unpack_from(endian + '2f', header, 112)
        if slope == 0 or math.isnan(slope):
            slope, intercept = 1., 0.
        result = {'status': 'header_read', 'shape': shape, 'datatype': dtype, 'bitpix': bitpix,
                  'voxelBytes': math.prod(shape) * bitpix // 8,
                  'effectiveSlope': safe_float(slope), 'effectiveIntercept': safe_float(intercept),
                  'qformCode': struct.unpack_from(endian + 'h', header, 252)[0],
                  'sformCode': struct.unpack_from(endian + 'h', header, 254)[0],
                  'headerSha256': hashlib.sha256(header).hexdigest(), 'fullPayloadValidated': False}
        if is_image:
            result['workingBytes'] = math.prod(shape) * (4 if slope != 1 or intercept != 0 else bitpix // 8)
            try:
                meta = geometry.parse_header(header)
                result['currentViewerHeaderCheck'] = {'status': 'accepted', 'geometryHash': meta['geometryHash'],
                    'unit': meta['unit'], 'voxelToLPS': meta['voxelToLPS'], 'warnings': meta['warnings']}
            except geometry.NiftiError as error:
                result['currentViewerHeaderCheck'] = {'status': 'blocked', 'code': error.code, 'message': str(error)}
        return result
    except Exception as error:
        return {'status': 'failed', 'error': str(error), 'fullPayloadValidated': False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rex', type=Path, default=Path(r'E:\Data\ReXGroundingCT'))
    parser.add_argument('--ct', type=Path, default=Path(r'E:\Data\CT-RATE'))
    parser.add_argument('--output', type=Path, default=PROJECT / 'local-data/rexgroundingct')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    roots = {'rexgroundingct': args.rex.resolve(), 'ct-rate': args.ct.resolve()}
    issues, source_files, variants, memberships = [], [], [], collections.defaultdict(list)
    canonical, release_summary = {}, {}
    for filename in RELEASES:
        path = args.rex / filename
        data = json.loads(path.read_text(encoding='utf-8'))
        source_files.append(path)
        release_summary[filename] = {}
        seen = set()
        for split, records in data.items():
            release_summary[filename][split] = {'cases': len(records), 'findings': sum(len(r['findings']) for r in records)}
            for index, record in enumerate(records):
                name = record['name']
                assert name not in seen, (filename, 'duplicate case', name)
                seen.add(name)
                reference = {'file': filename, 'split': split, 'jsonPointer': f'/{split}/{index}'}
                memberships[name].append(reference)
                variants.append({'caseId': case_id(name), **reference, 'sourceRecord': record})
                if name in canonical and record != canonical[name][1]:
                    issues.append({'code': 'ANNOTATION_VERSION_DIFFERENCE', 'caseId': case_id(name), 'file': filename})
                canonical.setdefault(name, (reference, record))

    images = collections.defaultdict(list)
    for path in args.ct.rglob('*.nii*'):
        if path.is_file() and path.name.endswith(('.nii', '.nii.gz')):
            images[path.name].append(path)
    masks = {path.name: path for path in (args.rex / 'segmentations').glob('*.nii.gz')}
    all_names = sorted(set(canonical) | set(images) | set(masks))
    tasks = [(p, True) for paths in images.values() for p in paths] + [(p, False) for p in masks.values()]
    headers = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(inspect, path, image): path for path, image in tasks}
        for count, future in enumerate(concurrent.futures.as_completed(futures), 1):
            path = futures[future]
            headers[str(path)] = future.result()
            if count % 500 == 0 or count == len(tasks):
                print(f'Headers checked {count}/{len(tasks)}', flush=True)

    reports, report_index, rex_report_index = [], collections.defaultdict(list), {}
    report_path = args.rex / 'reports_dataset.json'
    source_files.append(report_path)
    for split, rows in json.loads(report_path.read_text()).items():
        for key, body in rows.items():
            report_id = 'rexgroundingct:report:' + stem(key)
            assert key not in rex_report_index
            statements = []
            for section, values in body.get('Findings', {}).items():
                for index, text in enumerate(values):
                    section_slug = re.sub(r'[^a-z0-9]+', '-', section.lower()).strip('-')
                    statements.append({'statementId': f'{report_id}:{section_slug}:{index}', 'section': section, 'index': index, 'text': text})
            report = {'reportId': report_id, 'kind': 'rex_extracted_structured', 'language': 'en',
                      'sourceKey': key, 'split': split, 'sourceFile': 'reports_dataset.json',
                      'content': body, 'statements': statements, 'caseIds': []}
            rex_report_index[key] = report
            reports.append(report)

    csv.field_size_limit(10 * 1024 * 1024)
    ct_metadata = {}
    for path in sorted((args.ct / 'dataset/metadata').glob('*metadata.csv')):
        source_files.append(path)
        with path.open(newline='', encoding='utf-8-sig') as stream:
            for row in csv.DictReader(stream):
                if row['VolumeName'] in canonical:
                    ct_metadata[row['VolumeName']] = {k: row[k] for k in ('RescaleSlope', 'RescaleIntercept', 'XYSpacing', 'ZSpacing', 'NumberofSlices')}
    for path in sorted((args.ct / 'dataset/radiology_text_reports').glob('*.csv')):
        source_files.append(path)
        with path.open(newline='', encoding='utf-8-sig') as stream:
            for row_number, row in enumerate(csv.DictReader(stream), 2):
                name = row['VolumeName']
                if name not in canonical:
                    continue
                report_id = 'ct-rate:report:' + stem(name)
                report = {'reportId': report_id, 'kind': 'ct_rate_source_english', 'language': 'en',
                    'sourceKey': name, 'sourceFile': str(path.relative_to(args.ct)), 'sourceRow': row_number,
                    'content': {k: v for k, v in row.items() if k != 'VolumeName'},
                    'caseIds': [case_id(name)]}
                reports.append(report)
                report_index[name].append(report_id)

    cot_path = args.rex / 'anatomical_cot.json'
    source_files.append(cot_path)
    cot_index = {row['name']: row for rows in json.loads(cot_path.read_text()).values() for row in rows}
    non_chest = set()
    for path in (args.ct / 'dataset/metadata').glob('no_chest_*.txt'):
        source_files.append(path)
        non_chest.update(Path(line.strip()).name for line in path.read_text().splitlines() if line.strip())

    def asset(path, root_key):
        if path is None:
            return None
        stat = path.stat()
        return {'rootId': root_key, 'relativePath': path.relative_to(roots[root_key]).as_posix(),
                'localPath': str(path), 'fileBytes': stat.st_size, 'mtimeNs': stat.st_mtime_ns,
                'header': headers[str(path)], 'contentHash': None}

    cases, findings = [], []
    for name in all_names:
        cid = case_id(name)
        reference, record = canonical.get(name, ({}, {'name': name, 'findings': {}}))
        candidates = images.get(name, [])
        image_path = candidates[0] if len(candidates) == 1 else None
        mask_path = masks.get(name)
        image_asset, mask_asset = asset(image_path, 'ct-rate'), asset(mask_path, 'rexgroundingct')
        report_key = re.sub(r'_\d+\.nii\.gz$', '.nii.gz', name)
        rex_report = rex_report_index.get(report_key)
        report_ids = list(report_index.get(name, []))
        if rex_report:
            rex_report['caseIds'].append(cid)
            report_ids.insert(0, rex_report['reportId'])
        keys = sorted(record.get('findings', {}), key=int)
        reasons = []
        if not image_path: reasons.append('IMAGE_MISSING' if not candidates else 'AMBIGUOUS_IMAGE_PATH')
        if not mask_path: reasons.append('MASK_MISSING')
        if not rex_report: reasons.append('REX_REPORT_MISSING')
        if not report_ids: reasons.append('ALL_REPORTS_MISSING')
        grid_matches = bool(image_asset and mask_asset and image_asset['header'].get('shape') == mask_asset['header'].get('shape', [])[1:] == record.get('shape'))
        channel_matches = bool(mask_asset and mask_asset['header'].get('shape', [None])[0] == len(keys) and keys == [str(i) for i in range(len(keys))])
        if image_asset and mask_asset and not grid_matches: reasons.append('GRID_DIMENSIONS_MISMATCH')
        if mask_asset and not channel_matches: reasons.append('FINDING_AXIS_MISMATCH')
        viewer_check = image_asset['header'].get('currentViewerHeaderCheck', {}) if image_asset else {}
        if image_asset and viewer_check.get('status') != 'accepted': reasons.append(viewer_check.get('code', 'IMAGE_HEADER_INVALID'))
        if name in non_chest: reasons.append('CT_RATE_NON_CHEST_LIST')
        for reason in reasons:
            issues.append({'code': reason, 'caseId': cid, 'name': name})
        annotation_id = 'rexgroundingct:annotation:' + stem(name)
        finding_ids = []
        for key in keys:
            fid = cid + ':finding:' + key
            finding_ids.append(fid)
            text = record['findings'][key]
            matches = [s['statementId'] for s in rex_report['statements'] if normalized(text) and normalized(s['text']) == normalized(text)] if rex_report else []
            candidates = [s['statementId'] for s in rex_report['statements']
                if len(normalized(text).split()) >= 5 and (' ' + normalized(text) + ' ') in (' ' + normalized(s['text']) + ' ')
                and s['statementId'] not in matches] if rex_report else []
            findings.append({'findingId': fid, 'caseId': cid, 'sourceIndex': int(key), 'text': text,
                'categoryCode': record.get('categories', {}).get(key), 'declaredEntityCount': record.get('entity_counts', {}).get(key),
                'declaredForegroundVoxels': record.get('pixels', {}).get(key), 'provenance': reference,
                'reportIds': report_ids, 'reportAssociation': 'case_level_source_key_join',
                'reportStatementBinding': {'status': 'normalized_exact' if len(matches) == 1 else 'ambiguous' if matches else 'unresolved',
                    'statementIds': matches if len(matches) == 1 else [],
                    'candidateStatementIds': matches if len(matches) > 1 else candidates,
                    'candidateMethod': 'ambiguous_exact' if len(matches)>1 else 'normalized_substring_not_confirmed'},
                'maskRef': {'annotationId': annotation_id, 'findingAxis': 0, 'findingIndex': int(key),
                    'available': mask_path is not None, 'backgroundValue': 0, 'entityEncoding': 'nonzero_integer_values',
                    'observedEntityLabels': None, 'observedForegroundVoxels': None},
                'anatomicalGuidance': cot_index.get(name, {}).get('cot', {}).get(key),
                'anatomicalGuidanceKind': 'dataset_auxiliary_text_not_report'})
        cases.append({'caseId': cid, 'name': name, 'modality': 'CT', 'datasetMemberships': memberships.get(name, []),
            'canonicalAnnotation': reference, 'image': image_asset, 'dicomReferences': [],
            'reportIds': report_ids, 'defaultReportId': report_ids[0] if report_ids else None, 'findingIds': finding_ids,
            'annotation': {'annotationId': annotation_id, 'file': mask_asset, 'layout': ['finding', 'i', 'j', 'k'],
                'gridDimensionsMatch': grid_matches, 'findingAxisMatches': channel_matches,
                'physicalGeometrySource': 'paired_ct_after_verified_dataset_axis_extraction',
                'directImportSupported': False, 'requiresConversion': True},
            'ctRateV1ReferenceMetadata': ct_metadata.get(name),
            'ctRateImageVersion': 'v2_corrected' if image_path and any(p in ('train_fixed','valid_fixed') for p in image_path.parts) else None,
            'availability': {'image': image_path is not None, 'annotation': mask_path is not None,
                'rexReport': rex_report is not None, 'anyReport': bool(report_ids)}, 'issues': reasons})

    summary = {'cases': len(cases), 'findings': len(findings), 'reports': len(reports), 'releases': release_summary,
        'localImages': sum(c['availability']['image'] for c in cases),
        'localAnnotations': sum(c['availability']['annotation'] for c in cases),
        'imageBytes': sum(c['image']['fileBytes'] for c in cases if c['image']),
        'annotationBytes': sum(c['annotation']['file']['fileBytes'] for c in cases if c['annotation']['file']),
        'casesWithRexReport': sum(c['availability']['rexReport'] for c in cases),
        'localCasesWithRexReport': sum(c['availability']['image'] and c['availability']['rexReport'] for c in cases),
        'localCasesUsingCtRateReportFallback': sum(c['availability']['image'] and not c['availability']['rexReport'] and c['availability']['anyReport'] for c in cases),
        'localFindings': sum(len(c['findingIds']) for c in cases if c['availability']['annotation']),
        'casesWithAnyReport': sum(c['availability']['anyReport'] for c in cases),
        'localCasesWithAnyReport': sum(c['availability']['image'] and c['availability']['anyReport'] for c in cases),
        'headersChecked': len(headers), 'headerFailures': sum(h['status']=='failed' for h in headers.values()),
        'currentViewerImageHeaderChecks': dict(collections.Counter(c['image']['header'].get('currentViewerHeaderCheck',{}).get('code','accepted') for c in cases if c['image'])),
        'reportStatementBindings': dict(collections.Counter(f['reportStatementBinding']['status'] for f in findings)),
        'findingsWithUnconfirmedStatementCandidates': sum(bool(f['reportStatementBinding']['candidateStatementIds']) for f in findings),
        'issues': dict(collections.Counter(i['code'] for i in issues)),
        'fullDatasetVoxelValidation': False, 'rawFilesModified': False}
    for filename, data in [('cases.jsonl',cases),('reports.jsonl',reports),('findings.jsonl',findings),('annotation-variants.jsonl',variants),('issues.jsonl',issues)]:
        jsonl(args.output / filename, data)
    dump(args.output / 'summary.json', summary)
    for path in [args.rex/'README.md', args.ct/'dataset/README.md', args.ct/'dataset/data_correction_note.md']:
        source_files.append(path)
    manifest = {'schema': 'ohif-ai.dataset-preparation', 'schemaVersion': 1, 'status': 'prepared_not_runtime_import',
        'dataset': 'ReXGroundingCT', 'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'roots': {key:str(value) for key,value in roots.items()},
        'tables': {key:key+'.jsonl' for key in ['cases','reports','findings','annotation-variants','issues']},
        'metadataSources': [{'path':str(p),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in source_files],
        'notes': ['Original files are referenced, never moved or rewritten.',
                  'Case/report/finding IDs are dataset IDs, not runtime NIfTI sourceIds or DICOM UIDs.',
                  'Preserve split membership separately for every release.',
                  'Current OHIF CSV/JSON importer does not support this manifest.',
                  'NIfTI headers and grid dimensions are checked; whole-volume CRC and voxels are not globally checked.',
                  'Never reapply CT-RATE v1 CSV intensity correction to train_fixed/valid_fixed v2 images.',
                  'Rex 4D annotation axis 0 is a finding axis, not time; nonzero values within a finding are entity IDs.',
                  'Deriving a 3D mask requires paired CT geometry; annotation header geometry must not be used as the CT grid.',
                  'Finding-report case association is established by source keys. Only normalized exact statement matches are bound.',
                  'No DICOM files are part of this NIfTI dataset inventory.'], 'summary': summary}
    dump(args.output / 'manifest.json', manifest)
    ready = [c for c in cases if c['image'] and c['annotation']['gridDimensionsMatch'] and c['annotation']['findingAxisMatches'] and c['availability']['rexReport'] and c['image']['header'].get('currentViewerHeaderCheck',{}).get('status')=='accepted']
    selected = []
    for predicate in [lambda c:any(m['file']=='dataset.json' and m['split']=='val' for m in c['datasetMemberships']) and len(c['findingIds'])>2,
                      lambda c:c['name']=='train_13249_b_2.nii.gz', lambda c:len(c['findingIds'])==1,
                      lambda c:len(c['findingIds'])>=5, lambda c:True]:
        candidate = next((c for c in sorted(ready,key=lambda c:c['image']['fileBytes']) if c not in selected and predicate(c)),None)
        if candidate: selected.append(candidate)
    sample_ids = {c['caseId'] for c in selected}
    sample_report_ids = {rid for c in selected for rid in c['reportIds']}
    dump(args.output / 'development-sample.json', {'schema':'ohif-ai.dataset-preparation.sample','schemaVersion':1,
        'cases':selected, 'findings':[f for f in findings if f['caseId'] in sample_ids],
        'reports':[r for r in reports if r['reportId'] in sample_report_ids]})
    print(json.dumps(summary,ensure_ascii=False,indent=2),flush=True)


if __name__ == '__main__':
    main()
