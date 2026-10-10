// Recovery inventory is CPU/JSON work over historical evidence. Keep it off the live API/scheduler event loop.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { planDiscoveryRecovery } from './discovery-recovery.js';

export function createDiscoveryRecoveryPlanner({ path, timeoutMs = 10000 } = {}) {
  let worker = null, pending = null, sequence = 0, closed = false;
  const failure = code => Object.assign(new Error(code), { code });
  function finish(error, value) {
    if (!pending) return;
    const active = pending; pending = null; clearTimeout(active.timer);
    if (error) active.reject(error); else active.resolve(value);
  }
  function discard() {
    const old = worker; worker = null;
    return old?.terminate();
  }
  return {
    read(nowMs = Date.now()) {
      if (closed) return Promise.reject(failure('recovery_planner_closed'));
      if (pending) return pending.promise;
      if (!worker) {
        worker = new Worker(new URL(import.meta.url), { workerData: { path }, execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 4, stackSizeMb: 2 } });
        const current = worker;
        current.on('message', message => {
          if (current !== worker || message.id !== pending?.id) return;
          finish(message.error ? failure(message.error) : null, message.value);
        });
        current.on('error', () => { if (current === worker) { finish(failure('recovery_planner_failed')); void discard(); } });
        current.on('exit', () => { if (current === worker) { worker = null; finish(failure('recovery_planner_exit')); } });
      }
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const id = ++sequence;
      const timer = setTimeout(() => { finish(failure('recovery_planner_timeout')); void discard(); }, timeoutMs);
      pending = { promise, resolve, reject, timer, id };
      worker.postMessage({ id, nowMs });
      return promise;
    },
    async close() {
      closed = true; finish(failure('recovery_planner_closed')); await discard();
    },
  };
}

if (!isMainThread) {
  const db = new DatabaseSync(workerData.path, { readOnly: true });
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
  parentPort.on('message', ({ id, nowMs }) => {
    try {
      db.exec('BEGIN');
      let plan;
      try { plan = planDiscoveryRecovery(db, { now: nowMs }); } finally { db.exec('ROLLBACK'); }
      const { digest, counts, candidate } = plan;
      parentPort.postMessage({ id, value: { digest, counts, candidate } });
    } catch (error) { parentPort.postMessage({ id, error: error.code ?? 'recovery_planning_failed' }); }
  });
}
