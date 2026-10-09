import React, { useEffect, useState } from 'react';
import { useSystem } from '@ohif/core';
import { FileText, Link2, Unlink, Crosshair, Loader2 } from 'lucide-react';
import { request } from './api';
import { findingMasks, getWorkspace, locateFinding, setWorkspace, useWorkspace } from './workspace';
import './workspace.css';

export default function ReportPanel() {
  const { servicesManager } = useSystem();
  const { manifest, row, source, findingId } = useWorkspace(servicesManager);
  const [reportId, setReportId] = useState(''), [binding, setBinding] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const reports = row?.reports || [], report = reports.find(r => r.id === reportId) || reports[0];
  const finding = row?.findings?.find(f => f.id === findingId);
  useEffect(() => { setReportId(''); setBinding(false); setError(''); }, [row?.caseId]);
  const bind = async statementId => {
    if (!finding || busy) return;
    const caseId = row.caseId, id = manifest.id;
    setBusy(true); setError('');
    try {
      const ids = finding.statementIds.includes(statementId) ? finding.statementIds.filter(s => s !== statementId) : [...finding.statementIds, statementId];
      const updated = await (await request(`/manifests/${id}/binding`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId, findingId: finding.id, statementIds: ids, expectedRevision: manifest.revision }) })).json();
      // Never install an old response after the user has opened another case.
      if (getWorkspace().manifest?.id === id && getWorkspace().caseId === caseId) setWorkspace(updated, caseId);
      setBinding(false);
    } catch (e) {
      setError(e.message);
      if (e.status === 409) {
        try { const fresh = await (await request(`/manifests/${id}`)).json(); if (getWorkspace().manifest?.id === id && getWorkspace().caseId === caseId) setWorkspace(fresh, caseId); } catch { /* Preserve the visible failure and allow retry. */ }
      }
    } finally { setBusy(false); }
  };
  const sections = new Map<string, any[]>();
  for (const s of report?.statements || []) { if (!sections.has(s.section)) sections.set(s.section, []); sections.get(s.section).push(s); }
  return <section className="nifti-workspace nw-report" aria-label="病例报告">
    <header className="nw-heading"><FileText size={18} /><h2>报告</h2><span>{reports.length} 来源</span></header>
    {source?.annotationStatus?.busy && <p role="status" className="nw-notice">{source.annotationStatus.message || '正在加载标注…'}</p>}
    {source?.annotationStatus?.error && <p role="alert" className="nw-error">{source.annotationStatus.error}<button onClick={() => window.dispatchEvent(new CustomEvent('nifti:workspace-tab', { detail: 'annotation' }))}>查看标注与重试</button></p>}
    {reports.length ? <>
      <select aria-label="报告来源" value={report?.id} onChange={e => setReportId(e.target.value)}>{reports.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
      <p className="nw-caption">原文 · 病例级关联</p>
      {finding && <div className="nw-selected"><div><strong>F{row.findings.indexOf(finding) + 1}</strong><span>{finding.statementIds.length ? `${finding.statementIds.length} 条已绑定` : '尚未绑定原句'}</span><button aria-label="定位当前 Finding" disabled={!findingMasks(source, finding).length} onClick={() => locateFinding(source, finding)}><Crosshair size={16} /></button><button aria-label="选择报告语句绑定" aria-pressed={binding} onClick={() => setBinding(v => !v)}><Link2 size={16} /></button></div><p>{finding.text}</p></div>}
      {binding && <p role="status" className="nw-notice">选择原句旁的链接按钮，关联到当前 Finding。</p>}
      {error && <p role="alert" className="nw-error">{error}</p>}
      {[...sections].map(([name, statements]) => <section key={name} className="nw-report-section"><h3>{name}</h3>{statements.map(s => {
        const linked = finding?.statementIds.includes(s.id), candidate = finding?.candidateStatementIds.includes(s.id) && !linked;
        const otherLinks = row.findings.filter(f => f.statementIds.includes(s.id));
        return <div key={s.id} className={`nw-statement ${linked ? 'linked' : candidate ? 'candidate' : ''}`}><p>{s.text}</p>
          {(linked || candidate || binding || otherLinks.length > 0) && <div className="nw-binding-row">{otherLinks.map(f => <button key={f.id} onClick={() => locateFinding(source, f)}><Link2 size={13} />F{row.findings.indexOf(f) + 1}</button>)}{candidate && <span>候选关联 · 待确认</span>}{finding && (binding || linked || candidate) && <button disabled={busy} aria-label={`${linked ? '取消' : '确认'}语句关联 ${s.id}`} onClick={() => bind(s.id)}>{busy ? <Loader2 size={14} /> : linked ? <Unlink size={14} /> : <Link2 size={14} />}{linked ? '取消关联' : '关联'}</button>}</div>}
        </div>;
      })}</section>)}
    </> : <div className="nw-empty"><FileText size={30} /><p>此病例没有报告</p><small>从包含 reports 和 findings 的 JSON 清单打开病例。原有 CSV 和本地 NIfTI 仍可正常浏览、标注。</small></div>}
  </section>;
}
