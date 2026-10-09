import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Header, Dialog, DialogContent, DialogTitle, DialogDescription } from '@ohif/ui-next';
import { FilePlus2, ListPlus, Search, RefreshCw, ChevronLeft, ChevronRight, ArrowRight, Loader2, FolderOpen, Images, FileText, Layers3, Crosshair, Info } from 'lucide-react';
import { config, openLocal, openStreaming, releaseSource, sources } from './sourceStore';
import { prepareStreaming } from './streaming';
import { request, downloadSource, upload, openManifestCase } from './api';
import NiftiIcon from './NiftiIcon';
import { setWorkspace, workspaceQuery } from './workspace';

const button = 'catalog-button';
const field = 'catalog-field';
const storageKey = 'ohif.nifti.manifest.v1';
function restoredManifest() { try { const saved = JSON.parse(sessionStorage.getItem(storageKey)); if (!Array.isArray(saved?.items)) return null; saved.items = saved.items.map((r, i) => ({ caseId: `case-${i + 1}`, reports: [], findings: [], ...r })); return saved; } catch { return null; } }
function defaults() { try { const saved = JSON.parse(localStorage.getItem('ohif.nifti.import-defaults') || '{}'); return { modality: ['CT', 'MR', 'OT'].includes(saved.modality) ? saved.modality : 'OT', unit: ['', 'mm', 'm', 'um'].includes(saved.unit) ? saved.unit : '' }; } catch { return { modality: 'OT', unit: '' }; } }

export default function Gateway() {
  useEffect(() => {
    document.body.classList.add('imaging-catalog-page');
    return () => document.body.classList.remove('imaging-catalog-page');
  }, []);
  const navigate = useNavigate(), [query] = useSearchParams();
  const [manifest, setManifest] = useState(restoredManifest);
  const [view, setView] = useState(query.get('library') === '1' ? 'library' : restoredManifest() ? 'manifest' : 'library');
  const [unit, setUnit] = useState(() => defaults().unit), [modality, setModality] = useState(() => defaults().modality);
  const [dialog, setDialog] = useState<'local' | 'manifest' | 'settings' | 'help' | null>(null);
  const [notice, setNotice] = useState('');
  const [status, setStatus] = useState(''), [busy, setBusy] = useState(false);
  const [error, setError] = useState(query.get('error') === 'local-unavailable' ? '本地原图已关闭或页面已刷新，请重新选择文件。' : '');
  const [items, setItems] = useState([]), [total, setTotal] = useState(0), [page, setPage] = useState(0);
  const [search, setSearch] = useState(''), [refresh, setRefresh] = useState(0);
  const [roots, setRoots] = useState<string[]>([]), [base, setBase] = useState(restoredManifest()?.base || '');
  const task = useRef<AbortController>(), localInput = useRef<HTMLInputElement>(), manifestInput = useRef<HTMLInputElement>();
  const run = async action => {
    task.current?.abort(); const controller = new AbortController(); task.current = controller;
    setBusy(true); setError('');
    try { await action(controller.signal); } catch (e) { if (e.name !== 'AbortError') setError(e.message); }
    finally { if (task.current === controller) { setBusy(false); setStatus(''); } }
  };
  const open = async (file: File, stored?, signal?, maskIds: string[] = [], warnings: string[] = []) => {
    for (const key of [...sources.keys()]) releaseSource(key);
    const source = await openLocal(file, { unit: stored?.unit || unit || undefined, modality: stored?.modality || modality }, signal, p => setStatus(`解析原图 ${Math.round(p * 100)}%`));
    if (stored) {
      if (stored.geometryHash !== source.descriptor.geometryHash || stored.contentHash !== source.descriptor.contentHash) { releaseSource(source.sourceKey); throw Error('前后端原图身份或空间信息不一致。'); }
      Object.assign(source.descriptor, stored);
    }
    source.pendingMaskIds = maskIds; source.importWarnings = warnings;
    navigate(`/nifti-viewer/nifti?source=${encodeURIComponent(source.sourceKey)}${stored ? '&sourceId=' + stored.sourceId : ''}${maskIds.length ? '&maskIds=' + maskIds.join(',') : ''}${workspaceQuery()}`);
  };
  const openStored = async (id, signal, maskIds = [], warnings = []) => {
    setStatus('读取服务器原图…');
    const metadata = await (await request(`/${id}/metadata`, { signal })).json();
    if (config.enableNiftiStreaming) {
      if (!metadata.capabilities.streamingViewing) throw Error('后端尚未启用 NIfTI 渐进加载。请成套启用前后端；当前操作不会改为下载完整原图。');
      const transport = await prepareStreaming(id, metadata, signal, setStatus);
      signal.throwIfAborted();
      for (const key of [...sources.keys()]) releaseSource(key);
      const source = openStreaming(metadata, transport);
      source.pendingMaskIds = maskIds; source.importWarnings = warnings;
      navigate(`/nifti-viewer/nifti?source=${encodeURIComponent(source.sourceKey)}&sourceId=${id}${maskIds.length ? '&maskIds=' + maskIds.join(',') : ''}${workspaceQuery()}`);
      return;
    }
    const { descriptor, file } = await downloadSource(id, signal, p => setStatus(`下载原图 ${Math.round(p * 100)}%`));
    await open(file, descriptor, signal, maskIds, warnings);
  };
  const openManifest = async (list, row, signal) => {
    setStatus('读取原图并校验分割网格…');
    const reply = await openManifestCase({ manifestId: list.id, caseId: row.caseId, image: row.image, segmentations: row.segmentations, base: list.base, unit: list.unit || unit || null, modality: row.modality || list.modality || 'OT' }, signal);
    const updated = reply.manifest || { ...list, items: list.items.map(r => r.caseId === row.caseId ? { ...r, sourceId: reply.descriptor.sourceId } : r) };
    setManifest(updated); setWorkspace(updated, row.caseId);
    try { sessionStorage.setItem(storageKey, JSON.stringify(updated)); } catch { /* Server copy remains available. */ }
    await openStored(reply.descriptor.sourceId, signal, reply.maskIds, reply.errors.map(e => `${e.file}: ${e.message}`));
  };
  useEffect(() => {
    if (query.get('manifestId')) run(async signal => {
      const list = await (await request(`/manifests/${encodeURIComponent(query.get('manifestId'))}`, { signal })).json();
      setManifest(list); setView('manifest');
      try { sessionStorage.setItem(storageKey, JSON.stringify(list)); } catch { /* Server copy remains available. */ }
      const row = list.items.find(r => r.caseId === query.get('caseId'));
      if (row) await openManifest(list, row, signal);
      else if (query.get('caseId')) throw Error('清单中不存在该病例。');
    });
    else if (query.get('sourceId')) { setWorkspace(null, ''); run(signal => openStored(query.get('sourceId'), signal, (query.get('maskIds') || '').split(',').filter(Boolean))); }
    return () => task.current?.abort();
  }, []);
  useEffect(() => {
    if (!config.enableNiftiLibrary) return;
    const controller = new AbortController();
    request('/manifest/roots', { signal: controller.signal }).then(r => r.json()).then(r => { setRoots(r.roots); setBase(old => old || r.roots[0] || ''); }).catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!config.enableNiftiLibrary || view !== 'library') return;
    const controller = new AbortController();
    request(`?offset=${page * 25}&limit=25`, { signal: controller.signal }).then(r => r.json()).then(r => { setItems(r.items); setTotal(r.total); })
      .catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, [view, page, refresh]);
  const switchView = value => { setView(value); setPage(0); setSearch(''); };
  const rows = view === 'manifest' ? (manifest?.items || []).filter(r => `${r.name} ${r.image}`.toLowerCase().includes(search.toLowerCase())) : items;
  const shown = view === 'manifest' ? rows.slice(page * 25, page * 25 + 25) : rows;
  const count = view === 'manifest' ? rows.length : total;
  const openRow = row => run(async signal => {
    if (view === 'library') { setWorkspace(null, ''); return openStored(row.sourceId, signal); }
    await openManifest(manifest, row, signal);
  });
  if (!config.enableNiftiViewing) return <div className="p-8 text-white">NIfTI 尚未启用。<Link to="/">返回检查列表</Link></div>;
  const hasRelativePaths = manifest?.items?.some(row => [row.image, ...row.segmentations].some(p => !p.startsWith('/')));
  return <main className="imaging-catalog nifti-catalog">
    <Header isSticky menuOptions={[{ title: '导入默认设置', onClick: () => setDialog('settings') }, { title: '数据来源与保存说明', onClick: () => setDialog('help') }]} isReturnEnabled={false} showPatientInfo="disabled" />
    <Dialog open={!!dialog} onOpenChange={open => { if (!open) setDialog(null); }}>
      <DialogContent className="imaging-dialog max-h-[85vh] w-[calc(100vw-32px)] max-w-2xl overflow-y-auto p-6 text-[16px] leading-relaxed">
        <DialogTitle className="pr-8 text-[22px] font-semibold">{dialog === 'local' ? '打开本地 NIfTI' : dialog === 'manifest' ? '导入病例清单' : dialog === 'settings' ? '导入默认设置' : '数据来源与保存说明'}</DialogTitle>
        <DialogDescription className="text-[16px] text-gray-300">{dialog === 'help' ? '原图、清单和标注分别保存，状态分别显示。' : '确认导入信息。类型不会改变像素值，也不会直接切换窗宽窗位。'}</DialogDescription>
        {dialog === 'help' ? <div className="space-y-4">
          <p><strong>已保存病例</strong>：应用已保存原图的病例，可刷新后重新打开。这里不自动扫描或同步服务器文件夹。</p>
          <p><strong>清单病例</strong>：CSV / JSON 中列出的文件引用。点击打开时，应用校验并保存原图，再导入对应标注。</p>
          <p><strong>相对路径起点</strong>：仅用于拼接清单里的相对路径；绝对路径保持原样。它不是同步目录。</p>
          <p><strong>原图已保存</strong>不代表标注已保存。进入工作台后查看“标注未保存 / 标注已保存”，使用 Save All 保存编辑。</p>
          <p><strong>CT / MR</strong>用于登记原图类型。显示预设在看图工具栏中选择；选择 CT 不会将像素转换成 HU。已保存病例沿用其登记类型。</p>
        </div> : <div className="space-y-5">
          <label className="block">{dialog === 'settings' ? '默认原图类型' : '本次导入的原图类型'}<select aria-label="原图类型" className={field + ' mt-2 w-full'} value={modality} onChange={e => setModality(e.target.value)}><option value="OT">未指定 · 通用强度</option><option value="CT">CT</option><option value="MR">MR</option></select><span className="mt-2 block text-[14px] text-gray-300">{modality === 'OT' ? '不确定时保留未指定，仍可正常看图。' : `新原图将登记为 ${modality}。已保存病例不会被覆盖。`}</span></label>
          <details><summary className="cursor-pointer py-1 text-primary">高级导入选项</summary><label className="mt-3 block">文件缺少空间单位时<select aria-label="缺失空间单位" className={field + ' mt-2 w-full'} value={unit} onChange={e => setUnit(e.target.value)}><option value="">加载时检查并提示</option><option value="mm">使用毫米</option><option value="m">使用米</option><option value="um">使用微米</option></select><span className="mt-2 block text-[14px] text-gray-300">文件已有单位时沿用文件信息；不要用此项调整图像大小。</span></label></details>
          {dialog === 'manifest' && <label className="block">相对路径起点<select aria-label="相对路径起点" className={field + ' mt-2 w-full'} value={base} onChange={e => setBase(e.target.value)}>{roots.length ? roots.map(r => <option key={r} value={r}>{r}</option>) : <option value="">未配置可读取目录</option>}</select><span className="mt-2 block text-[14px] text-gray-300">例如 image.nii.gz 将在此目录下查找。清单使用 / 开头的绝对路径时，无需调整。</span></label>}
          <div className="border-t border-gray-600 pt-4"><button className={button + ' primary w-full'} disabled={busy} onClick={() => {
            if (dialog === 'settings') { try { localStorage.setItem('ohif.nifti.import-defaults', JSON.stringify({ modality, unit })); } catch { setNotice('设置仅在当前页面生效，浏览器未允许持久保存。'); setDialog(null); return; } setNotice(`导入默认设置已保存：${modality === 'OT' ? '未指定类型' : modality}。仅影响之后导入的新原图。`); setDialog(null); }
            else if (dialog === 'local') localInput.current.click(); else manifestInput.current.click();
          }}>{dialog === 'settings' ? '保存默认设置' : dialog === 'local' ? '选择 NIfTI 文件' : '选择 CSV / JSON 文件'}</button></div>
        </div>}
      </DialogContent>
    </Dialog>
    <nav aria-label="影像类型" className="catalog-navigation">
      <Link to="/"><Images />DICOM 检查</Link>
      <span aria-current="page"><NiftiIcon />NIfTI</span>
    </nav>
    <section className="catalog-titlebar">
      <div className="catalog-heading"><span className="catalog-symbol"><NiftiIcon /></span><div><h1>NIfTI 检查列表</h1><p>原图、报告与标注 · 在同一工作台查看</p></div></div>
      <div className="catalog-actions">
        <button className={button} disabled={busy} onClick={() => setDialog('local')}><FilePlus2 size={18} />打开本地原图</button>
        <button className={button + ' primary'} disabled={busy || !config.enableNiftiLibrary} onClick={() => setDialog('manifest')}><ListPlus size={18} />导入 CSV / JSON</button>
        <input ref={localInput} aria-label="本地 NIfTI 原图" className="hidden" type="file" accept=".nii,.nii.gz" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { setWorkspace(null, ''); setDialog(null); run(signal => open(f, null, signal)); } }} />
        <input ref={manifestInput} aria-label="NIfTI 病例清单" className="hidden" type="file" accept=".csv,.json" onChange={e => {
          const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; setDialog(null);
          run(async signal => { setStatus('检查清单中的文件路径…'); const form = new FormData(); form.append('file', f); form.append('base', base); form.append('unit', unit); form.append('modality', modality);
            const result = await upload('/manifest/preview', form, signal); result.name = f.name; result.modality = modality; result.unit = unit; setManifest(result); switchView('manifest');
            try { sessionStorage.setItem(storageKey, JSON.stringify(result)); } catch { /* Large manifests still work in this page. */ }
          });
        }} />
      </div>
    </section>
    <section className="catalog-content" aria-label="NIfTI 病例">
      {notice && <p role="status" className="catalog-notice">{notice}</p>}
      <div className="catalog-controls">
        <div className="catalog-tabs" role="tablist" aria-label="病例来源">{[['library', '已保存病例'], ['manifest', '清单病例']].map(([value, label]) => <button key={value} role="tab" aria-selected={view === value} onClick={() => switchView(value)}>{label}</button>)}</div>
        {view === 'manifest' ? <label className="catalog-search"><Search size={17} /><input aria-label="搜索清单病例" className={field} placeholder="搜索名称或路径" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} /></label> : <button className={button} aria-label="刷新已保存病例" onClick={() => setRefresh(n => n + 1)}><RefreshCw size={16} />刷新</button>}
      </div>
      <div className="catalog-context">
        <span><FolderOpen size={15} />{view === 'library' ? '应用保存的原图 · 非文件夹同步' : manifest?.name || '尚未导入清单'}</span>
        {view === 'manifest' && manifest && <span title={hasRelativePaths ? manifest.base : undefined}>{hasRelativePaths ? `路径起点：${manifest.base}` : '服务器绝对路径'}</span>}
        <button onClick={() => setDialog('help')}><Info size={14} />数据与保存说明</button>
      </div>
      {busy && <div role="status" className="catalog-progress"><Loader2 className="animate-spin" size={18} />{status}<button className="ml-auto underline" onClick={() => task.current?.abort()}>取消</button></div>}
      {error && <div role="alert" className="catalog-error">{error}</div>}
      <div className="catalog-table-scroll">
        <table className="catalog-table"><thead><tr><th style={{ width: '35%' }}>病例 / 原图</th><th style={{ width: '9%' }}>类型</th><th style={{ width: '32%' }}>{view === 'manifest' ? '报告与标注' : '图像信息'}</th><th style={{ width: '15%' }}>原图状态</th><th style={{ width: '9%' }}><span className="sr-only">打开</span></th></tr></thead>
          <tbody>{shown.map(row => <tr key={row.caseId || row.sourceId || row.row}>
            <td><button className="catalog-case" disabled={busy || row.status === 'invalid'} onClick={() => openRow(row)}><NiftiIcon /><span className="truncate" title={row.name}>{row.name}</span></button><p className="catalog-path" title={row.image || row.sourceId}>{row.image || row.sourceId}</p></td>
            <td><span className="catalog-modality">{(row.modality || manifest?.modality || 'OT') === 'OT' ? '未指定' : row.modality || manifest?.modality}</span></td>
            <td>{view === 'manifest' ? <>
              <div className="catalog-metrics"><span className="reports"><FileText size={14} />{row.reports?.length || 0} 报告</span><span className="findings"><Crosshair size={14} />{row.findings?.length || 0} Findings</span><span className="masks"><Layers3 size={14} />{row.segmentations?.length || 0} 分割文件</span></div>
              {!!row.segmentations?.length && <details className="catalog-files"><summary>查看文件</summary><p>目标数量在加载后确认</p>{row.segmentations.map((p, i) => <p title={p} key={`${i}:${p}`}>{p.split('/').pop()}</p>)}</details>}
            </> : <><div className="catalog-metrics">{row.dimensions.join(' × ')}</div><p className="catalog-path">{Math.round(row.workingBytes / 1024 ** 2)} MiB 工作数据</p></>}</td>
            <td><span title={row.error || (view === 'library' ? '仅表示原图已保存；标注保存状态在工作台内查看。' : '路径已校验，打开时读取原图并校验分割。')} className={`catalog-state ${row.status === 'invalid' ? 'invalid' : ''}`}>{row.status === 'invalid' ? '路径错误' : view === 'manifest' ? '可打开' : '已保存'}</span>{row.error && <p className="mt-2 text-[13px] text-red-300">{row.error}</p>}</td>
            <td><button className={button} aria-label={`打开 ${row.name}`} disabled={busy || row.status === 'invalid'} onClick={() => openRow(row)}><ArrowRight size={17} /></button></td>
          </tr>)}</tbody>
        </table>
        {!shown.length && <div className="catalog-empty"><NiftiIcon /><h2>{view === 'manifest' ? manifest ? '没有匹配的病例' : '从一份清单开始' : '还没有已保存病例'}</h2><p>{view === 'manifest' ? manifest ? '试试其他名称或路径。' : '导入 CSV / JSON，将原图、报告、Findings 和分割文件一起带入工作台。' : '打开本地 NIfTI，或导入服务器上的病例清单。'}</p><p>本地打开不会自动上传。</p></div>}
      </div>
      <footer className="catalog-footer"><span>{count} 例{view === 'manifest' && search ? '匹配病例' : ''} · 每页 25 例</span><div className="catalog-paging"><button className={button} aria-label="上一页" disabled={page === 0 || busy} onClick={() => setPage(n => n - 1)}><ChevronLeft size={16} /></button><span>{page + 1} / {Math.max(1, Math.ceil(count / 25))}</span><button className={button} aria-label="下一页" disabled={(page + 1) * 25 >= count || busy} onClick={() => setPage(n => n + 1)}><ChevronRight size={16} /></button></div></footer>
    </section>
  </main>;
}
