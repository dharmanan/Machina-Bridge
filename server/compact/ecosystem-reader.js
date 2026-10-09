// At most one worker and three fixed window jobs. Duplicate reads coalesce; every caller has a bounded deadline.
// Heavy synchronous SQLite work never runs on the public HTTP/scheduler event loop.
import { Worker } from 'node:worker_threads';
import { ECOSYSTEM_WINDOWS } from './intelligence-registry.js';

export const ECOSYSTEM_READ_TIMEOUT_MS = 6000;
const failure = (code) => Object.assign(new Error(code), { code });

export function createEcosystemReader({ path, timeoutMs = ECOSYSTEM_READ_TIMEOUT_MS,
  workerFactory = (url, options) => new Worker(url, options) }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('invalid_ecosystem_timeout');
  let worker = null, active = null, closed = false;
  let restarting = null;
  const jobs = new Map();
  const finish = (job, error, value) => {
    if (jobs.get(job.window) !== job) return;
    jobs.delete(job.window); clearTimeout(job.timer);
    if (active === job) active = null;
    if (error) job.reject(error); else job.resolve(value);
  };
  const reset = (error) => {
    const old = worker; worker = null;
    for (const job of [...jobs.values()]) finish(job, error);
    if (old) {
      restarting = Promise.resolve(old.terminate()).catch(() => {}).finally(() => { restarting = null; dispatch(); });
    }
  };
  const dispatch = () => {
    if (closed || active || restarting || !jobs.size) return;
    const job = jobs.values().next().value;
    if (!worker) {
      try {
        const created = workerFactory(new URL('./ecosystem-worker.js', import.meta.url), {
          workerData: { path }, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8 },
        });
        worker = created;
        created.on('message', (message) => {
          if (worker !== created || !active || message.window !== active.window) return;
          finish(active, message.error ? failure(message.error) : null, message.value);
          dispatch();
        });
        created.on('error', () => { if (worker === created) reset(failure('ecosystem_worker_failed')); });
        created.on('exit', () => { if (worker === created) reset(failure('ecosystem_worker_exited')); });
      } catch { reset(failure('ecosystem_worker_failed')); return; }
    }
    active = job;
    try { worker.postMessage({ window: job.window }); }
    catch { reset(failure('ecosystem_worker_failed')); }
  };
  return {
    read(window) {
      if (closed) return Promise.reject(failure('ecosystem_reader_closed'));
      if (!Object.hasOwn(ECOSYSTEM_WINDOWS, window)) return Promise.reject(failure('unsupported_window'));
      if (jobs.has(window)) return jobs.get(window).promise;
      const job = { window };
      job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      jobs.set(window, job);
      job.timer = setTimeout(() => {
        if (active === job) reset(failure('ecosystem_read_timeout'));
        else finish(job, failure('ecosystem_read_timeout'));
      }, timeoutMs);
      dispatch();
      return job.promise;
    },
    async close() {
      closed = true;
      reset(failure('ecosystem_reader_closed'));
      await restarting;
    },
  };
}
