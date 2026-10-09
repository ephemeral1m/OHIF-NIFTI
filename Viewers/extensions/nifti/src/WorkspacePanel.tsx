import React, { useEffect, useState } from 'react';
import { FileText, Layers } from 'lucide-react';
import Panel from './Panel';
import ReportPanel from './ReportPanel';
import { getWorkspace } from './workspace';
import './workspace.css';

export default function WorkspacePanel() {
  const [tab, setTab] = useState(() => { const w = getWorkspace(); return w.manifest?.items.find(r => r.caseId === w.caseId)?.reports?.length ? 'report' : 'annotation'; });
  useEffect(() => { const listener = e => setTab(e.detail); window.addEventListener('nifti:workspace-tab', listener); return () => window.removeEventListener('nifti:workspace-tab', listener); }, []);
  return <div className="nw-shell"><nav className="nw-tabs" aria-label="报告与标注面板"><button aria-pressed={tab === 'report'} onClick={() => setTab('report')}><FileText size={17} />报告</button><button aria-pressed={tab === 'annotation'} onClick={() => setTab('annotation')}><Layers size={17} />标注与 AI</button></nav><div hidden={tab !== 'report'}><ReportPanel /></div><div hidden={tab !== 'annotation'}><Panel /></div></div>;
}
