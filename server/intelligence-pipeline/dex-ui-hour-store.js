// Final accepted UI results, with the same bounded lossless codec as the existing evidence store.
// RPC piece bodies expire only after their complete, exact hourly result independently verifies.
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {encodeEvidence,decodeEvidence} from './binary-evidence.js';
import {createStableSymbols,stableSymbolReader} from './evidence-symbols.js';
import {hash,json,fail,readDefinition} from './storage.js';
import {canonicalJson,validPoolRow,validPricePathRow,validSwapFeeRow,validActivityRow,validV4Record,ACTIVITY_ROWS_PER_KIND,ACTIVITY_KINDS,PROJECTION_VERSIONS} from '../compact/projections.js';
import {LOG_STREAMS} from '../compact/sources.js';
import {deriveDexUiProjections} from './dex-projection-source.js';
const SQL=`CREATE TABLE IF NOT EXISTS arc_pipeline_ui_shards(sha TEXT PRIMARY KEY,payload BLOB NOT NULL,plain_bytes INTEGER NOT NULL CHECK(plain_bytes<=1048576)) STRICT,WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_ui_shard_immutable BEFORE UPDATE ON arc_pipeline_ui_shards BEGIN SELECT RAISE(ABORT,'ui_shard_immutable'); END;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_ui_shard_no_delete BEFORE DELETE ON arc_pipeline_ui_shards BEGIN SELECT RAISE(ABORT,'ui_shard_immutable'); END;`;
const hex=/^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
function object(db,sha,dictionary){
 const row=db.prepare('SELECT plain_bytes,CASE WHEN length(payload)<=1048576 THEN payload END payload FROM arc_pipeline_ui_shards WHERE sha=?').get(sha);if(!row||row.plain_bytes>1048576||!row.payload)fail('ui_shard_missing_or_corrupt');
 let raw;try{raw=gunzipSync(row.payload,{maxOutputLength:1048576});}catch{fail('ui_shard_missing_or_corrupt');}
 if(raw.length!==row.plain_bytes||hash(raw)!==sha)fail('ui_shard_missing_or_corrupt');
 return decodeEvidence(raw,{dictionary,resolveStableSymbol:stableSymbolReader(db)});
}
function dictionaryOf(db,seal){
 const values=[];for(const sha of seal.summary.symbols){const entries=object(db,sha);
  if(!Array.isArray(entries)||entries.length>512||!entries.every(v=>hex.test(v)))fail('ui_dictionary_corrupt');values.push(...entries);}
 if(values.length>100000||new Set(values).size!==values.length)fail('ui_dictionary_corrupt');return values;
}
function* rowsOf(db,seal,name,field,dictionary){
 for(const sha of seal.summary.projections[name][field]){const rows=object(db,sha,dictionary);
  if(!Array.isArray(rows)||rows.length>128)fail('ui_shard_rows_invalid');yield*rows;}
}
function projectionDigest(db,seal,name,dictionary){
 const digest=createHash('sha256'),meta=seal.summary.projections[name];digest.update('{');
 const fields=Object.keys(meta).filter(k=>['rows','registry'].includes(k)).sort();
 fields.forEach((field,i)=>{if(i)digest.update(',');digest.update(JSON.stringify(field)+':[');let n=0;
  for(const row of rowsOf(db,seal,name,field,dictionary)){if(n++)digest.update(',');digest.update(canonicalJson(row));}digest.update(']');});
 digest.update('}');return digest.digest('hex');
}
export function verifyDexUiSeal(db,seal,u){
 const s=seal.summary,source=JSON.parse(readDefinition(u.unit_json)).source;
 const expectedSource={id:source.protocol+'_ui_projection',definition:'verified-dex-ui-projection-pieces-v1',chainId:5042,
  protocol:source.protocol,projectionVersions:PROJECTION_VERSIONS,stream:LOG_STREAMS.find(x=>x.key===(source.protocol==='uniswap_v3'?'v3Pools':'v4'))};
 if(!['uniswap_v3','uniswap_v4'].includes(source.protocol)||hash(source)!==hash(expectedSource)
  ||s.format!=='arc-dex-ui-hour-v1'||s.protocol!==source.protocol
  ||s.sourceKey!==u.source_key||s.anchorHash!==u.anchor_hash||s.hourStart!==u.hour_start||!Array.isArray(s.symbols)||s.symbols.length>196)fail('ui_seal_invalid');
 const protocol=s.protocol,expected=[protocol+'_pools',protocol+'_price_paths','dex_activity',...(protocol==='uniswap_v4'?['uniswap_v4_swap_fees']:[])].sort();
 if(json(Object.keys(s.projections).sort())!==json(expected))fail('ui_seal_projection_missing');
 if(s.family?.status!=='available'||!['swapCount','mintCount','burnCount','initializeCount','modifyLiquidityCount'].every(k=>Number.isSafeInteger(s.family[k])&&s.family[k]>=0))fail('ui_family_invalid');
 const dictionary=dictionaryOf(db,seal),totals={swapCount:0,addCount:0,removeCount:0,pokeCount:0},counts={},poolSwaps=new Map();
 // Pools precede paths/fees so equal totals cannot conceal different per-pool counts.
 for(const row of rowsOf(db,seal,protocol+'_pools','rows',dictionary))poolSwaps.set(row.pool,row.swapCount);
 for(const name of expected){const m=s.projections[name];
  if(m.status!=='available'||!Array.isArray(m.rows)||m.rows.length>4096||m.registry&&(!Array.isArray(m.registry)||m.registry.length>4096)
   ||projectionDigest(db,seal,name,dictionary)!==m.rowsSha256)fail('ui_projection_corrupt');
  let count=0,lastPool='',lastActivity=null,swaps=0;const activityKinds={};
  for(const row of rowsOf(db,seal,name,'rows',dictionary)){
   count++;if(name==='dex_activity'){
    if(!validActivityRow(row)||row.protocol!==protocol||row.hourStart!==u.hour_start||row.blockNumber<u.first_block||row.blockNumber>u.last_block
     ||lastActivity&&(row.blockNumber>lastActivity.blockNumber||row.blockNumber===lastActivity.blockNumber&&row.logIndex>=lastActivity.logIndex))fail('ui_activity_invalid');
    activityKinds[row.kind]=(activityKinds[row.kind]??0)+1;lastActivity=row;
   }else{
    if(row.pool<=lastPool)fail('ui_pool_order_invalid');lastPool=row.pool;
    const valid=name.endsWith('_pools')?validPoolRow(row,protocol):name.endsWith('_price_paths')
     ?validPricePathRow(row,protocol,{firstBlock:u.first_block,lastBlock:u.last_block}):validSwapFeeRow(row);
    if(!valid||!name.endsWith('_pools')&&poolSwaps.get(row.pool)!==row.swapCount)fail('ui_projection_row_invalid');swaps+=row.swapCount;
    if(name.endsWith('_pools'))for(const key of Object.keys(totals))totals[key]+=row[key];
   }
  }
  if(count!==m.rowCount||name!=='dex_activity'&&swaps!==s.family.swapCount)fail('ui_projection_counts_conflict');
  if(name==='dex_activity'&&(count>ACTIVITY_ROWS_PER_KIND*ACTIVITY_KINDS.length||Object.values(activityKinds).some(n=>n>ACTIVITY_ROWS_PER_KIND)))fail('ui_activity_cap_conflict');
  if(m.registry){let n=0,last='';for(const r of rowsOf(db,seal,name,'registry',dictionary)){
    if(!validV4Record(r)||r.poolId<=last||r.createdBlock<u.first_block||r.createdBlock>u.last_block)fail('ui_registry_invalid');last=r.poolId;n++;}
    if(n!==m.registryCount||n!==s.family.initializeCount)fail('ui_registry_count_conflict');}
   if(!Number.isSafeInteger(count)||!name.endsWith('_pools')&&name!=='dex_activity'&&count!==[...poolSwaps.values()].filter(n=>n>0).length)fail('ui_pool_set_conflict');
   counts[name]=count;
 }
 if(totals.swapCount!==s.family.swapCount||protocol==='uniswap_v3'&&(totals.addCount!==s.family.mintCount||totals.removeCount+totals.pokeCount!==s.family.burnCount)
  ||protocol==='uniswap_v4'&&totals.addCount+totals.removeCount+totals.pokeCount!==s.family.modifyLiquidityCount)fail('ui_family_reconciliation_conflict');
 const sums={swapCount:0,mintCount:0,burnCount:0,initializeCount:0,modifyLiquidityCount:0};
 for(const segment of seal.segments){if(!/^[0-9a-f]{64}$/.test(segment.inputSha256))fail('ui_segment_provenance_invalid');
  for(const k of Object.keys(sums)){if(!Number.isSafeInteger(segment.counts[k])||segment.counts[k]<0)fail('ui_segment_counts_conflict');sums[k]+=segment.counts[k];}}
 if(Object.entries(sums).some(([k,n])=>!Number.isSafeInteger(n)||n<0||n!==s.family[k]))fail('ui_segment_counts_conflict');
 return{counts};
}
export function readDexUiHour(p,unitId){
 const seal=p.getSeal(unitId);if(seal?.summary.format!=='arc-dex-ui-hour-v1')fail('ui_hour_seal_required');
 const dictionary=dictionaryOf(p.db,seal),s=seal.summary,projections={};
 for(const [name,meta]of Object.entries(s.projections))projections[name]={status:'available',rows:[...rowsOf(p.db,seal,name,'rows',dictionary)],
  ...(meta.registry?{registry:[...rowsOf(p.db,seal,name,'registry',dictionary)]}:{}),rowsSha256:meta.rowsSha256};
 return{projections,family:s.family,unitId,activityCap:ACTIVITY_ROWS_PER_KIND,sourceKey:s.sourceKey,
  canonical:{hour:s.hourStart,first:seal.first,last:seal.last,hash:seal.anchorHash}};
}
export function createDexUiHourStore(p){
 if(p.readOnly)fail('ui_hour_writable_target_required');p.transaction(()=>p.db.exec(SQL));
 function publish(unitId,{evidenceSource=p,beforeCommit,afterCommit}={}){
  if(p.getSeal(unitId))return p.getSeal(unitId);
  if(evidenceSource!==p&&!evidenceSource.readOnly)fail('ui_source_read_only_required');
  if(evidenceSource.coverage(unitId).status!=='complete'||evidenceSource.getSeal(unitId))fail('ui_hour_incomplete');
  // Derive from authenticated complete pieces, never trust caller-supplied financial results.
  const derived=deriveDexUiProjections(evidenceSource,unitId);
  const u=evidenceSource.db.prepare('SELECT * FROM arc_pipeline_units WHERE unit_id=?').get(unitId),protocol=JSON.parse(readDefinition(u.unit_json)).source.protocol;
  if(derived.sourceKey!==u.source_key||derived.canonical.hour!==u.hour_start||derived.canonical.first!==u.first_block
   ||derived.canonical.last!==u.last_block||derived.canonical.hash!==u.anchor_hash)fail('ui_hour_binding_conflict');
  const stored=p.transaction(()=>{
   if(evidenceSource!==p){
    if(p.db.prepare('SELECT 1 FROM arc_pipeline_units WHERE unit_id=?').get(unitId))fail('ui_target_unit_conflict');
    const source=evidenceSource.db.prepare('SELECT * FROM arc_pipeline_sources WHERE source_key=?').get(u.source_key);
    p.db.prepare('INSERT OR IGNORE INTO arc_pipeline_sources VALUES(?,?,?)').run(source.source_key,source.definition_json,source.definition_sha);
    if(readDefinition(p.db.prepare('SELECT definition_json FROM arc_pipeline_sources WHERE source_key=?').get(u.source_key).definition_json)!==readDefinition(source.definition_json))fail('ui_source_conflict');
    p.db.prepare('INSERT INTO arc_pipeline_units VALUES(?,?,?,?,?,?,?,?)').run(u.unit_id,u.source_key,u.first_block,u.last_block,u.hour_start,u.anchor_hash,u.registry_digest,u.unit_json);
    for(const j of evidenceSource.db.prepare("SELECT * FROM arc_pipeline_jobs WHERE unit_id=? AND state='complete' ORDER BY first_block").iterate(unitId)){
     p.db.prepare('INSERT INTO arc_pipeline_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      j.job_id,j.unit_id,j.first_block,j.last_block,'complete',j.priority,null,j.attempts,0,0,null,j.expected_sha,null,null);
    }
   }
   const stable=createStableSymbols(p.db),stableMap=new Map(),locals=new Set();
   function collect(v,key){if(typeof v==='string'&&hex.test(v)){
     if(['pool','poolId','token0','token1','currency0','currency1','hooks','emitter','from','to','txFrom','counterparty'].includes(key))stableMap.set(v,stable.intern(v));else locals.add(v);
    }else if(v&&typeof v==='object')for(const [k,x]of Object.entries(v))collect(x,k);}
   for(const projection of Object.values(derived.projections))collect(projection);
   const dictionary=[...locals].filter(v=>!stableMap.has(v)).sort();if(dictionary.length>100000)fail('ui_dictionary_budget');
   const dictMap=new Map(dictionary.map((v,i)=>[v,i])),put=(value,withSymbols=true)=>{
    const raw=encodeEvidence(value,{compactIntegers:true,...(withSymbols?{dictionary:dictMap,stableSymbols:stableMap}:{})});if(raw.length>1048576)fail('ui_shard_budget');
    const sha=hash(raw);p.db.prepare('INSERT OR IGNORE INTO arc_pipeline_ui_shards VALUES(?,?,?)').run(sha,gzipSync(raw,{level:9}),raw.length);return sha;};
   const symbols=[];for(let i=0;i<dictionary.length;i+=512)symbols.push(put(dictionary.slice(i,i+512),false));
   const projections={};for(const [name,value]of Object.entries(derived.projections)){
    const meta={status:value.status,rowsSha256:value.rowsSha256,rows:[],rowCount:value.rows.length};
    for(let i=0;i<value.rows.length;i+=128)meta.rows.push(put(value.rows.slice(i,i+128)));
    if(value.registry){meta.registry=[];meta.registryCount=value.registry.length;for(let i=0;i<value.registry.length;i+=128)meta.registry.push(put(value.registry.slice(i,i+128)));}projections[name]=meta;
   }
   const segments=[];for(const job of evidenceSource.db.prepare("SELECT * FROM arc_pipeline_jobs WHERE unit_id=? AND state='complete' ORDER BY first_block").iterate(unitId)){
    const result=evidenceSource.getResult(job.result_sha);segments.push({first:job.first_block,last:job.last_block,resultSha:job.expected_sha,
     inputSha256:result.inputSha256,status:result.status,counts:result.counts});}
   const seal={format:'arc-unit-seal-v1',sourceKey:u.source_key,first:u.first_block,last:u.last_block,anchorHash:u.anchor_hash,segments,
    summary:{format:'arc-dex-ui-hour-v1',sourceKey:u.source_key,hourStart:u.hour_start,anchorHash:u.anchor_hash,protocol,family:derived.family,symbols,projections}};
   verifyDexUiSeal(p.db,seal,u);const raw=Buffer.from(json(seal));if(raw.length>8388608)fail('ui_seal_budget');
   p.db.prepare('INSERT INTO arc_pipeline_seals VALUES(?,?,?,?)').run(unitId,hash(raw),gzipSync(raw,{level:9}),raw.length);p.getSeal(unitId);beforeCommit?.();return seal;
  },8*1024*1024);afterCommit?.();return stored;
 }
 function compact(unitId,{beforeCommit}={}){
  if(p.getSeal(unitId)?.summary.format!=='arc-dex-ui-hour-v1')fail('verified_ui_hour_seal_required');
  if(p.db.prepare('SELECT 1 FROM arc_pipeline_fact_rows WHERE unit_id=? LIMIT 1').get(unitId))fail('ui_unsealed_facts');
  return p.transaction(()=>{
   p.getSeal(unitId);const jobs=p.db.prepare('SELECT DISTINCT result_sha FROM arc_pipeline_jobs WHERE unit_id=? AND result_sha IS NOT NULL').all(unitId);
   p.db.prepare("UPDATE arc_pipeline_jobs SET result_sha=NULL WHERE unit_id=? AND state='complete'").run(unitId);
   let removed=0;for(const row of jobs)removed+=p.db.prepare('DELETE FROM arc_pipeline_results WHERE result_sha=? AND NOT EXISTS(SELECT 1 FROM arc_pipeline_jobs WHERE result_sha=?)').run(row.result_sha,row.result_sha).changes;
   p.getSeal(unitId);beforeCommit?.();return{removedTransientPieces:removed,acceptedHourlyResultsRetained:true};
  });
 }
 return{publish,compact};
}
