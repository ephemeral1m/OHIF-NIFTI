"""Create a viewer manifest and narrowly scoped read-only mounts for the five reviewed cases."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[3]
prepared = root / 'local-data/rexgroundingct'
sample = json.loads((prepared / 'development-sample.json').read_text(encoding='utf-8'))
cases, mounts = [], []
for case in sample['cases']:
    name = case['name']
    image = '/rex-sample/images/' + name
    mounts.append({'type': 'bind', 'source': case['image']['localPath'], 'target': image, 'read_only': True})
    findings = sorted((f for f in sample['findings'] if f['caseId'] == case['caseId']), key=lambda f: f['sourceIndex'])
    paths, fs = [], []
    for f in findings:
        file = Path(f['maskRef']['derived3DMask']['path'])
        path = '/rex-sample/masks/' + file.name
        mounts.append({'type': 'bind', 'source': str(file), 'target': path, 'read_only': True})
        paths.append(path)
        fs.append({'id': f['findingId'], 'text': f['text'], 'segmentations': [path], 'candidateStatementIds': f['reportStatementBinding']['candidateStatementIds']})
    reports = []
    for r in sample['reports']:
        if r['reportId'] not in case['reportIds']: continue
        structured = r['kind'] == 'rex_extracted_structured'
        statements = [{'id': s['statementId'], 'section': s['section'], 'text': s['text']} for s in r.get('statements', [])]
        if structured:
            impression = r['content'].get('Impressions')
            if impression and impression != 'Not given.': statements.append({'id': r['reportId'] + ':impression', 'section': 'Impression', 'text': impression})
        else:
            statements = [{'id': r['reportId'] + ':' + key, 'section': key.replace('_EN', ''), 'text': value} for key, value in r['content'].items() if isinstance(value, str) and value and value != 'Not given.']
        reports.append({'id': r['reportId'], 'name': 'ReX · 结构化报告' if structured else 'CT-RATE · 原始文本', 'statements': statements})
    cases.append({'caseId': case['caseId'], 'name': name, 'modality': 'CT', 'image': image, 'segmentations': paths, 'reports': reports, 'findings': fs})
(prepared / 'rex-workspace.json').write_text(json.dumps({'schema': 'ohif-ai.case-manifest', 'schemaVersion': 1, 'cases': cases}, ensure_ascii=False, indent=2), encoding='utf-8')
override = {'services': {'backend': {'environment': {'NIFTI_IMPORT_ROOTS': json.dumps(['/local-input', '/rex-sample/images', '/rex-sample/masks'])}, 'volumes': mounts}}}
(root / 'deploy/local/rex-sample.compose.json').write_text(json.dumps(override, indent=2), encoding='utf-8')
print(f'Prepared {len(cases)} cases and {len(mounts)} read-only file mounts.')
