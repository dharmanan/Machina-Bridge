// Read-only disk preflight. No schema initialization, writer lock, providers or RPC.
import { DatabaseSync } from 'node:sqlite';
import { archiveConfig, storagePreflight } from '../server/compact/evidence-archive.js';
import { resolve } from 'node:path';
const path=process.env.COMPACT_SQLITE_PATH?.trim();
if(Number(process.versions.node.split('.')[0])!==24||!path||path===':memory:'||path.startsWith('file:'))throw new Error('node24_existing_sqlite_path_required');
const config=archiveConfig();
const db=new DatabaseSync(resolve(path),{readOnly:true});
try{
  db.exec('PRAGMA query_only=ON;BEGIN');
  const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
  const usage=tables.has('compact_evidence_archive_usage')?db.prepare('SELECT * FROM compact_evidence_archive_usage WHERE id=1').get():null;
  console.log(JSON.stringify({mode:'read_only',archiveEnabled:config.enabled,limits:config,capacity:storagePreflight(db,config),
    archiveUsage:usage,checkpoint:tables.has('compact_checkpoint')?db.prepare('SELECT * FROM compact_checkpoint WHERE id=1').get():null},null,2));
}finally{db.exec('ROLLBACK');db.close();}
