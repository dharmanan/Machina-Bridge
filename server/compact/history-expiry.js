// Compact engine: history expiry. The product is not a blockchain archive: it serves the last 30 days, the 30 days before
// them (the comparisons) and the recovery inside those spans, and nothing older needs its detail rows. OFF unless
// COMPACT_HISTORY_EXPIRY_ENABLED=true, which requires packed expiry (packed-shards.js) and refuses the evidence archive
// (store.js: a lossless archive and timed deletion exclude each other). ON, each writer pass first raises the history
// floor (compact_packed_history_floor 'details', only grows) to HISTORY_KEEP_HOURS before the checkpoint hour: 61 days,
// the 30D window, the previous 30D it is compared with and one day of margin. That is the widest reach of every dashboard
// field (families, valuations, DEX USD volume and fees, unique addresses, daily active addresses) and wider than
// projection, valuation and discovery recovery (35 and 30 days), family repair (24 hours) and the 36-day pool data packed
// expiry keeps. Then, below the floor, oldest first, in bounded steps that each run in their own savepoint and are admitted
// by the storage check (the write-ahead log a deletion needs, within the pass budget, like packed retention), it deletes:
//   - the hour's family, valuation, token price, DEX USD volume, DEX fee and pool TVL rows;
//   - DEX activity rows, except the newest ACTIVITY_ROWS_PER_KIND of each kind (the recent activity list has no window);
//   - DEX observations that are not the first of their pool and activity: the first-observation read returns the earliest
//     row up to its end block, which is the same row (or none) whatever later rows exist; creation rows all stay;
//   - daily active address rows (and their captured hours) of days wholly before the floor;
//   - hot identity, price-path and swap-fee rows that were never packed (incomplete or unavailable scopes); a final pool
//     hour that was never packed is folded first (its swaps into the all-history totals, the creation-hour counts of its
//     pools: packed-shards.js foldPoolHour), a pool hour that is not final keeps its rows (they count in pool activity);
//   - the prune and expiry markers of expired packed scopes (their sets are already gone);
//   - discovery unit, unit warning, retry and DEX width meta rows, and gateway repair evidence of the hour.
// Never touched: canonical hours (compact_hours with the checkpoint and the hash chain they carry), projection status rows
// and intelligence hours (the coverage proving a pool's first swap or liquidity since its creation hour), token discoveries
// (first sightings across all history), the registry and its coverage, token metadata, all-history pool totals and
// creation counts, the immutable recovery commitments (spine blocks, slices, DEX facts: byte-capped by the archive budget)
// and the daily status history. What is gone is reported as gone: store accessors answer history_expired, the DAU replay
// never re-reads a day before the floor and packing never recreates a scope before it. Rows a step cannot delete safely
// stay; a failure rolls back only its own step and is reported, never thrown.
import { ACTIVITY_KINDS, ACTIVITY_ROWS_PER_KIND } from './projections.js';
import { PACKED_DATASETS, PACKED_KEEP_HOURS } from './packed-shards.js';

export const HISTORY_KEEP_HOURS = PACKED_KEEP_HOURS.identity;
// Detail rows keyed by hour_start that no reader needs before the floor.
export const HISTORY_HOUR_TABLES = Object.freeze(['compact_family_hours', 'compact_valuation_hours', 'compact_token_price_hours',
  'compact_dex_volume_hours', 'compact_dex_fee_hours', 'compact_pool_tvl_hours']);
// compact_meta namespaces `<prefix><10-digit hour>:...`, read only by discovery and projection recovery (30 and 35 days).
export const HISTORY_META_PREFIXES = Object.freeze(['discovery_unit:', 'discovery_unit_warning:', 'discovery_retry:', 'compact_dex_width:']);
const GATEWAY_EVIDENCE = 'family_repair_evidence:gateway:'; // `<prefix><16-digit hour>` (store.js)
const LEFTOVER_DATASETS = Object.freeze(['compact_hour_addresses', 'compact_pool_price_hours', 'compact_pool_fee_hours', 'compact_daily_address_stage']);
const HOUR = 3600;
const DAY = 24 * HOUR;
const MiB = 1024 * 1024;

export class HistoryExpiryError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new HistoryExpiryError(code); };

// The oldest hour whose detail rows are kept for a checkpoint hour.
export const historyFloorOf = (checkpointHour) => checkpointHour - (HISTORY_KEEP_HOURS - 1) * HOUR;

// db: the store's DatabaseSync; maintain() runs inside the caller's writer transaction. packed: the store's packed shards
// (foldPoolHour). preflight(plannedBytes): the store's storage check ({ ok, reason }).
export function createHistoryExpiry(db, { config, packed, preflight = () => ({ ok: true }), log = console.warn } = {}) {
  const enabled = config?.retention === true && config?.expiry === true && config?.history === true;
  const maintenanceScopes = Number.isSafeInteger(config?.maintenanceScopes) ? config.maintenanceScopes : 16;
  const maintenanceBytes = (Number.isSafeInteger(config?.maintenanceMiB) ? config.maintenanceMiB : 64) * MiB;
  const int = (value) => BigInt(value);
  const changes = (statement, ...args) => Number(db.prepare(statement).run(...args).changes);
  const floorOf = (name) => db.prepare('SELECT hour_start FROM compact_packed_history_floor WHERE name = ?').get(name)?.hour_start ?? null;
  const raise = (name, hour) => db.prepare(`INSERT INTO compact_packed_history_floor (name, hour_start) VALUES (?, ?) ON CONFLICT (name)
    DO UPDATE SET hour_start = excluded.hour_start WHERE excluded.hour_start > compact_packed_history_floor.hour_start`).run(name, int(hour));
  // Bytes of every column of the rows a deletion removes: with their index pages, about twice that reaches the WAL.
  const columns = new Map();
  const bytesOf = (table, where, args) => {
    if (!columns.has(table)) {
      columns.set(table, db.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => `IFNULL(length(CAST(${name} AS BLOB)), 0)`).join(' + '));
    }
    return db.prepare(`SELECT IFNULL(SUM(${columns.get(table)}), 0) AS bytes FROM ${table} WHERE ${where}`).get(...args).bytes;
  };

  // The pass budget and storage rule of packed retention: the first deletion of a pass is refused only by the storage check.
  function admit(pass, planned) {
    if (pass.bytes > 0 && pass.bytes + planned > maintenanceBytes) return 'budget';
    const check = preflight(pass.bytes + planned);
    if (!check?.ok) return `storage_blocked:${check?.reason ?? 'storage_capacity_unknown'}`;
    pass.bytes += planned;
    return null;
  }

  // Up to `limit` deletions of one step, oldest scope first. next() names the oldest scope still to delete (or nothing);
  // each deletion runs in its own savepoint, and a failure, a storage refusal or no progress ends the step.
  function step(pass, report, name, limit, next, size, work) {
    let last = null;
    for (let done = 0; done < limit && !pass.blocked; done++) {
      const scope = next();
      if (scope === null || scope === undefined) return;
      if (scope === last) {
        report.failed.push({ step: name, scope, reason: 'history_no_progress' });
        return;
      }
      last = scope;
      const refused = admit(pass, 2 * size(scope) + 64 * 1024);
      if (refused === 'budget') return;
      if (refused) {
        pass.blocked = true;
        log(`HISTORY_EXPIRY_BLOCKED step=${name} scope=${scope} reason=${refused}`);
        report.failed.push({ step: name, scope, reason: refused });
        return;
      }
      db.exec('SAVEPOINT compact_history_expiry');
      try {
        const rows = work(scope);
        db.exec('RELEASE compact_history_expiry');
        report.deleted[name] = (report.deleted[name] ?? 0) + rows;
      } catch (error) {
        db.exec('ROLLBACK TO compact_history_expiry');
        db.exec('RELEASE compact_history_expiry');
        const reason = typeof error?.code === 'string' && !error.code.startsWith('ERR_') ? error.code : error?.message ?? 'history_expiry_failed';
        log(`HISTORY_EXPIRY_BLOCKED step=${name} scope=${scope} reason=${reason}`);
        report.failed.push({ step: name, scope, reason });
        return;
      }
    }
  }

  // One bounded pass inside the caller's writer transaction (null when OFF): raise the floor, then every step below it.
  function maintain(checkpointHour, { limit = maintenanceScopes } = {}) {
    if (!enabled) return null;
    if (db.isTransaction !== true) fail('history_transaction_required');
    if (!Number.isSafeInteger(limit) || limit < 1) fail('history_maintenance_limit_invalid');
    if (!Number.isSafeInteger(checkpointHour) || checkpointHour % HOUR !== 0) return null;
    raise('details', historyFloorOf(checkpointHour));
    const floor = floorOf('details');
    const dayBound = floor - (DAY - HOUR); // a day starting before this ends before the floor
    const report = { floor, deleted: {}, failed: [] };
    const pass = { bytes: 0, blocked: false };
    const run = (name, next, size, work) => step(pass, report, name, limit, next, size, work);

    for (const table of HISTORY_HOUR_TABLES) {
      run(table, () => db.prepare(`SELECT hour_start FROM ${table} WHERE hour_start < ? ORDER BY hour_start LIMIT 1`).get(int(floor))?.hour_start,
        (hour) => bytesOf(table, 'hour_start = ?', [int(hour)]), (hour) => changes(`DELETE FROM ${table} WHERE hour_start = ?`, int(hour)));
    }

    // The newest rows of a kind stay whatever their age: rows strictly older than its ACTIVITY_ROWS_PER_KIND-th newest.
    for (const kind of ACTIVITY_KINDS) {
      const edge = db.prepare(`SELECT block_number, log_index FROM compact_dex_activity WHERE kind = ? ORDER BY block_number DESC, log_index DESC
        LIMIT 1 OFFSET ?`).get(kind, int(ACTIVITY_ROWS_PER_KIND - 1));
      if (!edge) continue;
      const older = 'kind = ? AND (block_number < ? OR (block_number = ? AND log_index < ?))';
      const args = [kind, int(edge.block_number), int(edge.block_number), int(edge.log_index)];
      run('compact_dex_activity', () => db.prepare(`SELECT hour_start FROM compact_dex_activity WHERE ${older} AND hour_start < ?
        ORDER BY hour_start LIMIT 1`).get(...args, int(floor))?.hour_start,
      (hour) => bytesOf('compact_dex_activity', `${older} AND hour_start = ?`, [...args, int(hour)]),
      (hour) => changes(`DELETE FROM compact_dex_activity WHERE ${older} AND hour_start = ?`, ...args, int(hour)));
    }

    // Observations: an hour at a time from the 'observations' cursor up to the floor, keeping the first of each pool and
    // activity (no earlier row of the same pool and activity exists anywhere) and every creation row.
    let cursor = floorOf('observations')
      ?? db.prepare('SELECT MIN(hour_start) AS hour FROM compact_token_dex_observations').get().hour ?? floor;
    const later = `rowid IN (SELECT o.rowid FROM compact_token_dex_observations o WHERE o.hour_start = ? AND o.activity <> 'creation'
      AND EXISTS (SELECT 1 FROM compact_token_dex_observations e WHERE e.protocol = o.protocol AND e.pool = o.pool AND e.activity = o.activity
        AND (e.block_number < o.block_number OR (e.block_number = o.block_number AND e.log_index < o.log_index))))`;
    run('compact_token_dex_observations', () => {
      const hour = db.prepare('SELECT hour_start FROM compact_token_dex_observations WHERE hour_start >= ? AND hour_start < ? ORDER BY hour_start LIMIT 1')
        .get(int(cursor), int(floor))?.hour_start;
      if (hour === undefined) raise('observations', floor);
      return hour;
    }, (hour) => bytesOf('compact_token_dex_observations', later, [int(hour)]), (hour) => {
      const deleted = changes(`DELETE FROM compact_token_dex_observations WHERE ${later}`, int(hour));
      raise('observations', hour + HOUR);
      cursor = hour + HOUR;
      return deleted;
    });

    const oldestDay = () => {
      const days = ['compact_daily_active_addresses', 'compact_daily_address_hours']
        .map((table) => db.prepare(`SELECT MIN(day_start) AS day FROM ${table} WHERE day_start < ?`).get(int(dayBound)).day).filter((day) => day !== null);
      return days.length ? Math.min(...days) : null;
    };
    run('compact_daily_active_addresses', oldestDay,
      (day) => bytesOf('compact_daily_active_addresses', 'day_start = ?', [int(day)]) + bytesOf('compact_daily_address_hours', 'day_start = ?', [int(day)]),
      (day) => changes('DELETE FROM compact_daily_address_hours WHERE day_start = ?', int(day))
        + changes('DELETE FROM compact_daily_active_addresses WHERE day_start = ?', int(day)));

    // Hot rows of scopes that were never packed (no set, no marker); a packed or marked scope is left to packed retention.
    const unpacked = (dataset, column) => `NOT EXISTS (SELECT 1 FROM compact_packed_sets s WHERE s.dataset = '${dataset}' AND s.scope_start = t.${column})
      AND NOT EXISTS (SELECT 1 FROM compact_packed_pruned m WHERE m.dataset = '${dataset}' AND m.scope_start = t.${column})`;
    for (const dataset of LEFTOVER_DATASETS) {
      const column = PACKED_DATASETS[dataset].scope;
      const bound = column === 'day_start' ? dayBound : floor;
      run(dataset, () => db.prepare(`SELECT t.${column} AS scope FROM ${dataset} t WHERE t.${column} < ? AND ${unpacked(dataset, column)}
        ORDER BY t.${column} LIMIT 1`).get(int(bound))?.scope,
      (scope) => bytesOf(dataset, `${column} = ?`, [int(scope)]), (scope) => changes(`DELETE FROM ${dataset} WHERE ${column} = ?`, int(scope)));
    }
    // Final pool hours only (both pool projections available, every row present): see foldPoolHour.
    const pools = PACKED_DATASETS.compact_pool_hours.projections.map((name) => `'${name}'`).join(', ');
    run('compact_pool_hours', () => db.prepare(`SELECT t.hour_start AS scope FROM compact_pool_hours t WHERE t.hour_start < ?
      AND ${unpacked('compact_pool_hours', 'hour_start')}
      AND (SELECT COUNT(*) FROM compact_projection_hours p WHERE p.hour_start = t.hour_start AND p.projection IN (${pools}) AND p.status = 'available') = 2
      AND (SELECT COUNT(*) FROM compact_pool_hours q WHERE q.hour_start = t.hour_start)
        = (SELECT SUM(p.row_count) FROM compact_projection_hours p WHERE p.hour_start = t.hour_start AND p.projection IN (${pools}))
      ORDER BY t.hour_start LIMIT 1`).get(int(floor))?.scope,
    (hour) => bytesOf('compact_pool_hours', 'hour_start = ?', [int(hour)]), (hour) => packed.foldPoolHour(hour).rows);

    // Markers of expired scopes before the floor (the delete guards check the same conditions).
    for (const [dataset, { scope: column }] of Object.entries(PACKED_DATASETS)) {
      run('compact_packed_markers', () => db.prepare(`SELECT e.scope_start FROM compact_packed_expired e WHERE e.dataset = ? AND e.scope_start < ?
        AND NOT EXISTS (SELECT 1 FROM compact_packed_sets s WHERE s.dataset = e.dataset AND s.scope_start = e.scope_start)
        AND NOT EXISTS (SELECT 1 FROM ${dataset} t WHERE t.${column} = e.scope_start)
        ORDER BY e.scope_start LIMIT 1`).get(dataset, int(column === 'day_start' ? dayBound : floor))?.scope_start,
      () => 1024, (scope) => {
        const expired = changes('DELETE FROM compact_packed_expired WHERE dataset = ? AND scope_start = ?', dataset, int(scope));
        const pruned = changes('DELETE FROM compact_packed_pruned WHERE dataset = ? AND scope_start = ?', dataset, int(scope));
        if (expired !== 1 || pruned !== 1) fail('history_marker_mismatch');
        return expired + pruned;
      });
    }

    // Meta rows: all keys of one namespace and hour at a time. Hours are 10-digit numbers (2001 to 2286), so key order is
    // hour order; any other key ends the namespace for this pass and is reported.
    const metaHour = (prefix, digits) => {
      const row = db.prepare('SELECT key FROM compact_meta WHERE key > ? AND key < ? ORDER BY key LIMIT 1')
        .get(prefix, `${prefix}${String(floor).padStart(digits, '0')}`);
      if (!row) return null;
      const hour = new RegExp(`^(\\d{${digits}})(:|$)`).exec(row.key.slice(prefix.length))?.[1];
      if (hour === undefined || Number(hour) >= floor || Number(hour) % HOUR !== 0) {
        report.failed.push({ step: 'compact_meta', scope: row.key.slice(0, 96), reason: 'history_meta_key_unexpected' });
        return null;
      }
      return Number(hour);
    };
    if (floor >= 1e9 && floor < 1e10) {
      for (const prefix of HISTORY_META_PREFIXES) {
        const range = (hour) => [`${prefix}${hour}:`, `${prefix}${hour};`];
        run('compact_meta', () => metaHour(prefix, 10), (hour) => bytesOf('compact_meta', 'key >= ? AND key < ?', range(hour)),
          (hour) => changes('DELETE FROM compact_meta WHERE key >= ? AND key < ?', ...range(hour)));
      }
    }
    const gateway = (hour) => `${GATEWAY_EVIDENCE}${String(hour).padStart(16, '0')}`;
    run('compact_meta', () => metaHour(GATEWAY_EVIDENCE, 16), (hour) => bytesOf('compact_meta', 'key = ?', [gateway(hour)]),
      (hour) => changes('DELETE FROM compact_meta WHERE key = ?', gateway(hour)));
    return report;
  }

  return Object.freeze({ enabled, floor: () => packed?.historyFloor() ?? null, maintain });
}
