# MONAI Label + SAM2

### Overview

MonaiLabel: server: download & upload dcm to DicomStore, do data conversion (dicom->nifti->dicom) and inference using SAM2 

### Prerequisites

### Setup
- Written in `Dockerfile`
### Troubleshooting
- 
- 

To check whether it runs properly or not, access http://localhost:8002, and you'll see:

<img src="https://github.com/needinc/monai-label/blob/totalsegmentator/docs/images/total/monai_label_api.png?raw=true" alt="Monai Label API page" width="100%"/>

1. Click 'MONAI Totalsegmentator' button, that's it. You might need to comment out `self._assert_uid_format(series_instance_uid || study_instance_uid)`at `/home/cho/miniconda3/envs/monai-sam/lib/python3.10/site-packages/dicomweb_client/web.py` to avoid UID format checks