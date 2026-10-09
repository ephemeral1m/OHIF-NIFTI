import { groupedMasks, groupPresentation } from './groups';

// View-only state: never part of voxel revisions or server mask provenance.
export function targetPresentation(mask) {
  return mask.presentation ||= {
    mode: 'both', opacity: 0.45, outlineOpacity: 1, outlineWidth: 1,
    expanded: false,
  };
}

export function scenePresentation(source) {
  return source.scenePresentation ||= { otherOpacity: 1, expanded: false };
}

export function targetStyle(group, target, pulse = 0, otherOpacity = 1) {
  const fill = target.mode !== 'outline', outline = target.mode !== 'fill';
  const alpha = group.opacity * target.opacity;
  const edge = group.opacity * target.outlineOpacity;
  const width = target.outlineWidth;
  return {
    // The renderer uses a small nonzero fill for outline-only mode. At zero
    // context opacity use an explicit zero fill, so even outline-only targets vanish.
    renderFill: fill, renderFillInactive: fill || otherOpacity === 0,
    renderOutline: outline, renderOutlineInactive: outline && otherOpacity > 0,
    fillAlpha: alpha + (Math.max(alpha, 0.9) - alpha) * pulse,
    fillAlphaInactive: alpha * otherOpacity,
    outlineOpacity: edge + (1 - edge) * pulse,
    outlineOpacityInactive: edge * otherOpacity,
    outlineWidth: width + 3 * pulse, outlineWidthInactive: width,
    activeSegmentOutlineWidthDelta: 0,
  };
}

// One cancellable animation per mounted panel. Restore from current view state,
// not a captured style, so rapid selection and control changes cannot leave residue.
export function createPresentationController(service, source, onError, frames = {
  request: callback => requestAnimationFrame(callback), cancel: id => cancelAnimationFrame(id),
}) {
  let frame, flashing;
  const paint = (group, mask, pulse = 0) => {
    if (!source.masks.has(mask.segmentationId)) return;
    const state = groupPresentation(source, group.id);
    for (const viewportId of service.getViewportIdsWithSegmentation(mask.segmentationId)) {
      const type = 'Labelmap';
      service.setSegmentVisibility(viewportId, mask.segmentationId, 1, state.visible && mask.visible !== false, type);
      // Use the same viewport scope as normal appearance, and schedule a render.
      service.setStyle({ viewportId, segmentationId: mask.segmentationId, type },
        targetStyle(state, targetPresentation(mask), pulse, scenePresentation(source).otherOpacity));
    }
  };
  const stop = () => {
    if (frame !== undefined) frames.cancel(frame);
    frame = undefined;
    const previous = flashing;
    flashing = undefined;
    if (previous) paint(previous.group, previous.mask);
  };
  return {
    stop,
    apply() { stop(); groupedMasks(source).forEach(group => group.masks.forEach(mask => paint(group, mask))); },
    flash(mask) {
      stop();
      const group = groupedMasks(source).find(g => g.masks.includes(mask));
      if (!group) return;
      flashing = { group, mask };
      let start;
      const animate = timestamp => {
        try {
          start ??= timestamp;
          const progress = Math.min((timestamp - start) / 850, 1);
          if (progress >= 1 || !source.masks.has(mask.segmentationId)) { stop(); return; }
          paint(group, mask, Math.sin(Math.PI * progress) ** 2);
          frame = frames.request(animate);
        } catch (error) { stop(); onError(error.message); }
      };
      frame = frames.request(animate);
    },
  };
}
