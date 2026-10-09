import React, { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@ohif/ui-next';
import { History, Eye, Copy, RotateCcw, Download, Layers } from 'lucide-react';
import { request } from './api';
import { isMaskDirty, loadSaved } from './masks';
import { initialMaskColor } from './maskColors.mjs';
import { loadedAnnotation, readSavedVersion, loadLatestAnnotation, restoreAnnotation } from './history';
import HistoryPreview from './HistoryPreview';
import { targetName } from './groups';

const button = 'inline-flex min-h-[40px] items-center justify-center gap-2 rounded border border-primary/40 px-3 py-2 text-[14px] text-primary hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-40';
const label = item => item.operation === 'restore' ? `从 v${item.restoredFrom} 恢复` : item.version === 1 ? (item.derivedFrom ? '创建独立副本' : '首次保存') : '修订保存';

export default function SavedMasksDialog({ open, onOpenChange, source, servicesManager, onNotice, initialMaskId = '' }) {
  const [catalog, setCatalog] = useState<any[]>([]), [selectedId, setSelectedId] = useState('');
  const [history, setHistory] = useState<any>(), [chosen, setChosen] = useState<any>();
  const [busy, setBusy] = useState(false), [restoring, setRestoring] = useState(false);
  const [message, setMessage] = useState(''), [error, setError] = useState(''), [search, setSearch] = useState('');
  const [preview, setPreview] = useState<any>(), [confirm, setConfirm] = useState(false);
  const task = useRef<AbortController>(), previewRef = useRef<any>(), retry = useRef<any>();
  const selectedRef = useRef(''), sourceRef = useRef('');
  const endPreview = () => { previewRef.current?.dispose(); previewRef.current = undefined; setPreview(undefined); };
  const run = async (action, isRestore = false) => {
    task.current?.abort();
    const controller = new AbortController(); task.current = controller;
    setBusy(true); setRestoring(isRestore); setMessage(''); setError('');
    const timeout = setTimeout(() => controller.abort(new DOMException('操作超时。当前编辑已保留，请重试或刷新记录。', 'TimeoutError')), 10 * 60 * 1000);
    try { await action(controller.signal); }
    catch (e) {
      if (task.current !== controller) return;
      const reason = controller.signal.reason?.name === 'TimeoutError' ? controller.signal.reason.message : e.message;
      if (e.name === 'AbortError' && controller.signal.reason?.name !== 'TimeoutError') setMessage('已取消，当前编辑保持不变。');
      else { setError(reason); onNotice?.(reason); }
    } finally {
      clearTimeout(timeout);
      if (task.current === controller) { task.current = undefined; setBusy(false); setRestoring(false); }
    }
  };
  const fetchVersions = async (id, signal, append = false, requestedVersion?) => {
    setMessage('读取这份标注的版本轨迹…');
    const page = await (await request(`/${source.descriptor.sourceId}/masks/history?maskId=${id}&offset=${append ? history.items.length : 0}`, { signal })).json();
    signal.throwIfAborted();
    // A copy may link to a version older than the first page. Locate it in its own history.
    while (requestedVersion && !page.items.some(item => item.version === requestedVersion) && page.items.length < page.total) {
      const more = await (await request(`/${source.descriptor.sourceId}/masks/history?maskId=${id}&offset=${page.items.length}`, { signal })).json();
      signal.throwIfAborted(); if (!more.items.length) break; page.items.push(...more.items);
    }
    setHistory(append ? { ...page, items: [...history.items, ...page.items] } : page);
    if (!append) setChosen(page.items.find(item => item.version === requestedVersion) || page.items[0]);
    setMessage('');
  };
  const refreshCatalog = async (signal, preferred = selectedRef.current, requestedVersion?) => {
    const response = await (await request(`/${source.descriptor.sourceId}/masks`, { signal })).json();
    signal.throwIfAborted(); setCatalog(response.items);
    const id = response.items.some(item => item.maskId === preferred) ? preferred : response.items[0]?.maskId || '';
    selectedRef.current = id; setSelectedId(id);
    if (id) await fetchVersions(id, signal, false, requestedVersion);
    else { setHistory(undefined); setChosen(undefined); setMessage(''); }
  };
  useEffect(() => {
    if (!open || !source?.descriptor.sourceId) return;
    if (sourceRef.current !== source.sourceKey) { selectedRef.current = ''; retry.current = undefined; }
    sourceRef.current = source.sourceKey;
    if (initialMaskId) selectedRef.current = initialMaskId;
    setSearch(''); setConfirm(false); setCatalog([]); setHistory(undefined); setChosen(undefined);
    run(signal => refreshCatalog(signal));
    return () => { task.current?.abort(); previewRef.current?.dispose(); previewRef.current = undefined; setPreview(undefined); };
  }, [open, source?.sourceKey]);
  const select = (id, version?) => {
    endPreview(); setConfirm(false); selectedRef.current = id; setSelectedId(id); setHistory(undefined); setChosen(undefined);
    run(signal => fetchVersions(id, signal, false, version));
  };
  const annotation = catalog.find(item => item.maskId === selectedId);
  const loaded = source && loadedAnnotation(source, selectedId);
  const dirty = loaded && isMaskDirty(servicesManager, loaded);
  const color = item => item.displayColor || initialMaskColor(`${source?.descriptor.contentHash}:${item.maskId}`, []);
  const loadLatest = () => run(async signal => {
    endPreview(); await loadLatestAnnotation(servicesManager, source, annotation, signal, setMessage);
    setMessage(`已加载 ${annotation.name} 的最新版本 v${annotation.version}。`);
  });
  const restore = () => {
    setConfirm(false); endPreview();
    const key = `${source.sourceKey}:${chosen.maskId}:${chosen.version}:${annotation.version}`;
    if (retry.current?.key !== key) retry.current = { key, requestId: crypto.randomUUID() };
    run(async signal => {
      const record = await restoreAnnotation(servicesManager, source, chosen, annotation.version, retry.current.requestId, signal, setMessage);
      retry.current = undefined;
      await refreshCatalog(signal, record.maskId);
      setMessage(`已恢复为 v${record.version}，来自 v${record.restoredFrom}。旧版本全部保留。`);
    }, true);
  };
  const pickerItems = catalog.filter(item => `${item.name} ${item.segmentationSet?.name || ''}`.toLowerCase().includes(search.toLowerCase()));
  const parent = annotation?.derivedFrom && catalog.find(item => item.maskId === annotation.derivedFrom.maskId);
  return <Dialog open={open} onOpenChange={value => { if (restoring) return; if (!value) { task.current?.abort(); endPreview(); } onOpenChange(value); }}>
    <DialogContent className={`max-h-[90vh] w-[calc(100vw-32px)] overflow-y-auto bg-black text-white ${preview ? 'max-w-6xl' : 'max-w-3xl'}`}>
      <DialogTitle className="flex items-center gap-2 text-[20px]"><History size={22} />标注历史</DialogTitle>
      <DialogDescription className="break-all text-[14px] text-gray-400">当前病例 · {source?.descriptor.name}</DialogDescription>
      <div className="border-b border-gray-700 pb-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><span className="text-[14px] text-gray-300">选择标注 · {catalog.length} 份</span><button className={button} disabled={busy} onClick={() => run(signal => refreshCatalog(signal))}>刷新记录</button></div>
        {catalog.length <= 4 ? <div role="group" aria-label="选择标注" className="flex flex-wrap gap-2">{catalog.map(item => <button key={item.maskId} aria-label={item.name} disabled={busy} onClick={() => select(item.maskId)} aria-pressed={selectedId === item.maskId}
          className={`${button} min-w-0 flex-1 text-left ${selectedId === item.maskId ? 'border-primary bg-primary/15' : 'border-gray-600 text-gray-300'}`}>
          <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: `rgb(${color(item).slice(0, 3).join(',')})` }} /><span className="break-all">{targetName(item)}{item.segmentationSet && <span className="block text-[13px] text-gray-400">{item.segmentationSet.name}</span>}</span></button>)}</div>
          : <div className="flex flex-col gap-2"><input className="rounded border border-gray-600 bg-black px-3 py-2 text-[16px]" aria-label="搜索标注名称" placeholder="搜索标注名称" value={search} onChange={e => setSearch(e.target.value)} />
            <select aria-label="选择标注" className="min-w-0 rounded border border-gray-600 bg-black px-3 py-2 text-[16px]" disabled={busy} value={selectedId} onChange={e => select(e.target.value)}>
              {annotation && !pickerItems.includes(annotation) && <option value={annotation.maskId}>{annotation.name}（当前选中）</option>}
              {pickerItems.map(item => <option key={item.maskId} value={item.maskId}>{item.segmentationSet ? `${item.segmentationSet.name} / ` : ''}{targetName(item)}</option>)}
            </select><span className="text-[14px] text-gray-400">{search ? `匹配 ${pickerItems.length} 份标注` : '选择一份标注，查看它自己的完整轨迹。'}</span></div>}
      </div>
      {busy && <div role="status" className="flex items-center gap-3 text-[14px] text-primary"><span className="min-w-0 flex-1 break-all">{message || '处理中…'}</span>{!restoring && <button className={button} onClick={() => task.current?.abort()}>取消</button>}</div>}
      {!busy && message && <p role="status" className="text-[14px] text-primary">{message}</p>}
      {error && <p role="alert" className="text-[14px] text-red-300">{error}</p>}
      {!catalog.length && !busy && !error && <p className="py-6 text-center text-[16px] text-gray-400">还没有已保存的标注。使用 Save All 完成首次保存后，这里会出现它的版本轨迹。</p>}
      {annotation && <div className={preview ? 'grid gap-5 lg:grid-cols-2' : ''}>
        <div>
          {annotation.segmentationSet && <p className="mb-2 break-words text-[14px] text-gray-400">分割组 · {annotation.segmentationSet.name}</p>}
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="flex min-w-0 items-center gap-2 break-all text-[16px] font-medium"><span className="h-3 w-3 shrink-0 rounded-full" style={{ background: `rgb(${color(annotation).slice(0, 3).join(',')})` }} />{targetName(annotation)}</h3><span className="text-[14px] text-gray-400">{history?.total ?? '…'} 个版本</span></div>
          <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 rounded bg-gray-900 p-3 text-[14px]"><span>当前编辑：{loaded ? `v${loaded.saved.version}${dirty ? ' ＋ 未保存修改' : ''}` : '尚未加载'}</span><span className="text-primary">最新保存：v{annotation.version}</span></div>
          {annotation.derivedFrom ? <div className="mb-3 text-[14px] text-gray-400">副本来源：<button className="text-primary underline" disabled={busy || !parent} onClick={() => select(parent.maskId, annotation.derivedFrom.version)}>{parent?.name || annotation.derivedFrom.maskId} · v{annotation.derivedFrom.version}</button></div>
            : <p className="mb-3 break-all text-[14px] text-gray-400">来源：{annotation.originalFile || '首次保存'}</p>}
          {history && history.items.length < history.total && <button className={`${button} mb-2`} disabled={busy} onClick={() => run(signal => fetchVersions(selectedId, signal, true))}>更早的版本（已显示 {history.items.length} / {history.total}）</button>}
          <ol className="ml-2 space-y-2 border-l border-gray-600 py-2 pl-5" aria-label="当前标注的版本轨迹">
            {[...(history?.items || [])].sort((a,b) => a.version-b.version).map(item => <li key={item.version} className="relative">
              <span className={`absolute -left-[26px] top-5 h-3 w-3 rounded-full border-2 border-black ${chosen?.version === item.version ? 'bg-primary' : 'bg-gray-500'}`} />
              <button disabled={busy} aria-pressed={chosen?.version === item.version} aria-label={`选择版本 v${item.version}`} onClick={() => { endPreview(); setChosen(item); setConfirm(false); setMessage(''); setError(''); }}
                className={`flex w-full items-center justify-between gap-3 rounded border p-3 text-left ${chosen?.version === item.version ? 'border-primary/70 bg-primary/10' : 'border-transparent hover:bg-gray-900'}`}>
                <span><span className="block text-[16px]">v{item.version} · {label(item)}</span><time className="text-[14px] text-gray-400" dateTime={item.created}>{new Date(item.created).toLocaleString()}</time></span>{item.version === annotation.version && <span className="shrink-0 text-[14px] text-primary">最新保存</span>}
              </button></li>)}
          </ol>
          {chosen && <div className="mt-3 border-t border-gray-700 pt-3">
            <p className="break-all text-[16px]">已选中：{targetName(annotation)} · v{chosen.version}</p>
            {chosen.name !== annotation.name && <p className="mt-1 break-all text-[14px] text-gray-400">保存时名称：{chosen.name}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <button className={button} disabled={busy || !!preview} onClick={() => run(async signal => { endPreview(); const next = await readSavedVersion(servicesManager, source, chosen, signal, setMessage, true); previewRef.current = next; setPreview(next); setMessage(''); })}><Eye size={16} />只读预览</button>
              <button className={button} disabled={busy || dirty || chosen.version === annotation.version} onClick={() => setConfirm(true)}><RotateCcw size={16} />恢复为新版本</button>
              <button className={button} disabled={busy} onClick={() => run(async signal => { endPreview(); const results = await loadSaved(servicesManager, signal, undefined, { items: [chosen], asCopy: true, progress: setMessage }); const failure = results.find(r => r.status === 'failed'); if (failure) throw Error(failure.error); setMessage('已创建独立标注副本；使用 Save All 保存后，它会拥有自己的轨迹。'); })}><Copy size={16} />另存为独立标注</button>
            </div>
            {dirty && <p className="mt-2 text-[14px] text-yellow-300">这份标注有未保存修改。可以只读预览；恢复前请先保存或导出。</p>}
            {confirm && <div className="mt-3 rounded border border-primary/50 bg-gray-900 p-3"><p className="text-[14px]">将 v{chosen.version} 恢复为这份标注的新版本，保留所有历史和当前标注名称。其他标注不会改变。</p><div className="mt-3 flex gap-2"><button className={button} disabled={busy || dirty} onClick={restore}>确认恢复</button><button className={button} disabled={busy} onClick={() => setConfirm(false)}>取消恢复</button></div></div>}
          </div>}
        </div>
        {preview && <HistoryPreview preview={preview} onEnd={endPreview} servicesManager={servicesManager} />}
      </div>}
      {!!catalog.length && <div className="mt-2 flex flex-wrap gap-2 border-t border-gray-700 pt-3"><button className={button} disabled={busy || !annotation || dirty} onClick={loadLatest}><Download size={16} />加载这份标注的最新版本</button>
        <button className={button} disabled={busy} onClick={() => run(async signal => { endPreview(); const results = await loadSaved(servicesManager, signal, undefined, { progress: setMessage }); const failures = results.filter(r => r.status === 'failed'); setMessage(`加载完成：新增 ${results.filter(r => r.status === 'loaded').length} 个，已有 ${results.filter(r => r.status === 'alreadyLoaded').length} 个（保留当前编辑），失败 ${failures.length} 个。`); if (failures.length) throw Error(failures.map(r => `${r.item.name}：${r.error}`).join('；')); })}><Layers size={16} />补充加载其他标注</button></div>}
    </DialogContent>
  </Dialog>;
}
