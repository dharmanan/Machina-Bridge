// One existing SQLite file, read-only evidence selection. No RPC, inferred identities, independent database or writer.
import { createHash } from 'node:crypto';
import { statfsSync, mkdtempSync, openSync, unlinkSync, rmdirSync, closeSync, writeSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { archivedIdentitySet } from './evidence-archive.js';
import { COMPACT_DEFINITION_VERSION } from './sources.js';

const HOUR=3600,DAY=86400,MiB=1024**2;
export const IDENTITY_UNION_CHUNK_ROWS=1024;
const ADDRESS_BYTES=20,READ_ROWS=128,MAX_SOURCES=1536;
export const IDENTITY_UNION_MAX_TEMP_BYTES=256*MiB;
export const IDENTITY_COMMITMENTS_SQL=`
CREATE TRIGGER IF NOT EXISTS compact_identity_commitment_no_update BEFORE UPDATE ON compact_meta
WHEN OLD.key GLOB 'identity_membership:v1:*' BEGIN SELECT RAISE(ABORT,'immutable_identity_commitment'); END;
CREATE TRIGGER IF NOT EXISTS compact_identity_commitment_no_delete BEFORE DELETE ON compact_meta
WHEN OLD.key GLOB 'identity_membership:v1:*' BEGIN SELECT RAISE(ABORT,'immutable_identity_commitment'); END;
CREATE TRIGGER IF NOT EXISTS compact_identity_commitment_no_replace BEFORE INSERT ON compact_meta
WHEN NEW.key GLOB 'identity_membership:v1:*' AND EXISTS(SELECT 1 FROM compact_meta WHERE key=NEW.key)
BEGIN SELECT RAISE(ABORT,'immutable_identity_commitment'); END;`;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export const identityMetaKey=(dataset,scope)=>`identity_membership:v1:${dataset}:${scope}`;
function binding(db,dataset,scope){
  const day=dataset==='compact_daily_address_stage';
  const rows=db.prepare(`SELECT hour_start,definition_version,network_sha256 FROM compact_hours
    WHERE hour_start>=? AND hour_start<? ORDER BY hour_start`).all(scope,scope+(day?DAY:1));
  if(rows.length!==(day?24:1)||rows.some((r,i)=>r.hour_start!==scope+i*HOUR||r.definition_version!==COMPACT_DEFINITION_VERSION
    ||!/^[0-9a-f]{64}$/.test(r.network_sha256)))fail('identity_canonical_incomplete');
  return digest(JSON.stringify(rows));
}
export function recordIdentityCommitment(db,dataset,scope){
  const column=dataset==='compact_hour_addresses'?'hour_start':dataset==='compact_daily_address_stage'?'day_start':null;
  if(!column||!db.isTransaction)fail('identity_transaction_required');
  const hash=createHash('sha256');let count=0;
  for(const row of db.prepare(`SELECT address FROM ${dataset} WHERE ${column}=? ORDER BY address`).iterate(scope)){
    if(!ArrayBuffer.isView(row.address)||row.address.byteLength!==20)fail('identity_membership_invalid');
    hash.update(row.address);count++;
  }
  const value=JSON.stringify({version:1,canonical:binding(db,dataset,scope),count,sha256:hash.digest('hex')});
  const key=identityMetaKey(dataset,scope),old=db.prepare('SELECT value FROM compact_meta WHERE key=?').get(key);
  if(old){if(old.value!==value)fail('identity_evidence_conflict');return;}
  db.prepare('INSERT OR IGNORE INTO compact_meta(key,value) VALUES(?,?)').run(key,value);
}

export function identitySource(db,dataset,scope,expected,{packed}={}){
  const column=dataset==='compact_hour_addresses'?'hour_start':dataset==='compact_daily_address_stage'?'day_start':null;
  if(!column||!Number.isSafeInteger(scope)||scope%(column==='day_start'?DAY:HOUR)!==0
    ||!Number.isSafeInteger(expected)||expected<0)fail('identity_membership_invalid');
  const hot=db.prepare(`SELECT COUNT(*) AS count FROM ${dataset} WHERE ${column}=?`).get(scope).count;
  let source,token,open;
  const pruned=packed?.isPruned(dataset,scope),status=packed?.status(dataset,scope);
  if(!pruned&&hot===expected){source='hot';token='hot';open=()=>db.prepare(`SELECT * FROM ${dataset} WHERE ${column}=? ORDER BY address`).iterate(scope);}
  else if(status?.rowCount===expected){source='packed';token=status.rowsSha256;open=()=>packed.openRows(dataset,scope);}
  else{
    const archive=archivedIdentitySet(db,dataset,scope,expected);
    if(!archive)return null;
    source='archive';token=archive.id;open=archive.openRows;
  }
  const canonical=binding(db,dataset,scope);
  const stored=db.prepare('SELECT value FROM compact_meta WHERE key=?').get(identityMetaKey(dataset,scope));
  let commitment=null;
  if(stored){
    try{commitment=JSON.parse(stored.value);}catch{fail('identity_commitment_corrupt');}
    if(commitment.version!==1||commitment.count!==expected||commitment.canonical!==canonical
      ||!/^[0-9a-f]{64}$/.test(commitment.sha256))fail('identity_commitment_corrupt');
  }
  return {dataset,scope,count:expected,source,token:token+':'+(stored?.value??'legacy'),openRows:()=> (function*(){
    const rows=open();if(!rows)fail('identity_membership_missing');
    const hash=createHash('sha256');let count=0,last=null;
    for(const row of rows){
      if(Number(row[column])!==scope||!ArrayBuffer.isView(row.address)||row.address.byteLength!==20)fail('identity_membership_invalid');
      const address=Buffer.from(row.address.buffer,row.address.byteOffset,20);
      if(last&&Buffer.compare(last,address)>=0)fail('identity_membership_invalid');
      last=Buffer.from(address);hash.update(address);count++;
      if(count>expected)fail('identity_membership_invalid');
      yield row;
    }
    if(count!==expected||(commitment&&hash.digest('hex')!==commitment.sha256))fail('identity_commitment_corrupt');
  })()};
}

// Sources are already ordered and individually verified. Spool their exact binary addresses once, then merge
// fixed-size cursors. No SQLite DISTINCT b-tree, JSON/hex spool, growing Set or retained decoded source pieces.
// The anonymous temporary file is unlinked immediately: process death closes it without leaving an orphan archive.
function unionDirectory(db){
  const path=db.prepare('PRAGMA database_list').all().find(r=>r.name==='main')?.file;
  return path?dirname(path):tmpdir(); // Persistent reads charge their scratch to the SAME volume, not a possibly memory-backed /tmp.
}
export function identityUnionCapacity(db,sources,{capacity}={}){
  if(sources.length>MAX_SOURCES||sources.some(s=>!Number.isSafeInteger(s.count)||s.count<0))fail('identity_union_storage_budget');
  const members=sources.reduce((sum,s)=>sum+s.count,0),temporaryBytes=members*ADDRESS_BYTES;
  if(!Number.isSafeInteger(members)||members<0||!Number.isSafeInteger(temporaryBytes)
    ||temporaryBytes>IDENTITY_UNION_MAX_TEMP_BYTES)fail('identity_union_storage_budget');
  const free=capacity??(()=>{
    const s=statfsSync(unionDirectory(db));return s.bavail*s.bsize;
  });
  let available;try{available=free();}catch{fail('identity_union_storage_budget');}
  if(!Number.isSafeInteger(available)||available<temporaryBytes+256*MiB)fail('identity_union_storage_budget');
  return temporaryBytes;
}

function* mergedIdentityUnion(db,sources,emitRows,options){
  const planned=identityUnionCapacity(db,sources,options);
  let fd=null,directory=null,file=null;
  const observe=options.onProgress??(()=>{});
  try{
    directory=mkdtempSync(join(unionDirectory(db),'machina-identity-union-'));
    file=join(directory,'members.bin');fd=openSync(file,'wx+',0o600);
    unlinkSync(file);file=null;rmdirSync(directory);directory=null;
    const scratch=Buffer.allocUnsafe(IDENTITY_UNION_CHUNK_ROWS*ADDRESS_BYTES),runs=[];
    let offset=0;
    for(const source of sources){
      const start=offset,hash=createHash('sha256');let used=0,count=0;
      const flush=()=>{
        if(!used)return;
        if(offset+used>planned)fail('identity_membership_invalid');
        hash.update(scratch.subarray(0,used));let written=0;
        while(written<used){const n=writeSync(fd,scratch,written,used-written,offset+written);if(n<=0)fail('identity_union_io');written+=n;}
        offset+=used;used=0;
      };
      // Do not publish even the first union row until EVERY source reaches its verified end.
      for(const row of source.openRows()){
        const address=row.address;if(!ArrayBuffer.isView(address)||address.byteLength!==ADDRESS_BYTES||++count>source.count)fail('identity_membership_invalid');
        scratch.set(address,used);used+=ADDRESS_BYTES;if(used===scratch.length)flush();
      }
      flush();if(count!==source.count)fail('identity_membership_invalid');
      runs.push({start,bytes:offset-start,sha256:hash.digest('hex')});
      observe({phase:'verify',members:count,temporaryBytes:offset});
    }
    if(offset!==planned)fail('identity_membership_invalid');
    observe({phase:'verified',temporaryBytes:offset});
    const heap=[],last=Buffer.alloc(ADDRESS_BYTES);
    const compare=(a,b)=>a.buffer.compare(b.buffer,b.position,b.position+ADDRESS_BYTES,a.position,a.position+ADDRESS_BYTES);
    function refill(cursor){
      if(cursor.remaining===0){if(cursor.hash.digest('hex')!==cursor.sha256)fail('identity_union_spool_corrupt');return false;}
      const bytes=Math.min(cursor.buffer.length,cursor.remaining);let n=0;
      while(n<bytes){const got=readSync(fd,cursor.buffer,n,bytes-n,cursor.offset+n);if(got<=0)fail('identity_union_spool_corrupt');n+=got;}
      cursor.hash.update(cursor.buffer.subarray(0,n));cursor.offset+=n;cursor.remaining-=n;cursor.position=0;cursor.length=n;return true;
    }
    for(const run of runs){
      const cursor={buffer:Buffer.allocUnsafe(READ_ROWS*ADDRESS_BYTES),position:0,length:0,remaining:run.bytes,offset:run.start,
        hash:createHash('sha256'),sha256:run.sha256};
      if(!refill(cursor))continue;
      let i=heap.length;heap.push(cursor);
      while(i>0){const parent=(i-1)>>1;if(compare(heap[parent],cursor)<=0)break;heap[i]=heap[parent];i=parent;}heap[i]=cursor;
    }
    let count=0,seen=0;
    while(heap.length){
      const cursor=heap[0];
      if(count===0||cursor.buffer.compare(last,0,ADDRESS_BYTES,cursor.position,cursor.position+ADDRESS_BYTES)!==0){
        cursor.buffer.copy(last,0,cursor.position,cursor.position+ADDRESS_BYTES);count++;
        if(emitRows)yield last.toString('hex');
      }
      cursor.position+=ADDRESS_BYTES;
      const next=cursor.position<cursor.length||refill(cursor)?cursor:heap.pop();
      if(heap.length){
        let i=0;
        while(2*i+1<heap.length){let child=2*i+1;if(child+1<heap.length&&compare(heap[child+1],heap[child])<0)child++;
          if(compare(next,heap[child])<=0)break;heap[i]=heap[child];i=child;}
        heap[i]=next;
      }
      if(++seen%16384===0)observe({phase:'merge',members:seen,temporaryBytes:offset});
    }
    observe({phase:'complete',members:seen,unique:count,temporaryBytes:offset});
    return count;
  }catch(error){
    if(['ENOSPC','EDQUOT','ENOMEM','EMFILE','ENFILE','EACCES','EROFS','EIO','ENOENT'].includes(error.code))fail('identity_union_storage_budget');
    throw error;
  }finally{
    if(fd!==null)closeSync(fd);
    if(file!==null)try{unlinkSync(file);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(directory!==null)try{rmdirSync(directory);}catch(e){if(e.code!=='ENOENT')throw e;}
  }
}
export function identityUnionRows(db,sources,options={}){identityUnionCapacity(db,sources,options);return mergedIdentityUnion(db,sources,true,options);}
export const identityUnionCount=(db,sources,options={})=>mergedIdentityUnion(db,sources,false,options).next().value;

// Caller owns a savepoint/transaction. Add-only repair, independently checked against EVERY canonical hour;
// conflicting existing memberships are retained and reported, never silently overwritten.
export function populateDailyFromHours(db,dayStart,{packed}={}){
  const hours=db.prepare('SELECT hour_start,unique_active_addresses FROM compact_hours WHERE hour_start>=? AND hour_start<? ORDER BY hour_start').all(dayStart,dayStart+DAY);
  if(hours.length!==24||hours.some((h,i)=>h.hour_start!==dayStart+i*HOUR))fail('identity_canonical_incomplete');
  const sources=hours.map(h=>identitySource(db,'compact_hour_addresses',h.hour_start,h.unique_active_addresses,{packed}));
  if(sources.some(s=>!s))fail('identity_membership_missing');
  const oldCount=db.prepare('SELECT COUNT(*) AS n FROM compact_daily_address_stage WHERE day_start=?').get(dayStart).n;
  const existing=db.prepare('SELECT 1 FROM compact_daily_address_stage WHERE day_start=? AND address=?');
  const insert=db.prepare('INSERT OR IGNORE INTO compact_daily_address_stage VALUES(?,?)');let count=0,matched=0;
  for(const address of identityUnionRows(db,sources)){
    const value=Buffer.from(address,'hex');if(existing.get(dayStart,value))matched++;insert.run(dayStart,value);count++;
  }
  if(matched!==oldCount)fail('identity_daily_membership_conflict');
  for(const h of hours)db.prepare('INSERT OR IGNORE INTO compact_daily_address_hours VALUES(?,?)').run(dayStart,h.hour_start);
  return count;
}
