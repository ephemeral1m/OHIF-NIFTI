import { releaseBrushPreview } from './releaseBrushPreview.mjs';

test('native case closure releases the shared brush result and its retained viewport', () => {
  const preview = { preview: { segmentationId: 'nifti-a:mask:b', imageVoxelManager: {} }, element: {}, timer: null, isDrag: true };
  releaseBrushPreview(preview, 'nifti-a');
  expect(preview.preview).toBeNull(); expect(preview.element).toBeNull(); expect(preview.isDrag).toBe(false);
});

test('releasing a native source does not discard a different case or DICOM preview', () => {
  for (const segmentationId of ['nifti-b:mask:c', 'dicom-segmentation']) {
    const value = { segmentationId }; const preview = { preview: value };
    releaseBrushPreview(preview, 'nifti-a'); expect(preview.preview).toBe(value);
  }
});
