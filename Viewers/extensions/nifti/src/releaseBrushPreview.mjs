/** Cornerstone 3.33.5 keeps this shared preview after ToolGroup destruction. */
export function releaseBrushPreview(preview, sourceKey) {
  if (!preview?.preview?.segmentationId?.startsWith(sourceKey + ':')) return;
  clearTimeout(preview.timer);
  preview.preview = null; preview.element = null; preview.timer = null;
  preview.isDrag = false; preview.timerStart = 0; preview.startPoint = [NaN, NaN];
}
