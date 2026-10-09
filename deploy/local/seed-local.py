"""Seed and verify only the isolated local development deployment."""
import gzip
import hashlib
import io
import json
import time

import nibabel as nib
import numpy as np
import pydicom
import requests
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian

base = 'http://gateway:1026'
report = {'passed': False, 'sources': [], 'checks': []}

def checked(response):
    response.raise_for_status()
    return response

for modality, name in [('CT', 'ct-demo'), ('MR', 'mr-demo')]:
    reply = checked(requests.post(base + '/monai/nifti-images/manifest/open', json={
        'image': f'/local-input/{name}.nii.gz',
        'segmentations': [f'/local-input/{name}-labels.nii.gz'],
        'modality': modality,
    }, timeout=60)).json()
    assert not reply['errors'], reply['errors']
    source = reply['descriptor']
    source_id = source['sourceId']
    checked(requests.post(base + f'/monai/nifti-images/{source_id}/stream/prepare', timeout=30))
    for _ in range(60):
        state = checked(requests.get(base + f'/monai/nifti-images/{source_id}/stream', timeout=30)).json()
        if state['state'] == 'ready':
            break
        assert state['state'] != 'failed', state
        time.sleep(.5)
    else:
        raise TimeoutError('Local stream preparation did not finish')
    transport = state['descriptor']
    image = nib.load(f'/local-input/{name}.nii.gz')
    index = image.shape[2] // 2
    frame = checked(requests.get(base + f'/monai/nifti-images/{source_id}/frames/{index}', timeout=30))
    raw = gzip.decompress(frame.content)
    values = np.frombuffer(raw, dtype=transport['wireDtype'])
    expected = image.get_fdata(dtype=np.float32)[:, :, index].ravel(order='F')
    np.testing.assert_array_equal(values.astype(np.float32), expected)
    masks = checked(requests.get(base + f'/monai/nifti-images/{source_id}/masks', timeout=30)).json()
    report['sources'].append({'name': source['name'], 'sourceId': source_id,
        'modality': modality, 'geometryHash': source['geometryHash'], 'maskIds': reply['maskIds'],
        'frame': index, 'wireDtype': transport['wireDtype'],
        'frameBytes': len(frame.content), 'decodedHash': hashlib.sha256(raw).hexdigest()})
    report['checks'].append(f'{modality} upload, mask import, stream preparation, gateway frame delivery and exact pixels')

study = '2.25.213877914585182327097870235069063027100'
series = '2.25.213877914585182327097870235069063027101'
rows, columns, slices = 64, 64, 24
yy, xx = np.mgrid[:rows, :columns]
for index in range(slices):
    sop = f'2.25.{213877914585182327097870235069063028000 + index}'
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage
    meta.MediaStorageSOPInstanceUID = sop
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    dataset = FileDataset(None, {}, file_meta=meta, preamble=b'\0' * 128)
    dataset.is_little_endian, dataset.is_implicit_VR = True, False
    dataset.SOPClassUID, dataset.SOPInstanceUID = CTImageStorage, sop
    dataset.StudyInstanceUID, dataset.SeriesInstanceUID = study, series
    dataset.FrameOfReferenceUID = '2.25.213877914585182327097870235069063027102'
    dataset.PatientName, dataset.PatientID = 'SYNTHETIC^LOCAL', 'OHIF_LOCAL_PHANTOM'
    dataset.PatientIdentityRemoved = 'YES'
    dataset.Modality, dataset.StudyDescription = 'CT', 'Local synthetic CT'
    dataset.SeriesDescription = 'Development phantom'
    dataset.StudyDate, dataset.StudyTime = '20261009', '120000'
    dataset.SeriesNumber, dataset.InstanceNumber = 1, index + 1
    dataset.ImageType = ['ORIGINAL', 'PRIMARY', 'AXIAL']
    dataset.Rows, dataset.Columns = rows, columns
    dataset.PixelSpacing, dataset.SliceThickness = [1.2, 1.2], 2.0
    dataset.ImageOrientationPatient = [1, 0, 0, 0, 1, 0]
    dataset.ImagePositionPatient = [0, 0, index * 2.0]
    dataset.SamplesPerPixel, dataset.PhotometricInterpretation = 1, 'MONOCHROME2'
    dataset.BitsAllocated, dataset.BitsStored, dataset.HighBit, dataset.PixelRepresentation = 16, 16, 15, 1
    dataset.RescaleSlope, dataset.RescaleIntercept = 1, 0
    dataset.WindowCenter, dataset.WindowWidth = 0, 1200
    pixels = np.full((rows, columns), -1000, dtype='<i2')
    pixels[((xx-32)**2 + (yy-32)**2) < 24**2] = 40
    pixels[((xx-25)**2 + (yy-32)**2) < 8**2] = -750
    pixels[((xx-40)**2 + (yy-32)**2) < 8**2] = -750
    pixels[((xx-33)**2 + (yy-46)**2) < (3 + index % 3)**2] = 650
    dataset.PixelData = pixels.tobytes()
    buffer = io.BytesIO()
    dataset.save_as(buffer, write_like_original=False)
    checked(requests.post(base + '/pacs/instances', data=buffer.getvalue(),
        headers={'Content-Type': 'application/dicom'}, timeout=30))
studies = checked(requests.get(base + '/pacs/dicom-web/studies', timeout=30)).json()
assert any(entry.get('0020000D', {}).get('Value', [None])[0] == study for entry in studies)
report['studyInstanceUID'] = study
report['checks'].append('24-slice synthetic CT stored and listed through DICOMweb')
report['health'] = checked(requests.get(base + '/monai/health', timeout=30)).json()
report['passed'] = True
print(json.dumps(report, indent=2))
