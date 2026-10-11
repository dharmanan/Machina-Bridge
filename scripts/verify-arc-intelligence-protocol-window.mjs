import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPipeline, hash } from '../server/intelligence-pipeline/storage.js';
import { protocolSource } from '../server/intelligence-pipeline/protocol-source.js';
import { readProtocolWindow, rankFinancialActions } from '../server/intelligence-pipeline/protocol-window.js';
import { CIRCLE_ARC } from '../server/compact/protocols/circle.js';

const H = '0x' + '1'.repeat(64), R = 'a'.repeat(64);
let checks = 0;
function test(name, f) { f(); checks++; console.log('PASS ' + name); }
function fixture({ count = 24, family = 'gateway', omit = -1 } = {}) {
  const p = openPipeline({ path: join(mkdtempSync(join(tmpdir(), 'arc-protocol-window-')), 'lab.sqlite'), create: true });
  const source = protocolSource(family);
  for (let n = 0; n < count; n++) {
    if (n === omit) continue;
    const metrics = family === 'gateway' ? { depositCount: 1, depositAmountRaw: '1000001', uniqueDepositors: 1,
      outboundBurnCount: 0, outboundBurnAmountRaw: '0', outboundBurnFeeRaw: '0', outboundByDestinationDomain: {},
      inboundMintCount: 0, inboundMintAmountRaw: '0', inboundBySourceDomain: {}, uniqueInboundRecipients: 0,
      withdrawalInitiatedCount: 0, withdrawalCompletedCount: 0, withdrawalAmountRaw: '0' }
      : { supplyCount: 1, withdrawCount: 0, borrowCount: 0, repayCount: 0, liquidationCount: 0, uniqueUsers: 0,
        reserves: { 'r:0': { spoke: '0x' + '2'.repeat(40), reserveId: '0', underlying: CIRCLE_ARC.usdc, decimals: 6,
          suppliedRaw: '1000001', withdrawnRaw: '0', borrowedRaw: '0', repaidRaw: '0', liquidatedDebtRaw: '0', liquidatedCollateralRaw: '0' },
        'r:1': { spoke: '0x' + '2'.repeat(40), reserveId: '1', underlying: '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1', decimals: 6,
          suppliedRaw: '2000000', withdrawnRaw: '0', borrowedRaw: '0', repaidRaw: '0', liquidatedDebtRaw: '0', liquidatedCollateralRaw: '0' } } };
    const u = p.defineUnit({ source, first: n + 10, last: n + 10, hourStart: n * 3600, anchorHash: H, registryDigest: R });
    const j = p.claim({ unitId: u });
    p.accept(j, { format: 'arc-reduced-source-v1', first: n + 10, last: n + 10, sourceKey: hash(source), anchorHash: H,
      inputSha256: hash([n, family]), status: 'verified', reason: null, counts: { receivedEvents: 1 }, rows: [{
        kind: 'verified_protocol_range', family, definitionVersion: source.originalVersion, metrics,
        membership: family === 'gateway' ? { uniqueDepositors: Buffer.from('2'.repeat(40), 'hex').toString('base64'), uniqueInboundRecipients: '' } : { uniqueUsers: '' },
        historicalStateBlock: n + 10, viewProofs: [],
      }] });
  }
  return p;
}
for (const hours of [24, 168, 720]) test('exact ' + hours + '-hour sums and completed UTC days', () => {
  const p = fixture({ count: hours }), r = readProtocolWindow(p, { family: 'gateway', hours, endHour: hours * 3600, registryDigest: R });
  assert.equal(r.status, 'available'); assert.equal(r.coverage.verifiedHours, hours);
  assert.equal(r.metrics.depositAmountRaw, String(BigInt(hours) * 1000001n));
  assert.equal(r.actions.depositUsdMicros.usdMicros, r.metrics.depositAmountRaw);
  assert.equal(r.actions.depositUsdMicros.status, 'complete'); assert.equal(r.daily.length, hours / 24);
  assert(r.daily.every(d => d.status === 'available' && d.verifiedHours === 24));
  assert(!Object.hasOwn(r.metrics, 'uniqueDepositors')); p.close();
});
test('partial 30D retains numbers with actual coverage; incomplete days stay null', () => {
  const p = fixture({ count: 25 }), r = readProtocolWindow(p, { family: 'gateway', hours: 720, endHour: 25 * 3600, registryDigest: R });
  assert.equal(r.status, 'partial'); assert.equal(r.coverage.verifiedHours, 25); assert.equal(r.metrics.depositCount, 25);
  assert.equal(r.actions.depositUsdMicros.status, 'partial'); assert.equal(r.daily.filter(d => d.status === 'available').length, 1);
  assert(r.daily.filter(d => d.status === 'incomplete').every(d => d.metrics === null)); p.close();
});
test('missing 24H/7D evidence cannot become a zero-filled full total', () => {
  for (const hours of [24, 168]) {
    const p = fixture({ count: hours, omit: 3 }), r = readProtocolWindow(p, { family: 'gateway', hours, endHour: hours * 3600, registryDigest: R });
    assert.equal(r.status, 'partial'); assert.equal(r.metrics, null); assert.equal(r.actions.depositUsdMicros.usdMicros, null);
    assert.equal(r.coverage.missingHours, 1); p.close();
  }
});
test('unverified historical EURC price remains explicit while USDC subset stays numeric', () => {
  const p = fixture({ count: 24, family: 'aaveV4' }), r = readProtocolWindow(p, { family: 'aaveV4', hours: 24, endHour: 24 * 3600, registryDigest: R });
  const a = r.actions.suppliedUsdMicros;
  assert.equal(a.status, 'partial'); assert.equal(a.usdMicros, '24000024'); assert.equal(a.coverage.fullyValuedHours, 0);
  const eurc = a.assets.find(a => a.token !== CIRCLE_ARC.usdc);
  assert.equal(eurc.usdMicros, null); assert.equal(eurc.unvaluedAmountRaw, '48000000');
  assert.deepEqual(eurc.reasons, ['same_hour_verified_price_missing']); p.close();
});
test('registry split is not merged; malformed windows fail closed', () => {
  const p = fixture(), options = { family: 'gateway', hours: 24, endHour: 24 * 3600, registryDigest: 'b'.repeat(64) };
  assert.equal(readProtocolWindow(p, options).coverage.verifiedHours, 0);
  assert.throws(() => readProtocolWindow(p, { ...options, hours: 25 })); p.close();
});
test('corrupt accepted evidence queues only its exact range and restores expected checksum', () => {
  const p = fixture(), row = p.db.prepare('SELECT * FROM arc_pipeline_results ORDER BY result_sha LIMIT 1').get();
  p.db.prepare('DELETE FROM arc_pipeline_results WHERE result_sha=?').run(row.result_sha);
  const options = { family: 'gateway', hours: 24, endHour: 24 * 3600, registryDigest: R };
  assert.equal(readProtocolWindow(p, options).coverage.verifiedHours, 23);
  assert.equal(p.audit({ limit: 256 }).repairQueued, 1);
  p.db.prepare('INSERT INTO arc_pipeline_results VALUES(?,?,?,?)').run(row.result_sha, row.payload_gzip, row.plain_bytes, row.format);
  const j = p.claim(); p.accept(j, p.getResult(row.result_sha));
  assert.equal(readProtocolWindow(p, options).coverage.verifiedHours, 24); p.close();
});
test('DEX USD ranks exactly beyond JS integer precision; no cross-action financial sum', () => {
  const valued = usdMicros => ({ status: 'complete', scope: 'all_verified_window_amounts', usdMicros });
  const r = rankFinancialActions({ dex: [{ protocol: 'v3', ...valued('9007199254740992') }, { protocol: 'v4', ...valued('9007199254740993') }],
    protocols: [{ family: 'aaveV4', actions: { suppliedUsdMicros: valued('4'), repaidUsdMicros: valued('9') } },
      { family: 'morphoBlue', actions: { suppliedUsdMicros: valued('8') } }, { family: 'gateway', actions: { depositUsdMicros: valued('12') } }] });
  assert.equal(r.dex[0].protocol, 'v4'); assert.equal(r.lending.suppliedUsdMicros[0].protocol, 'morphoBlue');
  assert.equal(r.lending.repaidUsdMicros[0].protocol, 'aaveV4'); assert.equal(r.crossChain.depositUsdMicros[0].protocol, 'gateway');
  assert.equal(r.combinedFinancialTotal, null);
});
console.log(JSON.stringify({ checks, node: process.version, scope: 'synthetic window/repair safety tests, not real 720-hour proof', productionAccess: false }));
