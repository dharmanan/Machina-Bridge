import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPipeline } from '../server/intelligence-pipeline/storage.js';
import { mergePricePathRanges } from '../server/intelligence-pipeline/price-path-merge.js';
import { blockState } from '../server/compact/valuation.js';
const POOL = '0x' + '1'.repeat(40), Q96 = 2n ** 96n;
const p = openPipeline({ path: join(mkdtempSync(join(tmpdir(), 'arc-price-merge-')), 'lab.sqlite'), create: true });
function segment(first, last, swaps = []) {
  const rows = swaps.length ? [{ pool: POOL, swapCount: swaps.length, firstSwapBlock: swaps[0][0],
    lastSwapBlock: swaps.at(-1)[0], pricedBlocks: last - swaps[0][0] + 1, closeSqrtPriceX96: swaps.at(-1)[1].toString(),
    closeLiquidity: swaps.at(-1)[2].toString(), sqrtPriceBlockSum: '0', reserve0BlockSum: '0', reserve1BlockSum: '0' }] : [];
  for (let i = 0; i < swaps.length; i++) {
    const [block, price, liquidity] = swaps[i], state = blockState(price, liquidity);
    const blocks = (swaps[i + 1]?.[0] ?? last + 1) - block;
    for (const [key, value] of [['sqrtPriceBlockSum', state.sqrtPrice], ['reserve0BlockSum', state.reserve0], ['reserve1BlockSum', state.reserve1]])
      rows[0][key] = (BigInt(rows[0][key]) + value * BigInt(blocks)).toString();
  }
  return { status: 'available', firstBlock: first, lastBlock: last, swapCount: swaps.length, rows };
}
const opts = { protocol: 'uniswap_v3', firstBlock: 10, lastBlock: 30 };
let checks = 0;
const test = (name, f) => { f(); checks++; console.log('PASS ' + name); };
try {
  test('piecewise prices equal exact uninterrupted path across empty ranges', () => {
    const swaps = [[12, Q96, 100n], [23, Q96 * 2n, 101n], [23, Q96 * 3n, 103n], [28, Q96, 107n]];
    const pieces = [segment(10, 15, swaps.slice(0, 1)), segment(16, 20), segment(21, 25, swaps.slice(1, 3)), segment(26, 30, swaps.slice(3))];
    assert.deepEqual([...mergePricePathRanges(p, pieces, opts)], segment(10, 30, swaps).rows);
    assert.equal([...mergePricePathRanges(p, pieces, opts)][0].pricedBlocks, 19);
  });
  test('missing range never yields a completed price', () => assert.throws(() => [...mergePricePathRanges(p, [segment(10, 15), segment(17, 30)], opts)], e => e.code === 'price_path_coverage_incomplete'));
  test('partial source never becomes a completed price', () => assert.throws(() => [...mergePricePathRanges(p, [{ ...segment(10, 30), status: 'partial' }], opts)]));
  test('malformed pool and counter mismatch fail closed', () => {
    const s = segment(10, 30, [[12, Q96, 100n]]);
    assert.throws(() => [...mergePricePathRanges(p, [{ ...s, swapCount: 2 }], opts)]);
    assert.throws(() => [...mergePricePathRanges(p, [{ ...s, rows: [{ ...s.rows[0], pool: POOL.slice(1) }] }], opts)]);
  });
  test('empty verified hour has no invented opening state', () => assert.deepEqual([...mergePricePathRanges(p, [segment(10, 30)], opts)], []));
  test('consumer interruption removes only temporary scratch, preserving accepted pipeline tables', () => {
    const before = p.db.prepare('SELECT COUNT(*) n FROM arc_pipeline_jobs').get().n;
    const g = mergePricePathRanges(p, [segment(10, 30, [[12, Q96, 100n]])], opts); g.next(); g.return();
    assert.equal(p.db.prepare("SELECT COUNT(*) n FROM sqlite_temp_master WHERE name GLOB 'price_merge_*'").get().n, 0);
    assert.equal(p.db.prepare('SELECT COUNT(*) n FROM arc_pipeline_jobs').get().n, before);
  });
} finally { p.close(); }
console.log(JSON.stringify({ checks, scope: 'exact price-path math and scratch safety; not historical price availability proof' }));
