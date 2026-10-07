// One bounded enrichment pass over durable candidates. No block/log range scan or checkpoint write.
// Codespace/Railway Node24 only. The service owns this child under the existing single-writer discipline.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCompactStore } from '../server/compact/store.js';
import { createProvider } from '../server/compact/provider.js';
import { acquireWriterLock } from '../server/compact/writer-lock.js';
import { refreshDiscoverySafely } from '../server/compact/intelligence.js';
import { DEFAULT_RPC_INTERVAL_MS, MIN_RPC_INTERVAL_MS } from './run-compact-hour.mjs';

export function discoveryDrainConfig({ argv = process.argv.slice(2), env = process.env } = {}) {
  if (argv.length) throw new Error('discovery_drain_arguments_not_allowed');
  const path = env.COMPACT_SQLITE_PATH?.trim();
  if (!path || path === ':memory:' || path.startsWith('file:')) throw new Error('sqlite_path_required');
  const text = env.COMPACT_RPC_MIN_INTERVAL_MS ?? String(DEFAULT_RPC_INTERVAL_MS);
  const minIntervalMs = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < MIN_RPC_INTERVAL_MS) throw new Error('unsafe_rpc_pacing');
  return { sqlitePath: resolve(path), minIntervalMs };
}

export async function drainDiscovery({ store, provider, now = Date.now() }) {
  const before = store.checkpoint();
  if (!before) return { status: 'unavailable', reason: 'discovery_checkpoint_missing' };
  const result = await refreshDiscoverySafely({ store, provider, now });
  const after = store.checkpoint();
  if (!after || before.hourStart !== after.hourStart || before.lastBlock !== after.lastBlock || before.lastHash !== after.lastHash) {
    return { status: 'unavailable', reason: 'discovery_checkpoint_changed' };
  }
  return result;
}

export async function runDiscoveryDrain({ sqlitePath, provider, print = console.log }) {
  let lock = null; let db = null;
  try {
    if (!existsSync(sqlitePath)) throw new Error('database_not_ready');
    lock = acquireWriterLock(sqlitePath, { owner: 'discovery-drain' });
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(sqlitePath);
    const result = await drainDiscovery({ store: createCompactStore(db), provider });
    print(`DISCOVERY_DRAIN ${JSON.stringify(result)}`);
    return result;
  } catch {
    const result = { status: 'unavailable', reason: 'discovery_drain_unavailable' };
    print(`DISCOVERY_DRAIN ${JSON.stringify(result)}`);
    return result;
  } finally { db?.close(); lock?.release(); }
}

async function main() {
  try {
    const config = discoveryDrainConfig();
    const result = await runDiscoveryDrain({ ...config, provider: createProvider({ minIntervalMs: config.minIntervalMs }) });
    process.exitCode = result.status === 'available' ? 0 : 1;
  } catch { console.log('DISCOVERY_DRAIN unavailable invalid_configuration'); process.exitCode = 1; }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
