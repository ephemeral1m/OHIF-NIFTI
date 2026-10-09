"""Source geometry resolution shared by draft saving and nnInteractive restore."""
import logging
import os

from fastapi import HTTPException

logger = logging.getLogger(__name__)


def read_source_dicom(datastore, series_uid, study_uid=""):
    # Local imports avoid discovering/loading application models on module import.
    import SimpleITK as sitk
    from monailabel.datastore.dicom import DICOMWebDatastore

    try:
        if isinstance(datastore, DICOMWebDatastore):
            # An empty study means resolve it by series UID, not reuse another request's study.
            datastore.get_image_uri(series_uid, study_instance_uid=study_uid)
            image_dir = os.path.realpath(os.path.join(datastore._datastore.image_path(), series_uid))
        else:
            image_dir = datastore.get_image_uri(series_uid)
        reader = sitk.ImageSeriesReader()
        dicom_files = reader.GetGDCMSeriesFileNames(str(image_dir))
        if not dicom_files:
            raise ValueError("No source DICOM instances available")
        reader.SetFileNames(dicom_files)
        return reader.Execute()
    except Exception as exc:
        logger.exception("Could not retrieve source DICOM geometry for series %s", series_uid)
        raise HTTPException(status_code=502, detail={
            "code": "SOURCE_DICOM_UNAVAILABLE",
            "message": "无法获取原始 DICOM，请检查 Orthanc 后重试；现有 mask 和草稿未被替换。",
        }) from exc
