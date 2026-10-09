"""Create acceptance-only 3D images; never modifies input data.

Usage: derive-demo.py dicom INPUT_DIRECTORY OUTPUT.nii.gz
       derive-demo.py mr INPUT_4D_NIFTI OUTPUT.nii.gz
The MR input is explicitly reduced to frame zero; this does not enable 4D loading.
"""
import json
import sys
from pathlib import Path
import SimpleITK as sitk

kind, input_name, output_name = sys.argv[1:]
source, output = Path(input_name), Path(output_name)
if output.exists():
    raise SystemExit('Refusing to overwrite an existing acceptance image.')
output.parent.mkdir(parents=True, exist_ok=True)
if kind == 'dicom':
    series = sitk.ImageSeriesReader.GetGDCMSeriesIDs(str(source))
    if len(series or []) != 1:
        raise SystemExit('Select a directory containing exactly one DICOM series.')
    reader = sitk.ImageSeriesReader()
    reader.SetFileNames(sitk.ImageSeriesReader.GetGDCMSeriesFileNames(str(source), series[0]))
    image = reader.Execute()
    transform = 'SimpleITK DICOM series reader; original spatial grid and rescaled intensities'
elif kind == 'mr':
    image = sitk.ReadImage(str(source))
    if image.GetDimension() != 4:
        raise SystemExit('Expected the documented four-dimensional NiBabel MR fixture.')
    image = image[:, :, :, 0]
    transform = 'Extract temporal frame zero, retaining the spatial affine'
else:
    raise SystemExit('Choose dicom or mr.')
sitk.WriteImage(image, str(output))
output.with_suffix(output.suffix + '.provenance.json').write_text(json.dumps({
    'purpose': 'isolated acceptance only', 'source': str(source), 'conversion': transform,
    'size': image.GetSize(), 'spacing': image.GetSpacing(), 'origin': image.GetOrigin(),
    'direction': image.GetDirection(), 'synthetic': False,
}, indent=2))
print(json.dumps({'output': str(output), 'dimensions': image.GetSize()}))
