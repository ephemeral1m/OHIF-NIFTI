import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSystem } from '@ohif/core';
import AnnotationTools from './AnnotationTools';
import { ArrowLeft, Plus, Upload, FolderOpen, Save, Download, History, Loader2, X, AlertTriangle } from 'lucide-react';
import { currentSource, createMask, importMasks, saveAll, loadSaved, exportLocal, isMaskDirty, copyGroup } from './masks';
import GroupedSegmentationPanel from './GroupedSegmentationPanel';
import { config, memorySnapshot } from './sourceStore';
import { ensureStored } from './api';
import NiftiIcon from './NiftiIcon';
import SavedMasksDialog from './SavedMasksDialog';
import { ensureSlice, requestComplete } from './streaming';

function Action({ label, icon: Icon, disabled, onClick }) {
  return <button type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick}
    className="flex h-9 w-9 items-center justify-center rounded border border-primary/30 bg-primary/10 text-primary hover:bg-primary/25 disabled:cursor-not-allowed disabled:opacity-30"><Icon size={19} className={Icon === Loader2 ? 'animate-spin' : undefined} /></button>;
}

export default function Panel() {
  const { servicesManager, commandsManager } = useSystem();
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyMaskId, setHistoryMaskId] = useState('');
  const [streamOpen, setStreamOpen] = useState(false);
  const [pendingLoad, setPendingLoad] = useState(0);
  const [, update] = useState(0), task = useRef<AbortController>(), input = useRef<HTMLInputElement>();
  let source;
  try { source = currentSource(servicesManager).source; } catch { /* Viewport not ready. */ }
  const run = async action => {
    task.current?.abort();
    const controller = new AbortController(); task.current = controller; setBusy(true); setError(''); setMessage('');
    const timeout = setTimeout(() => controller.abort(new DOMException('操作超时，当前编辑已保留。请重试。', 'TimeoutError')), 10 * 60 * 1000);
    try { await action(controller.signal); if (task.current === controller) update(n => n + 1); }
    catch (e) {
      if (task.current !== controller) return;
      if (controller.signal.reason?.name === 'TimeoutError') setError(controller.signal.reason.message);
      else if (e.name !== 'AbortError') setError(e.message);
      else setMessage('已取消。已完成加载的目标及当前编辑均已保留。');
    }
    finally { clearTimeout(timeout); if (task.current === controller) { task.current = undefined; setBusy(false); } }
  };
  const load = async (signal, ids?, options = {}) => {
    setMessage('读取已保存 mask…');
    const results = await loadSaved(servicesManager, signal, ids, { ...options, progress: setMessage });
    const loaded = results.filter(r => r.status === 'loaded').length;
    const existing = results.filter(r => r.status === 'alreadyLoaded').length;
    const failures = results.filter(r => r.status === 'failed');
    setMessage(results.length ? `加载完成：新增 ${loaded} 个，已有 ${existing} 个（保留当前编辑），失败 ${failures.length} 个。` : '当前原图没有已保存的 mask。');
    if (failures.length) throw Error(failures.map(r => `${r.item.name}：${r.error}`).join('；'));
  };
  useEffect(() => {
    const id = setInterval(() => update(n => n + 1), 500);
    const unload = e => {
      let active; try { active = currentSource(servicesManager).source; } catch { return; }
      if ([...active.masks.values()].some(m => isMaskDirty(servicesManager, m))) { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', unload);
    return () => { clearInterval(id); task.current?.abort(); window.removeEventListener('beforeunload', unload); };
  }, []);
  useEffect(() => {
    setHistoryOpen(false); setMessage(''); setError('');
    if (source?.pendingMaskIds?.length) {
      const ids = source.pendingMaskIds; source.pendingMaskIds = [];
      run(signal => load(signal, ids));
    }
    return () => { task.current?.abort(); };
  }, [source?.sourceKey]);
  useEffect(() => {
    if (source) source.annotationStatus = { busy, message, error };
  }, [source, busy, message, error]);
  useEffect(() => {
    const listener = e => {
      let active; try { active = currentSource(servicesManager).source; } catch { return; }
      if (active.sourceKey !== e.detail || !active.pendingMaskIds?.length) return;
      setPendingLoad(n => n + 1);
    };
    window.addEventListener('nifti:load-pending-masks', listener);
    return () => window.removeEventListener('nifti:load-pending-masks', listener);
  }, [source?.sourceKey]);
  useEffect(() => {
    if (!source?.pendingMaskIds?.length) return;
    const ids = source.pendingMaskIds; source.pendingMaskIds = [];
    run(signal => load(signal, ids));
  }, [source?.sourceKey, pendingLoad]);
  const save = signal => saveAll(servicesManager, signal, p => setMessage(`上传原图 ${Math.round(p * 100)}%`)).then(results => {
    const failures = results.filter(r => !r.success);
    setMessage(`已保存 ${results.length - failures.length} / ${results.length} 个 mask。`);
    if (failures.length) throw Error(failures.map(r => r.error).join('；'));
  });
  const add = (group?) => run(signal => createMask(servicesManager, `新目标 ${(source?.masks.size || 0) + 1}`, undefined, undefined, signal, group));
  const prepareAI = async () => {
    if (busy) throw Error('请等待当前操作完成。');
    const controller = new AbortController(); task.current = controller;
    setBusy(true); setError('');
    try { await ensureStored(source, controller.signal, p => setMessage(`上传原图 ${Math.round(p * 100)}%`)); }
    finally { setBusy(false); }
  };
  const dirty = source ? [...source.masks.values()].filter(m => isMaskDirty(servicesManager, m)).length : 0;
  const viewport = servicesManager.services.cornerstoneViewportService.getCornerstoneViewport(servicesManager.services.viewportGridService.getState().activeViewportId);
  const slicePending = source?.stream && viewport?.getCurrentImageId?.() !== viewport?.getCornerstoneImage?.()?.imageId;
  return <div className="nifti-annotation flex min-h-full flex-col text-white">
    {(config.enableNiftiAI || config.enableNiftiEditing) && <AnnotationTools key={source?.sourceKey || 'pending'} sourceKey={source?.sourceKey} enableAI={config.enableNiftiAI} enableEditing={config.enableNiftiEditing} beforeAI={prepareAI} />}
    <div className="border-b border-primary/20 p-3">
      <div className="mb-3 flex items-center gap-2">
        <Link title="返回 NIfTI 检查列表" aria-label="打开另一例 NIfTI" to="/nifti" className="rounded p-1 text-primary hover:bg-primary/20" onClick={e => {
          if (dirty && !window.confirm('当前 mask 尚未保存。确定关闭编辑并返回检查列表？')) e.preventDefault();
        }}><ArrowLeft size={19} /></Link>
        <NiftiIcon className="h-5 w-5 text-primary" /><h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={source?.descriptor.name}>{source?.descriptor.name || '等待原图…'}</h2>
        <span className="rounded bg-primary/15 px-2 py-1 text-[14px] text-primary">{source?.descriptor.modality || 'NIfTI'}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {source?.stream && <Action label="原图加载状态" icon={source.stream.queue.active ? Loader2 : source.stream.errors.size ? AlertTriangle : Download} disabled={false} onClick={() => setStreamOpen(v => !v)} />}
        {config.enableNiftiEditing && <><Action label="新建二值 mask" icon={Plus} disabled={busy || !source} onClick={() => add()} /><Action label="导入 mask" icon={FolderOpen} disabled={busy || !source} onClick={() => input.current.click()} /></>}
        {config.enableNiftiLibrary && <><Action label="上传原图" icon={Upload} disabled={busy || !source || !!source.descriptor.sourceId} onClick={() => run(signal => ensureStored(source, signal))} /><Action label="Save All" icon={Save} disabled={busy || !source?.masks.size} onClick={() => run(save)} /><Action label="标注历史" icon={History} disabled={busy || !source?.descriptor.sourceId} onClick={() => { setError(''); setHistoryMaskId(''); setHistoryOpen(true); }} /></>}
        {config.enableNiftiEditing && <Action label="导出 NIfTI ZIP（本地）" icon={Download} disabled={busy || !source?.masks.size} onClick={() => run(signal => exportLocal(servicesManager, signal))} />}
      </div>
      {streamOpen && source?.stream && <div aria-label="原图渐进加载状态" className="mt-2 rounded border border-primary/30 bg-primary/10 p-2 text-[14px] text-primary">
        <span role="status">{source.stream.completing ? '正在准备完整体数据 · ' : slicePending ? '当前层加载中 · ' : '按需加载 · '}已加载 {source.stream.loaded.reduce((a, b) => a + b, 0)}/{source.stream.loaded.length} 层</span>
        <div className="mt-2 flex gap-2">
          {source.stream.completeController ? <button onClick={() => source.stream.completeController.abort()}>取消完整加载</button>
            : <button onClick={() => requestComplete(source).catch(e => { if (e.name !== 'AbortError') setError(e.message); })}>加载完整体数据</button>}
          <button onClick={() => {
            const viewport = servicesManager.services.cornerstoneViewportService.getCornerstoneViewport(servicesManager.services.viewportGridService.getState().activeViewportId);
            const index = viewport?.getCurrentImageIdIndex?.();
            if (Number.isInteger(index)) ensureSlice(source, index).then(async () => {
              const presentation = viewport.getViewPresentation?.(), properties = viewport.getProperties();
              await viewport.setStack(viewport.getImageIds(), index);
              if (presentation) viewport.setViewPresentation?.(presentation);
              viewport.setProperties(properties); viewport.render();
            }).catch(e => setError(e.message));
          }}>重试当前层</button>
        </div>
        {[...source.stream.errors.values()].slice(0, 1).map(text => <p key={text} role="alert">{text}</p>)}
      </div>}
      <input ref={input} aria-label="导入 NIfTI mask" className="hidden" type="file" accept=".nii,.nii.gz" multiple onChange={e => { const files = Array.from(e.target.files || []); e.target.value = ''; run(async signal => { for (const file of files) await importMasks(servicesManager, file, signal); }); }} />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-1 text-[14px] text-gray-400"><span>{source?.descriptor.sourceId ? '原图已保存' : '本地原图 · 未保存到服务器'}</span><span>{dirty ? `${dirty} 个目标未保存` : source?.masks.size ? '标注已保存' : '尚无标注'} · {Math.round(memorySnapshot().bytes / 1024 ** 2)} MiB</span></div>
      {!source?.descriptor.sourceId && <p className="mt-2 text-[14px] text-gray-500">保存或启动 AI 时上传原图。</p>}
      {source?.descriptor.sourceId && <a className="mt-2 block text-[14px] text-primary" aria-label="原图访问链接" href={`/nifti?sourceId=${source.descriptor.sourceId}`} target="_blank" rel="noreferrer">原图访问链接</a>}
      {busy && <div className="mt-2 flex items-center gap-2 text-[14px] text-primary"><Loader2 size={15} className="animate-spin" />处理中<Action label="取消" icon={X} disabled={false} onClick={() => task.current?.abort()} /></div>}
      {!historyOpen && message && <p role="status" className="mt-2 text-[14px] text-primary">{message}</p>}
      {!historyOpen && error && <p role="alert" className="mt-2 text-[14px] text-red-300">{error}</p>}
      {[...(source?.descriptor.warnings || []), ...(source?.importWarnings || [])].map(w => <p role="alert" key={w} className="mt-2 text-[14px] text-yellow-300">{w}</p>)}
    </div>
    <SavedMasksDialog open={historyOpen} onOpenChange={setHistoryOpen} source={source} servicesManager={servicesManager} onNotice={setError} initialMaskId={historyMaskId} />
    {config.enableNiftiEditing && <GroupedSegmentationPanel source={source} servicesManager={servicesManager} commandsManager={commandsManager} busy={busy || historyOpen} onAdd={add} onCopy={id => run(signal => copyGroup(servicesManager, id, signal))} onHistory={id => { setHistoryMaskId(id); setHistoryOpen(true); }} onError={setError} />}
    <p className="px-3 py-2 text-[14px] text-gray-500">NIfTI 使用独立分割文件保存与导出。DICOM SEG / PACS 导出不可用。</p>
  </div>;
}
