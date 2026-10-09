import { useDisplaySetSelectorStore } from '../stores/useDisplaySetSelectorStore';
import { useViewportGridStore } from '../stores/useViewportGridStore';
import { useHangingProtocolStageIndexStore } from '../stores/useHangingProtocolStageIndexStore';
import { useToggleHangingProtocolStore } from '../stores/useToggleHangingProtocolStore';

/** Forget only the study being released; other studies and the new view survive. */
export function releaseStudyLayoutState(studyUID: string) {
  if (!studyUID) return;
  const withoutStudy = <T,>(map: Record<string, T>): Record<string, T> => Object.fromEntries(
    Object.entries(map).filter(([key]) => !key.startsWith(`${studyUID}:`))
  );
  useDisplaySetSelectorStore.setState(state => ({ displaySetSelectorMap: withoutStudy(state.displaySetSelectorMap) }));
  useViewportGridStore.setState(state => ({ viewportGridState: withoutStudy(state.viewportGridState) }));
  useHangingProtocolStageIndexStore.setState(state => ({ hangingProtocolStageIndexMap: withoutStudy(state.hangingProtocolStageIndexMap) }));
  useToggleHangingProtocolStore.setState(state => ({ toggleHangingProtocol: withoutStudy(state.toggleHangingProtocol) }));
}
