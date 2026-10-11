import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { boundedRecoveryProvider } from './recover-compact-discovery.mjs';
import { attestPublishedDeployment } from '../server/intelligence-pipeline/source-attestation.js';
import { hash, assertHeapBudget } from '../server/intelligence-pipeline/storage.js';
const [directory, output] = process.argv.slice(2);
if (!directory?.startsWith('/tmp/machina-source-research') || !output?.startsWith('/tmp/')) throw Error('isolated_paths_required');
const raw = readFileSync(join(directory, 'topaz-deployments.json'));
const manifest = JSON.parse(raw), chain = manifest.chains.find(c => c.chainId === 5042);
if (!chain || chain.rpcUrl !== 'https://rpc.mainnet.arc.io') throw Error('official_arc_manifest_required');
const report = { scope: 'public-chain official-source attestation; not registry activation', heap: assertHeapBudget(),
  productionAccess: false, contracts: [], observationBlock: 21160958, requests: 0, bytes: 0, maximumResponseBytes: 0 };
const bounded = boundedRecoveryProvider({ fetchImpl: async (url, options) => {
  const r = await fetch(url, options); let bytes = 0; const reader = r.body.getReader();
  return { ok: r.ok, status: r.status, body: new ReadableStream({ async pull(c) {
    try { const p = await reader.read(); if (p.done) { report.maximumResponseBytes = Math.max(report.maximumResponseBytes, bytes); c.close(); }
      else { bytes += p.value.byteLength; c.enqueue(p.value); } } catch (e) { c.error(e); }
  }, cancel: reason => reader.cancel(reason) }) };
} });
const started = performance.now();
try {
  for (const name of ['CLFactory', 'PoolFactory', 'CLPool', 'Pool', 'XTopazOFT']) {
    const contract = chain.contracts[name], abi = JSON.parse(readFileSync(join(directory, 'topaz-' + name + '.json')));
    try { report.contracts.push({ name, ...await attestPublishedDeployment(bounded.provider, { contract, abi,
      provenance: { officialUrl: 'https://www.topazdex.com/docs/contracts',
        manifestUrl: 'https://raw.githubusercontent.com/topazdex/agent-skill/main/references/deployments.json',
        manifestSha256: hash(raw), abiPath: basename(contract.abi), reviewedAt: manifest.reviewedAt }, observationBlock: report.observationBlock }) }); }
    catch (e) { report.contracts.push({ name, status: 'not_verified', reason: e.code ?? e.message, diagnostics: e.diagnostics ?? null });
      if (!bounded.provider.canContinue()) break; }
    writeFileSync(output, JSON.stringify(report, null, 2));
  }
} finally {
  Object.assign(report, { ...bounded.stats, durationMs: Math.round(performance.now() - started), heapUsedBytes: process.memoryUsage().heapUsed });
  bounded.close(); writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
