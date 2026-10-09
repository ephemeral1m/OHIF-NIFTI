"""Prepare, activate or roll back a paired vanilla release. No data is deleted.

Run on vanilla: python3 deploy/nifti/release.py prepare|activate|rollback
Activation is separate so acceptance can be completed before production changes.
"""
import argparse
import json
import subprocess
from pathlib import Path

PRODUCTION = Path('/home/ubuntu/ohif-ai')
RELEASE = PRODUCTION / 'deploy/nifti-release-20260915'


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


def prepare():
    RELEASE.mkdir(parents=True, exist_ok=True)
    record = RELEASE / 'release.json'
    if record.exists():
        raise SystemExit('Release snapshot already exists; reuse it instead of replacing the rollback baseline.')
    snapshot = {}
    for service, container, candidate in [
        ('ohif_viewer', 'ohif_orthanc', 'ohif-ai-nifti-viewer:test'),
        ('monai_sam2', 'monai_sam2', 'ohif-ai-nifti-monai:test'),
    ]:
        previous = json.loads(docker('inspect', container))[0]['Image']
        tested = json.loads(docker('image', 'inspect', candidate))[0]['Id']
        snapshot[service] = {'previous': previous, 'candidate': tested}
        docker('tag', previous, f'ohif-ai-{service}:rollback-nifti-20260915')
        docker('tag', tested, f'ohif-ai-{service}:native-nifti-20260915')
    viewer = json.loads(docker('inspect', 'ohif_orthanc'))[0]
    original = next(m['Source'] for m in viewer['Mounts'] if m['Destination'] == '/etc/nginx/nginx.conf')
    nginx = Path(original).read_text()
    (RELEASE / 'nginx.previous.conf').write_text(nginx)
    location = '''    location /_nifti-files/ {
      internal;
      alias /var/nifti-images/;
    }

    location /monai/nifti-images {
      client_max_body_size 520M;
      proxy_pass http://monai_sam2:8002/nifti-images;
      proxy_http_version 1.1;
      proxy_request_buffering off;
      proxy_buffering off;
      proxy_read_timeout 1800s;
      proxy_send_timeout 1800s;
    }

'''
    marker = '    location /monai/ {'
    if nginx.count(marker) != 1 or 'location /monai/nifti-images' in nginx:
        raise SystemExit('Unexpected production Nginx layout; review before preparing release.')
    (RELEASE / 'nginx.conf').write_text(nginx.replace(marker, location + marker))
    for kind in ('candidate', 'previous'):
        # JSON is valid YAML and preserves exact paths without shell interpolation.
        override = {'services': {service: {'image': data[kind]} for service, data in snapshot.items()}}
        override['services']['ohif_viewer']['volumes'] = [
            f'{RELEASE / ("nginx.conf" if kind == "candidate" else "nginx.previous.conf")}:/etc/nginx/nginx.conf:ro']
        if kind == 'candidate':
            override['services']['ohif_viewer']['volumes'].append('nifti_images:/var/nifti-images:ro')
            override['services']['monai_sam2'].update(environment={
                'ENABLE_NIFTI_LIBRARY': 'true', 'ENABLE_NIFTI_EDITING': 'true', 'ENABLE_NIFTI_AI': 'true',
                'NIFTI_IMAGES_DIR': '/code/nifti_images', 'NIFTI_ACCEL_REDIRECT_PREFIX': '/_nifti-files',
                'MONAI_LABEL_DCMQI_DOWNLOAD': 'skip'},
                volumes=['nifti_images:/code/nifti_images'])
            override['volumes'] = {'nifti_images': {'name': 'ohif-ai-nifti-images'}}
        (RELEASE / (kind + '.yml')).write_text(json.dumps(override, indent=2))
    record.write_text(json.dumps(snapshot, indent=2))
    print('Prepared paired image/config snapshot:', RELEASE)


def switch(kind):
    if not (RELEASE / 'release.json').exists():
        raise SystemExit('Prepare a rollback snapshot first.')
    subprocess.run(['docker', 'compose', '--project-name', 'ohif-ai',
                    '-f', str(PRODUCTION / 'docker-compose.yml'),
                    '-f', str(PRODUCTION / 'deploy/vanilla/compose.vanilla.yml'),
                    '-f', str(RELEASE / (kind + '.yml')),
                    'up', '-d', '--no-build', '--pull', 'never', '--no-deps', 'monai_sam2', 'ohif_viewer'], check=True)
    print('Active configuration:', kind, '; NIfTI data volumes retained.')


def refresh_candidate():
    """Update tested candidate IDs while preserving the original rollback pair."""
    record = RELEASE / 'release.json'
    snapshot = json.loads(record.read_text())
    config = json.loads((RELEASE / 'candidate.yml').read_text())
    for service, image in [('ohif_viewer', 'ohif-ai-nifti-viewer:test'), ('monai_sam2', 'ohif-ai-nifti-monai:test')]:
        tested = json.loads(docker('image', 'inspect', image))[0]['Id']
        snapshot[service]['candidate'] = tested
        config['services'][service]['image'] = tested
        docker('tag', tested, f'ohif-ai-{service}:native-nifti-20260915')
    (RELEASE / 'candidate.yml').write_text(json.dumps(config, indent=2))
    record.write_text(json.dumps(snapshot, indent=2))
    print('Candidate IDs updated; original rollback images/configuration retained.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'refresh-candidate', 'activate', 'rollback'])
    action = parser.parse_args().action
    if action == 'prepare': prepare()
    elif action == 'refresh-candidate': refresh_candidate()
    else: switch('candidate' if action == 'activate' else 'previous')
