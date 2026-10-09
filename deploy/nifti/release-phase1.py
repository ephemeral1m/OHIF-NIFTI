"""Release the first usability revision while retaining the current native pair and ReX mounts."""
import argparse
import json
import subprocess
from pathlib import Path

project = Path('/home/ubuntu/ohif-ai')
release = project / 'deploy/nifti-phase1-release-20260916'

def inspect(kind, name):
    return json.loads(subprocess.check_output(['docker', kind, 'inspect', name], text=True))[0]

def prepare():
    if (release / 'release.json').exists(): raise SystemExit('Snapshot already exists; previous is immutable.')
    release.mkdir(parents=True, exist_ok=True)
    config = json.loads((project / 'deploy/nifti-ui-release-20260916/candidate.yml').read_text())
    record = {}
    for service, container in [('ohif_viewer', 'ohif_orthanc'), ('monai_sam2', 'monai_sam2')]:
        image = inspect('container', container)['Image']
        config['services'][service]['image'] = image
        record[service] = {'previous': image}
        subprocess.run(['docker', 'tag', image, f'ohif-ai-{service}:pre-phase1-20260916'], check=True)
    (release / 'previous.yml').write_text(json.dumps(config, indent=2))
    for service, tag in [('ohif_viewer','ohif-ai-nifti-viewer:test'), ('monai_sam2','ohif-ai-nifti-monai:test')]:
        image = inspect('image', tag)['Id']; config['services'][service]['image'] = image
        record[service]['candidate'] = image
        subprocess.run(['docker', 'tag', image, f'ohif-ai-{service}:phase1-20260916'], check=True)
    (release / 'candidate.yml').write_text(json.dumps(config, indent=2))
    (release / 'release.json').write_text(json.dumps(record, indent=2))
    print(json.dumps(record, indent=2))

def switch(kind):
    cmd=['docker','compose','-p','ohif-ai','-f',str(project/'docker-compose.yml'),'-f',str(project/'deploy/vanilla/compose.vanilla.yml'),'-f',str(release/f'{kind}.yml')]
    subprocess.run(cmd+['config','--quiet'],check=True)
    subprocess.run(cmd+['up','-d','--no-build','--pull','never','--no-deps','monai_sam2','ohif_viewer'],check=True)
    print('Active:',kind)

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('action',choices=['prepare','activate','rollback']); action=parser.parse_args().action
    if action=='prepare': prepare()
    else: switch('candidate' if action=='activate' else 'previous')
