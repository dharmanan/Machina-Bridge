// Separate read-only SQLite connection and short WAL snapshot; no writer, scheduler or RPC.
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createCompactReadModel } from './read-model.js';

const readModel = createCompactReadModel({ path: workerData.path, DatabaseSync, busyTimeoutMs: 1000 });
parentPort.on('message', ({ window }) => {
  try { parentPort.postMessage({ window, value: readModel.ecosystem(window) }); }
  catch (error) { parentPort.postMessage({ window, error: error?.code ?? 'read_failed' }); }
});
parentPort.on('close', () => readModel.close());
