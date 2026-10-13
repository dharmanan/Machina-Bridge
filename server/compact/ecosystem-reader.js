// One existing read-only worker; nine fixed Ecosystem/V3/V4 window jobs. Duplicate reads coalesce.
// Heavy synchronous SQLite work never runs on the public HTTP/scheduler event loop.
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { ECOSYSTEM_WINDOWS } from './intelligence-registry.js';

export const ECOSYSTEM_READ_TIMEOUT_MS = 6000;
const failure = (code, detail) => Object.assign(new Error(code), { code, detail });

export function createEcosystemReader({ path, timeoutMs = ECOSYSTEM_READ_TIMEOUT_MS,
  workerFactory = (url, options) => new Worker(url, options), log = () => {} }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('invalid_ecosystem_timeout');
  let worker = null, active = null, closed = false;
  let restarting = null;
  let nextId = 0;
  const jobs = new Map();
  const finish = (job, error, value) => {
    if (jobs.get(job.key) !== job) return;
    jobs.delete(job.key); clearTimeout(job.timer);
    if (active === job) active = null;
    const elapsedMs = Math.round(performance.now() - job.enqueuedAt);
    const queueMs = Math.round((job.dispatchedAt ?? performance.now()) - job.enqueuedAt);
    const code = error ? /^[a-z_]{1,64}$/.test(error.code) ? error.code : 'read_failed' : 'ok';
    log(`HTTP_READ_JOB kind=${job.kind} protocol=${job.protocol ?? 'none'} window=${job.window} code=${code}`
      + ` elapsedMs=${elapsedMs} queueMs=${queueMs} workerMs=${job.workerMs ?? 'unknown'}`
      + ` phase=${job.dispatchedAt === undefined ? 'queued' : job.started ? 'read' : 'startup'}`);
    if (error) job.reject(error); else job.resolve(value);
  };
  const reset = (error, all = false) => {
    const old = worker; worker = null;
    // An active failure must not discard unrelated queued sections. Their original deadlines still apply.
    if (all) for (const job of [...jobs.values()]) finish(job, error);
    else if (active) finish(active, error);
    if (old) {
      restarting = Promise.resolve(old.terminate()).catch(() => {}).finally(() => { restarting = null; dispatch(); });
    } else if (!restarting) queueMicrotask(dispatch);
  };
  const dispatch = () => {
    if (closed || active || restarting || !jobs.size) return;
    const job = jobs.values().next().value;
    if (performance.now() - job.enqueuedAt >= timeoutMs) {
      finish(job, failure(job.kind === 'pools' ? 'pools_read_timeout' : 'ecosystem_read_timeout'));
      queueMicrotask(dispatch); return;
    }
    active = job;
    job.dispatchedAt = performance.now();
    if (!worker) {
      try {
        const created = workerFactory(new URL('./ecosystem-worker.js', import.meta.url), {
          workerData: { path }, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8 },
        });
        worker = created;
        created.on('message', (message) => {
          if (worker !== created || !active || message.id !== active.id) return;
          if (message.phase === 'started') { active.started = true; return; }
          if (Number.isFinite(message.workerMs) && message.workerMs >= 0) active.workerMs = Math.round(message.workerMs);
          finish(active, message.error ? failure(message.error, message.detail) : null, message.value);
          dispatch();
        });
        created.on('error', () => { if (worker === created) reset(failure('ecosystem_worker_failed')); });
        created.on('exit', () => { if (worker === created) reset(failure('ecosystem_worker_exited')); });
      } catch { reset(failure('ecosystem_worker_failed')); return; }
    }
    try { worker.postMessage({ id: job.id, kind: job.kind, protocol: job.protocol, window: job.window }); }
    catch { reset(failure('ecosystem_worker_failed')); }
  };
  const read = (kind, window, protocol) => {
    if (closed) return Promise.reject(failure('ecosystem_reader_closed'));
    if (!Object.hasOwn(ECOSYSTEM_WINDOWS, window)) return Promise.reject(failure('unsupported_window'));
    if (kind === 'pools' && !['v3', 'v4'].includes(protocol)) return Promise.reject(failure('unsupported_protocol'));
    const key = `${kind}:${protocol ?? ''}:${window}`;
    if (jobs.has(key)) return jobs.get(key).promise;
    const job = { key, id: ++nextId, kind, window, protocol, enqueuedAt: performance.now() };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    jobs.set(key, job);
    job.timer = setTimeout(() => {
      const error = failure(kind === 'pools' ? 'pools_read_timeout' : 'ecosystem_read_timeout');
      if (active === job) reset(error);
      else finish(job, error);
    }, timeoutMs);
    dispatch();
    return job.promise;
  };
  return {
    read: (window) => read('ecosystem', window),
    readPools: (protocol, window) => read('pools', window, protocol),
    async close() {
      closed = true;
      reset(failure('ecosystem_reader_closed'), true);
      await restarting;
    },
  };
}
