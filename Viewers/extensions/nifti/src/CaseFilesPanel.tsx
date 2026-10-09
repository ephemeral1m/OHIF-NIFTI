import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSystem } from '@ohif/core';
import { ChevronDown, ChevronRight, Scan, FileText, Layers, Circle, ArrowLeft } from 'lucide-react';
import { findingMasks, locateFinding, useWorkspace } from './workspace';
import { isMaskDirty } from './masks';
import './workspace.css';
import { switchCase } from './switchCase';

export default function CaseFilesPanel() {
  const { servicesManager } = useSystem(), navigate = useNavigate();
  const { manifest, caseId, findingId, source, row } = useWorkspace(servicesManager);
  const [expanded, setExpanded] = useState({}), [search, setSearch] = useState('');
  const [loading, setLoading] = useState(''), [error, setError] = useState('');
  const task = useRef<AbortController>();
  const leave = to => {
    if (task.current) return;
    if (source && [...source.masks.values()].some(m => isMaskDirty(servicesManager, m)) && !window.confirm('当前标注尚未保存，切换病例会丢失未保存修改。继续？')) return;
    navigate(to);
  };
  useEffect(() => { const back = () => leave('/nifti'); window.addEventListener('nifti:return-list', back); return () => window.removeEventListener('nifti:return-list', back); }, [source]);
  useEffect(() => () => { task.current?.abort(); document.body.classList.remove('nifti-case-switching'); }, []);
  const openCase = async item => {
    if (task.current || source?.annotationStatus?.busy) return;
    if ([...source.masks.values()].some(m => isMaskDirty(servicesManager, m)) && !window.confirm('当前标注尚未保存，切换病例会丢失未保存修改。继续？')) return;
    const controller = new AbortController(); task.current = controller;
    setError(''); setLoading('准备病例…'); document.body.classList.add('nifti-case-switching');
    let committing = false;
    const blockKeys = e => { if (e.key === 'Escape' && !committing) controller.abort(); e.stopImmediatePropagation(); e.preventDefault(); };
    window.addEventListener('keydown', blockKeys, true);
    try { await switchCase({ servicesManager, previous: source, manifest, row: item, signal: controller.signal, progress: message => { committing = message === '切换视图…'; setLoading(message); } }); }
    catch (e) { if (e.name !== 'AbortError') setError(e.message); }
    finally { task.current = undefined; setLoading(''); window.removeEventListener('keydown', blockKeys, true); document.body.classList.remove('nifti-case-switching'); }
  };
  const rows = manifest?.items || (source ? [{ caseId: 'local', name: source.descriptor.name, modality: source.descriptor.modality, findings: [], reports: [] }] : []);
  return <section className="nifti-workspace" aria-label="病例与文件">
    <header className="nw-heading"><button aria-label="返回病例列表" onClick={() => leave('/nifti')}><ArrowLeft size={18} /></button><h2>病例与文件</h2><span>{rows.length}</span></header>
    <p className="nw-caption" title={manifest?.name}>{manifest?.name || '当前原图'}</p>
    {loading && <div role="status" className="nw-notice">{loading}{loading !== '切换视图…' && <button onClick={() => task.current?.abort()}>取消</button>}</div>}
    {error && <p role="alert" className="nw-error">{error}</p>}
    {rows.length > 8 && <input className="nw-search" aria-label="查找清单病例" placeholder="查找病例…" value={search} onChange={e => setSearch(e.target.value)} />}
    {rows.filter(r => r.name.toLowerCase().includes(search.toLowerCase())).map(item => {
      const active = item.caseId === caseId && !!row || !manifest;
      return <article key={item.caseId} className={`nw-case ${active ? 'active' : ''}`}>
        <button className="nw-case-pick" disabled={!!loading || source?.annotationStatus?.busy || !source} aria-current={active} aria-label={`打开病例 ${item.name}`} onClick={() => {
          if (!active && manifest) openCase(item);
        }}><span>{active ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span><span className="nw-truncate"><strong title={item.name}>{item.name.replace(/\.nii(?:\.gz)?$/i, '')}</strong><small>{item.modality || 'NIfTI'} · {item.findings?.length || 0} Findings{item.status === 'invalid' ? ' · 文件不可用' : ''}</small></span></button>
        {active && <div className="nw-tree">
          <div className="nw-tree-label nw-image-entry"><Scan size={16} /><span>原图</span><small>NIfTI</small></div>
          <button className="nw-report-entry" onClick={() => window.dispatchEvent(new CustomEvent('nifti:workspace-tab', { detail: 'report' }))}><FileText size={16} />报告<small>{item.reports?.length || 0} 来源</small></button>
          <div className="nw-tree-label"><Layers size={16} /><span>Findings & masks</span></div>
          {(item.findings || []).map((finding, index) => {const masks = findingMasks(source, finding); return <div key={finding.id} className="nw-finding-tree">
            <div className="nw-finding-row"><button aria-label={`展开 Finding ${index + 1} 标签`} aria-expanded={!!expanded[finding.id]} onClick={() => setExpanded(v => ({ ...v, [finding.id]: !v[finding.id] }))}>{expanded[finding.id] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button><button className="nw-tree-finding" aria-pressed={findingId === finding.id} title={finding.text} onClick={() => locateFinding(source, finding)}><span>F{index + 1}</span><span className="nw-ellipsis">{finding.text}</span></button></div>
            {expanded[finding.id] && <div className="nw-labels">{masks.length ? masks.map(m => <button key={m.segmentationId} onClick={() => locateFinding(source, finding, m)}><Circle size={11} style={{ color: `rgb(${m.displayColor?.slice(0,3).join(',') || '103,223,223'})` }} />Label {m.originalLabel ?? m.saved?.originalLabel ?? 1}<small>{m.saved ? `v${m.saved.version}` : '未保存'}</small></button>) : <small>{finding.maskIds?.length ? '标注未加载，可在标注历史中加载' : '没有可用 mask'}</small>}</div>}
          </div>; })}
          {!item.findings?.length && <p className="nw-caption">此清单未提供 Finding。</p>}
        </div>}
      </article>;
    })}
  </section>;
}
