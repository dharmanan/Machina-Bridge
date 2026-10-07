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
`;

export function dayStartOf(hourStart) {
  if (!Number.isSafeInteger(hourStart) || hourStart % HOUR !== 0) throw new Error('invalid_dau_hour');
  return Math.floor(hourStart / DAY) * DAY;
}

export function createDailyActiveAddressesStore(db) {
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
    "INSERT INTO compact_daily_active_addresses (day_start, status, reason, active_addresses) VALUES (?, 'available', NULL, ?)"
  );
  const finalizeUnavailable = db.prepare(
    "INSERT INTO compact_daily_active_addresses (day_start, status, reason, active_addresses) VALUES (?, 'unavailable', 'identity_not_captured', NULL)"
  );
  const clearHours = db.prepare('DELETE FROM compact_daily_address_hours WHERE day_start = ?');
  const clearStage = db.prepare('DELETE FROM compact_daily_address_stage WHERE day_start = ?');
  const clearUnavailable = db.prepare(
    "DELETE FROM compact_daily_active_addresses WHERE day_start = ? AND status = 'unavailable' AND reason = 'identity_not_captured'"
  );

  function observeHour(hourStart, addresses, { replay = false } = {}) {
    const dayStart = dayStartOf(hourStart);
    if (!Array.isArray(addresses) || addresses.some((address) => !ADDRESS.test(address))) {
      throw new Error('invalid_dau_addresses');
    }

    const stored = daily.get(dayStart);
    if (stored?.status === 'available') {
      return {
        dayStart,
        status: 'available',
        reason: null,
        activeAddresses: stored.active_addresses,
        finalized: true,
      };
    }

    if (stored) {
      if (!replay || stored.reason !== 'identity_not_captured') {
        return {
          dayStart,
          status: stored.status,
          reason: stored.reason,
          activeAddresses: stored.active_addresses,
          finalized: true,
        };
      }
      clearUnavailable.run(dayStart);
    }

    const inserted = insertHour.run(dayStart, hourStart);
    if (Number(inserted.changes) > 0) {
      for (const address of addresses) {
        insertAddress.run(dayStart, Buffer.from(address.slice(2), 'hex'));
      }
    }

    const hours = Number(capturedHours.get(dayStart).count);
    const storedHourCount = Number(storedHours.get(dayStart, dayStart + DAY).count);

    if (hours === 24) {
      const count = Number(activeCount.get(dayStart).count);
      finalize.run(dayStart, count);
      clearHours.run(dayStart);
      clearStage.run(dayStart);

      return {
        dayStart,
        status: 'available',
        reason: null,
        activeAddresses: count,
        finalized: true,
      };
    }

    if (!replay && storedHourCount === 24) {
      finalizeUnavailable.run(dayStart);
      clearHours.run(dayStart);
      clearStage.run(dayStart);

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
