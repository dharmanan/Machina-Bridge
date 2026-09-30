import { setTimeout as sleep } from 'node:timers/promises';

// Every A2 caller shares this budget. Zero spacing preserves direct foundation callers;
// the production A2 runtime always supplies its validated pacing configuration.
export function createRpcBudget({ maxConcurrency = 4, maxPending = 100, minIntervalMs = 0,
  cooldownMs = 15000, now = () => performance.now(), sleepImpl = sleep } = {}) {
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 4
    || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 100
    || !Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0 || minIntervalMs > 60000
    || !Number.isSafeInteger(cooldownMs) || cooldownMs < 1 || cooldownMs > 3600000
    || typeof now !== 'function' || typeof sleepImpl !== 'function') throw new Error('invalid_rpc_budget');
  let active = 0;
  let nextStart = -Infinity;
  let cooldownUntil = -Infinity;
  let wake = null;
  const pending = [];
  function cancelWake() {
    const old = wake;
    wake = null;
    old?.controller.abort();
  }
  function drain() {
    if (!pending.length) { cancelWake(); return; }
    if (active >= maxConcurrency || wake) return;
    while (active < maxConcurrency && pending.length) {
      const delay = Math.max(nextStart,cooldownUntil)-now();
      if (delay > 0) {
        const timer = { controller:new AbortController() };
        wake = timer;
        Promise.resolve().then(() => sleepImpl(delay,undefined,{signal:timer.controller.signal}))
          .catch(() => {}).finally(() => {
            if (wake !== timer) return;
            wake = null;
            drain();
          });
        return;
      }
      const entry = pending.shift();
      entry.signal?.removeEventListener('abort',entry.abort);
      if (entry.signal?.aborted) { entry.reject(new Error('operation_aborted')); continue; }
      active++;
      nextStart = now()+minIntervalMs;
      Promise.resolve().then(() => {
        if (entry.signal?.aborted) throw new Error('operation_aborted');
        return entry.work();
      }).then(entry.resolve,entry.reject).finally(() => { active--; drain(); });
    }
  }
  function run(work, { signal } = {}) {
    if (typeof work !== 'function') throw new Error('invalid_rpc_task');
    if (signal?.aborted) return Promise.reject(new Error('operation_aborted'));
    if (pending.length >= maxPending) return Promise.reject(new Error('rpc_budget_full'));
    return new Promise((resolve,reject) => {
      const entry = { work,signal,resolve,reject };
      entry.abort = () => {
        const index = pending.indexOf(entry);
        if (index >= 0) { pending.splice(index,1); reject(new Error('operation_aborted')); drain(); }
      };
      signal?.addEventListener('abort',entry.abort,{once:true});
      pending.push(entry);
      drain();
    });
  }
  const budget = Object.freeze({ run,
    notifyRateLimit() {
      cooldownUntil = Math.max(cooldownUntil,now()+cooldownMs);
      cancelWake();
      drain();
    },
    get active() { return active; }, get pending() { return pending.length; },
    wrap(rpc) { return Object.freeze({ url:rpc.url,budget,
      request(method,params = [],options = {}) { return run(() => rpc.request(method,params,options),options); } }); },
  });
  return budget;
}
