import { createPresentationController, targetPresentation, targetStyle, scenePresentation } from './presentation';
import { groupPresentation } from './groups';

test('group master composes independent fill, outline, and inactive styles', () => {
  const target = targetPresentation({});
  const group = { opacity: 0.5 };
  expect(targetStyle(group, target)).toMatchObject({ fillAlpha: .225, outlineOpacity: .5, outlineWidth: 1 });
  target.opacity = .2; target.mode = 'outline'; target.outlineWidth = 4;
  expect(targetStyle(group, target, 0, .3)).toMatchObject({ renderFill: false, renderOutline: true, fillAlpha: .1, fillAlphaInactive: .03, outlineWidth: 4 });
  expect(targetStyle(group, target, 0, 0)).toMatchObject({ renderFillInactive: true, renderOutlineInactive: false, fillAlphaInactive: 0, outlineOpacityInactive: 0 });
  expect(targetStyle({ opacity: 0 }, target)).toMatchObject({ fillAlpha: 0, outlineOpacity: 0 });
  expect(targetStyle(group, targetPresentation({})).fillAlpha).toBe(.225);
});

test('pulse renders every viewport and rapid focus restores the previous target', () => {
  const group = { id: 'group', name: 'Test', kind: 'manual' };
  const a = { segmentationId: 'a', segmentationSet: group }, b = { segmentationId: 'b', segmentationSet: group };
  const source = { masks: new Map([['a', a], ['b', b]]) };
  const styles = new Map(), pending = new Map(); let sequence = 0;
  const frames = { request: cb => { pending.set(++sequence, cb); return sequence; }, cancel: id => pending.delete(id) };
  const tick = time => { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(cb => cb(time)); };
  const service = { getViewportIdsWithSegmentation: () => ['axial', 'coronal', 'sagittal'], setSegmentVisibility: jest.fn(),
    setStyle: (scope, style) => styles.set(`${scope.segmentationId}/${scope.viewportId}`, style) };
  const controller = createPresentationController(service, source, jest.fn(), frames);
  controller.apply(); controller.flash(a); tick(0); tick(425);
  expect(styles.get('a/coronal').fillAlpha).toBeCloseTo(.9);
  controller.flash(b);
  expect(styles.get('a/coronal').fillAlpha).toBe(.45);
  tick(500); tick(925);
  targetPresentation(b).opacity = .23;
  groupPresentation(source, group.id).opacity = .5;
  controller.apply();
  expect(styles.get('b/axial').fillAlpha).toBe(.115);
  expect(pending.size).toBe(0);
  controller.flash(b); tick(1000); tick(2000);
  expect(styles.get('b/sagittal').outlineWidth).toBe(1);
  expect(styles.get('b/sagittal').fillAlpha).toBe(.115);
  controller.flash(a); source.masks.delete('a'); controller.stop();
  expect(pending.size).toBe(0);
  expect(a.revision).toBeUndefined();
});


test('one context control updates every group without changing their selected styles', () => {
  const a = { segmentationId: 'a', segmentationSet: { id: 'g1' } };
  const b = { segmentationId: 'b', segmentationSet: { id: 'g2' } };
  const source = { masks: new Map([['a', a], ['b', b]]) };
  targetPresentation(a).opacity = .2;
  targetPresentation(b).opacity = .6;
  targetPresentation(b).mode = 'outline';
  groupPresentation(source, 'g2').opacity = .5;
  const styles = new Map();
  const service = { getViewportIdsWithSegmentation: () => ['axial'], setSegmentVisibility: jest.fn(),
    setStyle: (scope, style) => styles.set(scope.segmentationId, style) };
  const controller = createPresentationController(service, source, jest.fn());
  scenePresentation(source).otherOpacity = .25; controller.apply();
  expect(styles.get('a')).toMatchObject({ fillAlpha: .2, fillAlphaInactive: .05, outlineOpacity: 1, outlineOpacityInactive: .25 });
  expect(styles.get('b')).toMatchObject({ fillAlpha: .3, fillAlphaInactive: .075, outlineOpacity: .5, outlineOpacityInactive: .125 });
  scenePresentation(source).otherOpacity = 0; controller.apply();
  expect(styles.get('b')).toMatchObject({ renderFillInactive: true, renderOutlineInactive: false, fillAlphaInactive: 0 });
  expect(targetPresentation(a).opacity).toBe(.2);
  expect(targetPresentation(b).opacity).toBe(.6);
});
