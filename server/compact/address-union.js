// Exact unique active addresses of a span of stored hours: the union of the stored identity sets, each address counted
// once. A completed UTC day inside the span uses its daily set (compact_daily_address_stage, the union of the day's 24
// hourly sets, counted when the day was finalized); every other hour uses its hourly set (compact_hour_addresses). A set is
// used only when it is complete: hot rows whose count equals the canonical count (compact_hours, or the finalized daily
// count), or a verified packed set of exactly that count (packed-shards.js; the only copy of a scope retention pruned). A
// day without a usable set falls back to its hours; an hour without one makes the span unavailable. Nothing is estimated
// and archived evidence is never substituted.
// Memory: when every set is hot, SQLite counts the distinct union itself (its sorter spills to temporary storage). With
// packed sets, the hot sets arrive as one sorted, distinct SQLite stream and each packed set as its own verified stream,
// merged in address order: memory holds one piece per open packed set and one heap entry per stream, never the union.
import { createHash } from 'node:crypto';

const HOUR = 3600;
const DAY = 24 * HOUR;
const unavailable = (reason) => ({ status: 'unavailable', reason, value: null });
const list = (values) => values.map(() => '?').join(', ');
const int = (value) => BigInt(value);

// Ascending lowercase-hex address streams (hex order is byte order) -> the number of distinct addresses.
function distinctOfMerged(streams) {
  const heap = [];
  const less = (a, b) => a.value < b.value;
  const siftDown = (index) => {
    for (;;) {
      const left = 2 * index + 1, right = left + 1;
      let smallest = index;
      if (left < heap.length && less(heap[left], heap[smallest])) smallest = left;
      if (right < heap.length && less(heap[right], heap[smallest])) smallest = right;
      if (smallest === index) return;
      [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
      index = smallest;
    }
  };
  const advance = (entry) => {
    const step = entry.stream.next();
    if (step.done) return false;
    if (entry.value !== null && step.value <= entry.value) throw Object.assign(new Error('identity_order_invalid'), { code: 'identity_order_invalid' });
    entry.value = step.value;
    return true;
  };
  for (const stream of streams) {
    const entry = { stream, value: null };
    if (advance(entry)) heap.push(entry);
  }
  for (let index = Math.floor(heap.length / 2) - 1; index >= 0; index--) siftDown(index);
  let count = 0;
  let last = null;
  while (heap.length) {
    const top = heap[0];
    if (top.value !== last) { count++; last = top.value; }
    if (!advance(top)) {
      const tail = heap.pop();
      if (heap.length) heap[0] = tail;
    }
    siftDown(0);
  }
  return count;
}

// db: a read connection (one snapshot for the whole call). packed: a packed-shards instance on the same connection.
// cache: an optional Map of answers already counted; a key names every set used and its count, and complete identity
// sets never change, so an answer stays valid for that key. Returns { status: 'available', value } or
// { status: 'unavailable', reason: insufficient_coverage | identity_incomplete | identity_unverified, value: null }.
export function uniqueAddressesOfSpan(db, from, to, { packed, cache = null, cacheLimit = 16 }) {
  const expected = new Map(db.prepare('SELECT hour_start, unique_active_addresses FROM compact_hours WHERE hour_start BETWEEN ? AND ?')
    .all(int(from), int(to)).map((row) => [row.hour_start, row.unique_active_addresses]));
  if (expected.size !== (to - from) / HOUR + 1) return unavailable('insufficient_coverage');
  const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name IN ('compact_daily_active_addresses', 'compact_daily_address_stage')`).all().map((row) => row.name));
  const hotCounts = (table, column, scopes) => (scopes.length ? new Map(db.prepare(`SELECT ${column} AS scope, COUNT(*) AS count FROM ${table}
    WHERE ${column} IN (${list(scopes)}) GROUP BY ${column}`).all(...scopes.map(int)).map((row) => [row.scope, row.count])) : new Map());
  // A complete set of `count` identities for one scope: hot unless retention pruned it, else packed; null when neither.
  const sourceOf = (scope, count, hot, pruned, stored) => {
    if (pruned.has(scope)) return stored.get(scope) === count ? 'packed' : null;
    if ((hot.get(scope) ?? 0) === count) return 'hot';
    return stored.get(scope) === count ? 'packed' : null;
  };
  const plan = [];
  const dayHours = new Set();
  const firstDay = Math.ceil(from / DAY) * DAY;
  const days = [];
  for (let day = firstDay; day + DAY - HOUR <= to; day += DAY) days.push(day);
  if (days.length && tables.size === 2) {
    const daily = new Map(db.prepare(`SELECT day_start, active_addresses FROM compact_daily_active_addresses WHERE status = 'available'
      AND day_start IN (${list(days)})`).all(...days.map(int)).map((row) => [row.day_start, row.active_addresses]));
    const finalized = days.filter((day) => daily.has(day));
    const hot = hotCounts('compact_daily_address_stage', 'day_start', finalized);
    const pruned = new Set(packed.prunedScopes('compact_daily_address_stage', firstDay, to));
    const stored = packed.storedScopes('compact_daily_address_stage', firstDay, to);
    for (const day of finalized) {
      const source = sourceOf(day, daily.get(day), hot, pruned, stored);
      if (!source) continue; // falls back to the day's hourly sets
      plan.push({ dataset: 'compact_daily_address_stage', scope: day, count: daily.get(day), source });
      for (let hour = day; hour < day + DAY; hour += HOUR) dayHours.add(hour);
    }
  }
  const hours = [...expected.keys()].filter((hour) => !dayHours.has(hour));
  const hot = hotCounts('compact_hour_addresses', 'hour_start', hours);
  const pruned = new Set(packed.prunedScopes('compact_hour_addresses', from, to));
  const stored = packed.storedScopes('compact_hour_addresses', from, to);
  for (const hour of hours) {
    const source = sourceOf(hour, expected.get(hour), hot, pruned, stored);
    if (!source) return unavailable('identity_incomplete');
    plan.push({ dataset: 'compact_hour_addresses', scope: hour, count: expected.get(hour), source });
  }
  const key = createHash('sha256').update(JSON.stringify([from, to, plan])).digest('hex');
  if (cache?.has(key)) return cache.get(key);

  const hotDays = plan.filter((set) => set.source === 'hot' && set.dataset === 'compact_daily_address_stage').map((set) => int(set.scope));
  const hotHours = plan.filter((set) => set.source === 'hot' && set.dataset === 'compact_hour_addresses').map((set) => int(set.scope));
  const hotUnion = [...(hotDays.length ? [`SELECT address FROM compact_daily_address_stage WHERE day_start IN (${list(hotDays)})`] : []),
    ...(hotHours.length ? [`SELECT address FROM compact_hour_addresses WHERE hour_start IN (${list(hotHours)})`] : [])].join(' UNION ALL ');
  const packedSets = plan.filter((set) => set.source === 'packed');
  let value;
  if (!packedSets.length) {
    value = hotUnion ? db.prepare(`SELECT COUNT(DISTINCT address) AS count FROM (${hotUnion})`).get(...hotDays, ...hotHours).count : 0;
  } else {
    const streams = [];
    try {
      if (hotUnion) {
        const statement = db.prepare(`SELECT DISTINCT lower(hex(address)) AS address FROM (${hotUnion}) ORDER BY address`);
        streams.push((function* hotStream() { for (const row of statement.iterate(...hotDays, ...hotHours)) yield row.address; })());
      }
      for (const set of packedSets) {
        const rows = packed.openRows(set.dataset, set.scope);
        if (!rows) return unavailable('identity_incomplete');
        streams.push((function* packedStream() {
          let count = 0;
          for (const row of rows) {
            count++;
            yield Buffer.from(row.address.buffer, row.address.byteOffset, row.address.byteLength).toString('hex');
          }
          // The packed iterator verified its own count and digest before ending; the plan's count must match too.
          if (count !== set.count) throw Object.assign(new Error('packed_rows_corrupt'), { code: 'packed_rows_corrupt' });
        })());
      }
      value = distinctOfMerged(streams);
    } catch (error) {
      if (typeof error?.code === 'string' && (error.code.startsWith('packed_') || error.code === 'identity_order_invalid')) {
        return unavailable('identity_unverified');
      }
      throw error;
    } finally {
      for (const stream of streams) stream.return?.();
    }
  }
  const answer = { status: 'available', value };
  if (cache) {
    cache.set(key, answer);
    while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
  }
  return answer;
}
