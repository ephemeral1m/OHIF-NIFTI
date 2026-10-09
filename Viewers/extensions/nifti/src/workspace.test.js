jest.mock('./masks', () => ({ currentSource: jest.fn() }));
import { findingMasks, getWorkspace, locateFinding, selectFinding, setWorkspace, workspaceQuery } from './workspace';

test('workspace navigation preserves a selection only inside the same manifest case', () => {
  const manifest = { id: 'one', items: [] };
  setWorkspace(manifest, 'case-a'); selectFinding('finding-a');
  setWorkspace({ ...manifest, revision: 2 }, 'case-a');
  expect(getWorkspace().findingId).toBe('finding-a');
  setWorkspace(manifest, 'case-b');
  expect(getWorkspace().findingId).toBe('');
  expect(workspaceQuery()).toBe('&manifestId=one&caseId=case-b');
  setWorkspace(null, ''); expect(workspaceQuery()).toBe('');
});

test('finding location uses saved mask identity, not filenames, labels or array positions', () => {
  const a = { segmentationId: 'a', label: 'same', saved: { maskId: 'saved-a' } };
  const b = { segmentationId: 'b', label: 'same', saved: { maskId: 'saved-b' } };
  const source = { sourceKey: 'source-a', masks: new Map([['b', b], ['a', a]]) };
  const finding = { id: 'f', maskIds: ['saved-a'] };
  expect(findingMasks(source, finding)).toEqual([a]);
  const listener = jest.fn(); window.addEventListener('nifti:select-target', listener);
  locateFinding(source, finding);
  expect(listener.mock.calls[0][0].detail).toEqual({ sourceKey: 'source-a', segmentationId: 'a' });
  locateFinding({ sourceKey: 'source-b', masks: new Map([['b', b]]) }, finding);
  expect(listener).toHaveBeenCalledTimes(1);
  window.removeEventListener('nifti:select-target', listener);
});
