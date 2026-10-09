"""Release grouped NIfTI targets with a pinned, paired rollback."""
import argparse
import json
import subprocess
from pathlib import Path

project = Path('/home/ubuntu/ohif-ai')
release = project / 'deploy/nifti-groups-release-20260917'


def inspect(kind, name):
    return json.loads(subprocess.check_output(['docker', kind, 'inspect', name], text=True))[0]


def prepare():
    if (release / 'release.json').exists():
        raise SystemExit('Snapshot exists; do not overwrite rollback metadata.')
    release.mkdir(parents=True, exist_ok=True)
    # SQLite backup includes WAL state without stopping the service. No voxel files change.
    backup_code = "import sqlite3; from pathlib import Path; p=Path('/code/nifti_images'); b=p/'.release-backups'; b.mkdir(exist_ok=True); src=sqlite3.connect(p/'index.sqlite3'); dst=sqlite3.connect(b/'pre-groups-20260917.sqlite3'); src.backup(dst); dst.close(); src.close()"
    subprocess.run(['docker', 'exec', 'monai_sam2', 'python', '-c', backup_code], check=True)
    config = json.loads((project / 'deploy/nifti-annotation-history-release-20260917/candidate.yml').read_text())
    record = {}
    for service, container in [('ohif_viewer', 'ohif_orthanc'), ('monai_sam2', 'monai_sam2')]:
        previous = inspect('container', container)['Image']
        inspect('image', previous)  # Fail before touching production if rollback is unavailable.
        subprocess.run(['docker', 'tag', previous, f'ohif-ai-{service}:pre-groups-20260917'], check=True)
        config['services'][service]['image'] = previous
        record[service] = {'previous': previous}
    (release / 'previous.yml').write_text(json.dumps(config, indent=2))
    for service, tag in [('ohif_viewer', 'ohif-ai-nifti-viewer:test'), ('monai_sam2', 'ohif-ai-nifti-monai:test')]:
        candidate = inspect('image', tag)['Id']
        subprocess.run(['docker', 'tag', candidate, f'ohif-ai-{service}:groups-20260917'], check=True)
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
