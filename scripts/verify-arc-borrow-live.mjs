// Run in the owner's existing Codespace. One public, read-only Circle request; no wallet,
// credentials, database, filesystem writes, production service or environment changes.
import { createHash } from 'node:crypto';
import v8 from 'node:v8';
import { BORROW_MARKETS_UPSTREAM_URL, normalizeBorrowMarketsPage, compatibleBorrowMarkets,
  BORROW_COLLATERAL_ASSET, BORROW_LOAN_ASSET } from '../api/_lib/borrow-markets-proxy.js';

if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('Node_24_required');
if (v8.getHeapStatistics().heap_size_limit > 64 * 1024 * 1024) throw Error('64_MiB_heap_limit_required');
const started = performance.now(), checkedAt = new Date().toISOString();
const report = { checkedAt, endpoint: BORROW_MARKETS_UPSTREAM_URL, requests: 0, status: null,
  responseBytes: 0, responseSha256: null, schemaVerified: false, compatibleMarkets: [],
  pageOnly: true, allMarketsVerified: false, mainnetTransactionsVerified: false,
  productionAccess: false, databaseAccess: false, filesWritten: false };
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 8000);
try {
  report.requests++;
  const response = await fetch(BORROW_MARKETS_UPSTREAM_URL, {
    method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal: controller.signal,
  });
  report.status = response.status;
  if (response.status !== 200) { await response.body?.cancel(); throw Error('http_status_' + response.status); }
  const reader = response.body.getReader(), chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      report.responseBytes += value.byteLength;
      if (report.responseBytes > 256 * 1024) { await reader.cancel(); throw Error('response_budget_exhausted'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  const body = Buffer.concat(chunks);
  report.responseSha256 = createHash('sha256').update(body).digest('hex');
  const payload = JSON.parse(body.toString('utf8'));
  const markets = normalizeBorrowMarketsPage(payload);
  const compatible = compatibleBorrowMarkets(markets);
  report.schemaVerified = true;
  report.pageMarketCount = markets.length;
  report.verifiedPair = { collateral: BORROW_COLLATERAL_ASSET, loan: BORROW_LOAN_ASSET };
  report.compatibleMarkets = compatible;
  report.outcome = compatible.length ? 'verified_compatible_market_page' : 'no_compatible_market_on_verified_page';
  // This single bounded page is not proof of exhaustive pagination or an executable borrowing route.
} catch (error) {
  report.outcome = 'unverified';
  report.reason = controller.signal.aborted ? 'timeout' : /^http_status_\d+$/.test(error.message) ? error.message
    : error.message === 'response_budget_exhausted' ? error.message
    : report.status === null ? 'transport' : 'schema_or_body_invalid';
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  report.durationMs = Math.round(performance.now() - started);
  report.heapLimitBytes = v8.getHeapStatistics().heap_size_limit;
  console.log(JSON.stringify(report, null, 2));
}
