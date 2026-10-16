import { recordIdentityCommitment } from './identity-evidence.js';
const HOUR = 3600;
const DAY = 24 * HOUR;
const ADDRESS = /^0x[0-9a-f]{40}$/;

export const DAILY_ACTIVE_ADDRESSES_SQL = `
CREATE TABLE IF NOT EXISTS compact_daily_address_hours (
  day_start INTEGER NOT NULL CHECK (day_start % 86400 = 0),
  hour_start INTEGER NOT NULL REFERENCES compact_hours (hour_start),
  PRIMARY KEY (day_start, hour_start),
  CHECK (hour_start >= day_start AND hour_start < day_start + 86400 AND hour_start % 3600 = 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS compact_daily_address_stage (
  day_start INTEGER NOT NULL CHECK (day_start % 86400 = 0),
  address BLOB NOT NULL CHECK (length(address) = 20),
  PRIMARY KEY (day_start, address)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS compact_daily_active_addresses (
  day_start INTEGER PRIMARY KEY CHECK (day_start % 86400 = 0),
  status TEXT NOT NULL CHECK (status IN ('available', 'unavailable')),
  reason TEXT,
  active_addresses INTEGER,
  CHECK (
    (status = 'available' AND reason IS NULL AND active_addresses IS NOT NULL AND active_addresses >= 0)
    OR
    (status = 'unavailable' AND reason IS NOT NULL AND active_addresses IS NULL)
  )
) STRICT;
CREATE TABLE IF NOT EXISTS compact_daily_address_status_history (
  day_start INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL,
  definition_version TEXT NOT NULL, PRIMARY KEY(day_start,status,reason,definition_version)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS compact_daily_status_history_no_update BEFORE UPDATE ON compact_daily_address_status_history BEGIN SELECT RAISE(ABORT,'immutable_daily_status_history'); END;
CREATE TRIGGER IF NOT EXISTS compact_daily_status_history_no_delete BEFORE DELETE ON compact_daily_address_status_history BEGIN SELECT RAISE(ABORT,'immutable_daily_status_history'); END;
`;

export function dayStartOf(hourStart) {
  if (!Number.isSafeInteger(hourStart) || hourStart % HOUR !== 0) throw new Error('invalid_dau_hour');
  return Math.floor(hourStart / DAY) * DAY;
}

export function createDailyActiveAddressesStore(db, { archive, reconcileDay = null } = {}) {
  const insertHour = db.prepare(
    'INSERT OR IGNORE INTO compact_daily_address_hours (day_start, hour_start) VALUES (?, ?)'
  );
  const insertAddress = db.prepare(
    'INSERT OR IGNORE INTO compact_daily_address_stage (day_start, address) VALUES (?, ?)'
  );
  const capturedHours = db.prepare(
    'SELECT COUNT(*) AS count FROM compact_daily_address_hours WHERE day_start = ?'
  );
  const storedHours = db.prepare(
    'SELECT COUNT(*) AS count FROM compact_hours WHERE hour_start >= ? AND hour_start < ?'
  );
  const activeCount = db.prepare(
    'SELECT COUNT(*) AS count FROM compact_daily_address_stage WHERE day_start = ?'
  );
  const daily = db.prepare(
    'SELECT status, reason, active_addresses FROM compact_daily_active_addresses WHERE day_start = ?'
  );
  const finalize = db.prepare(
    `INSERT INTO compact_daily_active_addresses (day_start,status,reason,active_addresses) VALUES (?,'available',NULL,?)
     ON CONFLICT(day_start) DO UPDATE SET status='available',reason=NULL,active_addresses=excluded.active_addresses
     WHERE compact_daily_active_addresses.status='unavailable' AND compact_daily_active_addresses.reason='identity_not_captured'`
  );
  const finalizeUnavailable = db.prepare(
    "INSERT INTO compact_daily_active_addresses (day_start, status, reason, active_addresses) VALUES (?, 'unavailable', 'identity_not_captured', NULL)"
  );

  function observeHour(hourStart, addresses, { replay = false, membershipPreserved = false } = {}) {
    const dayStart = dayStartOf(hourStart);
    if (!Array.isArray(addresses) || addresses.some((address) => !ADDRESS.test(address))) {
      throw new Error('invalid_dau_addresses');
    }

    const stored = daily.get(dayStart);
    // Small failure/status facts are permanent even while bulk archival is OFF. No deletion on replay.
    if (stored?.status === 'unavailable') db.prepare('INSERT OR IGNORE INTO compact_daily_address_status_history VALUES(?,?,?,?)')
      .run(dayStart,stored.status,stored.reason,'arc-dau-v1');
    if (archive?.config.enabled) {
      const finalized = db.prepare(`SELECT day_start FROM compact_daily_active_addresses WHERE status='available'
        AND day_start<=?
        AND (SELECT COUNT(*) FROM compact_daily_address_hours h WHERE h.day_start=compact_daily_active_addresses.day_start)=24
        AND (SELECT COUNT(*) FROM compact_daily_address_stage s WHERE s.day_start=compact_daily_active_addresses.day_start)=active_addresses
        AND active_addresses>0 ORDER BY day_start LIMIT ?`)
        .all(dayStart,archive.config.maxPruneHours);
      for (const row of finalized) {
        // These 24 tiny provenance markers are required for future packing/revalidation. Keep them, including when
        // archival is OFF or a large daily membership exceeds the bounded archive writer's row budget.
        archive.prune('compact_daily_address_stage','day_start=?',[row.day_start],'day_start');
      }
    }
    if (stored?.status === 'available' && (!replay || membershipPreserved)) {
      return {
        dayStart,
        status: 'available',
        reason: null,
        activeAddresses: stored.active_addresses,
        finalized: true,
      };
    }

    if (stored && stored.status !== 'available') {
      if (!replay || stored.reason !== 'identity_not_captured') {
        return {
          dayStart,
          status: stored.status,
          reason: stored.reason,
          activeAddresses: stored.active_addresses,
          finalized: true,
        };
      }
      // Keep the unavailable row until a complete replay can atomically upgrade it; history retains its reason.
      archive?.preserve('compact_daily_active_addresses',dayStart,
        archive.readRows('compact_daily_active_addresses','day_start=?',[dayStart]),{scope:'prior_daily_status'});
    }

    const inserted = insertHour.run(dayStart, hourStart);
    if (Number(inserted.changes) > 0) {
      for (const address of addresses) {
        insertAddress.run(dayStart, Buffer.from(address.slice(2), 'hex'));
      }
    }

    let hours = Number(capturedHours.get(dayStart).count);
    const storedHourCount = Number(storedHours.get(dayStart, dayStart + DAY).count);

    // Finalize only after reconciling the day against complete hourly inputs. A damaged staging row/marker must not
    // turn into a newly checksummed but incorrect daily fact. Failure keeps this canonical hour and the staging evidence.
    if(storedHourCount===24&&reconcileDay){
      db.exec('SAVEPOINT daily_identity_reconcile');
      try{
        const count=reconcileDay(dayStart);
        if(stored?.status==='available'&&stored.active_addresses!==count)throw new Error('identity_daily_count_conflict');
        db.exec('RELEASE daily_identity_reconcile');hours=24;
      }catch(e){
        db.exec('ROLLBACK TO daily_identity_reconcile; RELEASE daily_identity_reconcile');
        const safe=/^(identity_|archive_|packed_|storage_)[a-z_]{1,80}$/.test(e.code??e.message)?e.code??e.message:'identity_reconcile_failed';
        db.prepare('INSERT OR IGNORE INTO compact_daily_address_status_history VALUES(?,?,?,?)').run(dayStart,'unavailable',safe,'arc-dau-v1');
        if(!stored)finalizeUnavailable.run(dayStart);
        return {dayStart,status:'unavailable',reason:safe,activeAddresses:null,finalized:true};
      }
    }

    if (hours === 24) {
      const count = Number(activeCount.get(dayStart).count);
      if(stored?.status==='available' && stored.active_addresses!==count)throw new Error('identity_daily_count_conflict');
      finalize.run(dayStart, count);
      recordIdentityCommitment(db,'compact_daily_address_stage',dayStart);
      // Packing runs AFTER observeHour, in the same canonical transaction. Never archive/prune this newly finalized
      // stage before packDay can see its 24 captured hours. Later transactions still use verified archive/packed pruning.

      return {
        dayStart,
        status: 'available',
        reason: null,
        activeAddresses: count,
        finalized: true,
      };
    }

    if (!replay && storedHourCount === 24) {
      if (!stored) finalizeUnavailable.run(dayStart);
      // Incomplete membership is recovery evidence, never disposable staging.

      return {
        dayStart,
        status: 'unavailable',
        reason: 'identity_not_captured',
        activeAddresses: null,
        finalized: true,
      };
    }

    return {
      dayStart,
      status: 'pending',
      capturedHours: hours,
      activeAddresses: null,
      finalized: false,
    };
  }

  return { observeHour };
}
