// A bounded cooperative scheduler interface; no timers or workers are started on import.
export function createFoundationScheduler({ maxTasks = 3 } = {}) {
  if (!Number.isSafeInteger(maxTasks) || maxTasks < 1 || maxTasks > 3) throw new Error('invalid_scheduler_bounds');
  let running = false;
  return {
    async tick(tasks, { signal } = {}) {
      if (running) return { skipped:true };
      if (!Array.isArray(tasks) || tasks.length > maxTasks || tasks.some((task) => typeof task !== 'function')) {
        throw new Error('invalid_scheduler_tasks');
      }
      running = true;
      try {
        const results = [];
        for (const task of tasks) {
          if (signal?.aborted) break;
          try { results.push({ status:'fulfilled',value:await task({signal}) }); }
          catch { results.push({ status:'rejected',reason:'task_unavailable' }); }
        }
        return { results,aborted:signal?.aborted === true };
      } finally { running = false; }
    },
  };
}
