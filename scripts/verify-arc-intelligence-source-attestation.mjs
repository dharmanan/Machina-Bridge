import assert from 'node:assert/strict';
import { attestPublishedDeployment } from '../server/intelligence-pipeline/source-attestation.js';
import { hash } from '../server/intelligence-pipeline/storage.js';
const A = '0x' + '1'.repeat(40), T = '0x' + '2'.repeat(64), H = '0x' + '3'.repeat(64);
const abi = [], contract = { address: A, blockNumber: 10, transactionHash: T, abiSha256: hash(JSON.stringify(abi)) };
const spec = { contract, abi, observationBlock: 20,
  provenance: { officialUrl: 'https://official.example/contracts', manifestSha256: 'a'.repeat(64) } };
function rpc(change = {}) {
  let calls = 0;
  return { get calls() { return calls; }, canContinue: () => true, async request(method, params) {
    calls++;
    if (change[method]) return change[method](params);
    if (method === 'eth_getTransactionReceipt') return { transactionHash: T, blockHash: H, blockNumber: '0xa', status: '0x1', contractAddress: A };
    if (method === 'eth_getBlockByNumber') return { hash: H, number: '0xa', timestamp: '0x64', transactions: [T] };
    if (method === 'eth_getCode') return params[1] === '0x9' ? '0x' : '0x6000';
    throw Error('unexpected RPC');
  } };
}
let checks = 0;
async function test(name, f) { await f(); checks++; console.log('PASS ' + name); }
await test('official snapshot ABI and canonical deployment presence stay separate from registry activation', async () => {
  const p = rpc(), result = await attestPublishedDeployment(p, spec);
  assert.equal(result.validFromBlock, 10); assert.equal(result.deploymentTransactionAddressLink, 'direct_creation');
  assert.equal(result.registryActivated, false); assert(result.unresolved.includes('runtime_source_equivalence_not_proven')); assert.equal(p.calls, 5);
});
await test('changed ABI fails before any public RPC call', async () => {
  const p = rpc(); await assert.rejects(attestPublishedDeployment(p, { ...spec, contract: { ...contract, abiSha256: '0'.repeat(64) } }), e => e.code === 'published_source_invalid'); assert.equal(p.calls, 0);
});
await test('wrong deployment block/receipt does not become verified source evidence', async () => {
  const p = rpc({ eth_getTransactionReceipt: () => ({ transactionHash: T, blockHash: H, blockNumber: '0xb', status: '0x1' }) });
  await assert.rejects(attestPublishedDeployment(p, spec), e => e.code === 'published_deployment_receipt_mismatch'); assert.equal(p.calls, 1);
});
await test('canonical deployment hash mismatch stops before code or metadata reads', async () => {
  const p = rpc({ eth_getBlockByNumber: () => ({ hash: T, number: '0xa', transactions: [T] }) });
  await assert.rejects(attestPublishedDeployment(p, spec), e => e.code === 'published_deployment_canonical_mismatch'); assert.equal(p.calls, 2);
});
await test('pre-existing code cannot invent a source-validity beginning', async () => {
  await assert.rejects(attestPublishedDeployment(rpc({ eth_getCode: () => '0x6000' }), spec), e => e.code === 'published_validity_start_not_proven');
});
await test('unknown deployment association remains explicitly unproven', async () => {
  const p = rpc({ eth_getTransactionReceipt: () => ({ transactionHash: T, blockHash: H, blockNumber: '0xa', status: '0x1', contractAddress: null }) });
  assert.equal((await attestPublishedDeployment(p, spec)).deploymentTransactionAddressLink, 'official_manifest_only');
});
await test('budget exhaustion issues no additional RPC requests', async () => {
  const p = rpc(); p.canContinue = () => false;
  await assert.rejects(attestPublishedDeployment(p, spec), e => e.code === 'bounded_run_yield'); assert.equal(p.calls, 0);
});
console.log(JSON.stringify({ checks, scope: 'source-attestation safety regressions', productionAccess: false }));
