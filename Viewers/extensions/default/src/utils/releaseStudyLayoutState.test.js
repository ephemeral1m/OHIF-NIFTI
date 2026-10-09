import { useDisplaySetSelectorStore } from '../stores/useDisplaySetSelectorStore';
import { useViewportGridStore } from '../stores/useViewportGridStore';
import { useHangingProtocolStageIndexStore } from '../stores/useHangingProtocolStageIndexStore';
import { useToggleHangingProtocolStore } from '../stores/useToggleHangingProtocolStore';
import { releaseStudyLayoutState } from './releaseStudyLayoutState';

const stores = [
  [useDisplaySetSelectorStore, 'displaySetSelectorMap'],
  [useViewportGridStore, 'viewportGridState'],
  [useHangingProtocolStageIndexStore, 'hangingProtocolStageIndexMap'],
  [useToggleHangingProtocolStore, 'toggleHangingProtocol'],
];
afterEach(() => stores.forEach(([store, key]) => store.setState({ [key]: {} })));

test('clearing an active selector removes the key rather than leaving an invalid null UID', () => {
  const store = useDisplaySetSelectorStore;
  store.getState().setDisplaySetSelector('old:activeDisplaySet:0', 'old-set');
  store.getState().setDisplaySetSelector('new:activeDisplaySet:0', 'new-set');
  const before = store.getState().displaySetSelectorMap;
  store.getState().setDisplaySetSelector('old:activeDisplaySet:0', null);
  expect(store.getState().displaySetSelectorMap).toEqual({ 'new:activeDisplaySet:0': 'new-set' });
  expect(before['old:activeDisplaySet:0']).toBe('old-set');
});

test('releasing a case clears all of its layout references but keeps other studies', () => {
  for (const [store, key] of stores) {
    store.setState({ [key]: { 'old:study:default:0': 'removed-set', 'old:study:activeDisplaySet:0': null,
      'new:study:primaryAxial:0': 'new-set', 'old:study-other:default:0': 'other-set' } });
  }
  releaseStudyLayoutState('old:study');
  for (const [store, key] of stores) expect(store.getState()[key]).toEqual({
    'new:study:primaryAxial:0': 'new-set', 'old:study-other:default:0': 'other-set',
  });
  releaseStudyLayoutState('old:study'); // idempotent cleanup
  expect(useDisplaySetSelectorStore.getState().displaySetSelectorMap['new:study:primaryAxial:0']).toBe('new-set');
});
