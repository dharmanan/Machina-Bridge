// Actual dense-hour lossless reduced-result comparison; no backup, deletion, production or RPC.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openPipeline, hash, assertHeapBudget } from '../server/intelligence-pipeline/storage.js';
import { verifyDexSeal, readDexSealSummaries } from '../server/intelligence-pipeline/dex-hour-store.js';
import { importVerifiedDexResults } from '../server/intelligence-pipeline/dex-storage-transfer.js';
const [sourcePath, reportPath] = process.argv.slice(2);
if (![sourcePath, reportPath].every(p => p?.startsWith('/tmp/'))) throw Error('isolated_tmp_paths_required');
const fingerprint = hash(readFileSync(sourcePath)), options = { verifySeal: verifyDexSeal, readSealSummaries: readDexSealSummaries };
const source = openPipeline({ path: sourcePath, readOnly: true, ...options }); source.db.exec('BEGIN');
const root = mkdtempSync(join(tmpdir(), 'arc-dex-shared-')), targetPath = join(root, 'results.sqlite');
let target = openPipeline({ path: targetPath, create: true, knownOtherBytes: 1981427712, volumeLimitBytes: 4838498304, ...options });
const started = performance.now(), result = importVerifiedDexResults(source, target); let checked = 0;
for (const row of source.db.prepare('SELECT unit_id FROM arc_pipeline_seals').iterate()) {
  const original = source.summaries(row.unit_id)[Symbol.iterator](), restored = target.summaries(row.unit_id)[Symbol.iterator]();
  // Shard boundaries may differ, compare exact pool row contents in order instead of serialized storage layout.
  const flatten = function* (iter) { for (const piece of { [Symbol.iterator]: () => iter }) yield* piece.rows.slice(1); };
  const a = flatten(original), b = flatten(restored);
  for (;;) { const x = a.next(), y = b.next(); assert.equal(x.done, y.done); if (x.done) break; assert.deepEqual(y.value, x.value); checked++; }
  assert.equal(target.getSeal(row.unit_id).summary.poolSha, source.getSeal(row.unit_id).summary.poolSha);
}
assert.equal(target.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
assert.equal(target.db.prepare('PRAGMA foreign_key_check').all().length, 0);
target.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
const metrics = target.metrics(), tables = target.db.prepare('SELECT name,sum(pgsize) bytes,sum(payload) payload FROM dbstat GROUP BY name ORDER BY bytes DESC').all();
target.close(); target = openPipeline({ path: targetPath, knownOtherBytes: 1981427712, volumeLimitBytes: 4838498304, ...options });
for (const row of target.db.prepare('SELECT unit_id FROM arc_pipeline_seals').iterate()) assert.equal(target.coverage(row.unit_id).status, 'complete');
source.db.exec('COMMIT'); source.close(); assert.equal(hash(readFileSync(sourcePath)), fingerprint);
const report = { root, sourcePath, ...result, checkedExactRows: checked, restartVerified: true, durationMs: Math.round(performance.now() - started),
  metrics, tables, heapBudget: assertHeapBudget(), sampledHeapBytes: process.memoryUsage().heapUsed, maxRSSBytes: process.resourceUsage().maxRSS * 1024,
  capacityScope: 'One real hour; shared stable identifiers are durable once. 720 distinct real hours and additional API data still require measurement.', productionAccess: false, rpcRequests: 0, backupsCreated: false };
target.close(); writeFileSync(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
