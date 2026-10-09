"""Align uploaded DICOM labelmap frames to the authoritative source SOP order."""
import json
from fastapi import HTTPException


def dicom_description(value):
    # Rehydrated drafts retain structured prompt metadata. DICOM ST requires text.
    if value is None:
        return ''
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True)
    return text[:1024]


def order_labelmap_by_sop(prediction, submitted, authoritative):
    if submitted is None:
        return prediction  # Legacy clients already submit geometry order.
    if (not isinstance(submitted, list) or len(submitted) != prediction.shape[0]
            or any(not isinstance(uid, str) for uid in submitted)
            or len(set(submitted)) != len(submitted)
            or len(set(authoritative)) != len(authoritative)
            or set(submitted) != set(authoritative)):
        raise HTTPException(422, 'Labelmap SOP references do not exactly match the source series.')
    positions = {uid: index for index, uid in enumerate(submitted)}
    return prediction[[positions[uid] for uid in authoritative]]
