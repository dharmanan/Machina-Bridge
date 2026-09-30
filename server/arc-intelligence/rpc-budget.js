// Future A2 workers must share one instance. A2.1 does not attach it to A1 or start a worker.
export function createRpcBudget({ maxConcurrency = 4, maxPending = 100 } = {}) {
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 4
    || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 100) throw new Error('invalid_rpc_budget');
  let active = 0;
  const pending = [];
  function drain() {
    while (active < maxConcurrency && pending.length) {
      const entry = pending.shift();
      entry.signal?.removeEventListener('abort', entry.abort);
      if (entry.signal?.aborted) { entry.reject(new Error('operation_aborted')); continue; }
      active++;
      Promise.resolve().then(entry.work).then(entry.resolve,entry.reject).finally(() => { active--; drain(); });
    }
  }
  function run(work, { signal } = {}) {
    if (typeof work !== 'function') throw new Error('invalid_rpc_task');
    if (signal?.aborted) return Promise.reject(new Error('operation_aborted'));
    if (pending.length >= maxPending) return Promise.reject(new Error('rpc_budget_full'));
    return new Promise((resolve,reject) => {
      const entry = { work, signal, resolve, reject };
      entry.abort = () => {
        const index = pending.indexOf(entry);
        if (index >= 0) { pending.splice(index,1); reject(new Error('operation_aborted')); }
      };
      signal?.addEventListener('abort',entry.abort,{ once:true });
      pending.push(entry); drain();
    });
  }
  return Object.freeze({ run, get active() { return active; }, get pending() { return pending.length; },
    wrap(rpc) { return Object.freeze({ url:rpc.url,
      request(method,params = [],options = {}) { return run(() => rpc.request(method,params,options),options); } }); } });
}
