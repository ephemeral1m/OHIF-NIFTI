"""Independent annotation history release; preserves data and a pinned rollback pair."""
import argparse
import json
import subprocess
from pathlib import Path

project = Path('/home/ubuntu/ohif-ai')
release = project / 'deploy/nifti-annotation-history-release-20260917'

def inspect(kind, name):
    return json.loads(subprocess.check_output(['docker', kind, 'inspect', name], text=True))[0]

def prepare():
    if (release / 'release.json').exists():
        raise SystemExit('Snapshot exists; do not overwrite rollback metadata.')
    release.mkdir(parents=True, exist_ok=True)
    config = json.loads((project / 'deploy/nifti-mask-history-release-20260917/candidate.yml').read_text())
    services = [('ohif_viewer', 'ohif_orthanc'), ('monai_sam2', 'monai_sam2')]
    originals = {service: inspect('container', container)['Image'] for service, container in services}
    available = all(subprocess.run(['docker', 'image', 'inspect', image],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
                    for image in originals.values())
    # Replaced OCI test tags lost their old manifests. A live container cannot be
    # committed without those manifests either. Use the last pinned, tested pair
    # together, never a mixture of frontend/backend releases.
    rollback = {service: originals[service] if available else
                inspect('image', f'ohif-ai-{service}:phase1-20260916')['Id']
                for service, _ in services}
    record = {}
    for service, container in services:
        original = originals[service]
        previous = rollback[service]
        tag = f'ohif-ai-{service}:pre-annotation-history-20260917'
        subprocess.run(['docker', 'tag', previous, tag], check=True)
        config['services'][service]['image'] = previous
        record[service] = {'previous': previous, 'originalContainerImage': original,
                           'rollbackBaseline': 'immediate-previous' if available else 'phase1-20260916',
                           'rollbackReason': None if available else 'Previous OCI test manifests unavailable; use last pinned tested pair.'}
    (release / 'previous.yml').write_text(json.dumps(config, indent=2))
    for service, tag in [('ohif_viewer', 'ohif-ai-nifti-viewer:test'), ('monai_sam2', 'ohif-ai-nifti-monai:test')]:
        candidate = inspect('image', tag)['Id']
        subprocess.run(['docker', 'tag', candidate, f'ohif-ai-{service}:annotation-history-20260917'], check=True)
        config['services'][service]['image'] = candidate
        record[service]['candidate'] = candidate
    (release / 'candidate.yml').write_text(json.dumps(config, indent=2))
    (release / 'release.json').write_text(json.dumps(record, indent=2))
    print(json.dumps(record, indent=2))

def switch(kind):
    cmd = ['docker', 'compose', '-p', 'ohif-ai', '-f', str(project / 'docker-compose.yml'),
           '-f', str(project / 'deploy/vanilla/compose.vanilla.yml'), '-f', str(release / f'{kind}.yml')]
    subprocess.run(cmd + ['config', '--quiet'], check=True)
    subprocess.run(cmd + ['up', '-d', '--no-build', '--pull', 'never', '--no-deps', 'monai_sam2', 'ohif_viewer'], check=True)
    print('Active:', kind)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'activate', 'rollback'])
    action = parser.parse_args().action
    if action == 'prepare': prepare()
    else: switch('candidate' if action == 'activate' else 'previous')

