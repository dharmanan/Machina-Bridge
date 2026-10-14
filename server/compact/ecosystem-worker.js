// Separate read-only SQLite connection and short WAL snapshot; no writer, scheduler or RPC.
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createCompactReadModel } from './read-model.js';
import { performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

// Parent V8 flags can override Worker resourceLimits. Refuse reads rather than silently exceeding the heap budget.
if (getHeapStatistics().heap_size_limit > 64 * 1024 * 1024) {
  throw Object.assign(new Error('ecosystem_worker_heap_limit'), { code: 'ecosystem_worker_heap_limit' });
}

// Opt-in test telemetry, never a public payload or a background task. RSS is process-wide; heap/external are this isolate.
const metricsEnabled = workerData.collectMetrics === true;
let samples = 0, peak = null;
const memory = () => ({ ...process.memoryUsage(), heapSizeLimit: getHeapStatistics().heap_size_limit });
const sample = () => {
  if (!metricsEnabled) return;
  const current = memory();
  for (const key of Object.keys(current)) peak[key] = Math.max(peak[key] ?? 0, current[key]);
};
const readModel = createCompactReadModel({ path: workerData.path, DatabaseSync, busyTimeoutMs: 1000,
  onReadSample: metricsEnabled ? () => { if (++samples % 32 === 0) sample(); } : null });
const DIAGNOSTICS = new Set(['pool_registry_missing', 'pool_registry_metadata_malformed', 'pool_tvl_malformed',
  'packed_set_missing', 'checkpoint_not_contiguous', 'ERR_SQLITE_ERROR']);
parentPort.on('message', ({ id, kind, protocol, window }) => {
  const started = performance.now();
  if (metricsEnabled) { peak = {}; samples = 0; sample(); }
  const metrics = () => {
    if (!metricsEnabled) return undefined;
    sample(); return { memory: peak, proofCache: readModel.poolProofStats(), sampledPieces: samples };
  };
  parentPort.postMessage({ id, phase: 'started' });
  try {
    if (kind !== 'ecosystem' && kind !== 'pools') throw Object.assign(new Error('unsupported_read'), { code: 'unsupported_read' });
    const value = kind === 'pools' ? readModel.pools(protocol, window) : readModel.ecosystem(window);
    parentPort.postMessage({ id, value, workerMs: performance.now() - started, metrics: metrics() });
  } catch (error) { parentPort.postMessage({ id, error: error?.code ?? 'read_failed',
    detail: DIAGNOSTICS.has(error?.detail) ? error.detail : undefined, workerMs: performance.now() - started, metrics: metrics() }); }
});
parentPort.on('close', () => readModel.close());
