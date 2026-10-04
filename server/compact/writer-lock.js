// Compact engine: one writer at a time for the compact SQLite file. Every process that writes it (the hourly runner, the
// projection-only repair child, the projection backfill and the valuation backfill) holds an exclusive lock file next to
// the database for its whole run, so a backfill never interleaves its commits with a scheduled hour, and two operator runs
// never overlap. SQLite would serialize single transactions anyway; this lock keeps whole runs apart.
// The lock file holds { pid, owner, since } and is removed on release, so nothing is left behind. A lock whose process is
// gone is stale and replaced under a short acquisition guard. Age never overrides a live process. An unreadable lock
// fails closed and needs operator inspection; guessing that a writer has expired can permit overlapping runs.
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const MAX_LOCK_AGE_MS = 3 * 60 * 60 * 1000;

export const lockPathOf = (sqlitePath) => `${sqlitePath}.writer-lock`;

export class WriterLockError extends Error {
  constructor(code, holder = null) { super(code); this.code = code; this.holder = holder; }
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLock(path) {
  let stat;
  try { stat = statSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let holder = null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (Number.isSafeInteger(parsed?.pid) && parsed.pid > 0 && typeof parsed.owner === 'string') holder = parsed;
  } catch { /* unreadable locks fail closed */ }
  return { holder, mtimeMs: stat.mtimeMs };
}

// The live holder of the lock, or null when there is none (or only a stale one). Read-only.
export function writerLockHolder(sqlitePath, { isAlive = processAlive, now = () => Date.now() } = {}) {
  const lock = readLock(lockPathOf(sqlitePath));
  if (!lock) return null;
  if (!lock.holder) return { pid: null, owner: 'unknown', since: null };
  return isAlive(lock.holder.pid) ? lock.holder : null;
}

// Takes the lock or throws WriterLockError('writer_lock_held', holder). Returns { path, release() }.
export function acquireWriterLock(sqlitePath, { owner, isAlive = processAlive, now = () => Date.now() } = {}) {
  if (typeof owner !== 'string' || !owner) throw new Error('writer_lock_owner_required');
  const path = lockPathOf(sqlitePath);
  // Serialize acquisition and dead-process replacement. Without this guard, two contenders can both see a dead lock
  // and one can unlink the other's newly acquired lock. A crash during acquisition leaves the guard fail-closed.
  const guard = `${path}.claim`;
  let guardFd;
  try { guardFd = openSync(guard, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new WriterLockError('writer_lock_contended'); throw error; }
  const token = randomUUID();
  try {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = openSync(path, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = writerLockHolder(sqlitePath, { isAlive, now });
      if (holder) throw new WriterLockError('writer_lock_held', holder);
      try { unlinkSync(path); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; } // stale
      continue;
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, owner, token, since: new Date(now()).toISOString() }));
    } finally {
      closeSync(fd);
    }
    let released = false;
    return {
      path,
      release() {
        if (released) return;
        released = true;
        try {
          if (readLock(path)?.holder?.token === token) unlinkSync(path);
        } catch { /* already gone */ }
      },
    };
  }
  throw new WriterLockError('writer_lock_contended');
  } finally { closeSync(guardFd); unlinkSync(guard); }
}
