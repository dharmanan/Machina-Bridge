// Exact unique active addresses of a span of stored hours: the union of the stored identity sets, each address counted
// once. A completed UTC day inside the span uses its daily set (compact_daily_address_stage, the union of the day's 24
// hourly sets, counted when the day was finalized); every other hour uses its hourly set (compact_hour_addresses). A set is
// used only when it is complete: hot rows whose count equals the canonical count (compact_hours, or the finalized daily
// count), or a verified packed set of exactly that count (packed-shards.js; the only copy of a scope retention pruned). A
// day without a usable set falls back to its hours; an hour without one makes the span unavailable. Nothing is estimated.
// Archived sets are used only after independent canonical, full-count, typed-row and checksum verification.
// Memory: each source is fully verified into one anonymous, bounded binary spool before an exact sorted merge.
// Only 128 addresses per source are retained during merging; no decoded source piece remains open across sources.
import { createHash } from 'node:crypto';
import { identitySource, identityUnionCount } from './identity-evidence.js';
const connections=new WeakMap();let nextConnection=0;

const HOUR = 3600;
const DAY = 24 * HOUR;
const unavailable = (reason) => ({ status: 'unavailable', reason, value: null });
const list = (values) => values.map(() => '?').join(', ');
const int = (value) => BigInt(value);

// db: a read connection (one snapshot for the whole call). packed: a packed-shards instance on the same connection.
// cache: an optional Map of answers already counted; a key names every set used and its count, and complete identity
// sets never change, so an answer stays valid for that key. Returns { status: 'available', value } or
// { status: 'unavailable', reason: insufficient_coverage | identity_incomplete | identity_unverified, value: null }.
export function uniqueAddressesOfSpan(db, from, to, options = {}) {
  try{return verifiedUnion(db,from,to,options);}catch(error){
    if([7,13].includes(error.errcode))return unavailable('identity_read_budget');
    if(/^(archive_|packed_|identity_)/.test(error?.code??''))return unavailable(error.code==='identity_union_storage_budget'?'identity_read_budget':'identity_unverified');
    throw error;
  }
}
function verifiedUnion(db,from,to,{packed,cache=null,cacheLimit=16,onProgress}) {
  const expected = new Map(db.prepare('SELECT hour_start, unique_active_addresses FROM compact_hours WHERE hour_start BETWEEN ? AND ?')
    .all(int(from), int(to)).map((row) => [row.hour_start, row.unique_active_addresses]));
  if (expected.size !== (to - from) / HOUR + 1 || [...expected.keys()].sort((a,b)=>a-b).some((h,i)=>h!==from+i*HOUR)) return unavailable('insufficient_coverage');
  const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name IN ('compact_daily_active_addresses', 'compact_daily_address_stage')`).all().map((row) => row.name));
  const plan = [];
  const dayHours = new Set();
  const firstDay = Math.ceil(from / DAY) * DAY;
  const days = [];
  for (let day = firstDay; day + DAY - HOUR <= to; day += DAY) days.push(day);
  if (days.length && tables.size === 2) {
    const daily = new Map(db.prepare(`SELECT day_start, active_addresses FROM compact_daily_active_addresses WHERE status = 'available'
      AND day_start IN (${list(days)})`).all(...days.map(int)).map((row) => [row.day_start, row.active_addresses]));
    const finalized = days.filter((day) => daily.has(day));
    for (const day of finalized) {
      const source = identitySource(db,'compact_daily_address_stage',day,daily.get(day),{packed});
      if (!source) continue; // falls back to the day's hourly sets
      plan.push(source);
      for (let hour = day; hour < day + DAY; hour += HOUR) dayHours.add(hour);
    }
  }
  const hours = [...expected.keys()].filter((hour) => !dayHours.has(hour));
  for (const hour of hours) {
    const source = identitySource(db,'compact_hour_addresses',hour,expected.get(hour),{packed});
    if (!source) return unavailable('identity_incomplete');
    plan.push(source);
  }
  if(!connections.has(db))connections.set(db,++nextConnection);
  const epoch=[connections.get(db),db.prepare('PRAGMA data_version').get().data_version,db.prepare('SELECT total_changes() AS n').get().n];
  const key = createHash('sha256').update(JSON.stringify([from,to,epoch,plan.map(({openRows,...source})=>source)])).digest('hex');
  if (cache?.has(key)) return cache.get(key);
  const value=identityUnionCount(db,plan,{onProgress});
  const answer = { status: 'available', value };
  if (cache) {
    cache.set(key, answer);
    while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
  }
  return answer;
}
