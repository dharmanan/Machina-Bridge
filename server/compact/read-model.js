// Compact engine: read-only model of the compact SQLite database for the public Intelligence API. The connection is opened
// with node:sqlite readOnly and PRAGMA query_only, so this module can never change persisted data; it never touches Arc
// RPC. Every answer is computed inside one short read transaction (a single WAL snapshot), so a response never mixes an
// hour with another hour's family rows, a half committed hour, or two definition states. Schema and family definition
// versions are checked inside every snapshot: an incompatible database fails closed instead of being misread.
// Windows are anchored to the committed checkpoint, never to the wall clock. Values require verified evidence for their
// stated interval; 30D exposes a shorter stored interval with explicit coverage, never missing hours turned into zero.
import { existsSync } from 'node:fs';
import { readEcosystem, discoveryWorkDue } from './intelligence-store.js';
import { ECOSYSTEM_WINDOWS } from './intelligence-registry.js';
import { ARC_ASSETS_BY_ADDRESS } from '../../api/_lib/arc-intelligence/assets.js';
import { FAMILY_FIELDS, FAMILY_WINDOWS } from './families.js';
import { POOL_PROJECTION_FAMILY, projectionRepairState, V4_POOL_KIND } from './projections.js';
import { CIRCLE_ARC } from './protocols/circle.js';
import { ARC_CHAIN_ID } from './provider.js';
import { V3_POOL_KIND } from './registry.js';
import { COMPACT_DEFINITION_VERSION, FAMILY_VERSIONS } from './sources.js';
import { ADDRESS_WINDOW_HOURS, COMPACT_SCHEMA_VERSION } from './store.js';
import { poolTvlUsd, TVL_VERSION } from './tvl.js';
import { anchorDecimals, poolVolumeUsd, PRICE_POLICY, priceableDecimals, PRICEABLE_TOKENS, usdMicrosOf, VALUATION_VERSIONS } from './valuation.js';
import { storedWindow, sumWindow, WindowError } from './windows.js';

export const SUMMARY_SCHEMA = 'machina.intelligence.summary.v1';
export const TIMESERIES_SCHEMA = 'machina.intelligence.timeseries.v1';
export const POOLS_SCHEMA = 'machina.intelligence.pools.v1';
export const ACTIVITY_SCHEMA = 'machina.intelligence.activity.v1';
// 24H and 7D require full windows. 30D uses all contiguous committed hours inside the selected window,
// with an explicit coverage interval; metric-specific verification still fails closed.
// Unique active addresses over 7D/30D are not_supported (identities are kept for 24 hours only); everything additive is
// summed from hourly rows. Daily timeseries expose completed UTC days; 30D also identifies incomplete boundary days.
export const SUMMARY_WINDOWS = Object.freeze({ '1h': 1, '6h': 6, '24h': 24, '7d': 168, '30d': 720 });
export const TIMESERIES_WINDOWS = Object.freeze({ '6h': 6, '24h': 24, '7d': 168, '30d': 720 });
export const POOLS_WINDOWS = Object.freeze({ '24h': 24, '7d': 168, '30d': 720 });
const DAILY_BUCKET_HOURS = 24;
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
// (the registry's native interface, 18 decimals). Any other address keeps symbol and decimals null (unverified). Its
// contractMetadata is what the token contract itself answered (symbol, name, decimals), read once by the indexer and
// cached in SQLite (token-metadata.js), or null: display data only, never a verified identity and never used for a value.
const poolToken = (address, contractMetadata = null) => (address === ZERO_ADDRESS
  ? { address, symbol: ARC_USDC.symbol, decimals: ARC_USDC.interfaces.nativeDecimals, verified: true, native: true, contractMetadata: null }
  : { address, ...tokenUnit(address), native: false, contractMetadata: tokenUnit(address).verified ? null : contractMetadata });
const METADATA_SYMBOL = /^[A-Za-z0-9][A-Za-z0-9._+$-]{0,19}$/;
const contractMetadataOf = (row) => (row && typeof row.symbol === 'string' && METADATA_SYMBOL.test(row.symbol) && Number.isSafeInteger(row.decimals)
  && row.decimals >= 0 && row.decimals <= 36 && (row.name === null || typeof row.name === 'string')
  ? { symbol: row.symbol, name: row.name, decimals: row.decimals } : null);
const USD_DIGITS = /^\d+$/;
// V4 Swap To: the Swap event records no recipient, and the public Arc RPC has no trace methods (debug_traceTransaction,
// trace_transaction and ots_* answer -32601). Even a trace could not tie a PoolManager take to one swap of a multi-hop
// transaction (flash accounting nets them). So To stays null with this exact reason; tx.to, a router, the PoolManager or the
// event sender is never used instead.
export const V4_SWAP_TO_BLOCKER = 'v4_swap_recipient_not_emitted_and_trace_unavailable';

// USD value of the other protocols' amounts, per action and never added across actions, legs or protocols: every hour's
// raw amount of a token times that hour's value of the token (USDC exactly; another verified asset only with a verified price
// of that hour), summed over the window. Token units are never mixed: an amount is valued only in its own token's verified
// decimals (an Aave reserve whose stated decimals differ from the verified asset's is not valued). Any non-zero amount that
// cannot be valued leaves that protocol's USD unavailable for the window, never partial.
const USDC_ERC20 = ARC_USDC.address;
const usdcAmounts = (fields) => (metrics, value) => Object.fromEntries(fields.map(([out, field]) => [out, [value(USDC_ERC20, metrics[field])]]));
const tallyAmounts = (tally, fields, tokenOf, decimalsOf = () => null) => (metrics, value) => Object.fromEntries(fields.map(([out, field, side]) => [out,
  Object.values(metrics[tally] ?? {}).map((entry) => value(tokenOf(entry, side), entry[field], decimalsOf(entry)))]));
export const PROTOCOL_USD = Object.freeze({
  cctp: { section: 'crossChain', amounts: usdcAmounts([['outboundUsdMicros', 'outboundAmountRaw'], ['inboundUsdMicros', 'inboundAmountRaw'],
    ['inboundFeeUsdMicros', 'inboundFeeCollectedRaw']]) },
  gateway: { section: 'crossChain', amounts: usdcAmounts([['depositUsdMicros', 'depositAmountRaw'], ['outboundBurnUsdMicros', 'outboundBurnAmountRaw'],
    ['outboundBurnFeeUsdMicros', 'outboundBurnFeeRaw'], ['inboundMintUsdMicros', 'inboundMintAmountRaw'], ['withdrawalUsdMicros', 'withdrawalAmountRaw']]) },
  across: { section: 'crossChain', amounts: (metrics, value) => ({
    depositUsdMicros: Object.entries(metrics.depositByToken ?? {}).map(([token, entry]) => value(token, entry.inputAmountRaw)),
    fillUsdMicros: Object.entries(metrics.fillByToken ?? {}).map(([token, entry]) => value(token, entry.outputAmountRaw)) }) },
  aaveV4: { section: 'lending', amounts: tallyAmounts('reserves', [['suppliedUsdMicros', 'suppliedRaw'], ['withdrawnUsdMicros', 'withdrawnRaw'],
    ['borrowedUsdMicros', 'borrowedRaw'], ['repaidUsdMicros', 'repaidRaw'], ['liquidatedDebtUsdMicros', 'liquidatedDebtRaw'],
    ['liquidatedCollateralUsdMicros', 'liquidatedCollateralRaw']], (entry) => entry.underlying, (entry) => entry.decimals) },
  morphoBlue: { section: 'lending', amounts: tallyAmounts('markets', [['suppliedUsdMicros', 'suppliedRaw', 'loan'], ['withdrawnUsdMicros', 'withdrawnRaw', 'loan'],
    ['borrowedUsdMicros', 'borrowedRaw', 'loan'], ['repaidUsdMicros', 'repaidRaw', 'loan'], ['collateralSuppliedUsdMicros', 'collateralSuppliedRaw', 'collateral'],
    ['collateralWithdrawnUsdMicros', 'collateralWithdrawnRaw', 'collateral'], ['liquidationRepaidUsdMicros', 'liquidationRepaidRaw', 'loan'],
    ['liquidationSeizedUsdMicros', 'liquidationSeizedRaw', 'collateral'], ['badDebtUsdMicros', 'badDebtRaw', 'loan']],
  (entry, side) => (side === 'loan' ? entry.loanToken : entry.collateralToken)) },
  morphoVaultsV2: { section: 'lending', amounts: tallyAmounts('vaults', [['depositedUsdMicros', 'depositedAssetsRaw'], ['withdrawnUsdMicros', 'withdrawnAssetsRaw']],
    (entry) => entry.asset) },
});

// Machine-readable valuation rules beside every USD amount (valuation.js).
const VALUATION_DEFINITION = Object.freeze({
  versions: VALUATION_VERSIONS,
  unit: 'usd_micros',
  anchors: Object.freeze(['0x3600000000000000000000000000000000000000 (Arc USDC ERC-20, 6 decimals) = 1 USD',
    '0x0000000000000000000000000000000000000000 (Arc native USDC in Uniswap V4, 18 decimals) = 1 USD']),
  pricedTokens: Object.freeze([...PRICEABLE_TOKENS]),
  priceSource: 'block-weighted mean square-root price of verified USDC pools of the same hour (official V3 pools, V4 pools without hooks)',
  pricePolicy: Object.freeze({ minSwaps: PRICE_POLICY.minSwaps, minCoverageBps: PRICE_POLICY.minCoverageBps,
    minDepthUsdMicros: PRICE_POLICY.minDepthUsdMicros.toString(10), maxDivergenceBps: PRICE_POLICY.maxDivergenceBps }),
  volume: 'each swap valued once by one side: the USDC side, otherwise the side with a verified hourly price; unpriced swaps are counted as unvalued',
  liquidity: `${TVL_VERSION}: V3 token.balanceOf(pool); V4 estimated principal reserves from PoolManager pool state (tick sweep reproducing the in-range liquidity, excludes uncollected fees and per-position rounding); `
    + 'valued with the same hour\'s prices; top pools only; never from add or remove activity',
  protocolUsd: 'per protocol and action: each hour\'s raw amount of a token times that hour\'s USD value of the token (USDC exactly, other verified '
    + 'assets only with a verified hourly price), summed; never added across actions, legs or protocols; unavailable when any amount cannot be valued',
  swapFees: 'estimated pool swap fees on the input amount (V3 fee tier; V4 fee recorded by each Swap event); excludes per-step integer rounding; valued by the volume side rule; '
    + 'swaps in V4 pools whose hook may return swap deltas are unvalued; hook-taken fees are never included; average = total / valued swaps',
});
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
  dailyActiveAddressTable: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'compact_daily_active_addresses'",
  dailyActiveAddress: `SELECT status, reason, active_addresses FROM compact_daily_active_addresses WHERE day_start = ?`,
  dauReplayBootstrapCandidate: `SELECT MIN(hour_start) AS hour_start
    FROM compact_hours
    GROUP BY (hour_start - (hour_start % 86400))
    HAVING COUNT(*) = 24
    ORDER BY (hour_start - (hour_start % 86400)) DESC
    LIMIT 1`,
  dauReplayCandidate: `SELECT h.hour_start
    FROM compact_hours h
    LEFT JOIN compact_daily_address_hours c ON c.hour_start = h.hour_start
    LEFT JOIN compact_daily_active_addresses d
      ON d.day_start = h.hour_start - (h.hour_start % 86400)
    WHERE c.hour_start IS NULL
      AND (
        d.day_start IS NULL
        OR (d.status = 'unavailable' AND d.reason = 'identity_not_captured')
      )
      AND (
        SELECT COUNT(*)
        FROM compact_hours x
        WHERE x.hour_start >= h.hour_start - (h.hour_start % 86400)
          AND x.hour_start < h.hour_start - (h.hour_start % 86400) + 86400
      ) = 24
    ORDER BY h.hour_start - (h.hour_start % 86400) DESC, h.hour_start ASC
    LIMIT 1`,
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
    SELECT p.pool, top.total, p.hour_start, p.swap_count, p.token0_in_raw, p.token0_out_raw, p.token1_in_raw, p.token1_out_raw, p.add_count,
      p.remove_count, p.poke_count, p.add_amount0_raw, p.add_amount1_raw, p.remove_amount0_raw, p.remove_amount1_raw
    FROM compact_pool_hours p JOIN top ON top.pool = p.pool
    WHERE p.protocol = ?1 AND p.hour_start BETWEEN ?2 AND ?3 ORDER BY top.total DESC, p.pool ASC, p.hour_start ASC`,
  // Valuations and token metadata (store.js). Optional tables: a database written before them still serves everything
  // else, and these reads report valuation_not_ready (or no contract metadata).
  optionalTables: `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('compact_valuation_hours', 'compact_dex_volume_hours',
    'compact_token_price_hours', 'compact_token_metadata', 'compact_dex_fee_hours', 'compact_pool_tvl_hours')`,
  poolTvlRows: `SELECT pool, status, reason, amount0_raw, amount1_raw, block_number FROM compact_pool_tvl_hours WHERE hour_start = ? AND protocol = ?
    ORDER BY pool`,
  dexFeeRows: `SELECT hour_start, protocol, fee_usd_micros, valued_swaps, unvalued_swaps FROM compact_dex_fee_hours
    WHERE hour_start BETWEEN ? AND ? ORDER BY hour_start, protocol`,
  valuationStatusRows: `SELECT h.hour_start, v.status, v.reason FROM compact_hours h
    LEFT JOIN compact_valuation_hours v ON v.hour_start = h.hour_start AND v.valuation = ?
    WHERE h.hour_start BETWEEN ? AND ? ORDER BY h.hour_start`,
  dexVolumeRows: `SELECT hour_start, protocol, volume_usd_micros, valued_swaps, unvalued_swaps FROM compact_dex_volume_hours
    WHERE hour_start BETWEEN ? AND ? ORDER BY hour_start, protocol`,
  tokenPriceRows: `SELECT hour_start, token, price_usd_e18, source_protocol, source_pool, depth_usd_micros, source_count
    FROM compact_token_price_hours WHERE hour_start BETWEEN ? AND ? ORDER BY hour_start, token`,
  tokenMetadata: 'SELECT symbol, name, decimals FROM compact_token_metadata WHERE token = ? AND verified = 1',
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

  function dailyActiveAddresses(dayStart) {
    if (!statement('dailyActiveAddressTable').get()) {
      return { status: 'not_stored', reason: 'daily_identity_not_processed', value: null };
    }

    const row = statement('dailyActiveAddress').get(int(dayStart));
    if (!row) {
      return { status: 'not_stored', reason: 'daily_identity_not_processed', value: null };
    }

    if (row.status === 'available') {
      return { status: 'available', value: row.active_addresses };
    }

    if (row.status === 'unavailable' && typeof row.reason === 'string') {
      return { status: 'unavailable', reason: row.reason, value: null };
    }

    throw new ReadModelError('inconsistent_state', 'daily_active_addresses_malformed');
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

  const optionalTables = () => new Set(statement('optionalTables').all().map((row) => row.name));
  const valuationReady = (tables) => tables.has('compact_valuation_hours') && tables.has('compact_dex_volume_hours')
    && tables.has('compact_token_price_hours');

  // Valuation status of every hour of [from, to]: available only when each hour is; a gap is never a partial window.
  function valuationWindow(name, from, to, hours, tables) {
    if (!valuationReady(tables)) return { status: 'unavailable', reason: 'valuation_not_ready', reasons: ['valuation_not_ready'], unavailableHours: [] };
    const rows = statement('valuationStatusRows').all(name, int(from), int(to));
    if (rows.length !== hours) return { status: 'unavailable', reason: 'insufficient_coverage', reasons: ['insufficient_coverage'], unavailableHours: [] };
    const gaps = rows.filter((row) => row.status !== 'available');
    if (!gaps.length) return { status: 'available', reason: null, reasons: [], unavailableHours: [] };
    return { status: 'unavailable', reason: 'valuation_hour_unavailable',
      reasons: [...new Set(gaps.map((row) => (row.status === null ? 'valuation_not_processed' : row.reason ?? 'valuation_unavailable')))].sort(),
      unavailableHours: gaps.map((row) => iso(row.hour_start)) };
  }

  // Stored DEX USD volume rows of [from, to] per hour: { uniswap_v3, uniswap_v4 } with exact BigInt values. Every stored
  // available hour holds exactly one row per protocol; anything else is inconsistent and fails closed.
  function dexVolumeByHour(from, to) {
    const byHour = new Map();
    for (const row of statement('dexVolumeRows').all(int(from), int(to))) {
      if (!USD_DIGITS.test(row.volume_usd_micros) || !Number.isSafeInteger(row.valued_swaps) || !Number.isSafeInteger(row.unvalued_swaps)) {
        throw new ReadModelError('inconsistent_state', 'dex_volume_malformed');
      }
      if (!byHour.has(row.hour_start)) byHour.set(row.hour_start, {});
      byHour.get(row.hour_start)[row.protocol] = { usdMicros: BigInt(row.volume_usd_micros), valuedSwaps: row.valued_swaps,
        unvaluedSwaps: row.unvalued_swaps };
    }
    return byHour;
  }
  const hourVolume = (entry) => {
    if (!entry?.uniswap_v3 || !entry?.uniswap_v4) throw new ReadModelError('inconsistent_state', 'dex_volume_missing');
    return entry;
  };

  // DEX USD volume of the window: each swap valued once (valuation.js); swaps without a verified price are reported as
  // unvalued, never as zero. Amounts are exact micro-USD integer strings.
  function volumeWindow(from, to, hours, tables) {
    const range = { start: iso(from), end: iso(to + HOUR) };
    const status = valuationWindow('dex_usd_volume', from, to, hours, tables);
    const base = { ...status, ...range, totalUsdMicros: null, byProtocol: null, valuedSwaps: null, unvaluedSwaps: null };
    if (status.status !== 'available') return base;
    const byHour = dexVolumeByHour(from, to);
    const totals = { uniswap_v3: 0n, uniswap_v4: 0n };
    let valuedSwaps = 0;
    let unvaluedSwaps = 0;
    for (let hour = from; hour <= to; hour += HOUR) {
      const entry = hourVolume(byHour.get(hour));
      for (const protocol of Object.keys(totals)) {
        totals[protocol] += entry[protocol].usdMicros;
        valuedSwaps += entry[protocol].valuedSwaps;
        unvaluedSwaps += entry[protocol].unvaluedSwaps;
      }
    }
    return { ...base, totalUsdMicros: (totals.uniswap_v3 + totals.uniswap_v4).toString(10),
      byProtocol: { uniswapV3: totals.uniswap_v3.toString(10), uniswapV4: totals.uniswap_v4.toString(10) }, valuedSwaps, unvaluedSwaps };
  }

  // Swap fees of the window (valuation.js hourFeesOf): what swaps paid to Uniswap pools, valued in USD, and the average per
  // valued swap. Hook-taken fees are never included; swaps whose fee cannot be valued are counted, never zero.
  function feeWindow(from, to, hours, tables) {
    const range = { start: iso(from), end: iso(to + HOUR) };
    const status = tables.has('compact_dex_fee_hours') ? valuationWindow('dex_fees', from, to, hours, tables)
      : { status: 'unavailable', reason: 'valuation_not_ready', reasons: ['valuation_not_ready'], unavailableHours: [] };
    const base = { ...status, ...range, calculation: 'estimated', basis: VALUATION_VERSIONS.dex_fees,
      totalFeeUsdMicros: null, byProtocol: null, valuedSwaps: null, unvaluedSwaps: null, averageFeeUsdMicros: null };
    if (status.status !== 'available') return base;
    const byHour = new Map();
    for (const row of statement('dexFeeRows').all(int(from), int(to))) {
      if (!USD_DIGITS.test(row.fee_usd_micros) || !Number.isSafeInteger(row.valued_swaps) || !Number.isSafeInteger(row.unvalued_swaps)) {
        throw new ReadModelError('inconsistent_state', 'dex_fee_malformed');
      }
      if (!byHour.has(row.hour_start)) byHour.set(row.hour_start, {});
      byHour.get(row.hour_start)[row.protocol] = row;
    }
    const totals = { uniswap_v3: 0n, uniswap_v4: 0n };
    let valuedSwaps = 0;
    let unvaluedSwaps = 0;
    for (let hour = from; hour <= to; hour += HOUR) {
      const entry = byHour.get(hour);
      if (!entry?.uniswap_v3 || !entry?.uniswap_v4) throw new ReadModelError('inconsistent_state', 'dex_fee_missing');
      for (const protocol of Object.keys(totals)) {
        totals[protocol] += BigInt(entry[protocol].fee_usd_micros);
        valuedSwaps += entry[protocol].valued_swaps;
        unvaluedSwaps += entry[protocol].unvalued_swaps;
      }
    }
    const total = totals.uniswap_v3 + totals.uniswap_v4;
    return { ...base, totalFeeUsdMicros: total.toString(10), byProtocol: { uniswapV3: totals.uniswap_v3.toString(10),
      uniswapV4: totals.uniswap_v4.toString(10) }, valuedSwaps, unvaluedSwaps,
    averageFeeUsdMicros: valuedSwaps ? (total / BigInt(valuedSwaps)).toString(10) : null };
  }

  // USD of every other protocol over the window (PROTOCOL_USD). Prices are read only when a non-USDC token has an amount.
  function protocolUsdWindow(from, to, hours, tables) {
    const range = { start: iso(from), end: iso(to + HOUR) };
    let prices = null;
    const pricesOf = () => {
      if (prices) return prices;
      prices = { byHour: new Map(), valued: new Set() };
      if (!valuationReady(tables)) return prices;
      for (const row of statement('valuationStatusRows').all('token_prices', int(from), int(to))) if (row.status === 'available') prices.valued.add(row.hour_start);
      for (const row of statement('tokenPriceRows').all(int(from), int(to))) {
        if (!prices.byHour.has(row.hour_start)) prices.byHour.set(row.hour_start, new Map());
        prices.byHour.get(row.hour_start).set(row.token, { priceUsdE18: BigInt(row.price_usd_e18) });
      }
      return prices;
    };
    return Object.fromEntries(Object.entries(PROTOCOL_USD).map(([name, spec]) => {
      const rows = statement('familyRows').all(name, int(from), int(to));
      const unavailable = (reason, extra = {}) => [name, { status: 'unavailable', reason, ...range, values: null, ...extra }];
      if (rows.length !== hours) return unavailable('insufficient_coverage');
      const gap = rows.find((row) => row.status !== 'available');
      if (gap) return unavailable('family_hour_unavailable', { unavailableHours: rows.filter((row) => row.status !== 'available').map((row) => iso(row.hour_start)) });
      const totals = {};
      let failure = null;
      for (const row of rows) {
        const value = (token, raw, declaredDecimals = null) => {
          const address = typeof token === 'string' ? token.toLowerCase() : '';
          if (typeof raw !== 'string' || !DIGITS.test(raw)) throw new ReadModelError('inconsistent_state', `${name}_amount_malformed`);
          const amount = BigInt(raw);
          if (amount === 0n) return 0n;
          const verifiedDecimals = anchorDecimals(address) ?? priceableDecimals(address);
          if (verifiedDecimals === null) { failure ??= 'unverified_token'; return null; }
          if (declaredDecimals !== null && declaredDecimals !== verifiedDecimals) { failure ??= 'decimals_mismatch'; return null; }
          if (anchorDecimals(address) !== null) return usdMicrosOf(address, amount, null);
          const book = pricesOf();
          if (!book.valued.has(row.hour_start)) { failure ??= 'prices_unavailable'; return null; }
          const usd = usdMicrosOf(address, amount, book.byHour.get(row.hour_start));
          if (usd === null) failure ??= 'no_verified_price';
          return usd;
        };
        for (const [field, values] of Object.entries(spec.amounts(JSON.parse(row.metrics_json), value))) {
          totals[field] ??= 0n;
          for (const usd of values) if (usd !== null) totals[field] += usd;
        }
        if (failure) return unavailable(failure, { failedHour: iso(row.hour_start) });
      }
      return [name, { status: 'available', reason: null, ...range, values: Object.fromEntries(Object.entries(totals).map(([field, total]) => [field, total.toString(10)])) }];
    }));
  }

  // Verified token prices of one hour (the checkpoint hour in the summary), with their source pool.
  function hourPrices(hour, tables) {
    const status = valuationWindow('token_prices', hour, hour, 1, tables);
    const base = { hour: iso(hour), status: status.status, reason: status.reason, reasons: status.reasons };
    if (status.status !== 'available') return { ...base, tokens: [] };
    const tokens = statement('tokenPriceRows').all(int(hour), int(hour)).map((row) => {
      if (!USD_DIGITS.test(row.price_usd_e18) || !USD_DIGITS.test(row.depth_usd_micros)) throw new ReadModelError('inconsistent_state', 'token_price_malformed');
      return { ...poolToken(row.token), priceUsdE18: row.price_usd_e18, sourceProtocol: row.source_protocol, sourcePool: row.source_pool,
        depthUsdMicros: row.depth_usd_micros, sourceCount: row.source_count };
    });
    return { ...base, tokens };
  }

  function buildSummary(windowKey, hours) {
    const state = anchor();
    const to = state.hour;
    const selected = storedWindow(windowKey, hours, state.firstHour, to);
    const from = selected.from;
    const expectedHours = hours;
    hours = selected.hours;
    const previousTo = selected.selectedFrom - HOUR;
    const previousFrom = previousTo - (expectedHours - 1) * HOUR;
    const network = networkWindow(from, to, hours, state.hour);
    network.previous = networkWindow(previousFrom, previousTo, expectedHours, state.hour);
    const families = Object.fromEntries(FAMILIES.map((name) => {
      const current = familyWindow(name, from, to, hours, { full: true });
      current.previous = familyWindow(name, previousFrom, previousTo, expectedHours, { full: false });
      return [name, current];
    }));
    const registry = statement('registryCoverage').get(V3_POOL_KIND);
    const officialV3Pools = registry && registry.through_block >= state.block
      ? { status: 'available', count: statement('poolCount').get(V3_POOL_KIND, int(state.block)).count, throughBlock: state.block }
      : { status: 'unavailable', reason: registry ? 'registry_behind_checkpoint' : 'registry_missing', count: null, throughBlock: null };
    const tables = optionalTables();
    const usdVolume = volumeWindow(from, to, hours, tables);
    usdVolume.previous = volumeWindow(previousFrom, previousTo, expectedHours, tables);
    const swapFees = feeWindow(from, to, hours, tables);
    swapFees.previous = feeWindow(previousFrom, previousTo, expectedHours, tables);
    const protocolUsd = protocolUsdWindow(from, to, hours, tables);
    return {
      window: selected.window,
      anchor: state,
      network,
      assets: { usdc: families.usdc, verifiedAssets: families.assets },
      dex: { uniswapV3: families.uniswapV3, uniswapV4: families.uniswapV4, officialV3Pools, usdVolume, swapFees,
        usdPrices: hourPrices(state.hour, tables) },
      lending: { aaveV4: families.aaveV4, morphoBlue: families.morphoBlue, morphoVaultsV2: families.morphoVaultsV2 },
      protocolUsd,
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
    const selected = storedWindow(windowKey, hours, state.firstHour, state.hour);
    const daily = hours > 24;
    const latestCompleteDayStart = Math.floor((state.hour + HOUR) / (DAILY_BUCKET_HOURS * HOUR))
      * (DAILY_BUCKET_HOURS * HOUR) - (DAILY_BUCKET_HOURS * HOUR);
    const to = windowKey === '30d' ? state.hour : daily ? latestCompleteDayStart + (DAILY_BUCKET_HOURS - 1) * HOUR : state.hour;
    // Include both UTC-day boundaries for 30D. Missing/ongoing hours stay explicit gaps,
    // and no completed day outside the selected rolling window is counted.
    const from = windowKey === '30d' ? Math.floor(selected.selectedFrom / 86400) * 86400
      : daily ? to - (hours - 1) * HOUR : state.hour - (hours - 1) * HOUR;
    const readFrom = windowKey === '30d' ? selected.selectedFrom : from;
    const network = new Map(statement('networkRows').all(int(readFrom), int(to)).map((row) => [row.hour_start, row]));
    const familyRows = new Map();
    for (const row of statement('allFamilyRows').all(int(from), int(to))) familyRows.set(`${row.hour_start}:${row.family}`, row);
    const tables = optionalTables();
    const volumeStatus = valuationReady(tables)
      ? new Map(statement('valuationStatusRows').all('dex_usd_volume', int(from), int(to)).map((row) => [row.hour_start, row])) : null;
    const volumes = volumeStatus ? dexVolumeByHour(from, to) : null;
    // One hour's DEX USD volume: per protocol and total (exact micro-USD strings), or unavailable with its reason.
    const dexUsdVolume = (hour) => {
      if (!volumeStatus) return { status: 'unavailable', reason: 'valuation_not_ready' };
      const status = volumeStatus.get(hour);
      if (status?.status !== 'available') return { status: 'unavailable', reason: status?.status ? status.reason : 'valuation_not_processed' };
      const entry = hourVolume(volumes.get(hour));
      return { status: 'available', totalUsdMicros: (entry.uniswap_v3.usdMicros + entry.uniswap_v4.usdMicros).toString(10),
        uniswapV3UsdMicros: entry.uniswap_v3.usdMicros.toString(10), uniswapV4UsdMicros: entry.uniswap_v4.usdMicros.toString(10),
        valuedSwaps: entry.uniswap_v3.valuedSwaps + entry.uniswap_v4.valuedSwaps,
        unvaluedSwaps: entry.uniswap_v3.unvaluedSwaps + entry.uniswap_v4.unvaluedSwaps };
    };
    const buckets = [];
    for (let hour = from; hour <= to; hour += HOUR) {
      const range = { start: iso(hour), end: iso(hour + HOUR) };
      const row = network.get(hour);
      if (!row) {
        buckets.push({ ...range, status: 'not_stored', network: null, families: null, dexUsdVolume: null });
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
        dexUsdVolume: dexUsdVolume(hour),
      });
    }
    if (hours <= 24) return { window: { key: windowKey, hours, start: iso(from), end: iso(to + HOUR) }, anchor: state, bucketHours: 1, buckets };
    return { window: windowKey === '30d' ? selected.window : { key: windowKey, hours, start: iso(from), end: iso(to + HOUR) }, anchor: state, bucketHours: DAILY_BUCKET_HOURS,
      buckets: dailyBuckets(buckets) };
  }

  // 24-hour buckets of hourly buckets (oldest first). A bucket is committed only when all 24 hours are; its family and USD
  // values only when every hour's is (sums of the additive fields), otherwise unavailable with the first gap's reason.
  // Daily active addresses come only from an exact persisted UTC-day distinct count; missing history is never zero-filled.
  function dailyBuckets(hourly) {
    const out = [];
    for (let index = 0; index < hourly.length; index += DAILY_BUCKET_HOURS) {
      const day = hourly.slice(index, index + DAILY_BUCKET_HOURS);
      const range = { start: day[0].start, end: day.at(-1).end };
      const stored = day.filter((bucket) => bucket.status === 'committed');
      if (stored.length < DAILY_BUCKET_HOURS) {
        out.push({ ...range, status: stored.length ? 'incomplete' : 'not_stored', storedHours: stored.length, network: null, families: null, dexUsdVolume: null });
        continue;
      }
      const blocks = stored.reduce((total, bucket) => total + bucket.network.blocks, 0);
      const transactions = stored.reduce((total, bucket) => total + bucket.network.transactions, 0);
      const dayStart = Date.parse(range.start) / 1000;
      const dau = dailyActiveAddresses(dayStart);
      const network = { blocks, transactions, transactionsPerSecond: transactions / (DAILY_BUCKET_HOURS * HOUR),
        averageTransactionsPerBlock: blocks ? transactions / blocks : null,
        gasUsedRaw: stored.reduce((total, bucket) => total + BigInt(bucket.network.gasUsedRaw), 0n).toString(10),
        uniqueActiveAddresses: dau.status === 'available' ? dau.value : null,
        uniqueActiveAddressesStatus: dau };
      const families = Object.fromEntries(TIMESERIES_FAMILIES.map((name) => {
        const gap = stored.find((bucket) => bucket.families[name].status !== 'available');
        if (gap) return [name, { status: 'unavailable', reason: gap.families[name].reason }];
        try {
          return [name, { status: 'available', ...sumWindow(scalarSpec(FAMILY_WINDOWS[name]), stored.map((bucket) => bucket.families[name])) }];
        } catch (error) {
          if (!(error instanceof WindowError)) throw error;
          return [name, { status: 'unavailable', reason: error.code }];
        }
      }));
      const volumeGap = stored.find((bucket) => bucket.dexUsdVolume.status !== 'available');
      const sum = (field) => stored.reduce((total, bucket) => total + BigInt(bucket.dexUsdVolume[field]), 0n).toString(10);
      const count = (field) => stored.reduce((total, bucket) => total + bucket.dexUsdVolume[field], 0);
      const dexUsdVolume = volumeGap ? { status: 'unavailable', reason: volumeGap.dexUsdVolume.reason }
        : { status: 'available', totalUsdMicros: sum('totalUsdMicros'), uniswapV3UsdMicros: sum('uniswapV3UsdMicros'),
          uniswapV4UsdMicros: sum('uniswapV4UsdMicros'), valuedSwaps: count('valuedSwaps'), unvaluedSwaps: count('unvaluedSwaps') };
      out.push({ ...range, status: 'committed', storedHours: DAILY_BUCKET_HOURS, network, families, dexUsdVolume });
    }
    return out;
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

  // A pool token with its cached contract metadata when the token is not a verified identity (never for verified assets or
  // the native currency). A malformed cached row is simply not shown.
  function tokenOf(address, tables) {
    const token = poolToken(address);
    if (token.verified || !tables.has('compact_token_metadata')) return token;
    return poolToken(address, contractMetadataOf(statement('tokenMetadata').get(address)));
  }

  // Exact identity of a registry pool. Malformed or missing metadata fails the whole answer closed, never a guessed pair.
  function registryDetails(kind, pool, tables = new Set()) {
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
    return { pool, createdBlock: row.created_block, token0: tokenOf(token0, tables), token1: tokenOf(token1, tables), fee: meta.fee,
      tickSpacing: meta.tickSpacing, hooks: v4 ? meta.hooks : null };
  }

  // Top pools of one protocol over the window, ranked by swap count (the only verified ranking: USD volume and liquidity
  // are source_pending). Available only when every hour of the window holds that protocol's pool projection and the
  // registry covers the checkpoint; flows and V3 liquidity amounts are exact raw integer strings.
  function buildPools(protocolKey, windowKey, hours) {
    const state = anchor();
    const spec = POOL_PROTOCOLS[protocolKey];
    const to = state.hour;
    const selected = storedWindow(windowKey, hours, state.firstHour, to);
    const from = selected.from;
    hours = selected.hours;
    const base = { window: selected.window, anchor: state, poolsTracked: null, newPools: null,
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
    // Pool USD volume: only when the window's DEX USD volume is available (every hour valued). Each hour of a pool is
    // valued with that hour's own stored prices; a pool with any swap hour it cannot value has no USD volume.
    const tables = optionalTables();
    const valuation = valuationWindow('dex_usd_volume', from, to, hours, tables);
    const prices = new Map();
    if (valuation.status === 'available') {
      for (const row of statement('tokenPriceRows').all(int(from), int(to))) {
        if (!USD_DIGITS.test(row.price_usd_e18)) throw new ReadModelError('inconsistent_state', 'token_price_malformed');
        if (!prices.has(row.hour_start)) prices.set(row.hour_start, new Map());
        prices.get(row.hour_start).set(row.token, { priceUsdE18: BigInt(row.price_usd_e18) });
      }
    }
    const details = new Map();
    const detailsOf = (pool) => {
      if (!details.has(pool)) details.set(pool, registryDetails(spec.registryKind, pool, tables));
      return details.get(pool);
    };
    const totals = new Map();
    for (const row of statement('topPoolRows').all(spec.protocol, int(from), int(to), int(POOL_LIMIT))) {
      const flows = [row.token0_in_raw, row.token0_out_raw, row.token1_in_raw, row.token1_out_raw];
      const liquidity = [row.add_amount0_raw, row.add_amount1_raw, row.remove_amount0_raw, row.remove_amount1_raw];
      if (!flows.every(isDigits) || !(v3 ? liquidity.every(isDigits) : liquidity.every((value) => value === null))
        || !Number.isSafeInteger(row.total) || !Number.isSafeInteger(row.swap_count)) throw new ReadModelError('inconsistent_state', 'pool_projection_malformed');
      let entry = totals.get(row.pool);
      if (!entry) {
        totals.set(row.pool, (entry = { swapCount: row.total, flows: [0n, 0n, 0n, 0n], liquidity: [0n, 0n, 0n, 0n], add: 0, remove: 0, poke: 0,
          usdMicros: 0n, bases: new Set(), unvalued: false }));
      }
      flows.forEach((value, index) => { entry.flows[index] += BigInt(value); });
      if (v3) liquidity.forEach((value, index) => { entry.liquidity[index] += BigInt(value); });
      entry.add += row.add_count;
      entry.remove += row.remove_count;
      entry.poke += row.poke_count;
      if (valuation.status === 'available' && row.swap_count > 0) {
        const { token0, token1 } = detailsOf(row.pool);
        const value = poolVolumeUsd({ token0: token0.address, token1: token1.address, side0Raw: BigInt(flows[0]) + BigInt(flows[1]),
          side1Raw: BigInt(flows[2]) + BigInt(flows[3]) }, prices.get(row.hour_start) ?? new Map());
        if (value) {
          entry.usdMicros += value.usdMicros;
          entry.bases.add(value.basis);
        } else entry.unvalued = true;
      }
    }
    // Pool liquidity: the snapshot of the checkpoint hour (tvl.js, pool state at the hour's last block), valued with that
    // hour's stored prices. Never derived from add or remove activity; a held token without a price leaves it unavailable.
    const tvlRows = tables.has('compact_pool_tvl_hours') ? new Map(statement('poolTvlRows').all(int(to), spec.protocol).map((row) => [row.pool, row]))
      : new Map();
    const checkpointPrices = new Map();
    if (tables.has('compact_valuation_hours') && valuationWindow('token_prices', to, to, 1, tables).status === 'available') {
      for (const row of statement('tokenPriceRows').all(int(to), int(to))) checkpointPrices.set(row.token, { priceUsdE18: BigInt(row.price_usd_e18) });
    }
    const liquidityOf = (pool) => {
      const row = tvlRows.get(pool);
      const calculation = v3 ? 'balance_snapshot' : 'estimated_principal_reserves';
      const missing = { status: 'unavailable', usdMicros: null, amount0Raw: null, amount1Raw: null, asOfBlock: null };
      if (!row) return { ...missing, reason: tvlRows.size ? 'tvl_not_collected_for_pool' : 'tvl_not_collected' };
      if (row.status !== 'available') return { ...missing, reason: row.reason, asOfBlock: row.block_number };
      if (!isDigits(row.amount0_raw) || !isDigits(row.amount1_raw)) throw new ReadModelError('inconsistent_state', 'pool_tvl_malformed');
      const { token0, token1 } = detailsOf(pool);
      const usdMicros = poolTvlUsd({ token0: token0.address, token1: token1.address, amount0: BigInt(row.amount0_raw), amount1: BigInt(row.amount1_raw) },
        checkpointPrices);
      const amounts = { calculation, amount0Raw: row.amount0_raw, amount1Raw: row.amount1_raw, asOfBlock: row.block_number };
      return usdMicros === null ? { status: 'unavailable', reason: 'no_verified_price', usdMicros: null, ...amounts }
        : { status: 'available', reason: null, usdMicros: usdMicros.toString(10), ...amounts };
    };
    const raw = (values) => values.map((value) => value.toString(10));
    const usdVolumeOf = (entry) => {
      if (valuation.status !== 'available') return { status: 'unavailable', reason: valuation.reason, usdMicros: null, basis: null };
      if (entry.unvalued) return { status: 'unavailable', reason: 'no_verified_price', usdMicros: null, basis: null };
      return { status: 'available', reason: null, usdMicros: entry.usdMicros.toString(10),
        basis: entry.bases.size === 1 ? [...entry.bases][0] : entry.bases.size ? 'mixed' : 'usd_anchor' };
    };
    const pools = [...totals].map(([pool, entry]) => {
      const [token0In, token0Out, token1In, token1Out] = raw(entry.flows);
      const [addAmount0Raw, addAmount1Raw, removeAmount0Raw, removeAmount1Raw] = raw(entry.liquidity);
      return { ...detailsOf(pool), swapCount: entry.swapCount, flowsRaw: { token0In, token0Out, token1In, token1Out },
        usdVolume: usdVolumeOf(entry),
        liquidityUsd: liquidityOf(pool),
        liquidityActivity: { addCount: entry.add, removeCount: entry.remove, pokeCount: entry.poke,
          amounts: v3 ? { status: 'available', addAmount0Raw, addAmount1Raw, removeAmount0Raw, removeAmount1Raw }
            : { status: 'not_supported', reason: 'v4_token_amounts_unavailable', addAmount0Raw: null, addAmount1Raw: null, removeAmount0Raw: null,
              removeAmount1Raw: null } } };
    });
    return { ...base, ...counts, status: 'available', reason: null, reasons: [], unavailableHours: [], pools,
      usdVolume: { status: valuation.status, reason: valuation.reason, reasons: valuation.reasons },
      liquidityUsd: { status: pools.some((pool) => pool.liquidityUsd.status === 'available') ? 'available' : 'unavailable',
        reason: pools.some((pool) => pool.liquidityUsd.status === 'available') ? null : pools.find((pool) => pool.liquidityUsd.reason)?.liquidityUsd.reason ?? 'tvl_not_collected',
        asOfHour: iso(to) } };
  }

  // One activity row with the exact semantics of the projection: from is the verified transaction sender; to is only the
  // event's own recipient (V3 swap), owner (V3 mint/burn) or sender (V4 modifyLiquidity), and null for a V4 swap.
  function activityRow(row, tables) {
    const kind = row.protocol === 'uniswap_v3' ? V3_POOL_KIND : row.protocol === 'uniswap_v4' ? V4_POOL_KIND : null;
    if (!kind) throw new ReadModelError('inconsistent_state', 'activity_protocol_unknown');
    const { token0, token1, fee, tickSpacing, hooks } = registryDetails(kind, row.pool, tables);
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
      toKind: row.counterparty_kind, toReason: row.counterparty_kind === 'none' ? V4_SWAP_TO_BLOCKER : null };
  }

  // The newest rows (block DESC, log index DESC), only while the checkpoint hour itself holds verified activity: a feed
  // whose latest hour is missing or unavailable is unavailable, never an older list presented as current.
  function buildActivity(typeKey) {
    const state = anchor();
    const unavailable = (reason) => ({ anchor: state, status: 'unavailable', reason, rows: [] });
    if (!projectionDataReady()) return unavailable('projection_not_ready');
    const latest = statement('projectionHour').get(int(state.hour), 'dex_activity');
    if (latest?.status !== 'available') return unavailable(latest ? latest.reason : 'projection_not_processed');
    const tables = optionalTables();
    return { anchor: state, status: 'available', reason: null,
      rows: statement('activityRows').all(ACTIVITY_TYPES[typeKey], int(ACTIVITY_LIMIT)).map((row) => activityRow(row, tables)) };
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
    families: FAMILY_VERSIONS, aggregationRules: AGGREGATION_RULES, valuation: VALUATION_DEFINITION });
  const chain = Object.freeze({ id: ARC_CHAIN_ID, name: 'Arc' });

  return Object.freeze({
    ecosystem(windowKey) {
      if (typeof windowKey !== 'string' || !Object.hasOwn(ECOSYSTEM_WINDOWS, windowKey)) throw new ReadModelError('unsupported_window');
      return snapshot(() => { anchor(); return readEcosystem(connection(), windowKey); });
    },
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
        assets: core.assets, dex: core.dex, lending: core.lending, crossChain: core.crossChain, protocolUsd: core.protocolUsd, coverage: core.coverage,
        definitions };
    },
    timeseries(windowKey) {
      if (typeof windowKey !== 'string' || !Object.hasOwn(TIMESERIES_WINDOWS, windowKey)) throw new ReadModelError('unsupported_window');
      const core = cached(`timeseries:${windowKey}`, () => snapshot(() => buildTimeseries(windowKey, TIMESERIES_WINDOWS[windowKey])));
      return { schema: TIMESERIES_SCHEMA, chain, window: core.window, freshness: freshness(core.anchor, now()), bucketHours: core.bucketHours,
        units: { 'usdc.amountRaw': { decimalsField: 'rawDecimals', source: 'persisted_raw_decimals' }, cctp: FAMILY_UNITS.cctp,
          gateway: FAMILY_UNITS.gateway }, buckets: core.buckets, definitions };
    },
    pools(protocolKey, windowKey) {
      if (typeof protocolKey !== 'string' || !Object.hasOwn(POOL_PROTOCOLS, protocolKey)) throw new ReadModelError('unsupported_protocol');
      if (typeof windowKey !== 'string' || !Object.hasOwn(POOLS_WINDOWS, windowKey)) throw new ReadModelError('unsupported_window');
      const core = cached(`pools:${protocolKey}:${windowKey}`, () => snapshot(() => buildPools(protocolKey, windowKey, POOLS_WINDOWS[windowKey])));
      return { schema: POOLS_SCHEMA, chain, protocol: protocolKey, window: core.window, freshness: freshness(core.anchor, now()), status: core.status,
        reason: core.reason, reasons: core.reasons, unavailableHours: core.unavailableHours,
        ranking: { by: 'swap_count', usdVolume: core.usdVolume ?? { status: 'unavailable', reason: core.reason, reasons: core.reasons },
          liquidityUsd: core.liquidityUsd ?? { status: 'unavailable', reason: core.reason } },
        poolsTracked: core.poolsTracked, newPools: core.newPools, pools: core.pools };
    },
    activity(typeKey) {
      if (typeof typeKey !== 'string' || !Object.hasOwn(ACTIVITY_TYPES, typeKey)) throw new ReadModelError('unsupported_activity_type');
      const core = cached(`activity:${typeKey}`, () => snapshot(() => buildActivity(typeKey)));
      return { schema: ACTIVITY_SCHEMA, chain, type: typeKey, freshness: freshness(core.anchor, now()), status: core.status, reason: core.reason,
        limit: ACTIVITY_LIMIT, rows: core.rows };
    },
    // For the scheduler: the committed checkpoint, or null for a missing file or an empty store. Never a guess.
    dailyActiveReplayCandidate() {
      if (statement('dailyActiveAddressTable').get()) {
        return statement('dauReplayCandidate').get()?.hour_start ?? null;
      }
      return statement('dauReplayBootstrapCandidate').get()?.hour_start ?? null;
    },
    checkpoint() {
      if (!existsSync(path)) return null;
      return snapshot((state) => {
        if (state.code === 'database_empty') return null;
        const checkpoint = statement('checkpoint').get();
        return checkpoint ? { hourStart: checkpoint.hour_start, lastBlock: checkpoint.last_block } : null;
      }, { requireDefinitions: false });
    },
    // Internal eligibility only: no RPC, no writes; old DBs without the new table have no candidate work.
    discoveryPending({ nowMs }) {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new ReadModelError('invalid_time');
      if (!existsSync(path)) return false;
      return snapshot((state) => state.code === 'database_empty' ? false : discoveryWorkDue(connection(), nowMs), { requireDefinitions: false });
    },
    // Durable stored-history bounds for the scheduler. Read-only and side-effect free.
    historyBounds() {
      if (!existsSync(path)) return null;
      return snapshot((state) => {
        if (state.code === 'database_empty') return null;
        const row = statement('bounds').get();
        return row.first === null ? null : { first: row.first, last: row.last, count: row.count };
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
