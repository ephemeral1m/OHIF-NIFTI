"""Check normalized referential integrity and retained metadata independently."""
import collections
import hashlib
import json
from pathlib import Path
from prepare import PROJECT, dump

root = PROJECT / 'local-data/rexgroundingct'
def rows(name):
    return [json.loads(line) for line in (root / (name + '.jsonl')).read_text(encoding='utf-8').splitlines()]
def unique(records, key):
    mapping = {r[key]:r for r in records}
    assert len(mapping) == len(records), 'Duplicate ' + key
    return mapping

cases = unique(rows('cases'), 'caseId')
reports = unique(rows('reports'), 'reportId')
findings = unique(rows('findings'), 'findingId')
manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
for case in cases.values():
    for rid in case['reportIds']:
        assert rid in reports and case['caseId'] in reports[rid]['caseIds']
    for fid in case['findingIds']:
        finding = findings[fid]
        assert finding['caseId'] == case['caseId']
        assert finding['maskRef']['annotationId'] == case['annotation']['annotationId']
        assert finding['reportIds'] == case['reportIds']
    if case['image']:
        assert Path(case['image']['localPath']).is_file()
        assert case['annotation']['gridDimensionsMatch'] and case['annotation']['findingAxisMatches']
    for issue in case['issues']:
        if issue in ('IMAGE_MISSING','MASK_MISSING'):
            assert any(m['file']=='MICCAI_challenge_dataset.json' and m['split']=='test' for m in case['datasetMemberships'])
for report in reports.values():
    assert report['caseIds'] and all(cid in cases for cid in report['caseIds'])
for finding in findings.values():
    statements = {s['statementId'] for rid in finding['reportIds'] for s in reports[rid].get('statements', [])}
    assert set(finding['reportStatementBinding']['statementIds']) <= statements
    assert set(finding['reportStatementBinding']['candidateStatementIds']) <= statements
for source in manifest['metadataSources']:
    assert hashlib.sha256(Path(source['path']).read_bytes()).hexdigest() == source['sha256'], source['path']
sample = json.loads((root / 'sample-validation.json').read_text(encoding='utf-8'))
assert sample['passed']
for case in sample['cases']:
    assert case['caseId'] in cases
    for target in case['targets']:
        assert target['findingId'] in findings
        assert hashlib.sha256(Path(target['path']).read_bytes()).hexdigest() == target['fileSha256']
report = {'passed':True, 'cases':len(cases), 'reports':len(reports), 'findings':len(findings),
    'checks':['Unique dataset IDs', 'Case-report-finding-mask references', 'Image-mask dimensions and finding axes',
              'Missing image/mask cases belong to challenge test split', 'Statement and candidate references',
              'Source metadata checksums unchanged', 'Sample derived files match validation checksums'],
    'limits':['Full mask payloads validated only for the five-case sample.',
              'CT payloads were not fully read; header acceptance is not complete image validation.',
              'Report statement candidates are not confirmed bindings.']}
dump(root / 'audit.json', report)
print(json.dumps(report,indent=2))
