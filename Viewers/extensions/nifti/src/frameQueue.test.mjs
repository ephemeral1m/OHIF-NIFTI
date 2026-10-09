import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameQueue } from './frameQueue.mjs';
const tick = () => new Promise(r => setTimeout(r, 0));

test('deduplicates consumers, preserves current requests, reserves interaction slot', async () => {
  const pending = new Map(), calls = [], loaded = new Set();
  const queue = new FrameQueue(50, (i, signal) => new Promise((resolve, reject) => {
    calls.push(i); pending.set(i, () => { loaded.add(i); resolve(); });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), i => loaded.has(i));
  queue.prefetch(20); await tick();
  assert.equal(pending.size, 2);
  const subscriber = new AbortController();
  const first = queue.ensure(21, 'interactive', subscriber.signal).catch(e => e.name);
  const second = queue.ensure(21);
  subscriber.abort();
  const far = queue.ensure(45); await tick();
  assert.equal(calls.filter(i => i === 21).length, 1);
  assert(calls.includes(45));
  pending.get(21)(); pending.get(45)();
  assert.equal(await first, 'AbortError'); await second; await far;
  queue.close(); await tick(); assert.equal(queue.jobs.size, 0);
});

test('only fetches neighborhood and reuses loaded slices after jumps', async () => {
  const loaded = new Set([25]), calls = [];
  const queue = new FrameQueue(100, async i => { calls.push(i); loaded.add(i); }, i => loaded.has(i));
  queue.prefetch(25); for (let n=0;n<25;n++) await tick();
  assert.deepEqual([...loaded].sort((a,b)=>a-b), Array.from({length:17},(_,i)=>17+i));
  await queue.ensure(25); assert.equal(calls.length,16);
  await queue.ensure(90); queue.prefetch(90); for (let n=0;n<25;n++) await tick();
  assert(loaded.has(90)); assert(!loaded.has(50)); queue.close();
});

test('canceled prefetch cannot poison a new interactive subscriber', async () => {
  const queue = new FrameQueue(30, (i, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 5);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, {once:true});
  }), () => false);
  const abort = new AbortController();
  const old = queue.ensure(5, 'prefetch', abort.signal).catch(e=>e.name);
  await tick(); abort.abort(); const current = queue.ensure(5);
  assert.equal(await old, 'AbortError'); await current; queue.close();
});

test('a distant navigation cancels obsolete background work before its new frame displays', async () => {
  const started = [], signals = [];
  const queue = new FrameQueue(100, (index, signal) => new Promise((resolve, reject) => {
    started.push(index); signals.push(signal);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), () => false);
  queue.prefetch(10); await tick(); const old = [...signals];
  queue.cancelObsolete(80); const current = queue.ensure(80).catch(e => e.name); await tick();
  assert(old.every(signal => signal.aborted)); assert.equal(queue.nearby.size, 0);
  assert(started.includes(80)); assert.equal(queue.active, 1);
  queue.close(); assert.equal(await current, 'AbortError');
});
