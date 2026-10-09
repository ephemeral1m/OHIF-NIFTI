/** AI edits existing labelmap pixels. No segmentation creation or draft I/O. */
export type NnTarget = {
  seriesUID: string;
  studyUID: string;
  segmentationId: string;
  segmentIndex: number;
  viewportId: string;
  imageIds: string[];
  referenceImageIds: string[];
  shape: number[];
  slices: any[];
  promptSlices: string[];
  nativeSource?: {
    sourceId: string; geometryHash: string; maskOrder: number[]; promptOrder: number[];
  };
};

export const targetKey = (t: Pick<NnTarget, 'seriesUID' | 'segmentationId' | 'segmentIndex'>) =>
  JSON.stringify([t.seriesUID, t.segmentationId, t.segmentIndex]);

export type NnTicket = { target: NnTarget; generation: number; revision: number; epoch: number };
type Prompt = { uid: string; kind: string; value: any };
type Reply = { pixels: Uint8Array; context: any; shape: number[]; elapsed?: number; flipped?: boolean };
type Adapter = {
  capture: () => NnTarget;
  inspect: (target: NnTarget, includeBuffer: boolean) => Promise<{ buffer?: Uint8Array; maskHash: string }>;
  prompts: (target: NnTarget, epoch: number) => Prompt[];
  infer: (context: any, seed: Uint8Array | undefined, prompts: Prompt[]) => Promise<Reply>;
  commit: (target: NnTarget, reply: Reply) => { clipped: boolean };
  retirePrompts: (prompts: Prompt[]) => void;
  notify: (message: string, type?: string) => void;
};

/** Validate the ENTIRE response before touching any original buffer. */
export function commitPrediction(slices: ArrayLike<number>[], segmentIndex: number, prediction: Uint8Array) {
  if (!slices.length || !slices[0].length || slices.some(s => s.length !== slices[0].length) ||
      prediction.length !== slices.length * slices[0].length || prediction.some(v => v !== 0 && v !== 1)) {
    throw new Error('AI 返回的 mask 尺寸或像素格式无效，原 mask 未修改。');
  }
  let offset = 0;
  let clipped = false;
  const modifiedSlices: number[] = [];
  const foregroundSlices: number[] = [];
  for (let z = 0; z < slices.length; z++) {
    const slice = slices[z] as any;
    let modified = false;
    let foreground = false;
    for (let i = 0; i < slice.length; i++, offset++) {
      const old = slice[i];
      if (old !== 0 && old !== segmentIndex) {
        if (prediction[offset]) clipped = true;
        continue;
      }
      const next = prediction[offset] ? segmentIndex : 0;
      if (next === segmentIndex) foreground = true;
      if (old !== next) { slice[i] = next; modified = true; }
    }
    if (modified) modifiedSlices.push(z);
    if (foreground) foregroundSlices.push(z);
  }
  return { clipped, modifiedSlices, foregroundSlices };
}

export function createNnEditor(adapter: Adapter) {
  const revisions = new Map<string, number>();
  let generation = 0;
  let epoch = 0;
  let selection = '';
  let binding: { key: string; revision: number; token: string } | undefined;
  let processed = new Set<string>();
  let pending: NnTicket | undefined;
  let running: Promise<void> | undefined;
  let committing = false;
  let requestSequence = 0;
  // Unique across page reloads, without requiring a secure-context crypto API.
  const clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  function clearSession() { binding = undefined; processed = new Set(); }
  function observe(): NnTicket | undefined {
    let target: NnTarget | undefined;
    try { target = adapter.capture(); } catch { /* No editable selected mask. */ }
    const next = target ? `${target.viewportId}:${targetKey(target)}:${target.imageIds.join('|')}` : '';
    if (selection !== next) {
      selection = next;
      generation++;
      epoch++;
      clearSession();
    }
    return target ? { target, generation, epoch, revision: revisions.get(target.segmentationId) || 0 } : undefined;
  }
  function isCurrent(ticket: NnTicket) {
    const now = observe();
    return !!now && now.generation === ticket.generation && now.epoch === ticket.epoch &&
      now.revision === ticket.revision && targetKey(now.target) === targetKey(ticket.target);
  }
  function changed(segmentationId: string) {
    if (committing) return;
    revisions.set(segmentationId, (revisions.get(segmentationId) || 0) + 1);
    const current = observe();
    if (current?.target.segmentationId === segmentationId) {
      epoch++;
      clearSession();
    }
  }
  function reset() {
    const current = observe();
    if (!current) { adapter.notify('请先选择一个可编辑的 mask。', 'warning'); return; }
    adapter.retirePrompts(adapter.prompts(current.target, current.epoch));
    epoch++;
    generation++;
    pending = undefined;
    clearSession();
    adapter.notify('AI 交互已重置，当前 mask 保留；下次操作将以当前像素重新开始。', 'info');
  }

  async function runOne(queued: NnTicket) {
    // A preceding successful AI commit may have advanced the pixel revision;
    // it does not change the interaction epoch. Brush edits / switches do.
    const current = observe();
    if (!current || current.generation !== queued.generation || current.epoch !== queued.epoch) return;
    const ticket = current;
    const target = ticket.target;
    const prompts = adapter.prompts(target, ticket.epoch).filter(p => !processed.has(p.uid));
    if (!prompts.length) return;
    const key = targetKey(target);
    let seedNeeded = !binding || binding.key !== key || binding.revision !== ticket.revision;
    let snapshot = await adapter.inspect(target, seedNeeded);
    if (!isCurrent(ticket)) { adapter.notify('目标或笔刷内容已变化，未发送旧 AI 请求。', 'warning'); return; }
    let reply: Reply;
    try {
      for (let attempt = 0; ; attempt++) {
        const context: Record<string, any> = {
          version: 1, seriesUID: target.seriesUID, segmentationId: target.segmentationId,
          segmentIndex: target.segmentIndex, requestId: `${clientId}-${++requestSequence}`,
          revision: ticket.revision, generation: ticket.generation,
          sessionToken: seedNeeded ? undefined : binding?.token,
          shape: target.shape, slices: target.slices, promptSlices: target.promptSlices,
          studyInstanceUID: target.studyUID,
        };
        if (target.nativeSource) {
          Object.assign(context, target.nativeSource, { version: 2, sourceType: 'nifti',
            gridConvention: { source: 'IJK', model: 'ZYX', physical: 'LPS-mm' } });
        }
        try {
          reply = await adapter.infer(context, snapshot.buffer, prompts);
          const echoed = reply.context;
          if (!echoed || ['version', 'seriesUID', 'segmentationId', 'segmentIndex', 'requestId', 'revision', 'generation']
            .some(field => echoed[field] !== context[field]) || typeof echoed.sessionToken !== 'string' || !echoed.sessionToken ||
            JSON.stringify(reply.shape) !== JSON.stringify(target.shape)) {
            throw new Error('AI 响应与当前请求不匹配，原 mask 未修改。');
          }
          if (context.version === 2 && ['sourceType', 'sourceId', 'geometryHash'].some(field => echoed[field] !== context[field])) {
            throw new Error('AI 返回的 NIfTI 原图身份不匹配，原 mask 未修改。');
          }
          break;
        } catch (error) {
          binding = undefined;
          if (attempt !== 0 || (error as any).code !== 'NN_RESYNC_REQUIRED' || !isCurrent(ticket)) throw error;
          // Retry only the new prompts from THIS transaction, never old history.
          seedNeeded = true;
          snapshot = await adapter.inspect(target, true);
          if (!isCurrent(ticket)) throw new Error('当前 mask 已变化，取消重新同步。');
        }
      }
      // Hash check also catches edits by third-party tools missing a data event.
      const latest = await adapter.inspect(target, false);
      if (!isCurrent(ticket) || latest.maskHash !== snapshot.maskHash) {
        clearSession();
        // A missing data event must also retire this interaction epoch. Do not
        // invalidate a new target's queued prompts when discarding an old one.
        const now = observe();
        if (now?.generation === ticket.generation && now.epoch === ticket.epoch) epoch++;
        adapter.retirePrompts(prompts);
        adapter.notify('AI 结果已丢弃：目标已切换或 mask 已被编辑，当前内容保留。', 'warning');
        return;
      }
      committing = true;
      let clipped: boolean;
      try { ({ clipped } = adapter.commit(target, reply)); }
      finally { committing = false; }
      const revision = ticket.revision + 1;
      revisions.set(target.segmentationId, revision);
      binding = clipped ? undefined : { key, revision, token: reply.context.sessionToken };
      for (const prompt of prompts) processed.add(prompt.uid);
      adapter.retirePrompts(prompts);
      adapter.notify(clipped ? '已更新当前 mask；与同组其他 mask 冲突的像素已保留。' : '已更新当前 mask。', 'success');
    } catch (error) {
      binding = undefined;
      // A failed request never changes browser pixels. Retrying can reuse only
      // its current-epoch prompts and must seed again.
      adapter.notify((error as Error).message || 'AI 操作失败，当前 mask 保留。', 'error');
    }
  }

  function run(ticket?: NnTicket) {
    const captured = ticket || observe();
    if (!captured) { adapter.notify('请先在分割面板创建或选择一个未锁定的 mask。', 'warning'); return Promise.resolve(); }
    pending = captured;
    if (!running) {
      running = (async () => {
        while (pending) {
          const next = pending;
          pending = undefined;
          try { await runOne(next); }
          catch (error) { binding = undefined; adapter.notify((error as Error).message, 'error'); }
        }
      })().finally(() => { running = undefined; });
    }
    return running;
  }
  return { capture: observe, selectionChanged: observe, changed, reset, run };
}
