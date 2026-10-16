// Default: indexed read-only inventory of ONE UTC day. --execute requires operator approval and never performs RPC.
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCompactStore } from '../server/compact/store.js';
import { createPackedShards } from '../server/compact/packed-shards.js';
import { identitySource } from '../server/compact/identity-evidence.js';
import { acquireWriterLock } from '../server/compact/writer-lock.js';

export function inventoryDay(db,dayStart){
  const packed=createPackedShards(db,{config:{enabled:false}});
  const canonical=db.prepare('SELECT hour_start,first_block,last_block,transaction_count,unique_active_addresses FROM compact_hours WHERE hour_start>=? AND hour_start<? ORDER BY hour_start').all(dayStart,dayStart+86400);
  const hours=canonical.map(h=>{
    try{const source=identitySource(db,'compact_hour_addresses',h.hour_start,h.unique_active_addresses,{packed});
      const blocks=h.last_block-h.first_block+1;
      return {hour:new Date(h.hour_start*1000).toISOString(),blocks,transactions:h.transaction_count,
        expectedAddresses:h.unique_active_addresses,source:source?.source??'missing',payloadVerified:false,
        membershipRawBytes:h.unique_active_addresses*20,
        rpcEstimateIfNoOtherEvidence:{calls:blocks+2,httpRequestsAtExistingBatch50:Math.ceil(blocks/50)+2,
          minimumPacingSecondsAt1Hz:Math.ceil(blocks/50)+1,responseBytes:null,note:'Existing exact-hour DAU path; excludes retries/latency. Not authorization or proof of RPC-budget feasibility.'}};
    }catch(e){return {hour:new Date(h.hour_start*1000).toISOString(),source:'invalid',reason:e.code??'identity_unverified',payloadVerified:false};}
  });
  return {day:new Date(dayStart*1000).toISOString(),canonicalHours:canonical.length,requiredCanonicalHours:24,hours,
    rpcExecuted:false,note:'Metadata candidates only: execution streams and verifies every selected byte before committing.'};
}
async function main(){
  const args=process.argv.slice(2),execute=args.includes('--execute'),text=args.find(a=>!a.startsWith('--'));
  if(args.some(a=>a!==text&&a!=='--execute')||!/^\d{4}-\d{2}-\d{2}$/.test(text??''))throw Error('usage: repair-compact-daily-identity.mjs YYYY-MM-DD [--execute]');
  const dayStart=Date.parse(text+'T00:00:00Z')/1000;
  if(!Number.isSafeInteger(dayStart)||new Date(dayStart*1000).toISOString().slice(0,10)!==text)throw Error('invalid_dau_day');
  const raw=process.env.COMPACT_SQLITE_PATH;
  if(!raw||raw===':memory:'||raw.startsWith('file:'))throw Error('sqlite_path_required');
  const path=resolve(raw);let db,lock;
  try{
    if(!execute){
      db=new DatabaseSync(path,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN');
      const result=inventoryDay(db,dayStart);db.exec('COMMIT');console.log(JSON.stringify(result));return;
    }
    lock=acquireWriterLock(path,{owner:'repair-compact-daily-identity'});db=new DatabaseSync(path);
    const store=createCompactStore(db),before=store.checkpoint(),result=store.repairDailyIdentity(dayStart);
    if(JSON.stringify(store.checkpoint())!==JSON.stringify(before))throw Error('identity_checkpoint_changed');
    console.log(JSON.stringify({...result,checkpointUnchanged:true,rpcExecuted:false}));
  }finally{db?.close();lock?.release();}
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href)main().catch(e=>{console.error(e.code??e.message);process.exitCode=1;});
