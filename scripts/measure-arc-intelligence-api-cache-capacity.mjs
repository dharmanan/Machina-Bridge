// Physical cache-layout stress measurement with real dense-hour address identities. Not 24/720 real hours.
// Disposable /tmp only, no backups, raw block archive, production access or cleanup.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPipeline, assertHeapBudget, inspectCapacity } from '../server/intelligence-pipeline/storage.js';
import { verifyNetworkSeal, decodeIds } from '../server/intelligence-pipeline/network-hour-store.js';
import assert from 'node:assert/strict';

const [networkPath, reportPath] = process.argv.slice(2);
if (![networkPath, reportPath].every(p => p?.startsWith('/tmp/'))) throw Error('isolated_tmp_paths_required');
const p = openPipeline({ path: networkPath, readOnly: true, verifySeal: verifyNetworkSeal });
const u = p.db.prepare('SELECT unit_id FROM arc_pipeline_units WHERE hour_start IS NOT NULL ORDER BY hour_start LIMIT 1').get();
const s = p.getSeal(u.unit_id).summary;
const directory = mkdtempSync(join(tmpdir(), 'arc-api-cache-capacity-')), path = join(directory, 'cache.sqlite');
const db = new DatabaseSync(path);
const used = 1981427712, volume = 4838498304;
const guard = bytes => {
  const r = inspectCapacity({ directory, knownOtherBytes: used, volumeLimitBytes: volume, plannedBytes: bytes });
  if (!r.ok) throw Error(r.reason); return r;
};
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-2048;
  CREATE TABLE cache_hour_addresses(hour_start INTEGER NOT NULL,address BLOB NOT NULL CHECK(length(address)=20),
    PRIMARY KEY(hour_start,address)) STRICT,WITHOUT ROWID;
  CREATE TABLE cache_daily_address_stage(day_start INTEGER NOT NULL,address BLOB NOT NULL CHECK(length(address)=20),
    PRIMARY KEY(day_start,address)) STRICT,WITHOUT ROWID;`);
const get = p.db.prepare('SELECT address FROM arc_pipeline_addresses WHERE id=?'), add = db.prepare('INSERT OR IGNORE INTO cache_hour_addresses VALUES(?,?)');
let heap = 0, peakWalBytes = 0, peakDirectoryBytes = 0;
const started = performance.now();
for (let hour = 0; hour < 24; hour++) {
  guard(s.network.uniqueActiveAddresses * 80 + 65536); db.exec('BEGIN IMMEDIATE');
  try {
    for (const text of [s.senderIds, s.recipientIds]) for (const id of decodeIds(text)) {
      add.run(s.hourStart + hour * 3600, get.get(id).address);
    }
    guard(0); db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const sample = guard(0); peakDirectoryBytes = Math.max(peakDirectoryBytes, sample.usedBytes);
  try { peakWalBytes = Math.max(peakWalBytes, statSync(path + '-wal').size); } catch { /* no WAL file */ }
  heap = Math.max(heap, process.memoryUsage().heapUsed); assertHeapBudget();
}
const day = Math.floor(s.hourStart / 86400) * 86400;
db.exec('BEGIN IMMEDIATE');
db.prepare('INSERT INTO cache_daily_address_stage SELECT ?,address FROM cache_hour_addresses WHERE hour_start=?').run(day, s.hourStart);
db.exec('COMMIT');
assert.equal(db.prepare('SELECT COUNT(*) n FROM cache_hour_addresses').get().n, 24 * s.network.uniqueActiveAddresses);
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const tables = db.prepare('SELECT name,SUM(pgsize) bytes FROM dbstat GROUP BY name ORDER BY name').all();
const cacheBytes = tables.filter(t => t.name.startsWith('cache_')).reduce((n, t) => n + t.bytes, 0);
const budgets = { safetyBytes: 512 * 1024 * 1024, liveGrowthBytes: 256 * 1024 * 1024, extraWalBytes: 128 * 1024 * 1024,
  temporaryWorkBytes: 128 * 1024 * 1024 };
const reserved = Object.values(budgets).reduce((n, x) => n + x, 0), newDataBudget = volume - used - reserved;
const previousMeasuredDex720Fixture = 1767297024;
const report = { scope: '24 dense-hour population copies, exact API cache table/index layout; NOT 24 actual canonical hours or all-84-field 720-hour capacity proof',
  directory, sourceHour: new Date(s.hourStart * 1000).toISOString(), uniqueAddressesPerHour: s.network.uniqueActiveAddresses,
  measuredTables: tables, databaseBytes: statSync(path).size, allocatedDatabaseBytes: statSync(path).blocks * 512,
  peakWalBytes, peakDirectoryBytes, sampledHeapBytes: heap, heapBudget: assertHeapBudget(), durationMs: Math.round(performance.now() - started),
  ownerInventory: { capacityBytes: volume, usedBytes: used, freeBytes: volume - used, oldBackupsPreserved: true },
  planningAllowancesNotMeasuredFuturePeaks: budgets, additionalPermanentDataBudgetBytes: newDataBudget,
  previousDex720Fixture: { bytes: previousMeasuredDex720Fixture, real720Hours: false },
  measuredApiMembershipCacheBytes: cacheBytes,
  remainingAfterPreviousDexFixtureAndThisCacheBytes: newDataBudget - previousMeasuredDex720Fixture - cacheBytes,
  excludes: ['Permanent network dictionary and source seals', 'Protocol evidence and pinned views', 'API family/hour/publication records',
    'Pool/price/valuation/discovery records', 'Actual 720 distinct mainnet hours and future growth'],
  fullProductCapacityProven: false, productionAccess: false, rpcRequests: 0, backupsCreated: false };
writeFileSync(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); db.close(); p.close();
