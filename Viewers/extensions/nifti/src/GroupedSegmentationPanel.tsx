import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Layers, ChevronDown, ChevronRight, Eye, EyeOff, Plus, History, Lock, Unlock, Pencil, Copy, SlidersHorizontal, RotateCcw, X } from 'lucide-react';
import { segmentation } from '@cornerstonejs/tools';
import { groupedMasks, groupPresentation, maskGroup, newGroup, targetName, groupFindingName } from './groups';
import { isMaskDirty, maskAppearance } from './masks';
import { createPresentationController, targetPresentation, scenePresentation } from './presentation';
import { maskLocation } from './maskLocation';
import { getWorkspace, selectFinding, useWorkspace } from './workspace';
import './segmentation-panel.css';

const smallButton = 'seg-action';
function IconAction({ label, icon: Icon, onClick, disabled = false, pressed = undefined }) {
  return <button type="button" aria-label={label} title={label} aria-pressed={pressed} onClick={onClick} disabled={disabled} className={smallButton}><Icon size={16} strokeWidth={1.7} /></button>;
}
function Range({ label, name, value, onChange, max = 100, step = 1, unit = '%' }) {
  const id = React.useId();
  return <div className="seg-range"><label htmlFor={id}>{label}</label><input id={id} aria-label={name} type="range" min="0" max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} /><output htmlFor={id}>{value}{unit}</output></div>;
}

export default function GroupedSegmentationPanel({ source, servicesManager, commandsManager, busy, onAdd, onCopy, onHistory, onError }) {
  const [, update] = useState(0), selection = useRef(0);
  const { segmentationService: service, viewportGridService, measurementService, cornerstoneViewportService } = servicesManager.services;
  const groups = source ? groupedMasks(source) : [];
  const viewportId = viewportGridService.getState().activeViewportId;
  const activeId = service.getActiveSegmentation(viewportId)?.segmentationId;
  const active = source?.masks.get(activeId);
  const scene = source && scenePresentation(source);
  const { row } = useWorkspace(servicesManager);
  const presenter = useMemo(() => source && createPresentationController(service, source, onError), [service, source, onError]);
  const representations = groups.flatMap(g => g.masks.flatMap(m => service.getViewportIdsWithSegmentation(m.segmentationId).map(v => `${m.segmentationId}@${v}`))).join('|');
  const execute = fn => { try { const result = fn(); if (result?.catch) result.catch(e => onError(e.message)); update(n => n + 1); } catch (e) { onError(e.message); } };
  useEffect(() => { execute(() => presenter?.apply()); }, [presenter, representations]);
  useEffect(() => () => { selection.current++; presenter?.stop(); }, [presenter]);
  const change = fn => execute(() => { selection.current++; fn(); presenter.apply(); });
  const select = async mask => {
    const workspace = getWorkspace();
    const row = workspace.manifest?.items.find(r => r.caseId === workspace.caseId && r.sourceId === source.descriptor.sourceId);
    const finding = row?.findings.find(f => f.maskIds.includes(mask.saved?.maskId));
    if (finding) selectFinding(finding.id);
    const token = ++selection.current;
    const group = groups.find(g => g.id === maskGroup(source, mask).id);
    groupPresentation(source, group.id).visible = true; mask.visible = true;
    presenter.stop();
    const viewportIds = service.getViewportIdsWithSegmentation(mask.segmentationId);
    for (const vp of viewportIds) service.setActiveSegmentation(vp, mask.segmentationId);
    service.setActiveSegment(mask.segmentationId, 1);
    presenter.apply();
    update(n => n + 1);
    const location = maskLocation(source, mask);
    if (!location) return; // Empty targets can be selected for drawing, but have no location.
    await Promise.all(viewportIds.map(async id => {
      const viewport = cornerstoneViewportService.getCornerstoneViewport(id);
      if (!viewport) return;
      if (viewport.type === 'stack') await viewport.setImageIdIndex(location.slice);
      else viewport.jumpToWorld(location.world);
      viewport.render();
    }));
    if (token === selection.current && source.masks.has(mask.segmentationId)) presenter.flash(mask);
  };
  const remove = mask => {
    if (!window.confirm(`从当前视图移除“${targetName(mask)}”？${isMaskDirty(servicesManager, mask) ? '未保存的修改会丢失。' : ''}服务器上的已保存版本会保留。`)) return;
    selection.current++; presenter.stop();
    const ids = measurementService.getMeasurements().filter(m => m.metadata?.segmentationId === mask.segmentationId).map(m => m.uid);
    if (ids.length) measurementService.removeMany(ids);
    service.remove(mask.segmentationId);
    source.masks.delete(mask.segmentationId);
  };
  useEffect(() => {
    const listener = e => {
      if (busy || e.detail.sourceKey !== source?.sourceKey) return;
      const mask = source.masks.get(e.detail.segmentationId);
      if (mask) execute(() => select(mask));
    };
    window.addEventListener('nifti:select-target', listener);
    return () => window.removeEventListener('nifti:select-target', listener);
  }, [source, busy, presenter, representations]);
  return <section aria-label="分割标注" className="nifti-segments">
    <div className="seg-heading"><Layers size={19} /><h3>分割标注</h3><span className="seg-muted">{groups.length} 组 · {source?.masks.size || 0} 个目标</span><IconAction label="显示配置" icon={SlidersHorizontal} disabled={!source} pressed={scene?.expanded} onClick={() => execute(() => { scene.expanded = !scene.expanded; })} /><IconAction label="新组与目标" icon={Plus} disabled={busy || !source} onClick={() => onAdd(newGroup(`手工分割 ${groups.length + 1}`))} /></div>
    {scene?.expanded && <div className="seg-controls seg-scene-controls" aria-label="全局显示配置" title="其他目标的填充和边界按此比例淡化；当前选中目标保持自身透明度。0% 隐藏其他目标。">
      <Range label="其他目标" name="未选中目标透明度" value={Math.round(scene.otherOpacity * 100)} onChange={value => change(() => { scene.otherOpacity = value / 100; })} />
    </div>}
    {groups.map(group => {
      const displayName = groupFindingName(group, row);
      const state = groupPresentation(source, group.id);
      const dirty = group.masks.filter(m => isMaskDirty(servicesManager, m)).length;
      return <article key={group.id} data-group-id={group.id} aria-label={`分割组 ${displayName}`} className="seg-group">
        <div className="seg-group-header">
          <button type="button" title={displayName} aria-label={`展开分割组 ${displayName}`} aria-expanded={state.expanded} className="seg-group-title" onClick={() => execute(() => { state.expanded = !state.expanded; })}>
            {state.expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}<Layers size={17} /><span><span className="seg-name seg-finding-name">{displayName}</span><span className="seg-muted">{group.masks.length} 个目标{dirty ? ` · ${dirty} 未保存` : ''}</span></span>
          </button>
          <IconAction label={`${state.visible ? '隐藏' : '显示'}整组 ${group.name}`} icon={state.visible ? Eye : EyeOff} onClick={() => change(() => { state.visible = !state.visible; })} />
        </div>
        {state.expanded && <>
          <div className="seg-group-opacity" title="整组透明度按比例影响各目标，不会覆盖单目标的设置。"><Range label="整体透明度" name={`整体透明度 ${group.name}`} value={Math.round(state.opacity * 100)} onChange={value => change(() => { state.opacity = value / 100; })} /></div>
          {group.masks.map(mask => {
            const title = targetName(mask), color = maskAppearance(servicesManager, mask), view = targetPresentation(mask);
            const locked = segmentation.segmentLocking.isSegmentIndexLocked(mask.segmentationId, 1);
            return <div key={mask.segmentationId} data-target-id={mask.saved?.maskId || mask.segmentationId} aria-current={mask.segmentationId === activeId} className="seg-target">
              <div className="seg-target-heading">
                <button type="button" title={`修改颜色 ${title}`} aria-label={`修改颜色 ${title}`} disabled={busy} className="seg-action" onClick={() => commandsManager.run('editSegmentColor', { segmentationId: mask.segmentationId, segmentIndex: 1 })}><span className="seg-color" style={{ backgroundColor: `rgb(${color?.slice(0, 3).join(',') || '80,200,240'})` }} /></button>
                <button type="button" title={`点击定位 · ${mask.originalLabel || mask.saved?.originalLabel ? `源标签 ${mask.originalLabel || mask.saved.originalLabel} · ` : ''}${mask.saved ? `版本 ${mask.saved.version}` : '尚未保存'}`} aria-label={`编辑目标 ${title}`} disabled={busy} onClick={() => execute(() => select(mask))} className="seg-target-title"><span className="seg-name">{title}</span></button>
                {isMaskDirty(servicesManager, mask) && <span className="seg-dirty" role="img" aria-label="未保存修改" title="未保存修改" />}
                {mask.saved && <span className="seg-version" title={`已保存版本 ${mask.saved.version}`}>v{mask.saved.version}</span>}
                <IconAction label={`${mask.visible !== false ? '隐藏' : '显示'}目标 ${title}`} icon={mask.visible !== false ? Eye : EyeOff} onClick={() => change(() => { mask.visible = mask.visible === false; })} />
                <IconAction label={`目标历史 ${title}`} icon={History} disabled={busy || !mask.saved} onClick={() => onHistory(mask.saved.maskId)} />
                <IconAction label={`显示设置 ${title}`} icon={SlidersHorizontal} pressed={view.expanded} onClick={() => execute(() => { const expanded = !view.expanded; for (const item of source.masks.values()) targetPresentation(item).expanded = false; view.expanded = expanded; })} />
              </div>
              {view.expanded && <div className="seg-controls" aria-label={`目标显示设置 ${title}`}>
              <Range label="填充透明度" name={`填充透明度 ${title}`} value={Math.round(view.opacity * 100)} onChange={value => change(() => { view.opacity = value / 100; })} />
                <div className="seg-modes" role="group" aria-label={`显示模式 ${title}`}>{[['both', '填充与边界'], ['outline', '仅边界'], ['fill', '仅填充']].map(([mode, label]) => <button type="button" key={mode} aria-pressed={view.mode === mode} onClick={() => change(() => { view.mode = mode; })}>{label}</button>)}</div>
                <Range label="边界透明度" name={`边界透明度 ${title}`} value={Math.round(view.outlineOpacity * 100)} onChange={value => change(() => { view.outlineOpacity = value / 100; })} />
                <Range label="边界宽度" name={`边界宽度 ${title}`} value={view.outlineWidth} max={10} step={0.5} unit=" px" onChange={value => change(() => { view.outlineWidth = value; })} />
                <div className="seg-footer">
                  <button type="button" className="seg-action" aria-label={`${locked ? '解锁' : '锁定'}目标 ${title}`} disabled={busy} onClick={() => execute(() => service.setSegmentLocked(mask.segmentationId, 1, !locked))} title={locked ? '解锁目标' : '锁定目标'}>{locked ? <Lock size={15} /> : <Unlock size={15} />}</button>
                  <IconAction label={`重命名目标 ${title}`} icon={Pencil} disabled={busy} onClick={() => commandsManager.run('editSegmentLabel', { segmentationId: mask.segmentationId, segmentIndex: 1 })} />
                  <IconAction label={`移除目标 ${title}`} icon={X} disabled={busy} onClick={() => execute(() => remove(mask))} />
                  <IconAction label={`重置显示 ${title}`} icon={RotateCcw} onClick={() => change(() => { delete mask.presentation; targetPresentation(mask).expanded = true; })} />
                </div>
              </div>}
            </div>;
          })}
          <div className="seg-footer"><button type="button" disabled={busy} className={smallButton} aria-label="组内新增" onClick={() => onAdd(group)}><Plus size={15} />新增</button><button type="button" disabled={busy || !!dirty} title={dirty ? '先保存组内目标，再复制方案' : '将当前已加载目标复制到新组'} className={smallButton} aria-label="复制为新方案" onClick={() => onCopy(group.id)}><Copy size={15} />复制</button></div>
          <details className="seg-source"><summary>来源</summary><p>{group.sourceFile || (group.kind === 'legacy' ? '来源未能确认，单独保留分组。' : '在工作台中创建。')}</p></details>
        </>}
      </article>;
    })}
    {!groups.length && <p className="seg-muted">导入 mask，或新建分割目标。</p>}
    {active && <div aria-live="polite" className="sr-only">当前编辑：{maskGroup(source, active).name} / {targetName(active)}</div>}
  </section>;
}
