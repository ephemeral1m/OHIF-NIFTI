"""Isolated acceptance and paired release; retains original data and rollback config."""
import argparse
import copy
import json
import os
from pathlib import Path
import subprocess

project = Path('/home/ubuntu/ohif-ai')
release = project / 'deploy/nifti-streaming-release-20261008'
images = {'ohif_viewer': 'ohif-ai-nifti-viewer:streaming-20261008',
          'monai_sam2': 'ohif-ai-nifti-monai:streaming-20261008'}


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True)


def save(path, value):
    path.write_text(json.dumps(value, indent=2))
    os.chmod(path, 0o600)


def resolved_image(image):
    # With the containerd image store an image tag may identify an OCI index,
    # while Container.Image identifies its selected platform manifest.
    probe = docker('create', '--entrypoint', '/bin/true', image).strip()
    try:
        return json.loads(docker('inspect', probe))[0]['Image']
    finally:
        subprocess.run(['docker', 'rm', '-v', probe], check=True, stdout=subprocess.DEVNULL)


def test():
    batch = '/home/ubuntu/ohif-ai/nifti-demo/hospital-10-20261008'
    override = {'services': {s: {'image': resolved_image(image)} for s, image in images.items()}}
    override['services']['monai_sam2'].update(environment={
        'NIFTI_IMPORT_ROOTS': json.dumps(['/data/cache/datasets/CT-RATE', '/nifti-acceptance-data', batch])},
        volumes=[batch + ':' + batch + ':ro'])
    config = project / 'deploy/nifti/streaming-test.override.yml'
    save(config, override)
    subprocess.run(['docker', 'compose', '-f', str(project / 'deploy/nifti/compose.test.yml'),
                    '-f', str(config), 'up', '-d', '--no-build', '--pull', 'never',
                    '--no-deps', 'monai_sam2', 'ohif_viewer'], check=True)


def prepare():
    record = release / 'release.json'
    if record.exists():
        raise SystemExit('Release snapshot exists; retain the original rollback pair.')
    viewer = json.loads(docker('inspect', 'ohif_orthanc'))[0]
    files = viewer['Config']['Labels']['com.docker.compose.project.config_files'].split(',')
    args = ['compose', '-p', 'ohif-ai']
    for file in files:
        args += ['-f', file]
    previous = json.loads(docker(*args, 'config', '--format', 'json'))
    snapshot = {}
    for service, container in [('ohif_viewer', 'ohif_orthanc'), ('monai_sam2', 'monai_sam2')]:
        before = json.loads(docker('inspect', container))[0]['Image']
        after = resolved_image(images[service])
        previous['services'][service]['image'] = before
        snapshot[service] = {'previous': before, 'candidate': after}
        subprocess.run(['docker', 'tag', before, f'ohif-ai-{service}:pre-streaming-20261008'], check=True)
    save(release / 'previous.yml', previous)
    candidate = copy.deepcopy(previous)
    for service in images:
        candidate['services'][service]['image'] = snapshot[service]['candidate']
    nginx = next(m['Source'] for m in viewer['Mounts'] if m['Destination'] == '/etc/nginx/nginx.conf')
    content = Path(nginx).read_text()
    (release / 'nginx.previous.conf').write_text(content)
    anchor = '    location /_nifti-files/'
    if anchor not in content:
        raise RuntimeError('Inspect the production NIfTI file location before releasing.')
    content = content.replace(anchor, '''    location /_nifti-stream-cache/ {
      internal;
      alias /var/nifti-stream-cache/;
      etag off;
      add_header ETag $upstream_http_etag;
      add_header X-Nifti-Cache-Key $upstream_http_x_nifti_cache_key;
      add_header X-Nifti-Frame $upstream_http_x_nifti_frame;
    }
''' + anchor, 1)
    content = content.replace('    location / {', '''    location ~ "\\.[a-f0-9]{16,}\\.(js|css|wasm|woff2?)$" {
      root /var/www/html;
      try_files $uri =404;
      add_header Cache-Control "private, max-age=31536000, immutable";
    }
    location / {''', 1)
    (release / 'nginx.conf').write_text(content)
    volumes = candidate['services']['ohif_viewer']['volumes']
    for volume in volumes:
        if volume['target'] == '/etc/nginx/nginx.conf':
            volume['source'] = str(release / 'nginx.conf')
    volumes.append({'type': 'volume', 'source': 'nifti_stream_cache', 'target': '/var/nifti-stream-cache', 'read_only': True})
    backend = candidate['services']['monai_sam2']
    backend['environment'].update(ENABLE_NIFTI_STREAMING='true', NIFTI_STREAM_CACHE_DIR='/code/nifti_stream_cache',
                                  NIFTI_STREAM_CACHE_MAX_BYTES=str(10 * 1024 ** 3),
                                  NIFTI_STREAM_ACCEL_REDIRECT_PREFIX='/_nifti-stream-cache')
    backend['volumes'].append({'type': 'volume', 'source': 'nifti_stream_cache', 'target': '/code/nifti_stream_cache'})
    candidate.setdefault('volumes', {})['nifti_stream_cache'] = {'name': 'ohif-ai-nifti-stream-cache'}
    save(release / 'candidate.yml', candidate)
    save(record, snapshot)
    print('Paired image/configuration rollback snapshot prepared.')


def switch(kind):
    snapshot = json.loads((release / 'release.json').read_text())
    for service, container in [('ohif_viewer', 'ohif_orthanc'), ('monai_sam2', 'monai_sam2')]:
        active = json.loads(docker('inspect', container))[0]['Image']
        if active not in snapshot[service].values():
            raise RuntimeError('Another release changed the active container; inspect before switching.')
    command = ['docker', 'compose', '-p', 'ohif-ai', '-f', str(release / (kind + '.yml'))]
    subprocess.run(command + ['config', '--quiet'], check=True)
    subprocess.run(command + ['up', '-d', '--no-build', '--pull', 'never', '--no-deps', 'monai_sam2', 'ohif_viewer'], check=True)
    print('Active:', kind, '; originals, masks and cache volumes retained.')


if __name__ == '__main__':
    action = argparse.ArgumentParser()
    action.add_argument('action', choices=['test', 'prepare', 'activate', 'rollback'])
    selected = action.parse_args().action
    release.mkdir(exist_ok=True)
    if selected == 'test': test()
    elif selected == 'prepare': prepare()
    else: switch('candidate' if selected == 'activate' else 'previous')
