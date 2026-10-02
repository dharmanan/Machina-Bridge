// Compact engine, Stage 2a: one bounded, read-only validation of a completed historical UTC hour against live Arc RPC.
//  - Primary (rpc.mainnet.arc.io) bootstraps the official Uniswap V3 pool registry, then runs the full engine. Retained
//    metrics must equal the A2 ground truth exactly and every family must be available.
//  - Secondary (arc.drpc.org) runs only with --secondary: it independently re-derives the hour boundaries and the
//    canonical USDC and Uniswap V4 log identity sets. Once requested, a secondary failure fails the run; never a pass.
// Each provider is used alone; neither falls back to the other. Exit code 0 only when every check matches.
//   node --expose-gc --max-old-space-size=64 --max-semi-space-size=2 scripts/validate-compact-hour.mjs 2026-10-01T07:00:00Z [--secondary]
// COMPACT_V3_REGISTRY_FROM_BLOCK (default 0): registry scan start. Above 0 it must precede the V3 factory deployment
//   (checked with eth_getCode). The scan costs about one eth_getLogs per 10,000 blocks, paced at one request per second.
// COMPACT_SQLITE_DIR (optional): also round-trip the hour through a temporary node:sqlite file there.
import { createHash } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeLog } from '../api/_lib/arc-intelligence/normalize.js';
import { locateHourBlocks } from '../server/compact/boundary.js';
import { HourIncompleteError, processHour } from '../server/compact/hour.js';
import { LogError, streamLogs } from '../server/compact/logs.js';
import { ARC_SECONDARY_ENDPOINT, createProvider, ProviderError } from '../server/compact/provider.js';
import { bootstrapV3Registry, RegistryError, registrySnapshot } from '../server/compact/registry.js';
import { DENSE_LOG_RANGE_BLOCKS, LOG_STREAMS } from '../server/compact/sources.js';
import { headerOf } from '../server/compact/spine.js';
import { createCompactStore } from '../server/compact/store.js';

export const SAFE_HEAD_MARGIN_BLOCKS = 200;
// Recommended for a production process (not applied here): caps V8's heap high-water mark, which is what RSS keeps.
export const RECOMMENDED_NODE_FLAGS = Object.freeze(['--max-old-space-size=64', '--max-semi-space-size=2']);
const hex = (number) => `0x${number.toString(16)}`;
const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
const streamByKey = Object.fromEntries(LOG_STREAMS.map((stream) => [stream.key, stream]));
const CROSS_CHECKED = ['usdc', 'v4'];
const MEMORY_FIELDS = ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers'];

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

// RSS alone cannot tell retained JS objects from V8's kept pages or native buffers, so every component is reported.
// Peaks are sampled every 25 ms and whenever a log response is handed over; "after" follows a forced GC when exposed.
function startResources() {
  globalThis.gc?.();
  const before = process.memoryUsage();
  const peak = { ...before };
  const sample = () => {
    const now = process.memoryUsage();
    for (const field of MEMORY_FIELDS) peak[field] = Math.max(peak[field], now[field]);
  };
  const timer = setInterval(sample, 25);
  const started = performance.now();
  return {
    sample,
    stop() {
      clearInterval(timer);
      sample();
      const elapsedMs = Math.round(performance.now() - started);
      globalThis.gc?.();
      const after = process.memoryUsage();
      const report = { elapsedMs, gcExposed: typeof globalThis.gc === 'function', execArgv: process.execArgv };
      for (const field of MEMORY_FIELDS) {
        Object.assign(report, { [`${field}BeforeMb`]: mb(before[field]), [`${field}PeakSampledMb`]: mb(peak[field]), [`${field}AfterMb`]: mb(after[field]) });
      }
      report.maxRssProcessMb = mb(process.resourceUsage().maxRSS * 1024);
      return report;
    },
  };
}

const statsOf = (provider) => ({ requests: provider.stats.requests, responseBytes: provider.stats.responseBytes,
  retries: provider.stats.retries, calls: { ...provider.stats.calls } });
// Traffic since `base` (statsOf), so the registry bootstrap and the hour are reported separately.
function traffic(provider, base = { requests: 0, responseBytes: 0, retries: 0, calls: {} }) {
  const now = statsOf(provider);
  return { httpRequests: now.requests - base.requests, retries: now.retries - base.retries,
    rpcCalls: Object.fromEntries(Object.entries(now.calls).map(([method, count]) => [method, count - (base.calls[method] ?? 0)]).filter(([, count]) => count > 0)),
    responseBytesDecoded: now.responseBytes - base.responseBytes, responseMbDecoded: mb(now.responseBytes - base.responseBytes) };
}

const diagnosticsOf = (error) => (error instanceof ProviderError
  ? { endpoint: error.endpoint, httpStatus: error.httpStatus, rpcCode: error.rpcCode, detail: error.detail } : null);

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
    for await (const response of streamLogs(provider, stream, from, to)) {
      ledger.add(response.map((raw) => {
        if (raw?.removed === true) throw new LogError('removed_log');
        let log;
        try { log = normalizeLog(raw); } catch { throw new LogError('malformed_log'); }
        if (log.blockNumber < from || log.blockNumber > to || !log.blockHash || !log.transactionHash) throw new LogError('malformed_log', log.blockNumber);
        if (!stream.address.includes(log.address) || !stream.topics.includes(log.topics[0])) throw new LogError('unexpected_log', log.blockNumber);
        if (seen.has(`${log.blockNumber}:${log.logIndex}`)) throw new LogError('duplicate_log', log.blockNumber);
        seen.add(`${log.blockNumber}:${log.logIndex}`);
        return log;
      }).sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex));
    }
  }
  return ledger.finish();
}

async function crossCheck({ secondary, hourStart, result, primaryLedgers, safeHeadMargin, print }) {
  const resources = startResources();
  const checks = [];
  const check = (name, expected, actual) => {
    checks.push({ name, expected, actual, match: expected === actual });
    print(line(name, expected, actual, expected === actual));
  };
  print(`SECONDARY CROSS-CHECK ${secondary.endpoint?.url ?? 'secondary'} (EXPECTED = primary, ACTUAL = secondary)`);
  let status = 'verified';
  let reason = null;
  let diagnostics = null;
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
    diagnostics = diagnosticsOf(error);
    if (!(error instanceof ProviderError || error instanceof LogError || error?.code)) print(error?.stack ?? String(error));
    print(`SECONDARY NOT VERIFIED: ${reason}${diagnostics ? ` ${JSON.stringify(diagnostics)}` : ''}. The cross-check did not complete, so it is a failure, not a pass.`);
  }
  return { status, reason, diagnostics, checks, resources: { ...resources.stop(), ...traffic(secondary) } };
}

// Any spine-complete hour (complete or with unavailable families) must commit, replay unchanged and read back.
async function sqliteRoundTrip(result, registryScan, directory) {
  let sqlite;
  try { sqlite = await import('node:sqlite'); } catch { return { status: 'skipped', reason: `node:sqlite unavailable on ${process.version}` }; }
  const path = join(directory, `compact-validation-${process.pid}.sqlite`);
  const db = new sqlite.DatabaseSync(path);
  let report;
  try {
    const store = createCompactStore(db);
    if (registryScan) store.extendRegistry(registryScan);
    const first = store.commitHour(result);
    const second = store.commitHour(result);
    const families = store.familyRows(result.range.hourStart);
    const ok = first.outcome === 'inserted' && second.outcome === 'unchanged' && store.hourCount() === 1
      && store.checkpoint()?.hourStart === result.range.hourStart
      && families.length === Object.keys(result.families).length
      && families.every((row) => row.status === result.families[row.family].status)
      && store.uniqueActiveAddresses(result.range.hourStart, 1) === result.network.uniqueActiveAddresses;
    report = { status: ok ? 'verified' : 'mismatch', first: first.outcome, replay: second.outcome,
      families: Object.fromEntries(families.map((row) => [row.family, row.status])) };
  } catch (error) {
    report = { status: 'failed', reason: error?.code ?? error?.message ?? String(error) };
  } finally {
    db.close();
  }
  report.databaseBytes = (await stat(path)).size;
  await Promise.all(['', '-wal', '-shm'].map((suffix) => rm(`${path}${suffix}`, { force: true })));
  return report;
}

export async function validateHour({ primary, secondary = null, hourStart, expected, safeHeadMargin = SAFE_HEAD_MARGIN_BLOCKS,
  sqliteDirectory = null, v3RegistryFromBlock = 0, print = console.log }) {
  const utc = new Date(hourStart * 1000).toISOString();
  print(`COMPACT HOUR VALIDATION ${utc} to ${new Date((hourStart + 3600) * 1000).toISOString()}`);
  print(`PRIMARY ${primary.endpoint?.url ?? 'primary'}`);
  print(`RECOMMENDED PRODUCTION NODE FLAGS ${RECOMMENDED_NODE_FLAGS.join(' ')} (this run: ${process.execArgv.join(' ') || 'none'})`);
  let failure = null;
  let safeHead = null;
  try {
    safeHead = Number(BigInt(await primary.request('eth_blockNumber'))) - safeHeadMargin;
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    failure = error.code;
  }

  // Official V3 pool registry, through the safe head: it then covers the hour whatever the hour's position.
  const registryBase = statsOf(primary);
  const registryStarted = performance.now();
  let registryScan = null;
  let registryFailure = failure;
  if (safeHead !== null) {
    try {
      registryScan = await bootstrapV3Registry(primary, { fromBlock: v3RegistryFromBlock, toBlock: safeHead });
    } catch (error) {
      if (!(error instanceof ProviderError || error instanceof LogError || error instanceof RegistryError)) throw error;
      registryFailure = error.code;
    }
  }
  const registry = { fromBlock: v3RegistryFromBlock, through: registryScan?.through ?? null, officialPools: registryScan?.created.length ?? null,
    failure: registryFailure, elapsedMs: Math.round(performance.now() - registryStarted), ...traffic(primary, registryBase) };
  print(`V3 REGISTRY ${registryScan ? `blocks ${registry.fromBlock}-${registry.through}: ${registry.officialPools} official pools`
    : `unavailable (${registryFailure}); V3 will be reported unavailable`} (${registry.httpRequests} requests)`);

  const hourBase = statsOf(primary);
  const resources = startResources();
  const logCalls = {};
  const returnedLogs = Object.fromEntries(LOG_STREAMS.map((stream) => [stream.key, 0]));
  const ledgers = Object.fromEntries(CROSS_CHECKED.map((key) => [key, createLogLedger()]));
  let result = null;
  if (safeHead !== null) {
    try {
      result = await processHour({ provider: countLogCalls(primary, logCalls), hourStart, safeHead,
        v3Registry: registryScan ? registrySnapshot(registryScan) : null,
        onLogs: (key, logs) => { returnedLogs[key] += logs.length; ledgers[key]?.add(logs); resources.sample(); } });
    } catch (error) {
      if (!(error instanceof HourIncompleteError || error instanceof ProviderError)) throw error;
      failure = error.code;
    }
  }
  const primaryResources = { ...resources.stop(), ...traffic(primary, hourBase), logCallsByStream: logCalls, returnedLogsByStream: returnedLogs,
    blocks: result?.network.blockCount ?? null, transactions: result?.network.transactionCount ?? null };

  print(`EQUIVALENCE (A2 ground truth vs compact engine)${failure ? `: primary failed with ${failure}` : ''}`);
  const metrics = EQUIVALENCE_METRICS.map(([name, field, read]) => {
    const actual = result ? read(result) : null;
    const match = Number.isSafeInteger(actual) && actual === expected[field];
    print(line(name, expected[field], actual ?? 'unavailable', match));
    return { name, expected: expected[field], actual, match };
  });
  const unavailable = result ? Object.entries(result.families).filter(([, family]) => family.status !== 'available') : [];
  if (unavailable.length) print(`families unavailable: ${unavailable.map(([name, family]) => `${name} (${family.reason})`).join(', ')}`);
  const v3 = result?.families.uniswapV3;
  if (v3?.status === 'available') {
    print(`UNISWAP V3 official: ${v3.swapCount} swaps, ${v3.mintCount} mints, ${v3.burnCount} burns in ${v3.poolsWithSwaps} pools; `
      + `${v3.poolCreatedCount} pools created; foreign V3-signature emitters ignored: ${v3.foreignEmitterCount} (${v3.foreignEventCount} events)`);
  }
  const primaryLedgers = Object.fromEntries(Object.entries(ledgers).map(([key, ledger]) => [key, ledger.finish()]));
  let secondaryReport = { status: 'not_requested', reason: null, checks: [] };
  if (secondary) {
    secondaryReport = result ? await crossCheck({ secondary, hourStart, result, primaryLedgers, safeHeadMargin, print })
      : { status: 'not_verified', reason: 'primary_failed', checks: [] };
  }
  const equivalent = metrics.every((metric) => metric.match);
  const sqliteReport = sqliteDirectory && result ? await sqliteRoundTrip(result, registryScan, sqliteDirectory) : null;
  if (sqliteReport) print(`SQLITE round trip: ${JSON.stringify(sqliteReport)}`);

  const complete = result?.complete === true;
  const ok = equivalent && complete && (!secondary || secondaryReport.status === 'verified') && (!sqliteReport || sqliteReport.status === 'verified');
  const report = { hourStart, utc, ok, metrics, complete, secondary: secondaryReport, sqlite: sqliteReport,
    resources: { registry, primary: primaryResources, secondary: secondaryReport.resources ?? null } };
  print(`COMPACT_RESOURCES ${JSON.stringify(report.resources)}`);
  print(`RESULT ${ok ? 'PASS' : 'FAIL'}: equivalence ${equivalent ? 'MATCH' : 'MISMATCH'}, families ${complete ? 'all available' : 'NOT all available'}, `
    + `secondary ${secondaryReport.status}${sqliteReport ? `, sqlite ${sqliteReport.status}` : ''}`);
  return { ...report, result };
}

async function main() {
  const argument = process.argv.slice(2).find((value) => !value.startsWith('--')) ?? '';
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
  const v3RegistryFromBlock = Number(process.env.COMPACT_V3_REGISTRY_FROM_BLOCK ?? 0);
  if (!Number.isSafeInteger(v3RegistryFromBlock) || v3RegistryFromBlock < 0) {
    console.error('COMPACT_V3_REGISTRY_FROM_BLOCK must be a non-negative block number.');
    process.exitCode = 1;
    return;
  }
  const report = await validateHour({
    primary: createProvider(),
    secondary: process.argv.includes('--secondary') ? createProvider({ endpoint: ARC_SECONDARY_ENDPOINT }) : null,
    hourStart,
    expected,
    sqliteDirectory: process.env.COMPACT_SQLITE_DIR || null,
    v3RegistryFromBlock,
  });
  process.exitCode = report.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
