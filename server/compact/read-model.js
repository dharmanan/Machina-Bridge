// Compact engine: read-only model of the compact SQLite database for the public Intelligence API. The connection is opened
// with node:sqlite readOnly and PRAGMA query_only, so this module can never change persisted data; it never touches Arc
// RPC. Every answer is computed inside one short read transaction (a single WAL snapshot), so a response never mixes an
// hour with another hour's family rows, a half committed hour, or two definition states. Schema and family definition
// versions are checked inside every snapshot: an incompatible database fails closed instead of being misread.
// Windows are anchored to the committed checkpoint, never to the wall clock. A window is available only when every one
// of its hours is; missing evidence is reported (unavailable / not_supported), never turned into zero.
import { existsSync } from 'node:fs';
import { ARC_ASSETS_BY_ADDRESS } from '../../api/_lib/arc-intelligence/assets.js';
import { FAMILY_FIELDS, FAMILY_WINDOWS } from './families.js';
import { CIRCLE_ARC } from './protocols/circle.js';
import { ARC_CHAIN_ID } from './provider.js';
import { V3_POOL_KIND } from './registry.js';
import { COMPACT_DEFINITION_VERSION, FAMILY_VERSIONS } from './sources.js';
import { ADDRESS_WINDOW_HOURS, COMPACT_SCHEMA_VERSION } from './store.js';
import { sumWindow, WindowError } from './windows.js';

export const SUMMARY_SCHEMA = 'machina.intelligence.summary.v1';
export const TIMESERIES_SCHEMA = 'machina.intelligence.timeseries.v1';
export const SUMMARY_WINDOWS = Object.freeze({ '1h': 1, '6h': 6, '24h': 24 });
export const TIMESERIES_WINDOWS = Object.freeze({ '6h': 6, '24h': 24 });
// lagHours counts complete UTC hours that are not yet committed. In normal operation it is 0, or 1 between the end of an
// hour and its commit (safety delay plus about five minutes of indexing). 2 or more means an hour has been overdue for
// more than a full hour, which is never normal: the data is stale.
export const STALE_LAG_HOURS = 2;
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const HOUR = 3600;
const FAMILIES = Object.keys(FAMILY_FIELDS);
const TABLES = Object.freeze(['compact_meta', 'compact_hours', 'compact_family_hours', 'compact_hour_addresses', 'compact_registry',
  'compact_registry_coverage', 'compact_checkpoint']);
const FAMILY_VERSION_PREFIX = 'family_version:';
const DIGITS = /^\d+$/;

const ARC_USDC = ARC_ASSETS_BY_ADDRESS.get(CIRCLE_ARC.usdc);
// Arc leg amounts of CCTP and Gateway are in the Arc USDC ERC-20 interface units (protocols/circle.js). The canonical USDC
// family is different: its system-emitter amounts carry their own persisted rawDecimals (18), never assumed here.
const USDC_ERC20_UNIT = Object.freeze({ token: ARC_USDC.address, symbol: 'USDC', decimals: ARC_USDC.interfaces.erc20Decimals,
  source: 'arc_usdc_erc20_interface' });
const FAMILY_UNITS = Object.freeze({
  cctp: Object.freeze({ ...USDC_ERC20_UNIT, fields: Object.freeze(['outboundAmountRaw', 'inboundAmountRaw', 'inboundFeeCollectedRaw',
    'outboundByDestinationDomain.*.amountRaw']) }),
  gateway: Object.freeze({ ...USDC_ERC20_UNIT, fields: Object.freeze(['depositAmountRaw', 'outboundBurnAmountRaw', 'outboundBurnFeeRaw',
    'inboundMintAmountRaw', 'withdrawalAmountRaw', 'outboundByDestinationDomain.*.amountRaw', 'inboundBySourceDomain.*.amountRaw']) }),
});
// Machine-readable aggregation rules the UI must respect: these totals are never added to each other.
const AGGREGATION_RULES = Object.freeze({
  usdcIncludesBridgeLegs: 'canonical USDC transfer, mint and burn totals already contain bridge-related mints and burns; '
    + 'CCTP, Gateway and Across amounts are never added to them',
  morphoVaultsV2OverlapsMorphoBlue: 'Morpho Vaults V2 deposits and Morpho Blue supply can be the same capital; never summed',
  gatewayLegsNotAdditive: 'Gateway outbound burns and inbound mints are separate legs; never summed into one volume',
  cctpArcLegOnly: 'CCTP shows the Arc leg only; no net flow is derived from it',
});

export class ReadModelError extends Error {
  constructor(code, detail = null) { super(code); this.code = code; this.detail = detail; }
}

const iso = (seconds) => new Date(seconds * 1000).toISOString();
const int = (value) => BigInt(value); // bind as SQLite INTEGER, never REAL

// A window spec restricted to its top-level additive fields (counts, amounts, constants); keyed breakdowns stay with the
// current window only, so a previous-window comparison stays small. A family with only a list (assets) keeps it.
function scalarSpec(spec) {
  if (!spec.counts?.length && !spec.amounts?.length && !spec.constants?.length) return spec;
  return { counts: spec.counts ?? [], amounts: spec.amounts ?? [], constants: spec.constants ?? [] };
}
const scalarFields = (spec) => [...(spec.counts ?? []), ...(spec.amounts ?? []), ...(spec.constants ?? [])];
// Fields that only make sense for one hour (unique actors, pools with activity, foreign emitters): never summed.
const HOUR_ONLY_FIELDS = Object.freeze(Object.fromEntries(FAMILIES.map((name) => {
  const spec = FAMILY_WINDOWS[name];
  const windowed = new Set([...scalarFields(spec), ...Object.keys(spec.tallies ?? {}), ...Object.keys(spec.lists ?? {})]);
  return [name, Object.freeze(FAMILY_FIELDS[name].filter((field) => !windowed.has(field)))];
})));
const TIMESERIES_FAMILIES = Object.freeze(FAMILIES.filter((name) => scalarFields(FAMILY_WINDOWS[name]).length > 0));

const tokenUnit = (address) => {
  const asset = typeof address === 'string' ? ARC_ASSETS_BY_ADDRESS.get(address.toLowerCase()) : undefined;
  return asset ? { symbol: asset.symbol, decimals: asset.decimals, verified: true } : { symbol: null, decimals: null, verified: false };
};
const mapEntries = (object, mapper) => Object.fromEntries(Object.entries(object ?? {}).map(([key, entry]) => [key, mapper(key, entry)]));

// Decimals beside every exposed amount: persisted where the family stores them, the verified asset registry where a key is a
// token address, otherwise null (raw token units of an unverified token). Persisted values are never changed. Keyed
// breakdowns are annotated only when present (a previous window carries top-level fields only).
function withUnits(name, metrics) {
  const out = { ...metrics };
  if (name === 'usdc') {
    out.units = { amountRaw: { token: ARC_USDC.address, symbol: 'USDC', decimals: metrics.rawDecimals, source: 'persisted_raw_decimals' } };
  } else if (Object.hasOwn(FAMILY_UNITS, name)) {
    out.units = FAMILY_UNITS[name];
  } else if (name === 'across') {
    for (const field of ['depositByToken', 'fillByToken']) {
      if (metrics[field]) out[field] = mapEntries(metrics[field], (token, entry) => ({ ...entry, units: tokenUnit(token) }));
    }
  } else if (name === 'morphoBlue' && metrics.markets) {
    out.markets = mapEntries(metrics.markets, (_id, entry) => ({ ...entry,
      units: { loanToken: tokenUnit(entry.loanToken), collateralToken: tokenUnit(entry.collateralToken) } }));
  } else if (name === 'morphoVaultsV2' && metrics.vaults) {
    out.vaults = mapEntries(metrics.vaults, (_vault, entry) => ({ ...entry, units: { asset: tokenUnit(entry.asset) } }));
  }
  return out; // assets items and Aave reserves carry their persisted decimals
}

// Which persisted definition the database holds, read without any side effect.
function definitionState(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'compact_*'").all().map((row) => row.name);
  if (!tables.length) return { state: 'not_ready', code: 'database_empty' };
  if (TABLES.some((table) => !tables.includes(table))) return { state: 'incompatible', code: 'schema_tables_mismatch' };
  const meta = new Map(db.prepare('SELECT key, value FROM compact_meta').all().map((row) => [row.key, row.value]));
  if (meta.get('schema_version') !== COMPACT_SCHEMA_VERSION) return { state: 'incompatible', code: 'schema_version_mismatch' };
  const stored = [...meta.keys()].filter((key) => key.startsWith(FAMILY_VERSION_PREFIX)).map((key) => key.slice(FAMILY_VERSION_PREFIX.length));
  if (stored.some((name) => !Object.hasOwn(FAMILY_VERSIONS, name))) return { state: 'incompatible', code: 'family_unknown' };
  let missing = false;
  for (const [name, version] of Object.entries(FAMILY_VERSIONS)) {
    const value = meta.get(`${FAMILY_VERSION_PREFIX}${name}`);
    if (value === undefined) missing = true;
    else if (value !== version) return { state: 'incompatible', code: 'family_definition_mismatch' };
  }
  // The writer records a new family's version the first time it opens the database; until then nothing can be served.
  return missing ? { state: 'not_ready', code: 'family_version_missing' } : { state: 'ok', code: null };
}

const SQL = Object.freeze({
  checkpoint: 'SELECT hour_start, last_block, last_hash FROM compact_checkpoint WHERE id = 1',
  bounds: 'SELECT MIN(hour_start) AS first, MAX(hour_start) AS last, COUNT(*) AS count FROM compact_hours',
  networkRows: `SELECT hour_start, block_count, transaction_count, unique_active_addresses, network_json FROM compact_hours
    WHERE hour_start BETWEEN ? AND ? ORDER BY hour_start`,
  identityCounts: `SELECT h.hour_start, h.unique_active_addresses AS expected,
    (SELECT COUNT(*) FROM compact_hour_addresses a WHERE a.hour_start = h.hour_start) AS stored
    FROM compact_hours h WHERE h.hour_start BETWEEN ? AND ?`,
  identityUnion: 'SELECT COUNT(DISTINCT address) AS count FROM compact_hour_addresses WHERE hour_start BETWEEN ? AND ?',
  familyRows: `SELECT h.hour_start, f.status, f.reason, f.metrics_json FROM compact_hours h
    LEFT JOIN compact_family_hours f ON f.hour_start = h.hour_start AND f.family = ?
    WHERE h.hour_start BETWEEN ? AND ? ORDER BY h.hour_start`,
  allFamilyRows: `SELECT hour_start, family, status, reason, metrics_json FROM compact_family_hours
    WHERE hour_start BETWEEN ? AND ?`,
  registryCoverage: 'SELECT through_block FROM compact_registry_coverage WHERE kind = ?',
  poolCount: 'SELECT COUNT(*) AS count FROM compact_registry WHERE kind = ? AND created_block <= ?',
  availableFamilies: `SELECT h.hour_start,
    (SELECT COUNT(*) FROM compact_family_hours f WHERE f.hour_start = h.hour_start AND f.status = 'available') AS available
    FROM compact_hours h WHERE h.hour_start BETWEEN ? AND ? ORDER BY h.hour_start DESC`,
});

// path: the compact SQLite file. DatabaseSync: node:sqlite's class (injected so the module loads on any Node version).
// onSnapshotStarted: test hook, called inside every snapshot right after its first read.
export function createCompactReadModel({ path, DatabaseSync, now = () => Date.now(), busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS,
  onSnapshotStarted = null }) {
  if (typeof path !== 'string' || !path || path === ':memory:' || path.startsWith('file:')) throw new ReadModelError('invalid_path');
  if (typeof DatabaseSync !== 'function') throw new ReadModelError('sqlite_unavailable');
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) throw new ReadModelError('invalid_busy_timeout');
  let db = null;
  let statements = new Map();
  const cache = new Map();

  function connection() {
    if (db) return db;
    if (!existsSync(path)) throw new ReadModelError('not_ready', 'database_missing');
    const opened = new DatabaseSync(path, { readOnly: true, timeout: busyTimeoutMs });
    try {
      opened.exec('PRAGMA query_only = ON');
      opened.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      if (opened.prepare('PRAGMA query_only').get()?.query_only !== 1) throw new ReadModelError('incompatible', 'query_only_unavailable');
    } catch (error) {
      opened.close();
      throw error;
    }
    db = opened;
    statements = new Map();
    return db;
  }
  const statement = (name) => {
    if (!statements.has(name)) statements.set(name, connection().prepare(SQL[name]));
    return statements.get(name);
  };

  // One short read transaction: in WAL mode every statement inside it sees the same committed snapshot. It ends before
  // this function returns, so no snapshot is ever held between requests.
  function snapshot(work, { requireDefinitions = true } = {}) {
    const current = connection();
    if (current.isTransaction === true) current.exec('ROLLBACK');
    current.exec('BEGIN');
    try {
      const state = definitionState(current);
      onSnapshotStarted?.();
      if (state.state === 'incompatible') throw new ReadModelError('incompatible', state.code);
      if (requireDefinitions && state.state !== 'ok') throw new ReadModelError('not_ready', state.code);
      const value = work(state);
      current.exec('COMMIT');
      return value;
    } catch (error) {
      try { current.exec('ROLLBACK'); } catch { /* the original error is the one to report */ }
      throw error instanceof ReadModelError ? error : new ReadModelError('read_failed', error?.code ?? null);
    }
  }

  // Per-window cache, valid until any other connection commits (PRAGMA data_version), never by wall-clock TTL.
  function cached(key, build) {
    const version = connection().prepare('PRAGMA data_version').get().data_version;
    const entry = cache.get(key);
    if (entry && entry.version === version) return entry.value;
    const value = build();
    cache.set(key, { version, value });
    return value;
  }

  // The committed state every window is anchored to; refuses a checkpoint that is not the end of one contiguous run.
  function anchor() {
    const checkpoint = statement('checkpoint').get();
    if (!checkpoint) throw new ReadModelError('not_ready', 'no_checkpoint');
    const bounds = statement('bounds').get();
    if (bounds.last !== checkpoint.hour_start || bounds.count !== (bounds.last - bounds.first) / HOUR + 1) {
      throw new ReadModelError('inconsistent_state', 'checkpoint_not_contiguous');
    }
    return { hour: checkpoint.hour_start, block: checkpoint.last_block, firstHour: bounds.first, storedHours: bounds.count };
  }

  function uniqueActiveAddresses(rows, from, to, hours, newestHour) {
    if (rows.length !== hours) return { status: 'unavailable', reason: 'insufficient_coverage', value: null };
    if (hours === 1) return { status: 'available', value: rows[0].unique_active_addresses };
    // Identities are kept only for the newest ADDRESS_WINDOW_HOURS hours; older windows cannot be reconstructed exactly.
    if (from < newestHour - (ADDRESS_WINDOW_HOURS - 1) * HOUR) {
      return { status: 'not_supported', reason: 'identity_retention_exceeded', value: null };
    }
    const counts = statement('identityCounts').all(int(from), int(to));
    if (counts.length !== hours || counts.some((row) => row.stored !== row.expected)) {
      return { status: 'unavailable', reason: 'identity_incomplete', value: null };
    }
    return { status: 'available', value: statement('identityUnion').get(int(from), int(to)).count };
  }

  function networkWindow(from, to, hours, newestHour) {
    const rows = statement('networkRows').all(int(from), int(to));
    const range = { start: iso(from), end: iso(to + HOUR) };
    if (rows.length !== hours) {
      return { status: 'unavailable', reason: 'insufficient_coverage', ...range, blocks: null, transactions: null, transactionsPerSecond: null,
        averageTransactionsPerBlock: null, gasUsedRaw: null, uniqueActiveAddresses: { status: 'unavailable', reason: 'insufficient_coverage', value: null } };
    }
    let blocks = 0;
    let transactions = 0;
    let gasUsed = 0n;
    for (const row of rows) {
      blocks += row.block_count;
      transactions += row.transaction_count;
      const gasUsedRaw = JSON.parse(row.network_json).gasUsedRaw;
      if (typeof gasUsedRaw !== 'string' || !DIGITS.test(gasUsedRaw)) throw new ReadModelError('inconsistent_state', 'network_gas_malformed');
      gasUsed += BigInt(gasUsedRaw);
    }
    return { status: 'available', ...range, blocks, transactions, transactionsPerSecond: transactions / (hours * HOUR),
      averageTransactionsPerBlock: blocks ? transactions / blocks : null, gasUsedRaw: gasUsed.toString(10),
      uniqueActiveAddresses: uniqueActiveAddresses(rows, from, to, hours, newestHour) };
  }

  function familyWindow(name, from, to, hours, { full }) {
    const rows = statement('familyRows').all(name, int(from), int(to));
    const range = { start: iso(from), end: iso(to + HOUR) };
    if (rows.length !== hours) {
      return { status: 'unavailable', reason: 'insufficient_coverage', reasons: ['insufficient_coverage'], unavailableHours: [], ...range, metrics: null };
    }
    const gaps = rows.filter((row) => row.status !== 'available');
    if (gaps.length) {
      return { status: 'unavailable', reason: 'family_hour_unavailable',
        reasons: [...new Set(gaps.map((row) => (row.status === null ? 'family_not_processed' : row.reason)))].sort(),
        unavailableHours: gaps.map((row) => iso(row.hour_start)), ...range, metrics: null };
    }
    const hourly = rows.map((row) => JSON.parse(row.metrics_json));
    let metrics;
    try {
      metrics = sumWindow(full ? FAMILY_WINDOWS[name] : scalarSpec(FAMILY_WINDOWS[name]), hourly);
    } catch (error) {
      if (!(error instanceof WindowError)) throw error;
      return { status: 'unavailable', reason: error.code, reasons: [error.code], unavailableHours: [], ...range, metrics: null };
    }
    const window = { status: 'available', ...range, metrics: withUnits(name, metrics) };
    if (full) {
      window.hourOnly = hours === 1
        ? { status: 'available', values: Object.fromEntries(HOUR_ONLY_FIELDS[name].map((field) => [field, hourly[0][field]])) }
        : { status: 'not_supported', reason: 'per_hour_unique', values: null };
    }
    return window;
  }

  function buildSummary(windowKey, hours) {
    const state = anchor();
    const to = state.hour;
    const from = to - (hours - 1) * HOUR;
    const previousTo = from - HOUR;
    const previousFrom = previousTo - (hours - 1) * HOUR;
    const network = networkWindow(from, to, hours, state.hour);
    network.previous = networkWindow(previousFrom, previousTo, hours, state.hour);
    const families = Object.fromEntries(FAMILIES.map((name) => {
      const current = familyWindow(name, from, to, hours, { full: true });
      current.previous = familyWindow(name, previousFrom, previousTo, hours, { full: false });
      return [name, current];
    }));
    const registry = statement('registryCoverage').get(V3_POOL_KIND);
    const officialV3Pools = registry && registry.through_block >= state.block
      ? { status: 'available', count: statement('poolCount').get(V3_POOL_KIND, int(state.block)).count, throughBlock: state.block }
      : { status: 'unavailable', reason: registry ? 'registry_behind_checkpoint' : 'registry_missing', count: null, throughBlock: null };
    return {
      window: { key: windowKey, hours, start: iso(from), end: iso(to + HOUR) },
      anchor: state,
      network,
      assets: { usdc: families.usdc, verifiedAssets: families.assets },
      dex: { uniswapV3: families.uniswapV3, uniswapV4: families.uniswapV4, officialV3Pools },
      lending: { aaveV4: families.aaveV4, morphoBlue: families.morphoBlue, morphoVaultsV2: families.morphoVaultsV2 },
      crossChain: { cctp: families.cctp, gateway: families.gateway, across: families.across },
      coverage: {
        firstStoredHour: iso(state.firstHour),
        storedHours: state.storedHours,
        checkpointHour: iso(state.hour),
        verifiedThrough: iso(state.hour + HOUR),
        checkpointBlock: state.block,
        families: Object.fromEntries(FAMILIES.map((name) => [name, families[name].status === 'available'
          ? { status: 'available' }
          : { status: 'unavailable', reasons: families[name].reasons, unavailableHours: families[name].unavailableHours }])),
      },
    };
  }

  function buildTimeseries(windowKey, hours) {
    const state = anchor();
    const to = state.hour;
    const from = to - (hours - 1) * HOUR;
    const network = new Map(statement('networkRows').all(int(from), int(to)).map((row) => [row.hour_start, row]));
    const familyRows = new Map();
    for (const row of statement('allFamilyRows').all(int(from), int(to))) familyRows.set(`${row.hour_start}:${row.family}`, row);
    const buckets = [];
    for (let hour = from; hour <= to; hour += HOUR) {
      const range = { start: iso(hour), end: iso(hour + HOUR) };
      const row = network.get(hour);
      if (!row) {
        buckets.push({ ...range, status: 'not_stored', network: null, families: null });
        continue;
      }
      const gasUsedRaw = JSON.parse(row.network_json).gasUsedRaw;
      if (typeof gasUsedRaw !== 'string' || !DIGITS.test(gasUsedRaw)) throw new ReadModelError('inconsistent_state', 'network_gas_malformed');
      buckets.push({
        ...range,
        status: 'committed',
        network: { blocks: row.block_count, transactions: row.transaction_count, transactionsPerSecond: row.transaction_count / HOUR,
          averageTransactionsPerBlock: row.block_count ? row.transaction_count / row.block_count : null, gasUsedRaw,
          uniqueActiveAddresses: row.unique_active_addresses },
        families: Object.fromEntries(TIMESERIES_FAMILIES.map((name) => {
          const familyRow = familyRows.get(`${hour}:${name}`);
          if (!familyRow) return [name, { status: 'unavailable', reason: 'family_not_processed' }];
          if (familyRow.status !== 'available') return [name, { status: 'unavailable', reason: familyRow.reason }];
          const metrics = JSON.parse(familyRow.metrics_json);
          return [name, { status: 'available', ...Object.fromEntries(scalarFields(FAMILY_WINDOWS[name]).map((field) => [field, metrics[field]])) }];
        })),
      });
    }
    return { window: { key: windowKey, hours, start: iso(from), end: iso(to + HOUR) }, anchor: state, buckets };
  }

  function freshness(state, nowMs) {
    const latestCompleteHour = Math.floor(nowMs / 1000 / HOUR) * HOUR - HOUR;
    const lagHours = Math.max(0, (latestCompleteHour - state.hour) / HOUR);
    return { checkpointHour: iso(state.hour), verifiedThrough: iso(state.hour + HOUR), checkpointBlock: state.block,
      latestCompleteHour: iso(latestCompleteHour), lagHours, stale: lagHours >= STALE_LAG_HOURS, staleRule: `lagHours >= ${STALE_LAG_HOURS}` };
  }

  const definitions = Object.freeze({ schemaVersion: COMPACT_SCHEMA_VERSION, hourDefinition: COMPACT_DEFINITION_VERSION,
    families: FAMILY_VERSIONS, aggregationRules: AGGREGATION_RULES });
  const chain = Object.freeze({ id: ARC_CHAIN_ID, name: 'Arc' });

  return Object.freeze({
    // Process alive, file readable, schema and family versions valid. No checkpoint yet is still healthy (empty store).
    health() {
      return snapshot(() => {
        const checkpoint = statement('checkpoint').get();
        return { status: 'ok', checkpointHour: checkpoint ? iso(checkpoint.hour_start) : null,
          verifiedThrough: checkpoint ? iso(checkpoint.hour_start + HOUR) : null };
      });
    },
    summary(windowKey) {
      if (typeof windowKey !== 'string' || !Object.hasOwn(SUMMARY_WINDOWS, windowKey)) throw new ReadModelError('unsupported_window');
      const core = cached(`summary:${windowKey}`, () => snapshot(() => buildSummary(windowKey, SUMMARY_WINDOWS[windowKey])));
      return { schema: SUMMARY_SCHEMA, chain, window: core.window, freshness: freshness(core.anchor, now()), network: core.network,
        assets: core.assets, dex: core.dex, lending: core.lending, crossChain: core.crossChain, coverage: core.coverage, definitions };
    },
    timeseries(windowKey) {
      if (typeof windowKey !== 'string' || !Object.hasOwn(TIMESERIES_WINDOWS, windowKey)) throw new ReadModelError('unsupported_window');
      const core = cached(`timeseries:${windowKey}`, () => snapshot(() => buildTimeseries(windowKey, TIMESERIES_WINDOWS[windowKey])));
      return { schema: TIMESERIES_SCHEMA, chain, window: core.window, freshness: freshness(core.anchor, now()),
        units: { 'usdc.amountRaw': { decimalsField: 'rawDecimals', source: 'persisted_raw_decimals' }, cctp: FAMILY_UNITS.cctp,
          gateway: FAMILY_UNITS.gateway }, buckets: core.buckets, definitions };
    },
    // For the scheduler: the committed checkpoint, or null for a missing file or an empty store. Never a guess.
    checkpoint() {
      if (!existsSync(path)) return null;
      return snapshot((state) => {
        if (state.code === 'database_empty') return null;
        const checkpoint = statement('checkpoint').get();
        return checkpoint ? { hourStart: checkpoint.hour_start, lastBlock: checkpoint.last_block } : null;
      }, { requireDefinitions: false });
    },
    // Committed hours in [fromHour, toHour] that lack an available row for at least one family, newest first.
    repairCandidates({ fromHour, toHour }) {
      if (!Number.isSafeInteger(fromHour) || !Number.isSafeInteger(toHour) || fromHour % HOUR || toHour % HOUR) {
        throw new ReadModelError('invalid_range');
      }
      return snapshot(() => statement('availableFamilies').all(int(fromHour), int(toHour))
        .filter((row) => row.available < FAMILIES.length).map((row) => row.hour_start));
    },
    close() {
      cache.clear();
      statements = new Map();
      db?.close();
      db = null;
    },
  });
}
