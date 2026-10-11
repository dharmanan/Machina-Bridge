// Isolated read model. Does not replace or import into production APIs.
// Exact window membership is computed with bounded SQLite temp tables, never a JS window-sized set.
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openSync, closeSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { assertHeapBudget, fail } from './storage.js';
import { decodeIds } from './network-hour-store.js';

export function readNetworkWindow(p,{hours,endHour,sourceKey,registryDigest,onProgress=()=>{}}={}){
  assertHeapBudget();
  if(![24,168,720].includes(hours)||!Number.isSafeInteger(endHour)||endHour%3600!==0
    ||!/^[0-9a-f]{64}$/.test(sourceKey??'')||!/^[0-9a-f]{64}$/.test(registryDigest??''))fail('window_definition_invalid');
  const start=endHour-hours*3600,rows=p.db.prepare('SELECT unit_id,hour_start FROM arc_pipeline_units WHERE source_key=? AND registry_digest=? AND hour_start>=? AND hour_start<? ORDER BY hour_start,unit_id').all(sourceKey,registryDigest,start,endHour);
  if(rows.length>hours)fail('window_canonical_conflict');
  const scratch=join(p.directory,'.window-'+randomUUID()+'.sqlite'),days=new Map(),issues=[];
  let verified=0,blocks=0,transactions=0,gas=0n,attempts=0,first=null,last=null,previous=null;
  p.guard(65536);const fd=openSync(scratch,'wx',0o600);closeSync(fd);const work=new DatabaseSync(scratch);
  try{
    work.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-2048; CREATE TABLE membership(day INTEGER NOT NULL,address_id INTEGER NOT NULL,PRIMARY KEY(day,address_id)) WITHOUT ROWID; CREATE INDEX membership_id ON membership(address_id)');
    const add=work.prepare('INSERT OR IGNORE INTO membership VALUES(?,?)');
    for(const row of rows){
      let seal;try{seal=p.getSeal(row.unit_id);}catch(e){issues.push({hour:row.hour_start,reason:e.code??'evidence_invalid'});continue;}
      if(!seal){issues.push({hour:row.hour_start,reason:'hour_not_sealed'});continue;}
      const s=seal.summary;if(s.format!=='arc-network-hour-v1')fail('window_source_invalid');
      if(previous?.hour===row.hour_start)fail('window_canonical_conflict');
      if(previous?.hour+3600===row.hour_start&&(previous.lastHash!==s.range.parentHash||previous.lastBlock+1!==s.range.firstBlock))fail('window_canonical_discontinuity');
      previous={hour:row.hour_start,lastHash:s.range.lastHash,lastBlock:s.range.lastBlock};
      const day=Math.floor(row.hour_start/86400)*86400,d=days.get(day)??{day,hours:0,blocks:0,transactions:0,gas:0n};
      d.hours++;d.blocks+=s.network.blockCount;d.transactions+=s.network.transactionCount;d.gas+=BigInt(s.network.gasUsedRaw);days.set(day,d);
      // The seal's source-specific verifier has already checked every dictionary member and its checksum.
      p.guard((s.network.uniqueSenders+s.network.uniqueRecipients)*80+65536);
      work.exec('BEGIN IMMEDIATE');try{
        for(const packed of [s.senderIds,s.recipientIds])for(const id of decodeIds(packed))add.run(day,id);
        p.guard(0);work.exec('COMMIT');p.guard(0);
      }catch(e){if(work.isTransaction)work.exec('ROLLBACK');throw e;}
      verified++;blocks+=s.network.blockCount;transactions+=s.network.transactionCount;gas+=BigInt(s.network.gasUsedRaw);attempts+=s.network.internal.deploymentAttempts;
      first??=row.hour_start;last=row.hour_start;onProgress();
    }
    if(!Number.isSafeInteger(transactions)||!Number.isSafeInteger(blocks))fail('window_integer_overflow');
    const distinct=work.prepare('SELECT COUNT(DISTINCT address_id) n FROM membership').get().n;
    const complete=verified===hours,canDisplay=verified>0&&(complete||hours===720);
    const totals=canDisplay?{blockCount:blocks,transactionCount:transactions,gasUsedRaw:gas.toString(),uniqueActiveAddresses:distinct,deploymentAttempts:attempts,transactionsPerSecond:transactions/(verified*3600)}:null;
    const buckets=[];
    for(let day=Math.floor(start/86400)*86400;day<endHour;day+=86400){const d=days.get(day),full=day>=start&&day+86400<=endHour&&d?.hours===24;
      buckets.push({startUtc:new Date(day*1000).toISOString(),endUtc:new Date((day+86400)*1000).toISOString(),verifiedHours:d?.hours??0,requiredHours:24,status:full?'available':'incomplete',reason:full?null:'incomplete_utc_day',values:full?{blockCount:d.blocks,transactionCount:d.transactions,gasUsedRaw:d.gas.toString(),uniqueActiveAddresses:work.prepare('SELECT COUNT(*) n FROM membership WHERE day=?').get(day).n}:null});
    }
    return {scope:'isolated_network_read_model',selectedHours:hours,status:complete?'available':verified?'partial':'unavailable',reason:complete?null:verified?'partial_verified_history':'verified_history_missing',coverage:{verifiedHours:verified,requiredHours:hours,missingHours:hours-verified,selectedStartUtc:new Date(start*1000).toISOString(),selectedEndUtc:new Date(endHour*1000).toISOString(),firstVerifiedUtc:first===null?null:new Date(first*1000).toISOString(),lastVerifiedEndUtc:last===null?null:new Date((last+3600)*1000).toISOString()},totals,daily:buckets,issues};
  }finally{work.close();for(const path of [scratch,scratch+'-journal'])if(existsSync(path))unlinkSync(path);}
}
