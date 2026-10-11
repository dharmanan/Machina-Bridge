// Merge already verified price-path reductions without preserving raw swaps.
// SQLite scratch bounds memory; absent opening prices are never invented.
import { randomBytes } from 'node:crypto';
import { validPricePathRow } from '../compact/projections.js';
import { blockState } from '../compact/valuation.js';
import { fail, json, assertHeapBudget } from './storage.js';
export function* mergePricePathRanges(p, segments, { protocol, firstBlock, lastBlock } = {}) {
  assertHeapBudget();
  if (!['uniswap_v3', 'uniswap_v4'].includes(protocol) || !Number.isSafeInteger(firstBlock)
    || !Number.isSafeInteger(lastBlock) || firstBlock > lastBlock) fail('price_path_range_invalid');
  const table = 'price_merge_' + randomBytes(8).toString('hex');
  p.db.exec(`CREATE TEMP TABLE ${table}(pool TEXT NOT NULL,first_block INTEGER NOT NULL,last_block INTEGER NOT NULL,
    row_json TEXT NOT NULL,PRIMARY KEY(pool,first_block)) STRICT,WITHOUT ROWID`);
  const put = p.db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?)`);
  let next = firstBlock, scratchBytes = 0;
  try {
    for (const segment of segments) {
      if (segment.status !== 'available' || segment.firstBlock !== next || segment.lastBlock < next
        || segment.lastBlock > lastBlock || !Array.isArray(segment.rows)
        || !Number.isSafeInteger(segment.swapCount) || segment.swapCount < 0) fail('price_path_coverage_incomplete');
      let swaps = 0, previous = '';
      for (const row of segment.rows) {
        if (!validPricePathRow(row, protocol, segment) || row.pool <= previous) fail('price_path_row_invalid');
        previous = row.pool; swaps += row.swapCount;
        const text = json(row); scratchBytes += Buffer.byteLength(text) + 256;
        if (scratchBytes > 32 * 1024 * 1024) fail('price_path_scratch_budget');
        p.guard(scratchBytes);
        put.run(row.pool, segment.firstBlock, segment.lastBlock, text);
      }
      if (swaps !== segment.swapCount) fail('price_path_reconciliation_mismatch');
      next = segment.lastBlock + 1;
    }
    if (next !== lastBlock + 1) fail('price_path_coverage_incomplete');
    let aggregate = null, closedThrough = null;
    const extend = blocks => {
      const state = blockState(BigInt(aggregate.closeSqrtPriceX96), BigInt(aggregate.closeLiquidity));
      for (const [key, value] of [['sqrtPriceBlockSum', state.sqrtPrice], ['reserve0BlockSum', state.reserve0], ['reserve1BlockSum', state.reserve1]])
        aggregate[key] = (BigInt(aggregate[key]) + value * BigInt(blocks)).toString();
    };
    const finish = () => {
      extend(lastBlock - closedThrough); aggregate.pricedBlocks = lastBlock - aggregate.firstSwapBlock + 1;
      if (!validPricePathRow(aggregate, protocol, { firstBlock, lastBlock })) fail('price_path_merge_invalid');
      return aggregate;
    };
    for (const saved of p.db.prepare(`SELECT pool,last_block,row_json FROM ${table} ORDER BY pool,first_block`).iterate()) {
      const row = JSON.parse(saved.row_json);
      if (aggregate?.pool !== row.pool) {
        if (aggregate) yield finish();
        aggregate = { ...row }; closedThrough = saved.last_block;
      } else {
        if (row.firstSwapBlock <= closedThrough) fail('price_path_overlap');
        // Earlier close holds through intervening empty blocks, including empty range pieces.
        extend(row.firstSwapBlock - closedThrough - 1);
        for (const key of ['sqrtPriceBlockSum', 'reserve0BlockSum', 'reserve1BlockSum'])
          aggregate[key] = (BigInt(aggregate[key]) + BigInt(row[key])).toString();
        aggregate.swapCount += row.swapCount; aggregate.lastSwapBlock = row.lastSwapBlock;
        aggregate.closeSqrtPriceX96 = row.closeSqrtPriceX96; aggregate.closeLiquidity = row.closeLiquidity;
        closedThrough = saved.last_block;
      }
    }
    if (aggregate) yield finish();
  } finally { p.db.exec(`DROP TABLE ${table}`); }
}
