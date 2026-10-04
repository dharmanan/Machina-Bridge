// Compact engine, Stage 2b: one-shot persistent runner. Processes one complete UTC hour into a persistent node:sqlite
// database and exits. The official Uniswap V3 pool registry lives in the same database: the first run bootstraps it once
// from the factory deployment block; later runs reuse it, or catch up only the blocks after its stored coverage, and never
// rescan history. Coverage is only extended to the block before the requested hour; the hour's own validated PoolCreated
// logs advance it through the hour on commit. Strictly forward-only: an empty database accepts any first hour; after that
// only the checkpoint's next hour is processed. An hour already stored with every family available is reported without
// any RPC request; an hour stored with an unavailable family, or without a row for a family added later, is repaired.
// Uniswap pool/activity projections (projections.js) come from the same requests and commit with the hour; they are not
// families, so their status is reported but never makes the run fail or triggers a repair. The hour's valuations (token
// prices, DEX USD volume) are derived from stored rows in the same commit; afterwards a bounded pass derives them for stored
// hours that have none yet (no RPC), and a bounded step reads ERC-20 metadata of at most METADATA_TOKENS_PER_RUN newly met
// pool tokens (at most two batched eth_call requests). Neither step can fail the run.
// Primary Arc RPC only: no secondary, no failover. No daemon, scheduler or server.
//   COMPACT_SQLITE_PATH=/data/arc-compact.sqlite [COMPACT_RPC_MIN_INTERVAL_MS=1000] \
//   node --expose-gc --max-old-space-size=64 --max-semi-space-size=2 scripts/run-compact-hour.mjs 2026-10-01T07:00:00Z
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FAMILY_FIELDS } from '../server/compact/families.js';
import { locateHour, processHour } from '../server/compact/hour.js';
import { createProvider, ProviderError } from '../server/compact/provider.js';
import { bootstrapV3Registry, catchUpV3Registry } from '../server/compact/registry.js';
import { createCompactStore } from '../server/compact/store.js';
import { METADATA_TOKENS_PER_RUN, refreshTokenMetadata } from '../server/compact/token-metadata.js';

// First block with official V3 factory code on Arc mainnet (eth_getCode: none at 1948018, present at 1948019). The
// bootstrap still proves it: bootstrapV3Registry refuses a start that is not before the factory deployment.
export const V3_FACTORY_DEPLOYMENT_BLOCK = 1_948_019;
export const SAFE_HEAD_MARGIN_BLOCKS = 200;
export const DEFAULT_RPC_INTERVAL_MS = 1000;
export const MIN_RPC_INTERVAL_MS = 500; // 250 ms drew HTTP 429 from the primary RPC after 11 requests
// Stored hours without valuations derived per run, newest first (24 hours of a fresh window come first).
export const VALUATION_HOURS_PER_RUN = 72;
const HOUR = 3600;
const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
const iso = (seconds) => new Date(seconds * 1000).toISOString();
const span = (registry) => (registry ? `${registry.fromBlock}-${registry.through}` : 'none');
const statusOf = (family) => (family.status === 'available' ? 'available' : `unavailable(${family.reason})`);

export class RunnerError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Arguments and environment, checked before any file is opened or any request is made.
export function runnerConfig({ argv = process.argv.slice(2), env = process.env } = {}) {
  const hourStart = Date.parse(argv.find((value) => !value.startsWith('--')) ?? '') / 1000;
  if (!Number.isSafeInteger(hourStart) || hourStart % HOUR !== 0) throw new RunnerError('invalid_hour');
  const sqlitePath = env.COMPACT_SQLITE_PATH?.trim();
  if (!sqlitePath || sqlitePath === ':memory:' || sqlitePath.startsWith('file:')) throw new RunnerError('sqlite_path_required');
  const pacing = env.COMPACT_RPC_MIN_INTERVAL_MS ?? String(DEFAULT_RPC_INTERVAL_MS);
  const minIntervalMs = /^\d+$/.test(pacing) ? Number(pacing) : Number.NaN;
  if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < MIN_RPC_INTERVAL_MS) throw new RunnerError('unsafe_rpc_pacing');
  return { hourStart, sqlitePath: resolve(sqlitePath), minIntervalMs };
}

export async function runCompactHour({ sqlitePath, hourStart, provider, registryFromBlock = V3_FACTORY_DEPLOYMENT_BLOCK,
  safeHeadMargin = SAFE_HEAD_MARGIN_BLOCKS, print = console.log }) {
  const started = performance.now();
  const summary = { targetHour: iso(hourStart), sqlitePath, hourMode: null, repairFamilies: null, registryMode: null, registryBefore: null,
    registryAfter: null, officialV3Pools: null, hourOutcome: null, families: null, projections: null, valuations: null, valuationPass: null,
    metadata: null, checkpoint: null, provider: null, elapsedMs: null, sqliteBytes: null, ok: false, reason: null, diagnostics: null };
  print(`TARGET_HOUR ${summary.targetHour}`);
  print(`SQLITE_PATH ${sqlitePath}`);
  let db = null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(sqlitePath);
    const store = createCompactStore(db);
    const before = store.v3Registry();
    summary.registryBefore = span(before);
    const stored = store.familyRows(hourStart);
    // Unavailable families, and families added after the hour was stored (no row yet), are both repaired.
    const unavailableStored = [...stored.filter((row) => row.status !== 'available').map((row) => row.family),
      ...(stored.length ? Object.keys(FAMILY_FIELDS).filter((name) => !stored.some((row) => row.family === name)) : [])];
    if (stored.length && !unavailableStored.length) {
      // Stored with every family available: nothing to fetch, scan or write.
      summary.hourMode = 'stored';
      summary.registryMode = before ? 'reused' : 'none';
      summary.hourOutcome = 'already_committed';
    } else {
      // Repair: this exact stored hour again, on the persisted registry only (never a registry scan). commitHour then
      // upgrades unavailable families, keeps available ones immutable and leaves the checkpoint where it is.
      const repair = stored.length > 0;
      summary.hourMode = repair ? 'repair' : 'new';
      if (repair) summary.repairFamilies = unavailableStored;
      const checkpoint = store.checkpoint();
      if (!repair && checkpoint && hourStart > checkpoint.hourStart + HOUR) throw new RunnerError('checkpoint_gap');
      if (!repair && checkpoint && hourStart < checkpoint.hourStart + HOUR) throw new RunnerError('hour_before_checkpoint');
      const safeHead = Number(BigInt(await provider.request('eth_blockNumber'))) - safeHeadMargin;
      const bounds = await locateHour({ provider, hourStart, safeHead });
      const target = bounds.before.number; // the registry must cover every block before the hour
      if (repair) {
        // Coverage short of the hour is not scanned here: V3 then stays unavailable (v3_registry_missing/behind).
        summary.registryMode = !before ? 'none' : before.through >= target ? 'reused' : 'behind';
      } else if (!before) {
        summary.registryMode = 'bootstrap';
        store.extendRegistry(await bootstrapV3Registry(provider, { fromBlock: registryFromBlock, toBlock: target }));
      } else if (before.through < target) {
        summary.registryMode = 'catchup';
        store.extendRegistry(await catchUpV3Registry(provider, before, target));
      } else summary.registryMode = 'reused';
      const result = await processHour({ provider, hourStart, safeHead, v3Registry: store.v3Registry(), bounds });
      summary.hourOutcome = store.commitHour(result).outcome;
      // Display metadata of newly met pool tokens, read at the safe head. Never fails the run.
      summary.metadata = await refreshTokenMetadata({ store, provider, blockNumber: safeHead, limit: METADATA_TOKENS_PER_RUN });
    }
    // Valuations of stored hours that have none yet (hours stored before valuations existed). No RPC; never fails the run.
    try {
      summary.valuationPass = { derived: store.derivePendingValuations({ limit: VALUATION_HOURS_PER_RUN }).hours.length, error: null };
    } catch (error) {
      summary.valuationPass = { derived: 0, error: error?.code ?? error?.message ?? 'valuation_pass_failed' };
    }
    // What is stored now, which a repair can only improve: an available family is never replaced or downgraded.
    summary.families = Object.fromEntries(store.familyRows(hourStart).map((row) => [row.family, statusOf(row)]));
    summary.projections = Object.fromEntries(store.projectionStatus(hourStart).map((row) => [row.projection, statusOf(row)]));
    summary.valuations = Object.fromEntries(store.valuationStatus(hourStart).map((row) => [row.valuation, statusOf(row)]));
    const after = store.v3Registry();
    summary.registryAfter = span(after);
    summary.officialV3Pools = after?.pools.size ?? null;
    const checkpoint = store.checkpoint();
    summary.checkpoint = checkpoint && { hour: iso(checkpoint.hourStart), lastBlock: checkpoint.lastBlock, lastHash: checkpoint.lastHash };
    const unavailable = Object.entries(summary.families).filter(([, status]) => status !== 'available').map(([name]) => name);
    summary.ok = unavailable.length === 0;
    if (!summary.ok) summary.reason = `families_unavailable:${unavailable.join(',')}`;
  } catch (error) {
    summary.reason = error?.code ?? `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;
    if (error instanceof ProviderError) {
      summary.diagnostics = { endpoint: error.endpoint, httpStatus: error.httpStatus, rpcCode: error.rpcCode, detail: error.detail };
    }
  } finally {
    db?.close();
  }
  summary.provider = { requests: provider.stats.requests, retries: provider.stats.retries, calls: { ...provider.stats.calls },
    responseMbDecoded: mb(provider.stats.responseBytes) };
  summary.elapsedMs = Math.round(performance.now() - started);
  const sizeOf = (path) => stat(path).then((file) => file.size, () => null);
  summary.sqliteBytes = { db: await sizeOf(sqlitePath), wal: await sizeOf(`${sqlitePath}-wal`) };

  print(`HOUR_MODE ${summary.hourMode ?? 'not_reached'}${summary.repairFamilies ? ` repair_families=${summary.repairFamilies.join(',')}` : ''}`);
  print(`REGISTRY_MODE ${summary.registryMode ?? 'not_reached'}`);
  print(`REGISTRY_COVERAGE before=${summary.registryBefore ?? 'unknown'} after=${summary.registryAfter ?? 'unknown'}`);
  print(`V3_OFFICIAL_POOLS ${summary.officialV3Pools ?? 'unknown'}`);
  print(`HOUR_OUTCOME ${summary.hourOutcome ?? 'not_committed'}`);
  print(`FAMILIES ${summary.families ? Object.entries(summary.families).map(([name, status]) => `${name}=${status}`).join(' ') : 'unknown'}`);
  print(`PROJECTIONS ${summary.projections && Object.keys(summary.projections).length
    ? Object.entries(summary.projections).map(([name, status]) => `${name}=${status}`).join(' ') : 'none'}`);
  print(`VALUATIONS ${summary.valuations && Object.keys(summary.valuations).length
    ? Object.entries(summary.valuations).map(([name, status]) => `${name}=${status}`).join(' ') : 'none'}`);
  print(`VALUATION_PASS ${summary.valuationPass ? `derived=${summary.valuationPass.derived}${summary.valuationPass.error ? ` error=${summary.valuationPass.error}` : ''}` : 'not_reached'}`);
  print(`TOKEN_METADATA ${summary.metadata ? `candidates=${summary.metadata.candidates} verified=${summary.metadata.verified} `
    + `rejected=${summary.metadata.rejected} skipped=${summary.metadata.skipped} requests=${summary.metadata.requests}`
    + `${summary.metadata.error ? ` error=${summary.metadata.error}` : ''}` : 'not_run'}`);
  print(`CHECKPOINT ${summary.checkpoint ? `${summary.checkpoint.hour} last_block=${summary.checkpoint.lastBlock}` : 'none'}`);
  print(`PROVIDER requests=${summary.provider.requests} retries=${summary.provider.retries} response_mb=${summary.provider.responseMbDecoded} `
    + `calls=${JSON.stringify(summary.provider.calls)}`);
  print(`ELAPSED_MS ${summary.elapsedMs}`);
  print(`SQLITE_BYTES db=${summary.sqliteBytes.db} wal=${summary.sqliteBytes.wal ?? 0}`);
  print(`MEMORY max_rss_mb=${mb(process.resourceUsage().maxRSS * 1024)} heap_used_mb=${mb(process.memoryUsage().heapUsed)}`);
  print(`COMPACT_RUN_SUMMARY ${JSON.stringify(summary)}`);
  print(`RESULT ${summary.ok ? 'PASS' : `FAIL ${summary.reason}`}${summary.diagnostics ? ` ${JSON.stringify(summary.diagnostics)}` : ''}`);
  return summary;
}

async function main() {
  let config;
  try {
    config = runnerConfig();
  } catch (error) {
    console.log(`RESULT FAIL ${error.code ?? error.message}`);
    process.exitCode = 1;
    return;
  }
  const provider = createProvider({ minIntervalMs: config.minIntervalMs });
  console.log(`RPC ${provider.endpoint.url} min_interval_ms=${config.minIntervalMs}`);
  const summary = await runCompactHour({ sqlitePath: config.sqlitePath, hourStart: config.hourStart, provider });
  process.exitCode = summary.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
