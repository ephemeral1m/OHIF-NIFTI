/** One decoder per active transfer, reused until its source is released. */
export class FrameWorkerPool {
  constructor(createWorker, limit = 3) {
    this.createWorker = createWorker; this.limit = limit;
    this.idle = []; this.active = new Set(); this.pending = []; this.disposed = false;
  }
  decode(file, descriptor, frame, signal) {
    return new Promise((resolve, reject) => {
      if (this.disposed || signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
      const job = { file, descriptor, frame, signal, resolve, reject, done: false };
      job.abort = () => this.finish(job, new DOMException('Cancelled', 'AbortError'));
      signal?.addEventListener('abort', job.abort, { once: true });
      this.pending.push(job); this.pump();
    });
  }
  pump() {
    while (!this.disposed && this.pending.length && this.active.size < this.limit) {
      const job = this.pending.shift();
      if (job.done) continue;
      this.active.add(job);
      try {
        const worker = job.worker = this.idle.pop() || this.createWorker();
        job.timer = setTimeout(() => this.finish(job, Error('NIfTI 切片解码超时，请重试。')), 300000);
        worker.onerror = event => this.finish(job, Error(event.message));
        worker.onmessageerror = () => this.finish(job, Error('NIfTI worker 返回数据失败，请重试。'));
        worker.onmessage = ({ data }) => {
          if (data.error) this.finish(job, Object.assign(Error(data.error.message), { code: data.error.code }));
          else if (data.result) this.finish(job, null, data.result);
        };
        worker.postMessage({ file: job.file, wireDtype: job.descriptor.wireDtype,
          workingDtype: job.descriptor.workingDtype, frame: job.frame });
      } catch (error) { this.finish(job, error); }
    }
  }
  finish(job, error, value) {
    if (job.done) return;
    job.done = true; clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
    this.active.delete(job);
    this.pending = this.pending.filter(item => item !== job);
    if (job.worker) {
      job.worker.onmessage = job.worker.onerror = job.worker.onmessageerror = null;
      if (error || this.disposed) job.worker.terminate();
      else this.idle.push(job.worker);
    }
    error ? job.reject(error) : job.resolve(value);
    this.pump();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const job of [...this.pending, ...this.active]) this.finish(job, new DOMException('Cancelled', 'AbortError'));
    for (const worker of this.idle) worker.terminate();
    this.idle = [];
  }
}
