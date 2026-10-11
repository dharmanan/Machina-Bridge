// Explicit real mainnet, lab-only measurement. No production connections or backup operations.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openPipeline, assertHeapBudget, hash } from '../server/intelligence-pipeline/storage.js';
import { createProtocolProcessor, deriveProtocolMetrics, protocolSource } from '../server/intelligence-pipeline/protocol-source.js';
import { runBoundedUnit } from '../server/intelligence-pipeline/worker.js';
import { FAMILY_VERSIONS } from '../server/compact/sources.js';
import { evidenceJson } from '../server/compact/discovery-evidence.js';
import { sha256Of } from '../server/compact/projections.js';
import { boundedRecoveryProvider } from './recover-compact-discovery.mjs';
import { providerDiagnostics } from '../server/compact/provider.js';
import { refineProtocolPlan } from '../server/intelligence-pipeline/protocol-plan.js';

const [inputPath, reportPath, resumeDirectory, selected = 'cctp,gateway,across,aaveV4,morphoBlue,morphoVaultsV2,assets'] = process.argv.slice(2);
if (!inputPath?.startsWith('/tmp/machina-recovery-proof/') || !reportPath?.startsWith('/tmp/')
  || resumeDirectory && !resumeDirectory.startsWith('/tmp/arc-protocol-real-')) throw Error('isolated_tmp_paths_required');
const heapBudget = assertHeapBudget(), input = new DatabaseSync(inputPath, { readOnly: true });
input.exec('PRAGMA query_only=ON; PRAGMA cache_size=-2048');
const h = input.prepare('SELECT * FROM compact_hours WHERE hour_start=?').get(Date.parse('2026-09-16T12:00:00Z') / 1000);
if (!h) throw Error('target_hour_missing');
const first = input.prepare("SELECT key,value FROM compact_meta WHERE key GLOB 'discovery_spine_block:*' ORDER BY key LIMIT 1").get();
if (!first) throw Error('independent_canonical_spine_required');
const prefix = first.key.slice(0, first.key.lastIndexOf(':') + 1), get = input.prepare('SELECT value FROM compact_meta WHERE key=?');
const identity = JSON.parse(first.value).identity;
const key = n => prefix + String(n).padStart(16, '0');
function load(n, last) {
  const out = new Map(); let previous = n === h.first_block ? null : JSON.parse(get.get(key(n - 1))?.value ?? 'null');
  if (n !== h.first_block && !previous) throw Error('canonical_spine_gap');
  for (let i = n; i <= last; i++) {
    const saved = JSON.parse(get.get(key(i))?.value ?? 'null');
    if (!saved) throw Error('canonical_spine_gap');
    const { checksum, ...body } = saved, b = body.block;
    if (checksum !== hash(evidenceJson(body)) || body.previousDigest !== (previous?.checksum ?? null)
      || hash(body.identity) !== hash(identity) || body.identity.canonical !== h.network_sha256
      || b.number !== i || b.parentHash !== (previous?.block.hash ?? h.parent_hash)
      || b.timestamp < h.hour_start || b.timestamp >= h.hour_start + 3600) throw Error('canonical_spine_evidence_conflict');
    out.set(i, b); previous = saved;
  }
  return out;
}
const directory = resumeDirectory ?? mkdtempSync(join(tmpdir(), 'arc-protocol-real-'));
let clock = Date.now(), p;
const open = () => openPipeline({ path: join(directory, 'reduced.sqlite'), create: !resumeDirectory && !p,
  now: () => clock, compactDefinitions: true, knownOtherBytes: 1981427712, volumeLimitBytes: 4838498304 });
p = open();
let peakHeap = 0, maximumResponse = 0, peakDisk = 0, interrupted = !!resumeDirectory;
const monitor = setInterval(() => { peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); }, 10); monitor.unref();
const requests = [];
const provider = () => boundedRecoveryProvider({ fetchImpl: async (url, options) => {
  for (const c of [].concat(JSON.parse(options.body))) requests.push({ method: c.method, paramsSha: hash(c.params) });
  const response = await fetch(url, options), reader = response.body.getReader(); let size = 0;
  return { ok: response.ok, status: response.status, body: new ReadableStream({ async pull(controller) {
    try { const r = await reader.read(); if (r.done) { maximumResponse = Math.max(maximumResponse, size); reader.releaseLock(); controller.close(); }
      else { size += r.value.byteLength; controller.enqueue(r.value); } } catch (e) { controller.error(e); }
  }, cancel: reason => reader.cancel(reason) }) };
} });
const prior = resumeDirectory && existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
if (prior && (prior.directory !== directory || prior.inputPath !== inputPath)) throw Error('measurement_resume_conflict');
const report = prior ?? { scope: 'independent real-hour protocol metrics; not all 84 fields or full 30D acceptance',
  directory, inputPath, hour: new Date(h.hour_start * 1000).toISOString(), heapBudget, node: process.version,
  productionAccess: false, backupOperations: false, runs: [], families: [] };
delete report.error;
// Asset arrays have address identity, not positional identity. Keep production/API order unchanged.
const comparable = (name, value) => name === 'assets'
  ? { ...value, items: [...value.items].sort((a, b) => a.address.localeCompare(b.address)) } : value;
const started = performance.now();
try {
  for (const name of selected.split(',')) {
    if (input.prepare('SELECT value FROM compact_meta WHERE key=?').get('family_version:' + name)?.value !== FAMILY_VERSIONS[name]) throw Error('source_version_conflict');
    const unitId = p.defineUnit({ source: protocolSource(name), first: h.first_block, last: h.last_block,
      hourStart: h.hour_start, anchorHash: h.last_hash, registryDigest: hash({ family: name, version: FAMILY_VERSIONS[name] }) }, { chunkBlocks: 500 });
    if (name === 'usdc') report.refinement = refineProtocolPlan(p, unitId, { family: name, maxBlocks: 16 });
    for (let run = 0; run < 12; run++) {
      if (p.coverage(unitId).status === 'complete') break;
      const beforeRequests = requests.length, bounded = provider(), runStart = performance.now();
      try {
        const header = await bounded.provider.request('eth_getBlockByNumber', ['0x' + h.last_block.toString(16), false]);
        assert.equal(header.hash.toLowerCase(), h.last_hash);
        const processor = createProtocolProcessor(p, { family: name, loadVerifiedWindow: load,
          hourFirstBlock: h.first_block, hourLastBlock: h.last_block });
        const out = await runBoundedUnit(p, { unitId, bounded, processJob: processor.processJob,
          afterAccept() {
            peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); peakDisk = Math.max(peakDisk, p.metrics().directoryBytes);
            if (!interrupted) { interrupted = true; throw Object.assign(Error('lab_interrupt_after_commit'), { code: 'lab_interrupt_after_commit' }); }
          } });
        report.runs.push({ family: name, ...out, durationMs: Math.round(performance.now() - runStart), physicalCalls: requests.length - beforeRequests,
          observedMaximumResponseBytes: maximumResponse, observedHeapBytes: peakHeap, observedManagedBytes: peakDisk });
        if (out.coverage.status === 'complete') break;
        if (!['bounded_run_yield', 'suspect_log_result_count', 'range_too_large', 'too_many_results',
          'recovery_response_budget_exhausted', 'recovery_rpc_budget_exhausted', 'recovery_time_budget_exhausted'].includes(out.reason)) break;
      } catch (e) {
        report.runs.push({ family: name, reason: e.code ?? e.message, usage: { ...bounded.stats }, durationMs: Math.round(performance.now() - runStart), diagnostics: providerDiagnostics(e),
          observedMaximumResponseBytes: maximumResponse, observedHeapBytes: peakHeap, observedManagedBytes: peakDisk });
        if (e.code !== 'lab_interrupt_after_commit') break;
      } finally { bounded.close(); }
      p.close(); clock += 61000; p = open();
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
    }
    const coverage = p.coverage(unitId);
    report.families = report.families.filter(f => f.family !== name);
    if (coverage.status !== 'complete') {
      report.families.push({ family: name, unitId, coverage, realCountsMatch: false }); continue;
    }
    const metrics = deriveProtocolMetrics(p, unitId, name), canonical = input.prepare('SELECT * FROM compact_family_hours WHERE hour_start=? AND family=?').get(h.hour_start, name);
    assert.equal(hash(canonical.metrics_json), canonical.metrics_sha256);
    const expected = JSON.parse(canonical.metrics_json), equal = sha256Of(comparable(name, metrics)) === sha256Of(comparable(name, expected));
    report.families.push({ family: name, unitId, coverage, metrics, canonicalMetrics: expected, realCountsMatch: equal });
    if (!equal) throw Error('real_protocol_metrics_mismatch:' + name);
    // Completed restart cannot schedule a log request or re-download pinned views.
    const before = requests.length; p.close(); p = open(); assert.equal(p.claim({ unitId }), null);
    assert.deepEqual(deriveProtocolMetrics(p, unitId, name), metrics); assert.equal(requests.length, before);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
  }
  const logs = requests.filter(r => r.method === 'eth_getLogs').map(r => r.paramsSha);
  // A split parent can fail without accepted evidence; successful completed pieces are checked below.
  report.duplicateLogFilters = logs.length - new Set(logs).size;
  p.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  Object.assign(report, { completedFamilies: report.families.filter(f => f.realCountsMatch).length,
    maximumResponseBytes: report.runs.every(r => r.observedMaximumResponseBytes !== undefined)
      ? Math.max(0, ...report.runs.map(r => r.observedMaximumResponseBytes)) : null,
    sampledHeapBytes: report.runs.every(r => r.observedHeapBytes !== undefined)
      ? Math.max(0, ...report.runs.map(r => r.observedHeapBytes)) : null,
    measurementLimitations: report.runs.some(r => r.observedMaximumResponseBytes === undefined)
      ? ['Initial interrupted measurement did not persist maximum response or sampled heap; do not infer these from resume-only measurements.'] : [],
    sessionMaxRSSBytes: process.resourceUsage().maxRSS * 1024,
    peakManagedDirectoryBytes: peakDisk, durationMs: Math.round(performance.now() - started), metrics: p.metrics(),
    cumulativeRunDurationMs: report.runs.reduce((n, r) => n + r.durationMs, 0),
    restartPreservedAcceptedEvidence: true, requestsByMethod: Object.fromEntries([...new Set(requests.map(r => r.method))].map(m => [m, requests.filter(r => r.method === m).length])) });
} catch (e) { report.error = { code: e.code ?? e.message, diagnostics: providerDiagnostics(e) }; process.exitCode = 1; }
finally { clearInterval(monitor); writeFileSync(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); p.close(); input.close(); }
