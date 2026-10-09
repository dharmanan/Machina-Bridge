// EXACTLY one stored UTC hour. Operator invocation for deterministic failures requires separate approval.
// This file is not run by the implementation task. Transient Gateway-only failures may use it in the scheduler.
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { repairConfig } from './repair-compact-projection-hour.mjs';
import { repairStoredGatewayHour } from '../server/compact/gateway-repair.js';
import { createCompactStore } from '../server/compact/store.js';
import { createProvider } from '../server/compact/provider.js';
import { acquireWriterLock } from '../server/compact/writer-lock.js';

export async function main() {
  let db, lock;
  try {
    const config = repairConfig();
    if (!existsSync(config.sqlitePath)) throw new Error('database_missing');
    lock = acquireWriterLock(config.sqlitePath, { owner: 'repair-compact-gateway-hour' });
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(config.sqlitePath);
    const store = createCompactStore(db);
    const provider = createProvider({ minIntervalMs: config.minIntervalMs, maxAttempts: 1 });
    const result = await repairStoredGatewayHour({ store, provider, hourStart: config.hourStart });
    console.log(`GATEWAY_REPAIR ${JSON.stringify({ hour: new Date(config.hourStart * 1000).toISOString(), ...result,
      provider: provider.stats })}`);
    console.log('RESULT PASS');
  } catch (error) {
    console.log(`RESULT FAIL ${error.code ?? error.message}`);
    process.exitCode = 1;
  } finally { db?.close(); lock?.release(); }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
