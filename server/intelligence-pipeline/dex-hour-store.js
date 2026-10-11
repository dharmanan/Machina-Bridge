// Opt-in independent lab only. Permanent hourly DEX inputs, not raw logs or transaction bodies.
// Preserves per-action raw values, first OBSERVED proofs and latest pool states; never supplies USD/identity proof.
import { gzipSync,gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { hash,json,fail,readDefinition } from './storage.js';
import { unpackAddresses } from './network-reducer.js';
import { decodeIds } from './network-hour-store.js';
import { encodeEvidence,decodeEvidence } from './binary-evidence.js';
import { createStableSymbols, stableSymbolReader, stableDexIdentifiers, STABLE_SYMBOL_CODEC } from './evidence-symbols.js';
const MAX_SHARD=1024*1024, ROWS=128;
const COUNTS=['swapCount','mintCount','burnCount','initializeCount','liquidityIncreaseCount','liquidityDecreaseCount','liquidityPokeCount'];
const AMOUNTS=['swapAmount0AbsRaw','swapAmount1AbsRaw','mintAmount0Raw','mintAmount1Raw','burnAmount0Raw','burnAmount1Raw'];
const SQL=`CREATE TABLE IF NOT EXISTS arc_pipeline_addresses(id INTEGER PRIMARY KEY,address BLOB NOT NULL UNIQUE CHECK(length(address)=20)) STRICT;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_address_immutable BEFORE UPDATE ON arc_pipeline_addresses BEGIN SELECT RAISE(ABORT,'verified_address_immutable'); END;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_address_no_delete BEFORE DELETE ON arc_pipeline_addresses BEGIN SELECT RAISE(ABORT,'verified_address_immutable'); END;
CREATE TABLE IF NOT EXISTS arc_pipeline_dex_shards(sha TEXT PRIMARY KEY,payload_gzip BLOB NOT NULL,plain_bytes INTEGER NOT NULL CHECK(plain_bytes<=1048576)) STRICT;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_dex_shard_immutable BEFORE UPDATE ON arc_pipeline_dex_shards BEGIN SELECT RAISE(ABORT,'verified_dex_shard_immutable'); END;
CREATE TABLE IF NOT EXISTS arc_pipeline_dex_pool_stage(unit_id TEXT NOT NULL,pool TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(unit_id,pool)) STRICT,WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS arc_pipeline_dex_member_stage(unit_id TEXT NOT NULL,kind TEXT NOT NULL,address_id INTEGER NOT NULL REFERENCES arc_pipeline_addresses,PRIMARY KEY(unit_id,kind,address_id)) STRICT,WITHOUT ROWID;`;
function before(a,b){return a.blockNumber<b.blockNumber||a.blockNumber===b.blockNumber&&(a.transactionIndex<b.transactionIndex||a.transactionIndex===b.transactionIndex&&a.logIndex<b.logIndex);}
export function mergeDexPool(a,b){
 const allowed=['kind','protocol','pool',...COUNTS,...AMOUNTS,'observedSwap','observedLiquidity','latestPoolState','tokenIdentityStatus','valuationStatus','initializedPool'];
 if(Object.keys(b).some(k=>!allowed.includes(k)))fail('dex_unknown_field_requires_definition');
 if(!a)return structuredClone(b);
 if(a.pool!==b.pool||a.protocol!==b.protocol||a.kind!=='dex_pool_range'||b.kind!==a.kind||a.tokenIdentityStatus!==b.tokenIdentityStatus||a.valuationStatus!==b.valuationStatus)fail('dex_pool_conflict');
 const out={...a};for(const k of COUNTS){out[k]=a[k]+b[k];if(!Number.isSafeInteger(out[k])||a[k]<0||b[k]<0)fail('dex_count_invalid');}for(const k of AMOUNTS)out[k]=(BigInt(a[k])+BigInt(b[k])).toString();
 for(const k of ['observedSwap','observedLiquidity'])if(b[k]&&(!a[k]||before(b[k],a[k])))out[k]=b[k];
 if(b.latestPoolState&&(!a.latestPoolState||before(a.latestPoolState,b.latestPoolState)))out.latestPoolState=b.latestPoolState;
 if(b.initializedPool){if(a.initializedPool&&json(a.initializedPool)!==json(b.initializedPool))fail('dex_initialization_conflict');out.initializedPool=b.initializedPool;}
 return out;
}
// Shard schemas eliminate repeated JSON field names, preserving absent fields separately from nulls.
function encodeRows(rows){const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))];return {keys,values:rows.map(r=>keys.map(k=>Object.hasOwn(r,k)?[r[k]]:[]))};}
function decodeRows(encoded){if(!Array.isArray(encoded?.keys)||new Set(encoded.keys).size!==encoded.keys.length||!Array.isArray(encoded.values)||encoded.values.length>ROWS)fail('dex_shard_corrupt');return encoded.values.map(v=>{if(!Array.isArray(v)||v.length!==encoded.keys.length)fail('dex_shard_corrupt');const out={};v.forEach((x,i)=>{if(!Array.isArray(x)||x.length>1)fail('dex_shard_corrupt');if(x.length)out[encoded.keys[i]]=x[0];});return out;});}
function readObject(db,sha,dictionary){const r=db.prepare('SELECT plain_bytes,CASE WHEN length(payload_gzip)<=1048576 THEN payload_gzip END payload_gzip FROM arc_pipeline_dex_shards WHERE sha=?').get(sha);if(!r||r.plain_bytes>MAX_SHARD)fail('dex_shard_missing_or_corrupt');let raw;try{raw=gunzipSync(r.payload_gzip,{maxOutputLength:MAX_SHARD});}catch{fail('dex_shard_missing_or_corrupt');}if(raw.length!==r.plain_bytes||hash(raw)!==sha)fail('dex_shard_missing_or_corrupt');try{return decodeEvidence(raw,{dictionary,resolveStableSymbol:db.prepare("SELECT 1 FROM sqlite_schema WHERE name='arc_pipeline_stable_symbols'").get()?stableSymbolReader(db):undefined});}catch{fail('dex_shard_missing_or_corrupt');}}
function readShard(db,sha,dictionary){return decodeRows(readObject(db,sha,dictionary));}
function symbols(db,seal){const out=[];for(const sha of seal.summary.symbols){const values=readObject(db,sha);if(!Array.isArray(values)||values.length>512||values.some(v=>typeof v!=='string'||!/^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v)))fail('dex_symbols_corrupt');out.push(...values);if(out.length>100000)fail('dex_symbols_budget');}if(new Set(out).size!==out.length)fail('dex_symbols_corrupt');return out;}
function* addresses(db,text){const get=db.prepare('SELECT address FROM arc_pipeline_addresses WHERE id=?');for(const id of decodeIds(text)){const r=get.get(id);if(!r||r.address.length!==20)fail('verified_address_missing');yield Buffer.from(r.address);}}
function members(db,text){const sha=createHash('sha256');let count=0;for(const a of addresses(db,text)){sha.update(a);count++;}return {count,sha:sha.digest('hex')};}
function encodeIds(ids){let previous=0;const bytes=[];for(const id of ids){let gap=id-previous;if(!Number.isSafeInteger(gap)||gap<=0)fail('membership_id_invalid');while(gap>=128){bytes.push(gap%128+128);gap=Math.floor(gap/128);}bytes.push(gap);previous=id;}return Buffer.from(bytes).toString('base64');}
export function verifyDexSeal(db,seal,u){
 const s=seal.summary;if(s?.format!=='arc-dex-hour-v1'||s.codec!==undefined&&s.codec!==STABLE_SYMBOL_CODEC||s.sourceKey!==u.source_key||s.anchorHash!==u.anchor_hash||s.hourStart!==u.hour_start||!Array.isArray(s.symbols)||s.symbols.length>196||!Array.isArray(s.shards)||s.shards.length>4096||new Set(s.shards).size!==s.shards.length)fail('dex_seal_invalid');
 const trader=members(db,s.traderIds),foreign=members(db,s.foreignIds);if(trader.count!==s.counts.uniqueTraders||trader.sha!==s.traderSha||foreign.count!==s.counts.foreignEmitters||foreign.sha!==s.foreignSha)fail('dex_membership_corrupt');
 const dictionary=symbols(db,seal);let previous='',total=0,pools=0;const counts=Object.fromEntries(COUNTS.map(k=>[k,0]));const digest=createHash('sha256');
 for(const sha of s.shards)for(const r of readShard(db,sha,dictionary)){
  if(r.kind!=='dex_pool_range'||r.protocol!==s.protocol||r.pool<=previous||!/^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(r.pool)||r.tokenIdentityStatus!=='not_checked'||r.valuationStatus!=='not_checked')fail('dex_pool_invalid');previous=r.pool;pools++;
  for(const k of COUNTS){if(!Number.isSafeInteger(r[k])||r[k]<0)fail('dex_count_invalid');counts[k]+=r[k];total+=r[k];}for(const k of AMOUNTS)if(!/^[0-9]+$/.test(r[k]))fail('dex_amount_invalid');
  for(const k of ['observedSwap','observedLiquidity','latestPoolState'])if(r[k]&&(r[k].firstProven!==false||r[k].sourceKey!==u.source_key||r[k].blockNumber<u.first_block||r[k].blockNumber>u.last_block||!/^0x[0-9a-f]{64}$/.test(r[k].blockHash)||!/^0x[0-9a-f]{64}$/.test(r[k].transactionHash)||!/^0x[0-9a-f]{40}$/.test(r[k].emitter)||!Number.isSafeInteger(r[k].transactionIndex)||r[k].transactionIndex<0||!Number.isSafeInteger(r[k].logIndex)||r[k].logIndex<0||!Number.isSafeInteger(r[k].timestamp)||r[k].timestamp<u.hour_start||r[k].timestamp>=u.hour_start+3600))fail('dex_proof_invalid');
  digest.update(json(r)+'\n');
 }
 const received=seal.segments.reduce((n,x)=>n+x.counts.receivedEvents,0),accepted=seal.segments.reduce((n,x)=>n+x.counts.acceptedEvents,0),foreignEvents=seal.segments.reduce((n,x)=>n+x.counts.foreignEvents,0);
 if(pools!==s.poolCount||digest.digest('hex')!==s.poolSha||total!==accepted||s.counts.acceptedEvents!==accepted||s.counts.receivedEvents!==received||s.counts.foreignEvents!==foreignEvents||received!==accepted+foreignEvents||json(counts)!==json(s.actionCounts))fail('dex_hour_counts_conflict');
}
export function* readDexSealSummaries(db,seal){
 const s=seal.summary,dictionary=symbols(db,seal);
 yield {counts:s.counts,rows:[{kind:'dex_range_membership',traderMembership:Buffer.concat([...addresses(db,s.traderIds)].sort(Buffer.compare)).toString('base64'),foreignEmitters:[...addresses(db,s.foreignIds)].sort(Buffer.compare).map(a=>'0x'+a.toString('hex'))}]};
 for(const sha of s.shards)yield {counts:{receivedEvents:0,acceptedEvents:0,foreignEvents:0,foreignEmitters:0,uniqueTraders:0},rows:[{kind:'dex_range_membership',traderMembership:'',foreignEmitters:[]},...readShard(db,sha,dictionary)]};
}
export function createDexHourStore(p,{sharedSymbols=false}={}){
 p.transaction(()=>p.db.exec(SQL));
 const stable = sharedSymbols ? p.transaction(()=>createStableSymbols(p.db)) : null;
 function publish(unitId,{beforeCommit,afterCommit}={}){
  const already=p.getSeal(unitId);if(already)return already;if(p.coverage(unitId).status!=='complete')fail('partial_cannot_publish');
  const u=p.db.prepare('SELECT * FROM arc_pipeline_units WHERE unit_id=?').get(unitId);
  // Reject non-DEX inputs and unarchived facts. Factory proofs are retained separately.
  if(p.db.prepare('SELECT 1 FROM arc_pipeline_fact_rows WHERE unit_id=? LIMIT 1').get(unitId))fail('unsealed_fact_evidence');
  const stats=p.db.prepare('SELECT sum(plain_bytes) bytes FROM arc_pipeline_results WHERE result_sha IN(SELECT result_sha FROM arc_pipeline_jobs WHERE unit_id=?)').get(unitId);
  const seal=p.transaction(()=>{
   const insert=p.db.prepare('INSERT OR IGNORE INTO arc_pipeline_addresses(address) VALUES(?)'),lookup=p.db.prepare('SELECT id FROM arc_pipeline_addresses WHERE address=?'),member=p.db.prepare('INSERT OR IGNORE INTO arc_pipeline_dex_member_stage VALUES(?,?,?)');
   const upsert=p.db.prepare('INSERT INTO arc_pipeline_dex_pool_stage VALUES(?,?,?) ON CONFLICT(unit_id,pool) DO UPDATE SET payload_json=excluded.payload_json'),get=p.db.prepare('SELECT payload_json FROM arc_pipeline_dex_pool_stage WHERE unit_id=? AND pool=?');
   p.db.prepare('DELETE FROM arc_pipeline_dex_pool_stage WHERE unit_id=?').run(unitId);p.db.prepare('DELETE FROM arc_pipeline_dex_member_stage WHERE unit_id=?').run(unitId);
   const segments=[],counts={receivedEvents:0,acceptedEvents:0,foreignEvents:0,foreignEmitters:0,uniqueTraders:0};let protocol;
   for(const j of p.db.prepare("SELECT * FROM arc_pipeline_jobs WHERE unit_id=? AND state='complete' ORDER BY first_block").iterate(unitId)){
    const s=p.getResult(j.result_sha),m=s.rows[0];if(m?.kind!=='dex_range_membership'||s.status!=='verified')fail('dex_summary_invalid');
    segments.push({first:j.first_block,last:j.last_block,resultSha:j.expected_sha,inputSha256:s.inputSha256,status:s.status,counts:s.counts});
    for(const k of ['receivedEvents','acceptedEvents','foreignEvents'])counts[k]+=s.counts[k];
    for(const [kind,values]of [['trader',unpackAddresses(m.traderMembership)],['foreign',m.foreignEmitters]])for(const a of values){const b=Buffer.from(a.slice(2),'hex');if(b.length!==20)fail('dex_member_invalid');insert.run(b);member.run(unitId,kind,lookup.get(b).id);}
    for(const r of s.rows.slice(1)){protocol??=r.protocol;if(r.protocol!==protocol)fail('dex_protocol_conflict');const old=get.get(unitId,r.pool);upsert.run(unitId,r.pool,json(mergeDexPool(old?JSON.parse(old.payload_json):null,r)));}
   }
   protocol??=JSON.parse(readDefinition(u.unit_json)).source.id.includes('v3')?'uniswap_v3':'uniswap_v4';
   const ids=kind=>(function*(){for(const r of p.db.prepare('SELECT address_id FROM arc_pipeline_dex_member_stage WHERE unit_id=? AND kind=? ORDER BY address_id').iterate(unitId,kind))yield r.address_id;})();
   const traderIds=encodeIds(ids('trader')),foreignIds=encodeIds(ids('foreign')),t=members(p.db,traderIds),f=members(p.db,foreignIds);counts.uniqueTraders=t.count;counts.foreignEmitters=f.count;
   const stableMap=new Map(),dictSet=new Set();const collect=v=>{if(typeof v==='string'&&/^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v)){if(!stableMap.has(v))dictSet.add(v);if(dictSet.size>100000)fail('dex_symbols_budget');}else if(v&&typeof v==='object')for(const x of Object.values(v))collect(x);};
   if(stable)for(const r of p.db.prepare('SELECT payload_json FROM arc_pipeline_dex_pool_stage WHERE unit_id=? ORDER BY pool').iterate(unitId))for(const value of stableDexIdentifiers(JSON.parse(r.payload_json))){if(!stableMap.has(value))stableMap.set(value,stable.intern(value));if(stableMap.size>100000)fail('dex_symbols_budget');}
   for(const r of p.db.prepare('SELECT payload_json FROM arc_pipeline_dex_pool_stage WHERE unit_id=? ORDER BY pool').iterate(unitId))collect(JSON.parse(r.payload_json));
   const dict=[...dictSet].sort(),dictionary=new Map(dict.map((v,i)=>[v,i])),symbolShards=[];
   for(let i=0;i<dict.length;i+=512){const raw=encodeEvidence(dict.slice(i,i+512)),sha=hash(raw);p.db.prepare('INSERT OR IGNORE INTO arc_pipeline_dex_shards VALUES(?,?,?)').run(sha,gzipSync(raw,{level:9}),raw.length);symbolShards.push(sha);}
   const shards=[],digest=createHash('sha256'),actionCounts=Object.fromEntries(COUNTS.map(k=>[k,0]));let rows=[],poolCount=0;
   const flush=()=>{if(!rows.length)return;const raw=encodeEvidence(encodeRows(rows),{dictionary,stableSymbols:stableMap,compactIntegers:!!stable});if(raw.length>MAX_SHARD)fail('dex_shard_budget');const sha=hash(raw);p.db.prepare('INSERT OR IGNORE INTO arc_pipeline_dex_shards VALUES(?,?,?)').run(sha,gzipSync(raw,{level:9}),raw.length);readShard(p.db,sha,dict);shards.push(sha);rows=[];};
   for(const r of p.db.prepare('SELECT payload_json FROM arc_pipeline_dex_pool_stage WHERE unit_id=? ORDER BY pool').iterate(unitId)){
    const row=JSON.parse(r.payload_json);digest.update(json(row)+'\n');poolCount++;for(const k of COUNTS)actionCounts[k]+=row[k];rows.push(row);if(rows.length===ROWS)flush();
   }flush();
   const summary={format:'arc-dex-hour-v1',sourceKey:u.source_key,anchorHash:u.anchor_hash,hourStart:u.hour_start,protocol,counts,actionCounts,poolCount,poolSha:digest.digest('hex'),traderIds,foreignIds,traderSha:t.sha,foreignSha:f.sha,symbols:symbolShards,shards,...(stable?{codec:STABLE_SYMBOL_CODEC}:{})};
   const seal={format:'arc-unit-seal-v1',sourceKey:u.source_key,anchorHash:u.anchor_hash,first:u.first_block,last:u.last_block,segments,summary};verifyDexSeal(p.db,seal,u);
   const raw=Buffer.from(json(seal));if(raw.length>8*1024*1024)fail('unit_seal_too_large');p.db.prepare('INSERT INTO arc_pipeline_seals VALUES(?,?,?,?)').run(unitId,hash(raw),gzipSync(raw,{level:9}),raw.length);p.getSeal(unitId);beforeCommit?.();return seal;
  },Math.max(65536,stats.bytes));afterCommit?.();return seal;
 }
 function compact(unitId,{beforeCommit}={}){
  if(p.getSeal(unitId)?.summary.format!=='arc-dex-hour-v1')fail('committed_dex_seal_required');
  return p.transaction(()=>{p.getSeal(unitId);const shas=p.db.prepare('SELECT DISTINCT result_sha FROM arc_pipeline_jobs WHERE unit_id=? AND result_sha IS NOT NULL').all(unitId);p.db.prepare("UPDATE arc_pipeline_jobs SET result_sha=NULL WHERE unit_id=? AND state='complete'").run(unitId);let deleted=0;const del=p.db.prepare('DELETE FROM arc_pipeline_results WHERE result_sha=? AND NOT EXISTS(SELECT 1 FROM arc_pipeline_jobs WHERE result_sha=?)');for(const r of shas)deleted+=del.run(r.result_sha,r.result_sha).changes;p.db.prepare('DELETE FROM arc_pipeline_dex_pool_stage WHERE unit_id=?').run(unitId);p.db.prepare('DELETE FROM arc_pipeline_dex_member_stage WHERE unit_id=?').run(unitId);p.getSeal(unitId);beforeCommit?.();return {removedTransientPieces:deleted};});
 }
 return {publish,compact};
}
// Narrow repair from an independently trusted, checksummed backup. No RPC, other hours unchanged.
export function restoreDexShard(p,{unitId,sha},archiveDb){
 // Authenticate the expected shard digest using an intact local seal, even when its shard is missing.
 const rseal=p.db.prepare('SELECT * FROM arc_pipeline_seals WHERE unit_id=?').get(unitId),u=p.db.prepare('SELECT * FROM arc_pipeline_units WHERE unit_id=?').get(unitId);
 if(!rseal||!u)fail('trusted_seal_required');const raw=gunzipSync(rseal.payload_gzip,{maxOutputLength:8*1024*1024});if(hash(raw)!==rseal.seal_sha||raw.length!==rseal.plain_bytes)fail('unit_seal_corrupt');const s=JSON.parse(raw);
 if(s.sourceKey!==u.source_key||s.anchorHash!==u.anchor_hash||s.first!==u.first_block||s.last!==u.last_block||s.summary.format!=='arc-dex-hour-v1'||![...s.summary.shards,...s.summary.symbols].includes(sha))fail('trusted_seal_required');
 try{readObject(p.db,sha,s.summary.symbols.includes(sha)?undefined:symbols(p.db,s));return {alreadyVerified:true};}catch{}
 readObject(archiveDb,sha,s.summary.symbols.includes(sha)?undefined:symbols(archiveDb,s));const r=archiveDb.prepare('SELECT * FROM arc_pipeline_dex_shards WHERE sha=?').get(sha);
 // Caller must authenticate the backup manifest; an arbitrary archive is not a trust root.
 return p.transaction(()=>{p.db.prepare('DELETE FROM arc_pipeline_dex_shards WHERE sha=?').run(sha);p.db.prepare('INSERT INTO arc_pipeline_dex_shards VALUES(?,?,?)').run(sha,r.payload_gzip,r.plain_bytes);readObject(p.db,sha,s.summary.symbols.includes(sha)?undefined:symbols(p.db,s));},r.payload_gzip.length);
}
