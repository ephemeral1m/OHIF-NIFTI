"""Release NIfTI display fixes; switch only the viewer, retaining the active backend."""
import argparse
import json
import subprocess
from pathlib import Path

project = Path('/home/ubuntu/ohif-ai')
release = project / 'deploy/nifti-display-release-20260917'

def inspect(kind, name):
    return json.loads(subprocess.check_output(['docker', kind, 'inspect', name], text=True))[0]

def prepare():
    if (release / 'release.json').exists():
        raise SystemExit('Snapshot exists; do not overwrite rollback metadata.')
    release.mkdir(parents=True, exist_ok=True)
    config = json.loads((project / 'deploy/nifti-groups-release-20260917/candidate.yml').read_text())
    record = {}
    for service, container in [('ohif_viewer', 'ohif_orthanc'), ('monai_sam2', 'monai_sam2')]:
        previous = inspect('container', container)['Image']
        inspect('image', previous)
        subprocess.run(['docker', 'tag', previous, f'ohif-ai-{service}:pre-display-20260917'], check=True)
        config['services'][service]['image'] = previous
        record[service] = {'previous': previous, 'candidate': previous}
    (release / 'previous.yml').write_text(json.dumps(config, indent=2))
    candidate = inspect('image', 'ohif-ai-nifti-viewer:test')['Id']
    subprocess.run(['docker', 'tag', candidate, 'ohif-ai-ohif_viewer:display-20260917'], check=True)
    config['services']['ohif_viewer']['image'] = candidate
    record['ohif_viewer']['candidate'] = candidate
    (release / 'candidate.yml').write_text(json.dumps(config, indent=2))
    (release / 'release.json').write_text(json.dumps(record, indent=2))
    print(json.dumps(record, indent=2))

def switch(kind):
    record = json.loads((release / 'release.json').read_text())
    if inspect('container', 'monai_sam2')['Image'] != record['monai_sam2']['previous']:
        raise SystemExit('Backend changed since snapshot; inspect deployment before switching.')
    cmd = ['docker', 'compose', '-p', 'ohif-ai', '-f', str(project / 'docker-compose.yml'),
           '-f', str(project / 'deploy/vanilla/compose.vanilla.yml'), '-f', str(release / f'{kind}.yml')]
    subprocess.run(cmd + ['config', '--quiet'], check=True)
    subprocess.run(cmd + ['up', '-d', '--no-build', '--pull', 'never', '--no-deps', 'ohif_viewer'], check=True)
    print('Active:', kind)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'activate', 'rollback'])
    action = parser.parse_args().action
    if action == 'prepare': prepare()
    else: switch('candidate' if action == 'activate' else 'previous')
