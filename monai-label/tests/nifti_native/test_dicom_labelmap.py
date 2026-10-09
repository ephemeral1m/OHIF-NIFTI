import numpy as np
import pytest
from fastapi import HTTPException
from monailabel.utils.others.dicom_labelmap import order_labelmap_by_sop
from monailabel.utils.others.dicom_labelmap import dicom_description


def test_manual_mask_descending_stack_keeps_source_sop():
    mask = np.array([[[1, 0]], [[0, 0]], [[0, 0]]], dtype=np.uint8)
    result = order_labelmap_by_sop(mask, ['3', '2', '1'], ['1', '2', '3'])
    assert result[2, 0, 0] == 1
    assert not result[:2].any()


@pytest.mark.parametrize('references', [['1', '1', '3'], ['1', '2', 'other'], ['1', '2'], '123'])
def test_wrong_or_duplicate_source_sops_rejected(references):
    with pytest.raises(HTTPException) as error:
        order_labelmap_by_sop(np.zeros((3, 2, 2)), references, ['1', '2', '3'])
    assert error.value.status_code == 422


def test_legacy_client_order_preserved():
    mask = np.zeros((3, 2, 2))
    assert order_labelmap_by_sop(mask, None, ['1', '2', '3']) is mask


def test_reloaded_draft_prompt_metadata_is_valid_dicom_text():
    import json
    prompts = {'pos_points': [[1, 2, 3]], 'label': '测试'}
    assert json.loads(dicom_description(prompts)) == prompts
    assert dicom_description(None) == ''
    assert dicom_description('manual brush') == 'manual brush'
    assert len(dicom_description('x' * 2000)) == 1024
