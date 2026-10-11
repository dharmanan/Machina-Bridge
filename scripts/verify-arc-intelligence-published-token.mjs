import assert from 'node:assert/strict';
import { Interface, keccak256 } from 'ethers';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openPipeline, hash } from '../server/intelligence-pipeline/storage.js';
import { createPublishedTokenProcessor } from '../server/intelligence-pipeline/published-token.js';
const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), TOKEN = '0x' + '3'.repeat(40), H = '0x' + '4'.repeat(64);
const abi = ['event Transfer(address indexed from,address indexed to,uint256 value)',
  'function symbol() view returns(string)', 'function decimals() view returns(uint8)'];
const iface = new Interface(abi), event = iface.encodeEventLog(iface.getEvent('Transfer'), [A, B, 9007199254740993123n]);
const raw = { address: TOKEN, blockHash: H, blockNumber: '0xa', transactionHash: H, transactionIndex: '0x0', logIndex: '0x0', removed: false, ...event };
const attestation = { status: 'historical_code_presence_verified', chainId: 5042, address: TOKEN,
  deploymentTransactionAddressLink: 'direct_creation', abiSha256: hash(JSON.stringify(abi)), validFromBlock: 1,
  deploymentCodeHash: keccak256('0x6000'), views: { symbol: { value: 'X' }, decimals: { value: '18' } },
  provenance: { officialUrl: 'https://www.topazdex.com/docs/contracts', manifestSha256: hash('official') } };
let checks = 0;
const test = async (name, f) => { await f(); checks++; console.log('PASS ' + name); };
async function scenario({ logs = [raw], symbol = 'X', publication = attestation, code = '0x6000' } = {}) {
  const p = openPipeline({ path: join(mkdtempSync(join(tmpdir(), 'arc-published-token-')), 'lab.sqlite'), create: true });
  try {
    const processor = createPublishedTokenProcessor(p, { attestation: publication, abi,
      loadVerifiedWindow: n => new Map([[n, { hash: H, txHashes: [H], timestamp: 10 }]]) });
    const unit = p.defineUnit({ source: processor.source, first: 10, last: 10, anchorHash: H, registryDigest: hash(processor.source) });
    const rpc = { canContinue: () => true, async request(method, params) {
      if (method === 'eth_getCode') return code;
      if (method === 'eth_getLogs') return logs;
      assert.equal(params[1], '0xa'); const f = iface.parseTransaction(params[0]);
      return iface.encodeFunctionResult(f.name, [f.name === 'symbol' ? symbol : 18]);
    } };
    const j = p.claim({ unitId: unit }), { summary } = await processor.processJob(j, rpc); p.accept(j, summary);
    return summary.rows[0];
  } finally { p.close(); }
}
await test('issuer-sourced ERC20 raw transfer precision is exact and absent USD stays null', async () => {
  const row = await scenario(); assert.equal(row.metrics.amountRaw, '9007199254740993123'); assert.equal(row.metrics.transferCount, 1);
  assert.equal(row.usdMicros, null); assert.equal(row.usdReason, 'same_hour_verified_price_missing');
});
await test('conflicting historical symbol never becomes accepted identity', async () => await assert.rejects(scenario({ symbol: 'OTHER' }), e => e.code === 'published_token_metadata_conflict'));
await test('changed runtime code requires a new source version', async () => await assert.rejects(scenario({ code: '0x6001' }), e => e.code === 'published_token_code_version_mismatch'));
await test('malformed transfer and foreign emitter fail strict validation', async () => {
  await assert.rejects(scenario({ logs: [{ ...raw, data: '0x00' }] }));
  await assert.rejects(scenario({ logs: [{ ...raw, address: A }] }));
});
await test('unknown issuer/deployment cannot be inferred from an ERC20 event', async () => await assert.rejects(scenario({ publication: { ...attestation, deploymentTransactionAddressLink: 'official_manifest_only' } })));
await test('empty verified transfer interval is exact zero activity, not zero USD valuation', async () => {
  const row = await scenario({ logs: [] }); assert.equal(row.metrics.amountRaw, '0'); assert.equal(row.metrics.transferCount, 0); assert.equal(row.usdMicros, null);
});
console.log(JSON.stringify({ checks, scope: 'published token safety', productionAccess: false }));
