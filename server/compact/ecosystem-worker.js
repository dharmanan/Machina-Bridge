// Separate read-only SQLite connection and short WAL snapshot; no writer, scheduler or RPC.
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createCompactReadModel } from './read-model.js';
import { performance } from 'node:perf_hooks';

const readModel = createCompactReadModel({ path: workerData.path, DatabaseSync, busyTimeoutMs: 1000 });
const DIAGNOSTICS = new Set(['pool_registry_missing', 'pool_registry_metadata_malformed', 'pool_tvl_malformed',
  'packed_set_missing', 'checkpoint_not_contiguous', 'ERR_SQLITE_ERROR']);
parentPort.on('message', ({ id, kind, protocol, window }) => {
  const started = performance.now();
  parentPort.postMessage({ id, phase: 'started' });
  try {
    if (kind !== 'ecosystem' && kind !== 'pools') throw Object.assign(new Error('unsupported_read'), { code: 'unsupported_read' });
    const value = kind === 'pools' ? readModel.pools(protocol, window) : readModel.ecosystem(window);
    parentPort.postMessage({ id, value, workerMs: performance.now() - started });
  } catch (error) { parentPort.postMessage({ id, error: error?.code ?? 'read_failed',
    detail: DIAGNOSTICS.has(error?.detail) ? error.detail : undefined, workerMs: performance.now() - started }); }
});
parentPort.on('close', () => readModel.close());
