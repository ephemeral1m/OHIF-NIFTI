"""Join verified image identities to report references, without copying report text."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[3]
out = root / 'outputs/hospital-10-20261008'
registrations = json.loads((out / 'registrations.json').read_text())
by_id = {r['caseId']: r for r in registrations}
assert len(by_id) == 10
manifest = json.loads((out / 'case_associations.json').read_text(encoding='utf-8'))
review_root = Path('C:/Users/maczm/Documents/ChatGPT/NV-Reason-COLIPRI-VAL/results')
review = json.loads((review_root / 'hospital_deidentified_review.json').read_text(encoding='utf-8-sig'))
translations = json.loads((review_root / 'hospital_nv_chinese.json').read_text(encoding='utf-8-sig'))
assert {c['case_id'] for c in review['cases']} == set(by_id) == set(translations)
for case in manifest['cases']:
    record = by_id[case['name']]
    assert case['dimensions'] == record['dimensions']
    case.update(sourceId=record['sourceId'], geometryHash=record['geometryHash'])
    case['viewerUrl'] = 'https://server-vanilla.tailb37712.ts.net:9443/nifti?sourceId=' + record['sourceId']
    for ref in case['reportRefs']:
        if ref['kind'] == 'translation': ref['field'] = case['name'] + '.translation'
(out / 'case_associations.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
print('10 image/sourceId/report/translation associations verified; no report text exported.')
