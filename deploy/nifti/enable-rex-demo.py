"""Add only the derived ReX demo directory as a read-only manifest root."""
import json
import shutil
import subprocess
from pathlib import Path

project = Path('/home/ubuntu/ohif-ai')
release = project / 'deploy/nifti-ui-release-20260916'
candidate = release / 'candidate.yml'
demo = str(project / 'nifti-demo/rex-grounding-ct')
assert (Path(demo) / 'provenance.json').is_file(), 'Generate validated demo masks first'
backup = release / 'candidate.before-rex-demo.yml'
if not backup.exists(): shutil.copy2(candidate, backup)
config = json.loads(candidate.read_text())
backend = config['services']['monai_sam2']
roots = json.loads(backend['environment']['NIFTI_IMPORT_ROOTS'])
if demo not in roots: roots.append(demo)
backend['environment']['NIFTI_IMPORT_ROOTS'] = json.dumps(roots)
mount = f'{demo}:{demo}:ro'
if mount not in backend['volumes']: backend['volumes'].append(mount)
candidate.write_text(json.dumps(config, indent=2))
command = ['docker', 'compose', '-p', 'ohif-ai', '-f', str(project / 'docker-compose.yml'),
           '-f', str(project / 'deploy/vanilla/compose.vanilla.yml'), '-f', str(candidate)]
subprocess.run(command + ['config', '--quiet'], check=True)
subprocess.run(command + ['up', '-d', '--no-build', '--pull', 'never', '--no-deps', 'monai_sam2'], check=True)
print('Read-only demo root enabled:', demo)
