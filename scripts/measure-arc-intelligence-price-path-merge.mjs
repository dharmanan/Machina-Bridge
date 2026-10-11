// Real, deliberately small mainnet range. This proves merge/repair mechanics, not whole-window price coverage.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openPipeline, hash, json, assertHeapBudget } from '../server/intelligence-pipeline/storage.js';
import { mergePricePathRanges } from '../server/intelligence-pipeline/price-path-merge.js';
import { createProjectionSink } from '../server/compact/projections.js';
import { LOG_STREAMS, logFilter } from '../server/compact/sources.js';
import { validateLogs } from '../server/compact/logs.js';
import { decodeV4Swap, UNISWAP_EVENT_TOPICS as T } from '../api/_lib/arc-intelligence/uniswap.js';
import { evidenceJson } from '../server/compact/discovery-evidence.js';
import { boundedRecoveryProvider } from './recover-compact-discovery.mjs';
const [inputPath, output, resumeDirectory] = process.argv.slice(2);
if (!inputPath?.startsWith('/tmp/machina-recovery-proof/') || !output?.startsWith('/tmp/')
  || resumeDirectory && !resumeDirectory.startsWith('/tmp/arc-price-real-')) throw Error('isolated_paths_required');
const input = new DatabaseSync(inputPath, { readOnly: true }); input.exec('PRAGMA query_only=ON; PRAGMA cache_size=-2048');
const hour = input.prepare('SELECT * FROM compact_hours WHERE hour_start=?').get(Date.parse('2026-09-16T12:00Z') / 1000);
const sample = input.prepare("SELECT key FROM compact_meta WHERE key GLOB 'discovery_spine_block:*' ORDER BY key LIMIT 1").get();
const prefix = sample.key.slice(0, sample.key.lastIndexOf(':') + 1);
const get = n => JSON.parse(input.prepare('SELECT value FROM compact_meta WHERE key=?').get(prefix + String(n).padStart(16, '0')).value);
const window = { get(n) {
  const saved = get(n), { checksum, ...body } = saved, previous = n === hour.first_block ? null : get(n - 1);
  if (hash(evidenceJson(body)) !== checksum || body.identity.canonical !== hour.network_sha256
    || body.previousDigest !== (previous?.checksum ?? null)
    || body.block.parentHash !== (previous?.block.hash ?? hour.parent_hash) || body.block.number !== n) throw Error('canonical_evidence_conflict');
  return body.block;
} };
const first = hour.first_block, last = first + 15, anchor = window.get(last).hash;
const stream = { ...LOG_STREAMS.find(s => s.key === 'v4'), topics: [T.v4Swap] };
const source = { id: 'price_path_sample_v1', definition: 'verified-price-path-range-v1', protocol: 'uniswap_v4', chainId: 5042, stream };
const directory = resumeDirectory ?? mkdtempSync(join(tmpdir(), 'arc-price-real-'));
let p = openPipeline({ path: join(directory, 'lab.sqlite'), create: !resumeDirectory, knownOtherBytes: 1981427712, volumeLimitBytes: 4838498304 });
const unit = p.defineUnit({ source, first, last, anchorHash: anchor, registryDigest: hash(source), hourStart: hour.hour_start }, { chunkBlocks: 8 });
let maximumResponseBytes = 0, sampledHeapBytes = 0;
const monitor = setInterval(() => { sampledHeapBytes = Math.max(sampledHeapBytes, process.memoryUsage().heapUsed); }, 10); monitor.unref();
const bounded = boundedRecoveryProvider({ fetchImpl: async (url, options) => {
  const r = await fetch(url, options); const reader = r.body.getReader(); let size = 0;
  return { ok: r.ok, status: r.status, body: new ReadableStream({ async pull(c) {
    try { const v = await reader.read(); if (v.done) { maximumResponseBytes = Math.max(maximumResponseBytes, size); c.close(); }
      else { size += v.value.byteLength; c.enqueue(v.value); } } catch (e) { c.error(e); }
  }, cancel: reason => reader.cancel(reason) }) };
} });
async function reduce(a, b) {
  const raw = await bounded.provider.request('eth_getLogs', [logFilter(stream, a, b)]);
  if (raw.length >= 10000) throw Error('suspect_log_result_count');
  const logs = validateLogs(raw, stream, { fromBlock: a, toBlock: b, window, seen: new Set() });
  const sink = createProjectionSink({ activity: false });
  for (const l of logs) { const e = decodeV4Swap(l); if (!e) throw Error('swap_abi_invalid'); sink.v4('swap', l, e, window); }
  const result = sink.finish({ firstBlock: a, lastBlock: b, families: {
    uniswapV4: { status: 'available', swapCount: logs.length, modifyLiquidityCount: 0, initializeCount: 0 },
  } }).uniswap_v4_price_paths;
  if (result.status !== 'available') throw Error(result.reason);
  return { format: 'arc-reduced-source-v1', first: a, last: b, sourceKey: hash(source), anchorHash: anchor,
    inputSha256: hash(logs), status: 'verified', reason: null, counts: { swaps: logs.length },
    rows: [{ kind: 'verified_price_path_range', rows: result.rows }] };
}
const derive = () => [...mergePricePathRanges(p, (function* () {
  for (const s of p.summaries(unit)) yield { status: 'available', firstBlock: s.first, lastBlock: s.last,
    swapCount: s.counts.swaps, rows: s.rows[0].rows };
})(), { protocol: 'uniswap_v4', firstBlock: first, lastBlock: last })];
const report = { scope: 'real 16-block V4 swap price-path sample, not full hour or full USD valuation',
  productionAccess: false, directory, first, last, heapBudget: assertHeapBudget() };
const started = performance.now();
try {
  const header = await bounded.provider.request('eth_getBlockByNumber', ['0x' + last.toString(16), false]); assert.equal(header.hash, anchor);
  for (let j; j = p.claim({ unitId: unit });) p.accept(j, await reduce(j.first_block, j.last_block));
  const rows = derive(), reference = await reduce(first, last); assert.deepEqual(rows, reference.rows[0].rows);
  const before = bounded.stats.requests, path = p.path; p.close(); p = openPipeline({ path,
    knownOtherBytes: 1981427712, volumeLimitBytes: 4838498304 });
  assert.equal(p.claim({ unitId: unit }), null); assert.deepEqual(derive(), rows); assert.equal(bounded.stats.requests, before);
  const victim = p.db.prepare('SELECT result_sha FROM arc_pipeline_jobs WHERE unit_id=? ORDER BY first_block LIMIT 1').get(unit);
  p.db.prepare('DELETE FROM arc_pipeline_results WHERE result_sha=?').run(victim.result_sha);
  assert.equal(p.audit({ limit: 100 }).repairQueued, 1); assert.equal(p.coverage(unit).status, 'partial');
  const repair = p.claim({ unitId: unit }); assert(repair); p.accept(repair, await reduce(repair.first_block, repair.last_block));
  assert.equal(p.coverage(unit).status, 'complete'); assert.deepEqual(derive(), rows);
  p.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  Object.assign(report, { swaps: reference.counts.swaps, pools: rows.length, mergedRowsSha256: hash(rows),
    piecewiseEqualsUninterrupted: true, restartRpcRequests: 0, repairedRanges: 1, narrowRepairBlocks: 8,
    repairPreservedExpectedChecksum: true, rawResponsesPersisted: false,
    reducedPlainBytes: Buffer.byteLength(json(rows)), storage: p.metrics() });
} catch (e) { report.error = e.code ?? e.message; process.exitCode = 1; }
finally { Object.assign(report, { usage: { ...bounded.stats }, maximumResponseBytes, sampledHeapBytes,
  durationMs: Math.round(performance.now() - started) }); clearInterval(monitor); bounded.close();
  writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); p.close(); input.close(); }
