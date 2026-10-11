import assert from 'node:assert/strict';
import { Interface, keccak256 } from 'ethers';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPipeline, hash } from '../server/intelligence-pipeline/storage.js';
import { createPublishedFactoryProcessor } from '../server/intelligence-pipeline/published-dex-factory.js';
const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), P = '0x' + '3'.repeat(40), F = '0x' + '4'.repeat(40), H = '0x' + '5'.repeat(64);
const abi = ['event PoolCreated(address indexed token0,address indexed token1,int24 indexed tickSpacing,address pool)',
  'function getPool(address,address,int24) view returns(address)'];
const iface = new Interface(abi), e = iface.encodeEventLog(iface.getEvent('PoolCreated'), [A, B, 10, P]);
const raw = { address: F, blockHash: H, blockNumber: '0xa', transactionHash: H, transactionIndex: '0x0', logIndex: '0x0', removed: false, ...e };
const attestation = { status: 'historical_code_presence_verified', chainId: 5042, address: F, abiSha256: hash(JSON.stringify(abi)),
  deploymentTransactionAddressLink: 'direct_creation', validFromBlock: 1, deploymentCodeHash: keccak256('0x6000'), deploymentTransaction: H,
  provenance: { officialUrl: 'https://www.topazdex.com/docs/contracts', manifestSha256: hash('official') } };
let checks = 0;
async function test(name, f) { await f(); checks++; console.log('PASS ' + name); }
async function scenario({ logs = [raw], returnedPool = P, publication = attestation } = {}) {
  const p = openPipeline({ path: join(mkdtempSync(join(tmpdir(), 'arc-published-dex-')), 'lab.sqlite'), create: true });
  try {
    const processor = createPublishedFactoryProcessor(p, { attestation: publication, abi, kind: 'topaz_cl',
      loadVerifiedWindow: n => new Map([[n, { hash: H, txHashes: [H], timestamp: 10 }]]) });
    const unit = p.defineUnit({ source: processor.source, first: 10, last: 10, anchorHash: H, registryDigest: hash(processor.source) });
    let reads = 0;
    const provider = { canContinue: () => true, async request(method, params) { reads++;
      if (method === 'eth_getCode') return '0x6000';
      if (method === 'eth_getLogs') return logs;
      assert.equal(method, 'eth_call'); assert.equal(params[0].to, F); assert.equal(params[1], '0xa');
      return iface.encodeFunctionResult('getPool', [returnedPool]); } };
    const j = p.claim({ unitId: unit }), { summary } = await processor.processJob(j, provider); p.accept(j, summary);
    return { summary, reads };
  } finally { p.close(); }
}
await test('official factory and historical membership prove a pool, never its token identity or USD price', async () => {
  const r = await scenario(); assert.equal(r.reads, 3); assert.equal(r.summary.rows[0].pool, P);
  assert.equal(r.summary.rows[0].tokenIdentityStatus, 'unverified'); assert.equal(r.summary.rows[0].usdValuationStatus, 'not_computed');
});
await test('foreign factory emitter fails strict canonical stream validation', async () => await assert.rejects(scenario({ logs: [{ ...raw, address: P }] })));
await test('canonical pool lookup mismatch fails without accepting pool evidence', async () => await assert.rejects(scenario({ returnedPool: A }), e => e.code === 'published_factory_membership_mismatch'));
await test('unconfirmed deployment association cannot become a qualified factory source', async () => await assert.rejects(scenario({ publication: { ...attestation, deploymentTransactionAddressLink: 'official_manifest_only' } })));
await test('absent events mean verified zero creations only, never fabricated token launches', async () => {
  const r = await scenario({ logs: [] }); assert.equal(r.summary.counts.poolCreatedCount, 0); assert.deepEqual(r.summary.rows, []);
});
console.log(JSON.stringify({ checks, scope: 'published DEX factory safety', productionAccess: false }));
