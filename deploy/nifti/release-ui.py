"""Release the NIfTI worklist/manifest revision; preserve the prior native release."""
import argparse
import copy
import json
import subprocess
from pathlib import Path

PROJECT = Path('/home/ubuntu/ohif-ai')
RELEASE = PROJECT / 'deploy/nifti-ui-release-20260916'
OLD = PROJECT / 'deploy/nifti-release-20260915'
DATASET = '/data/cache/datasets/CT-RATE'


def inspect(kind, name):
    return json.loads(subprocess.check_output(['docker', kind, 'inspect', name], text=True))[0]


def prepare():
    if (RELEASE / 'release.json').exists(): raise SystemExit('Snapshot exists; use refresh or activate.')
    RELEASE.mkdir(parents=True, exist_ok=True)
    config = json.loads((OLD / 'candidate.yml').read_text())
    record = {}
    viewer = inspect('container', 'ohif_orthanc')
    nginx = Path(next(m['Source'] for m in viewer['Mounts'] if m['Destination'] == '/etc/nginx/nginx.conf')).read_text()
    for kind in ('previous', 'candidate'):
        (RELEASE / f'nginx.{kind}.conf').write_text(nginx)
    for service, container in [('ohif_viewer', 'ohif_orthanc'), ('monai_sam2', 'monai_sam2')]:
        image = inspect('container', container)['Image']
        config['services'][service]['image'] = image
        record[service] = {'previous': image}
        subprocess.run(['docker', 'tag', image, f'ohif-ai-{service}:rollback-ui-20260916'], check=True)
    viewer_volumes = config['services']['ohif_viewer']['volumes']
    config['services']['ohif_viewer']['volumes'] = [v for v in viewer_volumes if ':/etc/nginx/nginx.conf:' not in v] + [f'{RELEASE}/nginx.previous.conf:/etc/nginx/nginx.conf:ro']
    (RELEASE / 'previous.yml').write_text(json.dumps(config, indent=2))
    candidate = copy.deepcopy(config)
    candidate['services']['ohif_viewer']['volumes'] = [v.replace('nginx.previous.conf', 'nginx.candidate.conf') for v in config['services']['ohif_viewer']['volumes']]
    backend = candidate['services']['monai_sam2']
    backend['environment']['NIFTI_IMPORT_ROOTS'] = json.dumps([DATASET])
    backend['volumes'].append(f'{DATASET}:{DATASET}:ro')
    (RELEASE / 'candidate.yml').write_text(json.dumps(candidate, indent=2))
    (RELEASE / 'release.json').write_text(json.dumps(record, indent=2))
    refresh()


def refresh():
    config = json.loads((RELEASE / 'candidate.yml').read_text())
    record = json.loads((RELEASE / 'release.json').read_text())
    for service, image in [('ohif_viewer', 'ohif-ai-nifti-viewer:test'), ('monai_sam2', 'ohif-ai-nifti-monai:test')]:
        identity = inspect('image', image)['Id']
        config['services'][service]['image'] = identity
        record[service]['candidate'] = identity
        subprocess.run(['docker', 'tag', identity, f'ohif-ai-{service}:ui-20260916'], check=True)
    (RELEASE / 'candidate.yml').write_text(json.dumps(config, indent=2))
    (RELEASE / 'release.json').write_text(json.dumps(record, indent=2))
    print('Candidate updated; previous native release and all data retained.')


def switch(kind):
    command = ['docker', 'compose', '-p', 'ohif-ai', '-f', str(PROJECT / 'docker-compose.yml'),
               '-f', str(PROJECT / 'deploy/vanilla/compose.vanilla.yml'), '-f', str(RELEASE / f'{kind}.yml')]
    subprocess.run(command + ['config', '--quiet'], check=True)
    subprocess.run(command + ['up', '-d', '--no-build', '--pull', 'never', '--no-deps', 'monai_sam2', 'ohif_viewer'], check=True)
    print('Active:', kind)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'refresh', 'activate', 'rollback'])
    action = parser.parse_args().action
    if action == 'prepare': prepare()
    elif action == 'refresh': refresh()
    else: switch('candidate' if action == 'activate' else 'previous')
