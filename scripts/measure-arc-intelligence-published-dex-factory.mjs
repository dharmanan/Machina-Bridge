import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { evidenceJson } from '../server/compact/discovery-evidence.js';
import { openPipeline, hash, assertHeapBudget } from '../server/intelligence-pipeline/storage.js';
import { createPublishedFactoryProcessor } from '../server/intelligence-pipeline/published-dex-factory.js';
import { createPublishedTokenProcessor } from '../server/intelligence-pipeline/published-token.js';
import { runBoundedUnit } from '../server/intelligence-pipeline/worker.js';
import { boundedRecoveryProvider } from './recover-compact-discovery.mjs';
const [inputPath, artifactDirectory, attestationPath, output, resumeDirectory] = process.argv.slice(2);
if (!inputPath?.startsWith('/tmp/machina-recovery-proof/') || !artifactDirectory?.startsWith('/tmp/machina-source-research')
  || !attestationPath?.startsWith('/tmp/') || !output?.startsWith('/tmp/')
  || resumeDirectory && !resumeDirectory.startsWith('/tmp/arc-published-factory-real-')) throw Error('isolated_paths_required');
const input = new DatabaseSync(inputPath, { readOnly: true }); input.exec('PRAGMA query_only=ON; PRAGMA cache_size=-2048');
const h = input.prepare('SELECT * FROM compact_hours WHERE hour_start=?').get(Date.parse('2026-09-16T12:00Z') / 1000);
const sample = input.prepare("SELECT key FROM compact_meta WHERE key GLOB 'discovery_spine_block:*' ORDER BY key LIMIT 1").get();
const prefix = sample.key.slice(0, sample.key.lastIndexOf(':') + 1);
const get = n => JSON.parse(input.prepare('SELECT value FROM compact_meta WHERE key=?').get(prefix + String(n).padStart(16, '0')).value);
const load = n => {
  const saved = get(n), { checksum, ...body } = saved, previous = n === h.first_block ? null : get(n - 1);
  if (hash(evidenceJson(body)) !== checksum || body.identity.canonical !== h.network_sha256
    || body.previousDigest !== (previous?.checksum ?? null) || body.block.number !== n
    || body.block.parentHash !== (previous?.block.hash ?? h.parent_hash)) throw Error('canonical_evidence_conflict');
  return new Map([[n, body.block]]);
};
const attested = JSON.parse(readFileSync(attestationPath)).contracts;
const directory = resumeDirectory ?? mkdtempSync(join(tmpdir(), 'arc-published-factory-real-'));
let p = openPipeline({ path: join(directory, 'lab.sqlite'), create: !resumeDirectory, knownOtherBytes: 1981427712, volumeLimitBytes: 4838498304 });
const bounded = boundedRecoveryProvider(), started = performance.now();
const report = { scope: 'real Topaz factory and issuer-token evidence, not whole DEX USD volume', directory, productionAccess: false,
  heapBudget: assertHeapBudget(), sources: [] };
try {
  const header = await bounded.provider.request('eth_getBlockByNumber', ['0x' + h.last_block.toString(16), false]); assert.equal(header.hash, h.last_hash);
  for (const [name, kind] of [['CLFactory', 'topaz_cl'], ['PoolFactory', 'topaz_stable_volatile'], ['XTopazOFT', 'topaz_asset']]) {
    const attestation = attested.find(c => c.name === name), abi = JSON.parse(readFileSync(join(artifactDirectory, 'topaz-' + name + '.json')));
    const processor = kind === 'topaz_asset' ? createPublishedTokenProcessor(p, { attestation, abi, loadVerifiedWindow: load })
      : createPublishedFactoryProcessor(p, { attestation, abi, kind, loadVerifiedWindow: load });
    const unit = p.defineUnit({ source: processor.source, first: h.first_block, last: h.last_block,
      hourStart: h.hour_start, anchorHash: h.last_hash, registryDigest: hash(processor.source) }, { chunkBlocks: 500 });
    const result = await runBoundedUnit(p, { unitId: unit, bounded, processJob: processor.processJob });
    const records = result.coverage.status === 'complete' ? [...p.summaries(unit)].flatMap(s => s.rows) : null;
    report.sources.push({ protocol: kind, ...result, poolCreatedCount: kind === 'topaz_asset' ? null : records?.length ?? null,
      evidenceSha256: records ? hash(records) : null, records,
      ...(kind === 'topaz_asset' && records ? { transferCount: records.reduce((n, r) => n + r.metrics.transferCount, 0),
        amountRaw: records.reduce((n, r) => n + BigInt(r.metrics.amountRaw), 0n).toString(), usdMicros: null } : {}) });
    if (result.reason) break;
    const before = bounded.stats.requests, path = p.path; p.close(); p = openPipeline({ path,
      knownOtherBytes: 1981427712, volumeLimitBytes: 4838498304 });
    assert.equal(p.claim({ unitId: unit }), null); assert.equal(bounded.stats.requests, before);
  }
  p.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); report.storage = p.metrics();
} catch (e) { report.error = e.code ?? e.message; process.exitCode = 1; }
finally { Object.assign(report, { usage: { ...bounded.stats }, durationMs: Math.round(performance.now() - started),
  heapUsedBytes: process.memoryUsage().heapUsed }); bounded.close(); writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); p.close(); input.close(); }
