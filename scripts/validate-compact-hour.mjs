// Compact engine, Stage 1.5: one bounded, read-only validation of a completed historical UTC hour against live Arc RPC.
//  - Primary (rpc.mainnet.arc.io) runs the full engine; retained metrics must equal the A2 ground truth exactly.
//  - Secondary (arc.drpc.org) independently re-derives the hour boundaries and the canonical USDC and Uniswap V4
//    log identity sets. A secondary failure or rate limit is reported as NOT VERIFIED and fails the run.
// Each provider is used alone; neither falls back to the other. Exit code 0 only when every check matches.
//   node --expose-gc scripts/validate-compact-hour.mjs 2026-10-01T07:00:00Z
// COMPACT_SQLITE_DIR (optional): also round-trip the verified hour through a temporary node:sqlite file there.
import { createHash } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeLog } from '../api/_lib/arc-intelligence/normalize.js';
import { locateHourBlocks } from '../server/compact/boundary.js';
import { HourIncompleteError, processHour } from '../server/compact/hour.js';
import { fetchStreamLogs, LogError } from '../server/compact/logs.js';
import { COMPACT_ENDPOINTS, createProvider, ProviderError } from '../server/compact/provider.js';
import { DENSE_LOG_RANGE_BLOCKS, LOG_STREAMS } from '../server/compact/sources.js';
import { headerOf } from '../server/compact/spine.js';
import { createCompactStore } from '../server/compact/store.js';

export const SAFE_HEAD_MARGIN_BLOCKS = 200;
const hex = (number) => `0x${number.toString(16)}`;
const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
const streamByKey = Object.fromEntries(LOG_STREAMS.map((stream) => [stream.key, stream]));
const CROSS_CHECKED = ['usdc', 'v4'];

// [printed name, ground-truth field, value in the compact result]. Receipt-based metrics are intentionally absent.
export const EQUIVALENCE_METRICS = Object.freeze([
  ['blocks', 'blocks', (result) => result.network.blockCount],
  ['transactions', 'transactions', (result) => result.network.transactionCount],
  ['uniqueActiveAddresses', 'activeAddresses', (result) => result.network.uniqueActiveAddresses],
  ['canonicalUsdcTransfers', 'canonicalUsdcTransfers', (result) => result.families.usdc.transferCount],
  ['canonicalUsdcMints', 'usdcMints', (result) => result.families.usdc.mintCount],
  ['canonicalUsdcBurns', 'usdcBurns', (result) => result.families.usdc.burnCount],
]);

const line = (name, expected, actual, match) =>
  `${name.padEnd(30)} EXPECTED ${String(expected).padEnd(14)} ACTUAL ${String(actual).padEnd(14)} ${match ? 'MATCH' : 'MISMATCH'}`;

// Identity of a log set: one rolling digest per absolute 500-block bucket over logs in (block, logIndex) order, so
// both sides only hold counters and a hash per bucket, and a mismatch is located to a bucket.
function createLogLedger() {
  const buckets = new Map();
  return {
    add(logs) {
      for (const log of logs) {
        const key = Math.floor(log.blockNumber / DENSE_LOG_RANGE_BLOCKS);
        if (!buckets.has(key)) buckets.set(key, { count: 0, hash: createHash('sha256') });
        const bucket = buckets.get(key);
        bucket.count += 1;
        bucket.hash.update(`${log.blockNumber}|${log.blockHash}|${log.logIndex}|${log.transactionHash}|${log.address}|${log.topics.join(',')}|${log.data}\n`);
      }
    },
    finish() {
      const sealed = [...buckets].sort(([left], [right]) => left - right)
        .map(([key, bucket]) => ({ fromBlock: key * DENSE_LOG_RANGE_BLOCKS, count: bucket.count, digest: bucket.hash.digest('hex') }));
      return { count: sealed.reduce((sum, bucket) => sum + bucket.count, 0), buckets: sealed,
        digest: createHash('sha256').update(sealed.map((bucket) => `${bucket.fromBlock}:${bucket.count}:${bucket.digest}`).join('\n')).digest('hex') };
    },
  };
}

function startResources() {
  globalThis.gc?.();
  const before = process.memoryUsage().rss;
  let peak = before;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 25);
  const started = performance.now();
  return () => {
    clearInterval(timer);
    peak = Math.max(peak, process.memoryUsage().rss);
    const elapsedMs = Math.round(performance.now() - started);
    globalThis.gc?.();
    return { elapsedMs, rssBeforeMb: mb(before), rssPeakSampledMb: mb(peak), rssAfterMb: mb(process.memoryUsage().rss),
      maxRssProcessMb: mb(process.resourceUsage().maxRSS * 1024) };
  };
}
const traffic = (provider) => ({ httpRequests: provider.stats.requests, rpcCalls: { ...provider.stats.calls }, retries: provider.stats.retries,
  responseBytesDecoded: provider.stats.responseBytes, responseMbDecoded: mb(provider.stats.responseBytes) });

// Counts eth_getLogs calls per stream; everything else passes straight through to the real provider.
function countLogCalls(provider, counts) {
  const keyOf = (filter) => LOG_STREAMS.find((stream) => (stream.address?.[0] ?? null) === (filter.address?.[0] ?? null)
    && stream.topics[0] === filter.topics?.[0]?.[0])?.key ?? 'unknown';
  return {
    stats: provider.stats,
    batch: (...args) => provider.batch(...args),
    request(method, params) {
      if (method === 'eth_getLogs') counts[keyOf(params[0])] = (counts[keyOf(params[0])] ?? 0) + 1;
      return provider.request(method, params);
    },
  };
}

// The secondary sees only its own responses: shape, range, emitter and topic checks, no spine from the primary.
async function secondaryLedger(provider, stream, first, last) {
  const ledger = createLogLedger();
  for (let from = first; from <= last; from += DENSE_LOG_RANGE_BLOCKS) {
    const to = Math.min(last, from + DENSE_LOG_RANGE_BLOCKS - 1);
    const seen = new Set();
    const logs = (await fetchStreamLogs(provider, stream, from, to)).map((raw) => {
      if (raw?.removed === true) throw new LogError('removed_log');
      let log;
      try { log = normalizeLog(raw); } catch { throw new LogError('malformed_log'); }
      if (log.blockNumber < from || log.blockNumber > to || !log.blockHash || !log.transactionHash) throw new LogError('malformed_log', log.blockNumber);
      if (!stream.address.includes(log.address) || !stream.topics.includes(log.topics[0])) throw new LogError('unexpected_log', log.blockNumber);
      if (seen.has(`${log.blockNumber}:${log.logIndex}`)) throw new LogError('duplicate_log', log.blockNumber);
      seen.add(`${log.blockNumber}:${log.logIndex}`);
      return log;
    }).sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
    ledger.add(logs);
  }
  return ledger.finish();
}

async function crossCheck({ secondary, hourStart, result, primaryLedgers, safeHeadMargin, print }) {
  const stop = startResources();
  const checks = [];
  const check = (name, expected, actual) => {
    checks.push({ name, expected, actual, match: expected === actual });
    print(line(name, expected, actual, expected === actual));
  };
  print(`SECONDARY CROSS-CHECK ${COMPACT_ENDPOINTS[1].url} (EXPECTED = primary, ACTUAL = secondary)`);
  let status = 'verified';
  let reason = null;
  try {
    const head = Number(BigInt(await secondary.request('eth_blockNumber')));
    const headers = new Map();
    const header = async (number) => {
      if (!headers.has(number)) headers.set(number, headerOf(await secondary.request('eth_getBlockByNumber', [hex(number), false]), number));
      return headers.get(number);
    };
    const bounds = await locateHourBlocks({ header, safeHead: head - safeHeadMargin, hourStart, hourEnd: hourStart + 3600 });
    check('firstBlock', result.range.firstBlock, bounds.first.number);
    check('lastBlock', result.range.lastBlock, bounds.last.number);
    check('firstBlockHash', result.range.firstHash, bounds.first.hash);
    check('lastBlockHash', result.range.lastHash, bounds.last.hash);
    check('blockCount', result.network.blockCount, bounds.last.number - bounds.first.number + 1);
    for (const key of CROSS_CHECKED) {
      const theirs = await secondaryLedger(secondary, streamByKey[key], result.range.firstBlock, result.range.lastBlock);
      const ours = primaryLedgers[key];
      check(`${key}LogCount`, ours.count, theirs.count);
      check(`${key}LogIdentitySet`, ours.digest, theirs.digest);
      const differing = ours.buckets.filter((bucket, index) => bucket.digest !== theirs.buckets[index]?.digest);
      if (differing.length || ours.buckets.length !== theirs.buckets.length) {
        print(`  ${key}: first differing 500-block bucket starts at block ${differing[0]?.fromBlock ?? theirs.buckets[ours.buckets.length]?.fromBlock}`);
      }
    }
    if (!checks.every((item) => item.match)) status = 'mismatch';
  } catch (error) {
    status = 'not_verified';
    reason = error?.code ?? error?.message ?? String(error);
    if (!(error instanceof ProviderError || error instanceof LogError || error?.code)) print(error?.stack ?? String(error));
    print(`SECONDARY NOT VERIFIED: ${reason}. The cross-check did not complete, so it is a failure, not a pass.`);
  }
  return { status, reason, checks, resources: { ...stop(), ...traffic(secondary) } };
}

async function sqliteRoundTrip(result, directory) {
  let sqlite;
  try { sqlite = await import('node:sqlite'); } catch { return { status: 'skipped', reason: `node:sqlite unavailable on ${process.version}` }; }
  const path = join(directory, `compact-validation-${process.pid}.sqlite`);
  const db = new sqlite.DatabaseSync(path);
  try {
    const store = createCompactStore(db);
    const first = store.commitHour(result);
    const second = store.commitHour(result);
    const ok = first.outcome === 'inserted' && second.outcome === 'unchanged' && store.hourCount() === 1
      && store.checkpoint()?.hourStart === result.range.hourStart;
    return { status: ok ? 'verified' : 'mismatch', first: first.outcome, replay: second.outcome, databaseBytes: (await stat(path)).size };
  } finally {
    db.close();
    await rm(path, { force: true });
  }
}

export async function validateHour({ primary, secondary, hourStart, expected, safeHeadMargin = SAFE_HEAD_MARGIN_BLOCKS,
  sqliteDirectory = null, print = console.log }) {
  const utc = new Date(hourStart * 1000).toISOString();
  print(`COMPACT HOUR VALIDATION ${utc} to ${new Date((hourStart + 3600) * 1000).toISOString()}`);
  print(`PRIMARY ${COMPACT_ENDPOINTS[0].url}`);
  const stop = startResources();
  const logCalls = {};
  const returnedLogs = Object.fromEntries(LOG_STREAMS.map((stream) => [stream.key, 0]));
  const ledgers = Object.fromEntries(CROSS_CHECKED.map((key) => [key, createLogLedger()]));
  let result = null;
  let failure = null;
  try {
    const head = Number(BigInt(await primary.request('eth_blockNumber')));
    result = await processHour({ provider: countLogCalls(primary, logCalls), hourStart, safeHead: head - safeHeadMargin,
      onLogs: (key, logs) => { returnedLogs[key] += logs.length; ledgers[key]?.add(logs); } });
  } catch (error) {
    if (!(error instanceof HourIncompleteError || error instanceof ProviderError)) throw error;
    failure = error.code;
  }
  const primaryResources = { ...stop(), ...traffic(primary), logCallsByStream: logCalls, returnedLogsByStream: returnedLogs,
    blocks: result?.network.blockCount ?? null, transactions: result?.network.transactionCount ?? null };

  print(`EQUIVALENCE (A2 ground truth vs compact engine)${failure ? `: primary failed with ${failure}` : ''}`);
  const metrics = EQUIVALENCE_METRICS.map(([name, field, read]) => {
    const actual = result ? read(result) : null;
    const match = Number.isSafeInteger(actual) && actual === expected[field];
    print(line(name, expected[field], actual ?? 'unavailable', match));
    return { name, expected: expected[field], actual, match };
  });
  if (result && !result.complete) {
    print(`families unavailable: ${Object.entries(result.families).filter(([, family]) => family.status !== 'available')
      .map(([name, family]) => `${name} (${family.reason})`).join(', ')}`);
  }
  const primaryLedgers = Object.fromEntries(Object.entries(ledgers).map(([key, ledger]) => [key, ledger.finish()]));
  const secondaryReport = result
    ? await crossCheck({ secondary, hourStart, result, primaryLedgers, safeHeadMargin, print })
    : { status: 'not_verified', reason: 'primary_failed', checks: [] };
  const equivalent = metrics.every((metric) => metric.match);
  const sqliteReport = sqliteDirectory && equivalent && result.complete ? await sqliteRoundTrip(result, sqliteDirectory) : null;
  if (sqliteReport) print(`SQLITE round trip: ${JSON.stringify(sqliteReport)}`);

  const ok = equivalent && secondaryReport.status === 'verified' && (!sqliteReport || sqliteReport.status === 'verified');
  const report = { hourStart, utc, ok, metrics, secondary: secondaryReport, sqlite: sqliteReport,
    resources: { primary: primaryResources, secondary: secondaryReport.resources ?? null } };
  print(`COMPACT_RESOURCES ${JSON.stringify(report.resources)}`);
  print(`RESULT ${ok ? 'PASS' : 'FAIL'}: equivalence ${equivalent ? 'MATCH' : 'MISMATCH'}, secondary ${secondaryReport.status}`
    + `${sqliteReport ? `, sqlite ${sqliteReport.status}` : ''}`);
  return { ...report, result };
}

async function main() {
  const argument = process.argv[2] ?? '';
  const hourStart = Date.parse(argument) / 1000;
  const truth = JSON.parse(await readFile(new URL('./fixtures/compact-a2-ground-truth.json', import.meta.url), 'utf8'));
  const known = truth.hours.map((hour) => new Date(hour.hourStart * 1000).toISOString()).join(', ');
  const expected = truth.hours.find((hour) => hour.hourStart === hourStart);
  if (!expected) {
    console.error(`No A2 ground truth for "${argument}". Refusing to compare against invented values. Known hours: ${known}`);
    process.exitCode = 1;
    return;
  }
  const missing = EQUIVALENCE_METRICS.map(([, field]) => field).filter((field) => !Number.isSafeInteger(expected[field]));
  if (missing.length) {
    console.error(`A2 ground truth for ${argument} lacks: ${missing.join(', ')}. Refusing to compare.`);
    process.exitCode = 1;
    return;
  }
  const report = await validateHour({
    primary: createProvider({ endpoints: [COMPACT_ENDPOINTS[0]] }),
    secondary: createProvider({ endpoints: [COMPACT_ENDPOINTS[1]] }),
    hourStart,
    expected,
    sqliteDirectory: process.env.COMPACT_SQLITE_DIR || null,
  });
  process.exitCode = report.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
