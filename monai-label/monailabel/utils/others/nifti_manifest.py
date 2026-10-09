"""Path-only manifests; all image reads remain within explicitly mounted roots."""
import csv
import io
import json
import os
from pathlib import Path


def import_roots():
    return [Path(p).resolve() for p in json.loads(os.environ.get('NIFTI_IMPORT_ROOTS', '[]'))]


def resolve_image(value, base=None):
    if not isinstance(value, str) or not value.strip() or '\x00' in value:
        raise ValueError('图像路径不能为空。')
    roots = import_roots()
    if not roots:
        raise ValueError('服务器尚未配置只读数据目录。')
    base_path = Path(base).resolve() if base else roots[0]
    if not any(base_path == r or r in base_path.parents for r in roots):
        raise ValueError('基准目录不在允许读取的数据目录内。')
    candidate = Path(value.strip())
    path = (candidate if candidate.is_absolute() else base_path / candidate).resolve()
    if not any(r in path.parents for r in roots):
        raise ValueError('路径超出允许读取的数据目录（包括符号链接）。')
    if not str(path).lower().endswith(('.nii', '.nii.gz')):
        raise ValueError('文件必须为 .nii 或 .nii.gz。')
    if not path.is_file():
        raise ValueError('文件不存在或无法读取：' + value)
    if path.stat().st_size > 514 * 1024 ** 2:
        raise ValueError('文件超过 514 MiB 传输上限。')
    return path


def parse_manifest(data, filename):
    if len(data) > 5 * 1024 ** 2:
        raise ValueError('清单不能超过 5 MiB。')
    text = data.decode('utf-8-sig')
    if filename.lower().endswith('.json'):
        rows = json.loads(text)
        if isinstance(rows, dict): rows = rows.get('cases')
        if not isinstance(rows, list): raise ValueError('JSON 必须是病例数组，或包含 cases 数组。')
    elif filename.lower().endswith('.csv'):
        rows = list(csv.reader(io.StringIO(text), strict=True))
        rows = [row for row in rows if any(value.strip() for value in row)]
        if rows and rows[0][0].strip().lower() in ('image', 'nifti', 'image_path', 'nifti_path', 'path'):
            rows = rows[1:]
    else:
        raise ValueError('请选择 UTF-8 CSV 或 JSON 清单。')
    if not rows or len(rows) > 10000: raise ValueError('清单须包含 1–10000 行。')
    result = []
    for index, row in enumerate(rows, 1):
        if isinstance(row, list):
            if not 1 <= len(row) <= 3: raise ValueError(f'第 {index} 行须为原图、可选 seg1、可选 seg2。')
            image, masks = row[0], row[1:]
            label = ''
        elif isinstance(row, dict):
            image = row.get('image', row.get('nifti'))
            masks = row.get('segmentations', [row.get('segmentation1'), row.get('segmentation2')])
            label = row.get('name', '')
        else: raise ValueError(f'第 {index} 行不是病例对象或数组。')
        if not isinstance(image, str) or not image.strip(): raise ValueError(f'第 {index} 行缺少原图地址。')
        if not isinstance(masks, list) or len(masks) > 256: raise ValueError(f'第 {index} 行最多 256 个 segmentation 地址。')
        if any(m is not None and not isinstance(m, str) for m in masks): raise ValueError(f'第 {index} 行 segmentation 必须是路径字符串。')
        item = {'row': index, 'image': image.strip(), 'segmentations': [m.strip() for m in masks if m and m.strip()],
                'name': str(label or Path(image).name)[:200], 'caseId': f'case-{index}', 'reports': [], 'findings': []}
        if isinstance(row, dict):
            item['caseId'] = str(row.get('caseId') or item['caseId'])[:200]
            if 'modality' in row:
                item['modality'] = row['modality']
                if item['modality'] not in ('CT', 'MR', 'OT'): raise ValueError('无效的图像类型。')
            for kind in ('reports', 'findings'):
                entries = row.get(kind, [])
                if not isinstance(entries, list) or len(entries) > 256: raise ValueError(f'{kind} 必须是最多 256 项的数组。')
                ids = set()
                for entry in entries:
                    if not isinstance(entry, dict) or not isinstance(entry.get('id'), str) or not entry['id'] or len(entry['id']) > 200 or entry['id'] in ids:
                        raise ValueError(f'{kind} 必须包含唯一的 id。')
                    ids.add(entry['id'])
                    if kind == 'reports':
                        statements = entry.get('statements', [])
                        if not isinstance(statements, list) or len(statements) > 2000: raise ValueError('报告 statements 无效。')
                        seen = set()
                        for s in statements:
                            if not isinstance(s, dict) or not isinstance(s.get('id'), str) or s['id'] in seen or not isinstance(s.get('text'), str) or len(s['text']) > 100000: raise ValueError('报告语句无效。')
                            seen.add(s['id'])
                        item[kind].append({'id': entry['id'], 'name': str(entry.get('name', '报告'))[:200], 'statements': [{'id': s['id'], 'section': str(s.get('section', 'Findings'))[:200], 'text': s['text']} for s in statements]})
                    else:
                        paths = entry.get('segmentations', [])
                        candidates = entry.get('candidateStatementIds', [])
                        if not isinstance(paths, list) or any(p not in item['segmentations'] for p in paths): raise ValueError('Finding mask 必须引用本例 segmentations。')
                        if not isinstance(candidates, list) or any(not isinstance(s, str) for s in candidates): raise ValueError('候选报告关联无效。')
                        item[kind].append({'id': entry['id'], 'text': str(entry.get('text', ''))[:10000], 'segmentations': paths, 'candidateStatementIds': candidates, 'statementIds': [], 'maskIds': []})
            statement_ids = [s['id'] for r in item['reports'] for s in r['statements']]
            if len(set(statement_ids)) != len(statement_ids): raise ValueError('同一病例中的报告语句 id 必须唯一。')
            if any(s not in statement_ids for f in item['findings'] for s in f['candidateStatementIds']): raise ValueError('候选语句必须属于当前病例。')
        result.append(item)
    if len({r['caseId'] for r in result}) != len(result): raise ValueError('caseId 必须唯一。')
    return result
