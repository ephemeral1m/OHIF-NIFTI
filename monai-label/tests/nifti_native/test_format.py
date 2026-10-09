import gzip
import itertools
import json
import struct
import subprocess
from pathlib import Path
import nibabel as nib
import numpy as np
import pytest
from monailabel.utils.others.nifti_source import read_nifti, NiftiError, align_mask, write_mask


def phantom(path, dtype=np.int16, slope=1, intercept=0, endian='<', units='mm', qform=False):
    data = np.arange(7 * 9 * 11).reshape((7, 9, 11)).astype(dtype)
    c, s = np.cos(.42), np.sin(.42)
    affine = np.array([[c, 0, s * 5, 23], [0, 2, 0, -19], [-s, 0, c * 5, 42], [0, 0, 0, 1.]])
    image = nib.Nifti1Image(data, affine)
    image.set_sform(affine, 0 if qform else 1)
    image.set_qform(affine, 1)
    image.header.set_xyzt_units(units)
    image.header.set_slope_inter(slope, intercept)
    image = nib.Nifti1Image(data, None, header=image.header.as_byteswapped(endian))
    image.header.set_slope_inter(slope, intercept)
    nib.save(image, path)
    return data, nib.load(path)


@pytest.mark.parametrize('dtype', [np.uint8, np.int8, np.uint16, np.int16, np.float32])
@pytest.mark.parametrize('slope,intercept', [(1, 0), (1, -1024), (2, 0), (2, -1024)])
@pytest.mark.parametrize('endian', ['<', '>'])
def test_pixels_match_nibabel(tmp_path, dtype, slope, intercept, endian):
    path = tmp_path / 'test.nii'
    phantom(path, dtype, slope, intercept, endian)
    meta, data = read_nifti(path)
    expected = nib.load(path).get_fdata().transpose(2, 1, 0).astype(data.dtype)
    np.testing.assert_array_equal(data, expected)
    assert meta['dimensions'] == [7, 9, 11]


@pytest.mark.parametrize('qform', [False, True])
@pytest.mark.parametrize('unit,factor', [('mm', 1), ('meter', 1000), ('micron', .001)])
def test_oblique_geometry_matches_nibabel(tmp_path, qform, unit, factor):
    path = tmp_path / 'test.nii'
    _, image = phantom(path, units=unit, qform=qform)
    meta, _ = read_nifti(path)
    expected = np.diag([-factor, -factor, factor, 1]) @ image.affine
    for point in itertools.product([0, 6], [0, 8], [0, 10]):
        np.testing.assert_allclose(np.array(meta['voxelToLPS']) @ [*point, 1], expected @ [*point, 1], rtol=0, atol=1e-3)


def test_gzip_magic_and_canonical_identity(tmp_path):
    plain, zipped = tmp_path / 'test.nii', tmp_path / 'no-extension'
    phantom(plain)
    zipped.write_bytes(gzip.compress(plain.read_bytes()))
    m1, a = read_nifti(plain)
    m2, b = read_nifti(zipped)
    assert m1['contentHash'] == m2['contentHash']
    np.testing.assert_array_equal(a, b)


@pytest.mark.parametrize('damage,code', [('4d', 'NIFTI_DIMENSIONS'), ('shear', 'NIFTI_AFFINE'), ('singular', 'NIFTI_AFFINE'), ('truncated', 'NIFTI_LENGTH'), ('trailing', 'NIFTI_LENGTH'), ('large', 'NIFTI_TOO_LARGE'), ('magic', 'NIFTI_FORMAT'), ('scaling', 'NIFTI_SCALING')])
def test_invalid_inputs(tmp_path, damage, code):
    path = tmp_path / 'test.nii'
    phantom(path)
    raw = bytearray(path.read_bytes())
    if damage == '4d': struct.pack_into('<h', raw, 40, 4)
    elif damage == 'shear': struct.pack_into('<f', raw, 284, 1)
    elif damage == 'singular': raw[280:292] = bytes(12)
    elif damage == 'truncated': raw = raw[:-1]
    elif damage == 'trailing': raw += b'x'
    elif damage == 'large': struct.pack_into('<3h', raw, 42, 1000, 1000, 1000)
    elif damage == 'magic': raw[344] = 0
    elif damage == 'scaling': struct.pack_into('<f', raw, 112, float('inf'))
    path.write_bytes(raw)
    with pytest.raises(NiftiError) as exc: read_nifti(path)
    assert exc.value.code == code


def test_lossless_mask_permute_flip_and_export(tmp_path):
    src = tmp_path / 'source.nii'
    phantom(src)
    meta, data = read_nifti(src)
    mask = (data % 13 == 0).astype(np.uint8)
    original = tmp_path / 'mask.nii.gz'
    write_mask(original, mask, meta)
    loaded = nib.load(original)
    changed = loaded.as_reoriented(np.array([[2, -1], [0, 1], [1, -1]]))
    path = tmp_path / 'permuted.nii.gz'
    nib.save(changed, path)
    mm, pixels = read_nifti(path, mask=True)
    result, mapping = align_mask(pixels, mm, meta)
    np.testing.assert_array_equal(result, mask)
    assert mapping != np.eye(4).tolist()
    mm['voxelToLPS'][0][3] += 1
    with pytest.raises(NiftiError): align_mask(pixels, mm, meta)


def test_frontend_parser_same_pixels_and_geometry(tmp_path):
    path = tmp_path / 'test.nii'
    phantom(path, slope=2, intercept=-1024, endian='>')
    meta, data = read_nifti(path)
    module = Path(__file__).resolve().parents[3] / 'Viewers/extensions/nifti/src/format.mjs'
    script = """
      import fs from 'node:fs';
      const {parseNifti, geometryKey, sha256, contentHash} = await import(process.argv[1]);
      const b = fs.readFileSync(process.argv[2]);
      const p = parseNifti(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
      const hash = await sha256(new TextEncoder().encode(geometryKey(p.dimensions,p.voxelToLPS)));
      console.log(JSON.stringify({pixels:Array.from(p.scalarData), hash, content:await contentHash(p.scalarData, hash)}));
    """
    actual = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script, module.as_uri(), str(path)], text=True))
    assert actual['hash'] == meta['geometryHash']
    assert actual['content'] == meta['contentHash']
    np.testing.assert_array_equal(actual['pixels'], data.flatten())
