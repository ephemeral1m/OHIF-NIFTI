import { FrameWorkerPool } from './frameWorkerPool.mjs';

function fixture(limit = 3) {
  const workers = [];
  const create = () => { const worker = { postMessage: jest.fn(), terminate: jest.fn() }; workers.push(worker); return worker; };
  const pool = new FrameWorkerPool(create, limit);
  const decode = signal => pool.decode({}, { wireDtype: '<i2', workingDtype: '<i2' }, {}, signal);
  const respond = (worker, value = 42) => worker.onmessage({ data: { result: new Int16Array([value]) } });
  return { workers, pool, decode, respond };
}

test('nearby frames reuse decoders with at most three concurrent workers', async () => {
  const f = fixture(); const pending = Array.from({ length: 8 }, () => f.decode());
  expect(f.workers).toHaveLength(3);
  for (let i = 0; i < 8; i++) f.respond(f.workers[i % 3], i);
  expect((await Promise.all(pending)).map(v => v[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(f.workers).toHaveLength(3); f.pool.dispose();
  for (const worker of f.workers) expect(worker.terminate).toHaveBeenCalledTimes(1);
});

test('cancelling a running decoder terminates it without disturbing another frame', async () => {
  const f = fixture(); const controller = new AbortController();
  const first = f.decode(controller.signal).catch(e => e); const second = f.decode();
  controller.abort(); expect((await first).name).toBe('AbortError');
  expect(f.workers[0].terminate).toHaveBeenCalledTimes(1); f.respond(f.workers[1], 73);
  expect((await second)[0]).toBe(73); f.pool.dispose();
});

test('case disposal cancels queued and active work and rejects late requests', async () => {
  const f = fixture(1); const results = [f.decode().catch(e => e), f.decode().catch(e => e)];
  f.pool.dispose();
  expect((await Promise.all(results)).map(e => e.name)).toEqual(['AbortError', 'AbortError']);
  expect(f.workers[0].onmessage).toBeNull(); expect(f.pool.active.size).toBe(0);
  expect(f.pool.pending).toHaveLength(0); expect(f.pool.idle).toHaveLength(0);
  await expect(f.decode()).rejects.toMatchObject({ name: 'AbortError' });
});
