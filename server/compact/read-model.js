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
import { POOL_PROJECTION_FAMILY, projectionRepairState, V4_POOL_KIND } from './projections.js';
import { CIRCLE_ARC } from './protocols/circle.js';
import { ARC_CHAIN_ID } from './provider.js';
import { V3_POOL_KIND } from './registry.js';
import { COMPACT_DEFINITION_VERSION, FAMILY_VERSIONS } from './sources.js';
import { ADDRESS_WINDOW_HOURS, COMPACT_SCHEMA_VERSION } from './store.js';
import { sumWindow, WindowError } from './windows.js';

export const SUMMARY_SCHEMA = 'machina.intelligence.summary.v1';
export const TIMESERIES_SCHEMA = 'machina.intelligence.timeseries.v1';
export const POOLS_SCHEMA = 'machina.intelligence.pools.v1';
export const ACTIVITY_SCHEMA = 'machina.intelligence.activity.v1';
export const SUMMARY_WINDOWS = Object.freeze({ '1h': 1, '6h': 6, '24h': 24 });
export const TIMESERIES_WINDOWS = Object.freeze({ '6h': 6, '24h': 24 });
export const POOLS_WINDOWS = Object.freeze({ '24h': 24 });
export const ACTIVITY_TYPES = Object.freeze({ all: null, swaps: 'swap', adds: 'add', removes: 'remove' });
// lagHours counts complete UTC hours that are not yet committed. In normal operation it is 0, or 1 between the end of an
// hour and its commit (safety delay plus about five minutes of indexing). 2 or more means an hour has been overdue for
// more than a full hour, which is never normal: the data is stale.
export const STALE_LAG_HOURS = 2;
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const HOUR = 3600;
const ACTIVITY_LIMIT = 25;
const POOL_LIMIT = 10;
const FAMILIES = Object.keys(FAMILY_FIELDS);
const TABLES = Object.freeze(['compact_meta', 'compact_hours', 'compact_family_hours', 'compact_hour_addresses', 'compact_registry',
  'compact_registry_coverage', 'compact_checkpoint']);
const FAMILY_VERSION_PREFIX = 'family_version:';
const DIGITS = /^\d+$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const POOL_PROTOCOLS = Object.freeze({
  v3: Object.freeze({ protocol: 'uniswap_v3', projection: 'uniswap_v3_pools', registryKind: V3_POOL_KIND }),
  v4: Object.freeze({ protocol: 'uniswap_v4', projection: 'uniswap_v4_pools', registryKind: V4_POOL_KIND }),
});

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

// A pool token: the verified asset registry names known tokens, and Uniswap V4's currency 0x0 is Arc's native USDC
// (the registry's native interface, 18 decimals). Any other address stays unnamed: no token metadata is fetched or guessed.
const poolToken = (address) => (address === ZERO_ADDRESS
  ? { address, symbol: ARC_USDC.symbol, decimals: ARC_USDC.interfaces.nativeDecimals, verified: true, native: true }
  : { address, ...tokenUnit(address), native: false });
const isDigits = (value) => typeof value === 'string' && DIGITS.test(value);
const isSignedDigits = (value) => typeof value === 'string' && /^-?\d+$/.test(value);

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
  // Pools and recent activity (pools.v1 / activity.v1). The projection tables are optional: an older database without
  // them still serves health, summary and timeseries, and these reads report projection_not_ready.
  registryCreatedCount: 'SELECT COUNT(*) AS count FROM compact_registry WHERE kind = ? AND created_block BETWEEN ? AND ?',
  registryMeta: 'SELECT created_block, meta_json FROM compact_registry WHERE kind = ? AND address = ?',
  windowBlocks: `SELECT MIN(first_block) AS first_block, MAX(last_block) AS last_block, COUNT(*) AS hours
    FROM compact_hours WHERE hour_start BETWEEN ? AND ?`,
  projectionDataTables: `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'
    AND name IN ('compact_projection_hours', 'compact_pool_hours', 'compact_dex_activity')`,
  projectionStatusRows: `SELECT h.hour_start, p.status, p.reason FROM compact_hours h
    LEFT JOIN compact_projection_hours p ON p.hour_start = h.hour_start AND p.projection = ?
    WHERE h.hour_start BETWEEN ? AND ? ORDER BY h.hour_start`,
  projectionHour: 'SELECT status, reason FROM compact_projection_hours WHERE hour_start = ? AND projection = ?',
  // The top pools by summed swap count (ties by pool id), then only their own hourly rows: bounded by the pool limit, never
  // every pool of the window in memory. Raw token totals are summed in BigInt afterwards, never in SQL.
  topPoolRows: `WITH top AS (SELECT pool, SUM(swap_count) AS total FROM compact_pool_hours
      WHERE protocol = ?1 AND hour_start BETWEEN ?2 AND ?3 GROUP BY pool HAVING total > 0 ORDER BY total DESC, pool ASC LIMIT ?4)
    SELECT p.pool, top.total, p.token0_in_raw, p.token0_out_raw, p.token1_in_raw, p.token1_out_raw, p.add_count, p.remove_count,
      p.poke_count, p.add_amount0_raw, p.add_amount1_raw, p.remove_amount0_raw, p.remove_amount1_raw
    FROM compact_pool_hours p JOIN top ON top.pool = p.pool
    WHERE p.protocol = ?1 AND p.hour_start BETWEEN ?2 AND ?3 ORDER BY top.total DESC, p.pool ASC, p.hour_start ASC`,
  activityRows: `SELECT block_number, log_index, block_timestamp, tx_hash, tx_from, protocol, kind, pool, amount0_raw, amount1_raw,
    amount_basis, counterparty, counterparty_kind FROM compact_dex_activity WHERE (?1 IS NULL OR kind = ?1)
    ORDER BY block_number DESC, log_index DESC LIMIT ?2`,
  // Projection repair state per stored hour: primary-key lookups only (compact_hours by hour, family and projection rows by
  // their (hour_start, name) keys), so a 35-day scan stays a bounded index read.
  projectionTable: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'compact_projection_hours'",
  projectionRows: `SELECT h.hour_start, h.first_block, h.last_block, v3f.status AS v3_family, v4f.status AS v4_family,
    v3p.status AS v3_projection, v4p.status AS v4_projection, ap.status AS activity
    FROM compact_hours h
    LEFT JOIN compact_family_hours v3f ON v3f.hour_start = h.hour_start AND v3f.family = 'uniswapV3'
    LEFT JOIN compact_family_hours v4f ON v4f.hour_start = h.hour_start AND v4f.family = 'uniswapV4'
    LEFT JOIN compact_projection_hours v3p ON v3p.hour_start = h.hour_start AND v3p.projection = 'uniswap_v3_pools'
    LEFT JOIN compact_projection_hours v4p ON v4p.hour_start = h.hour_start AND v4p.projection = 'uniswap_v4_pools'
    LEFT JOIN compact_projection_hours ap ON ap.hour_start = h.hour_start AND ap.projection = 'dex_activity'
    WHERE h.hour_start BETWEEN ? AND ? ORDER BY h.hour_start`,
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

  const projectionDataReady = () => statement('projectionDataTables').get().count === 3;

  // Projection status of every hour of the window: available only when each hour is; a gap is never a partial window.
  function projectionWindow(name, from, to, hours) {
    const rows = statement('projectionStatusRows').all(name, int(from), int(to));
    if (rows.length !== hours) return { status: 'unavailable', reason: 'insufficient_coverage', reasons: ['insufficient_coverage'], unavailableHours: [] };
    const gaps = rows.filter((row) => row.status !== 'available');
    if (!gaps.length) return { status: 'available', reason: null, reasons: [], unavailableHours: [] };
    return { status: 'unavailable', reason: 'projection_hour_unavailable',
      reasons: [...new Set(gaps.map((row) => (row.status === null ? 'projection_not_processed' : row.reason ?? 'projection_unavailable')))].sort(),
      unavailableHours: gaps.map((row) => iso(row.hour_start)) };
  }

  // Exact identity of a registry pool. Malformed or missing metadata fails the whole answer closed, never a guessed pair.
  function registryDetails(kind, pool) {
    const row = statement('registryMeta').get(kind, pool);
    if (!row) throw new ReadModelError('inconsistent_state', 'pool_registry_missing');
    let meta = null;
    try { meta = JSON.parse(row.meta_json); } catch { /* reported below */ }
    const v4 = kind === V4_POOL_KIND;
    const [token0, token1] = v4 ? [meta?.currency0, meta?.currency1] : [meta?.token0, meta?.token1];
    if (![token0, token1, ...(v4 ? [meta?.hooks] : [])].every((value) => typeof value === 'string' && ADDRESS.test(value))
      || !Number.isSafeInteger(meta.fee) || !Number.isSafeInteger(meta.tickSpacing)) {
      throw new ReadModelError('inconsistent_state', 'pool_registry_metadata_malformed');
    }
    return { pool, createdBlock: row.created_block, token0: poolToken(token0), token1: poolToken(token1), fee: meta.fee,
      tickSpacing: meta.tickSpacing, hooks: v4 ? meta.hooks : null };
  }

  // Top pools of one protocol over the window, ranked by swap count (the only verified ranking: USD volume and liquidity
  // are source_pending). Available only when every hour of the window holds that protocol's pool projection and the
  // registry covers the checkpoint; flows and V3 liquidity amounts are exact raw integer strings.
  function buildPools(protocolKey, windowKey, hours) {
    const state = anchor();
    const spec = POOL_PROTOCOLS[protocolKey];
    const to = state.hour;
    const from = to - (hours - 1) * HOUR;
    const base = { window: { key: windowKey, hours, start: iso(from), end: iso(to + HOUR) }, anchor: state, poolsTracked: null, newPools: null,
      pools: [] };
    const unavailable = (reason) => ({ ...base, status: 'unavailable', reason, reasons: [reason], unavailableHours: [] });
    const blocks = statement('windowBlocks').get(int(from), int(to));
    if (blocks.hours !== hours) return unavailable('insufficient_coverage');
    if (!projectionDataReady()) return unavailable('projection_not_ready');
    const registry = statement('registryCoverage').get(spec.registryKind);
    if (!registry || registry.through_block < state.block) return unavailable(registry ? 'registry_behind_checkpoint' : 'registry_missing');
    const counts = { poolsTracked: statement('poolCount').get(spec.registryKind, int(state.block)).count,
      newPools: statement('registryCreatedCount').get(spec.registryKind, int(blocks.first_block), int(blocks.last_block)).count };
    const projection = projectionWindow(spec.projection, from, to, hours);
    if (projection.status !== 'available') return { ...base, ...counts, ...projection };
    const v3 = spec.protocol === 'uniswap_v3';
    const totals = new Map();
    for (const row of statement('topPoolRows').all(spec.protocol, int(from), int(to), int(POOL_LIMIT))) {
      const flows = [row.token0_in_raw, row.token0_out_raw, row.token1_in_raw, row.token1_out_raw];
      const liquidity = [row.add_amount0_raw, row.add_amount1_raw, row.remove_amount0_raw, row.remove_amount1_raw];
      if (!flows.every(isDigits) || !(v3 ? liquidity.every(isDigits) : liquidity.every((value) => value === null))
        || !Number.isSafeInteger(row.total)) throw new ReadModelError('inconsistent_state', 'pool_projection_malformed');
      let entry = totals.get(row.pool);
      if (!entry) totals.set(row.pool, (entry = { swapCount: row.total, flows: [0n, 0n, 0n, 0n], liquidity: [0n, 0n, 0n, 0n], add: 0, remove: 0, poke: 0 }));
      flows.forEach((value, index) => { entry.flows[index] += BigInt(value); });
      if (v3) liquidity.forEach((value, index) => { entry.liquidity[index] += BigInt(value); });
      entry.add += row.add_count;
      entry.remove += row.remove_count;
      entry.poke += row.poke_count;
    }
    const raw = (values) => values.map((value) => value.toString(10));
    const pools = [...totals].map(([pool, entry]) => {
      const [token0In, token0Out, token1In, token1Out] = raw(entry.flows);
      const [addAmount0Raw, addAmount1Raw, removeAmount0Raw, removeAmount1Raw] = raw(entry.liquidity);
      return { ...registryDetails(spec.registryKind, pool), swapCount: entry.swapCount, flowsRaw: { token0In, token0Out, token1In, token1Out },
        liquidityActivity: { addCount: entry.add, removeCount: entry.remove, pokeCount: entry.poke,
          amounts: v3 ? { status: 'available', addAmount0Raw, addAmount1Raw, removeAmount0Raw, removeAmount1Raw }
            : { status: 'not_supported', reason: 'v4_token_amounts_unavailable', addAmount0Raw: null, addAmount1Raw: null, removeAmount0Raw: null,
              removeAmount1Raw: null } } };
    });
    return { ...base, ...counts, status: 'available', reason: null, reasons: [], unavailableHours: [], pools };
  }

  // One activity row with the exact semantics of the projection: from is the verified transaction sender; to is only the
  // event's own recipient (V3 swap), owner (V3 mint/burn) or sender (V4 modifyLiquidity), and null for a V4 swap.
  function activityRow(row) {
    const kind = row.protocol === 'uniswap_v3' ? V3_POOL_KIND : row.protocol === 'uniswap_v4' ? V4_POOL_KIND : null;
    if (!kind) throw new ReadModelError('inconsistent_state', 'activity_protocol_unknown');
    const { token0, token1, fee, tickSpacing, hooks } = registryDetails(kind, row.pool);
    let amounts;
    if (row.amount_basis === 'none') {
      if (row.amount0_raw !== null || row.amount1_raw !== null) throw new ReadModelError('inconsistent_state', 'activity_amount_malformed');
      amounts = { status: 'not_supported', reason: 'v4_token_amounts_unavailable', basis: 'none', amount0Raw: null, amount1Raw: null };
    } else {
      const amount = row.amount_basis === 'v3_liquidity_amount' ? isDigits : isSignedDigits;
      if (!amount(row.amount0_raw) || !amount(row.amount1_raw)) throw new ReadModelError('inconsistent_state', 'activity_amount_malformed');
      amounts = { status: 'available', basis: row.amount_basis, amount0Raw: row.amount0_raw, amount1Raw: row.amount1_raw };
    }
    return { time: iso(row.block_timestamp), blockNumber: row.block_number, logIndex: row.log_index, txHash: row.tx_hash, protocol: row.protocol,
      kind: row.kind, pool: row.pool, pair: { token0, token1, fee, tickSpacing, hooks }, amounts, from: row.tx_from, to: row.counterparty,
      toKind: row.counterparty_kind };
  }

  // The newest rows (block DESC, log index DESC), only while the checkpoint hour itself holds verified activity: a feed
  // whose latest hour is missing or unavailable is unavailable, never an older list presented as current.
  function buildActivity(typeKey) {
    const state = anchor();
    const unavailable = (reason) => ({ anchor: state, status: 'unavailable', reason, rows: [] });
    if (!projectionDataReady()) return unavailable('projection_not_ready');
    const latest = statement('projectionHour').get(int(state.hour), 'dex_activity');
    if (latest?.status !== 'available') return unavailable(latest ? latest.reason : 'projection_not_processed');
    return { anchor: state, status: 'available', reason: null,
      rows: statement('activityRows').all(ACTIVITY_TYPES[typeKey], int(ACTIVITY_LIMIT)).map(activityRow) };
  }

  // Projection state of every stored hour in [fromHour, toHour], oldest first (see projections.js projectionRepairState).
  // Before the writer has created the projection tables nothing is stored yet, and nothing is reported.
  function projectionStates(fromHour, toHour) {
    if (!statement('projectionTable').get()) return { ready: false, hours: [] };
    const through = (kind) => {
      const row = statement('registryCoverage').get(kind);
      return row ? { through: row.through_block } : null;
    };
    const coverage = { uniswap_v3_pools: through(V3_POOL_KIND), uniswap_v4_pools: through(V4_POOL_KIND) };
    const hours = statement('projectionRows').all(int(fromHour), int(toHour)).map((row) => ({ hourStart: row.hour_start,
      projections: projectionRepairState({ families: { [POOL_PROJECTION_FAMILY.uniswap_v3_pools]: row.v3_family,
        [POOL_PROJECTION_FAMILY.uniswap_v4_pools]: row.v4_family },
      projections: { uniswap_v3_pools: row.v3_projection, uniswap_v4_pools: row.v4_projection, dex_activity: row.activity },
      firstBlock: row.first_block, lastBlock: row.last_block, coverage }) }));
    return { ready: true, hours };
  }
  const checkedRange = (fromHour, toHour) => {
    if (!Number.isSafeInteger(fromHour) || !Number.isSafeInteger(toHour) || fromHour % HOUR || toHour % HOUR) {
      throw new ReadModelError('invalid_range');
    }
  };

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
    pools(protocolKey, windowKey) {
      if (typeof protocolKey !== 'string' || !Object.hasOwn(POOL_PROTOCOLS, protocolKey)) throw new ReadModelError('unsupported_protocol');
      if (typeof windowKey !== 'string' || !Object.hasOwn(POOLS_WINDOWS, windowKey)) throw new ReadModelError('unsupported_window');
      const core = cached(`pools:${protocolKey}:${windowKey}`, () => snapshot(() => buildPools(protocolKey, windowKey, POOLS_WINDOWS[windowKey])));
      return { schema: POOLS_SCHEMA, chain, protocol: protocolKey, window: core.window, freshness: freshness(core.anchor, now()), status: core.status,
        reason: core.reason, reasons: core.reasons, unavailableHours: core.unavailableHours,
        ranking: { by: 'swap_count', usdVolume: { status: 'source_pending' }, liquidityUsd: { status: 'source_pending' } },
        poolsTracked: core.poolsTracked, newPools: core.newPools, pools: core.pools };
    },
    activity(typeKey) {
      if (typeof typeKey !== 'string' || !Object.hasOwn(ACTIVITY_TYPES, typeKey)) throw new ReadModelError('unsupported_activity_type');
      const core = cached(`activity:${typeKey}`, () => snapshot(() => buildActivity(typeKey)));
      return { schema: ACTIVITY_SCHEMA, chain, type: typeKey, freshness: freshness(core.anchor, now()), status: core.status, reason: core.reason,
        limit: ACTIVITY_LIMIT, rows: core.rows };
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
    // Internal (scheduler and tests only, never an HTTP route): per-hour projection state in [fromHour, toHour].
    projectionStates({ fromHour, toHour }) {
      checkedRange(fromHour, toHour);
      return snapshot(() => projectionStates(fromHour, toHour));
    },
    // For the scheduler's projection-only self-heal: stored hours in [fromHour, toHour] with at least one pool projection
    // missing or unavailable while its family is available, oldest first. Hours whose only such projections wait for a
    // registry are reported as blocked instead (no RPC child is started for them). Recent activity is never a candidate.
    projectionRepairCandidates({ fromHour, toHour }) {
      checkedRange(fromHour, toHour);
      return snapshot(() => {
        const { hours } = projectionStates(fromHour, toHour);
        const pools = Object.keys(POOL_PROJECTION_FAMILY);
        return {
          hours: hours.filter((hour) => pools.some((name) => hour.projections[name].repair === 'eligible')).map((hour) => hour.hourStart),
          blocked: hours.flatMap((hour) => pools.filter((name) => hour.projections[name].repair === 'blocked')
            .map((name) => ({ hourStart: hour.hourStart, projection: name, reason: hour.projections[name].blocker }))),
        };
      });
    },
    close() {
      cache.clear();
      statements = new Map();
      db?.close();
      db = null;
    },
  });
}
