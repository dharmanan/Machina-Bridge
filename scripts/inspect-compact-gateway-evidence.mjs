// Read-only evidence for at most TWO exact already-stored hours. No boundary search, migration, repair or metadata.
// Twenty HTTP requests TOTAL, one attempt each, >=1s pacing, <=90s until the last request starts, 10s request timeout.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertHourIso } from '../server/compact/scheduler.js';
import { createProvider } from '../server/compact/provider.js';
import { repairStoredGatewayHour } from '../server/compact/gateway-repair.js';

export async function inspectGatewayEvidence({ argv = process.argv.slice(2), env = process.env } = {}) {
  if (argv.length < 1 || argv.length > 2) throw new Error('one_or_two_exact_hours_required');
  const hours = [...new Set(argv.map((hour) => Date.parse(assertHourIso(hour)) / 1000))];
  const path = env.COMPACT_SQLITE_PATH?.trim();
  if (!path || path === ':memory:' || path.startsWith('file:') || !existsSync(path)) throw new Error('existing_sqlite_path_required');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(resolve(path), { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  if (db.prepare("SELECT value FROM compact_meta WHERE key='schema_version'").get()?.value !== '2') { db.close(); throw new Error('schema_version_mismatch'); }
  const startedAt = Date.now();
  let requests = 0;
  const provider = createProvider({ minIntervalMs: 1000, maxAttempts: 1, timeoutMs: 10000,
    fetchImpl: (...args) => {
      if (Date.now() - startedAt >= 90000 || requests >= 20) throw new Error('evidence_request_budget_exhausted');
      requests += 1;
      return globalThis.fetch(...args);
    } });
  const store = {
    gatewayRepairInput(hourStart) {
      const row = db.prepare(`SELECT h.*, f.status, f.reason FROM compact_hours h JOIN compact_family_hours f
        ON f.hour_start=h.hour_start AND f.family='gateway' WHERE h.hour_start=?`).get(BigInt(hourStart));
      return row ? { hourStart, firstBlock: row.first_block, lastBlock: row.last_block,
        firstHash: row.first_hash, lastHash: row.last_hash, parentHash: row.parent_hash,
        networkSha: row.network_sha256, status: row.status, reason: row.reason } : null;
    },
    commitGatewayRepair() { throw new Error('read_only_evidence_command'); },
  };
  try {
    for (const hourStart of hours) {
      try {
        const result = await repairStoredGatewayHour({ store, provider, hourStart, mode: 'inspect' });
        console.log(JSON.stringify({ hour: new Date(hourStart * 1000).toISOString(), ...result }));
      } catch (error) {
        console.log(JSON.stringify({ hour: new Date(hourStart * 1000).toISOString(), reason: error.code ?? error.message,
          evidence: error.evidence ?? null, storedReason: store.gatewayRepairInput(hourStart)?.reason ?? null }));
        if (!error.evidence) break; // Provider/budget/verification failures never trigger further requests.
      }
    }
  } finally { console.log(JSON.stringify({ readOnly: true, requests, maximumRequests: 20 })); db.close(); }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { await inspectGatewayEvidence(); } catch (error) { console.log(`EVIDENCE_FAIL ${error.code ?? error.message}`); process.exitCode = 1; }
}
