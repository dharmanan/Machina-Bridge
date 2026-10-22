// Operator-only maintenance entry point. No startup, scheduler, RPC or environment-variable trigger.
// The approval flag acknowledges a separately approved maintenance window; it is not authentication.
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DISCOVERY_RETRY_INDEX_SQL } from '../server/compact/intelligence-store.js';
import { acquireWriterLock } from '../server/compact/writer-lock.js';

const normalize = sql => sql.replace(/\bIF\s+NOT\s+EXISTS\s+/i, '').replace(/;\s*$/, '').replace(/\s+/g, ' ').trim();

export function migrateDiscoveryRetryIndex({ sqlitePath, maintenanceApproved = false } = {}) {
  if (maintenanceApproved !== true) throw Error('maintenance_approval_required');
  if (typeof sqlitePath !== 'string' || !isAbsolute(sqlitePath) || !statSync(sqlitePath).isFile()) throw Error('existing_sqlite_file_required');
  const lock = acquireWriterLock(sqlitePath, { owner: 'discovery-retry-index-maintenance' });
  let db;
  try {
    // Recheck under the same lock used by all compact writers. Never create the store/schema here.
    if (!statSync(sqlitePath).isFile()) throw Error('existing_sqlite_file_required');
    db = new DatabaseSync(sqlitePath);
    db.exec('PRAGMA busy_timeout=5000; PRAGMA temp_store=FILE;');
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') throw Error('existing_wal_database_required');
    if (db.prepare("SELECT value FROM compact_meta WHERE key='schema_version'").get()?.value !== '2') throw Error('schema_version_mismatch');
    db.exec('BEGIN IMMEDIATE');
    try {
      const present = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='compact_token_discovery_retry_due'").get();
      db.exec(DISCOVERY_RETRY_INDEX_SQL);
      const installed = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='compact_token_discovery_retry_due'").get();
      if (!installed || normalize(installed.sql) !== normalize(DISCOVERY_RETRY_INDEX_SQL)) throw Error('retry_index_definition_mismatch');
      db.exec('COMMIT');
      return { status: present ? 'already_present' : 'applied' };
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    try { db?.close(); } finally { lock.release(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  try {
    if (!args.length) {
      console.log('DISCOVERY_RETRY_MIGRATION not_applied: separate maintenance approval, an explicit database path and the writer lock are required.');
    } else {
      if (args.length !== 3 || args[0] !== '--apply-approved-maintenance' || args[1] !== '--sqlite-path') throw Error('explicit_maintenance_arguments_required');
      console.log('DISCOVERY_RETRY_MIGRATION ' + migrateDiscoveryRetryIndex({ sqlitePath: args[2], maintenanceApproved: true }).status);
    }
  } catch (error) {
    const safeCodes = ['maintenance_approval_required', 'existing_sqlite_file_required', 'existing_wal_database_required', 'schema_version_mismatch',
      'retry_index_definition_mismatch', 'explicit_maintenance_arguments_required', 'writer_lock_held', 'writer_lock_contended'];
    console.error('DISCOVERY_RETRY_MIGRATION ' + (safeCodes.includes(error?.code ?? error?.message) ? error.code ?? error.message : 'blocked'));
    process.exitCode = 1;
  }
}
