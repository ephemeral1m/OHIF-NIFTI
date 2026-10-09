import React, { useEffect, useRef, useState } from 'react';
import { ensureSlice } from './streaming';

/** Isolated raster preview: it never registers a Cornerstone tool or editable labelmap. */
export default function HistoryPreview({ preview, onEnd, servicesManager }) {
  const { source, item, pixels } = preview;
  const [nx, ny, nz] = source.descriptor.dimensions;
  const [slice, setSlice] = useState(Math.floor(nz / 2));
  const canvas = useRef<HTMLCanvasElement>(null);
  const [readySlice, setReadySlice] = useState(-1), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setReadySlice(-1); setError('');
    ensureSlice(source, slice, controller.signal).then(() => { if (!controller.signal.aborted) setReadySlice(slice); })
      .catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, [source, slice]);
  useEffect(() => { setSlice(Math.floor(nz / 2)); }, [preview]);
  useEffect(() => {
    if (!source.scalarData || !canvas.current || readySlice !== slice) return;
    let low = source.descriptor.min, high = source.descriptor.max;
    const { viewportGridService, cornerstoneViewportService } = servicesManager.services;
    const viewport = cornerstoneViewportService.getCornerstoneViewport(viewportGridService.getState().activeViewportId);
    const range = viewport?.getProperties?.()?.voiRange;
    if (Number.isFinite(range?.lower) && Number.isFinite(range?.upper) && range.upper > range.lower) { low = range.lower; high = range.upper; }
    const context = canvas.current.getContext('2d');
    const image = context.createImageData(nx, ny), start = Math.min(slice, nz - 1) * nx * ny;
    const color = item.displayColor || [82, 214, 241, 255];
    for (let i = 0; i < nx * ny; i++) {
      const grey = Math.max(0, Math.min(255, (source.scalarData[start + i] - low) / Math.max(1, high - low) * 255));
      for (let c = 0; c < 3; c++) image.data[4*i+c] = pixels[start+i] ? grey * .45 + color[c] * .55 : grey;
      image.data[4*i+3] = 255;
    }
    context.putImageData(image, 0, 0);
  }, [preview, slice, readySlice]);
  const affine = source.descriptor.voxelToLPS;
  const ratio = nx * Math.hypot(...affine.slice(0, 3).map(r => r[0])) / (ny * Math.hypot(...affine.slice(0, 3).map(r => r[1])));
  return <section className="rounded border border-primary/40 bg-black p-3" aria-label="只读历史影像预览">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[14px] text-primary"><span>历史预览 v{item.version} · 只读</span><button className="rounded border border-primary/40 px-3 py-2" onClick={onEnd}>结束预览</button></div>
    {readySlice !== slice && <p role="status" className="text-primary">{error || '当前层加载中…'}</p>}
    <div className="flex justify-center"><canvas ref={canvas} width={nx} height={ny} aria-label={`${item.name} v${item.version} 原始切片 ${slice + 1}`}
      style={{ width: '100%', maxHeight: 430, objectFit: 'contain', opacity: readySlice === slice ? 1 : 0, aspectRatio: String(ratio) }} /></div>
    <label className="mt-3 block text-[14px] text-gray-300">原始切片 {slice + 1} / {nz}<input className="mt-2 w-full" style={{ appearance: 'auto', WebkitAppearance: 'auto', accentColor: '#52d6f1' }} aria-label="历史预览切片" type="range" min={0} max={nz-1} value={slice} onChange={e => setSlice(Number(e.target.value))} /></label>
    <p className="mt-2 text-[14px] text-gray-400">当前编辑保持不变。此区域仅用于查看历史，不支持绘制。</p>
  </section>;
}
