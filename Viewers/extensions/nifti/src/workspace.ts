import { useEffect, useState } from 'react';
import { currentSource } from './masks';

let workspace: any = { manifest: null, caseId: '', findingId: '' };
const listeners = new Set<() => void>();
export function getWorkspace() { return workspace; }
export function setWorkspace(manifest, caseId = workspace.caseId) {
  const same = workspace.manifest?.id === manifest?.id && caseId === workspace.caseId;
  workspace = { manifest, caseId, findingId: same ? workspace.findingId : '' };
  listeners.forEach(fn => fn());
}
export function selectFinding(id) { workspace = { ...workspace, findingId: id }; listeners.forEach(fn => fn()); }
export function workspaceQuery() {
  return workspace.manifest?.id && workspace.caseId ? `&manifestId=${encodeURIComponent(workspace.manifest.id)}&caseId=${encodeURIComponent(workspace.caseId)}` : '';
}
export function useWorkspace(servicesManager) {
  const [, update] = useState(0);
  useEffect(() => { const fn = () => update(n => n + 1); listeners.add(fn); const tick = setInterval(fn, 500); return () => { listeners.delete(fn); clearInterval(tick); }; }, []);
  let source; try { source = currentSource(servicesManager).source; } catch { /* Viewport starts asynchronously. */ }
  const row = workspace.manifest?.items.find(r => r.caseId === workspace.caseId && r.sourceId === source?.descriptor.sourceId);
  return { ...workspace, source, row };
}
export function findingMasks(source, finding) {
  return source ? [...source.masks.values()].filter((m: any) => finding.maskIds?.includes(m.saved?.maskId)) : [];
}
export function locateFinding(source, finding, mask?) {
  selectFinding(finding.id);
  const target = mask || findingMasks(source, finding)[0];
  if (target) window.dispatchEvent(new CustomEvent('nifti:select-target', { detail: { sourceKey: source.sourceKey, segmentationId: target.segmentationId } }));
}
