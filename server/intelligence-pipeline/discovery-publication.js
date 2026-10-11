// Explicit independent API cache adapter. Creation evidence does not imply complete pool/launchpad coverage.
import {createCompactStore} from '../compact/store.js';
import {archiveConfig} from '../compact/evidence-archive.js';
import {createIntelligenceSink} from '../compact/intelligence.js';
import {INTELLIGENCE_REGISTRY,registryDigest,INTELLIGENCE_VERSION} from '../compact/intelligence-registry.js';
import {hash,json,fail,readDefinition} from './storage.js';
const SQL=`CREATE TABLE IF NOT EXISTS arc_pipeline_api_discovery_copies(hour_start INTEGER PRIMARY KEY,
  source_sha TEXT NOT NULL,rows_sha TEXT NOT NULL,expected_sha TEXT NOT NULL) STRICT;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_api_discovery_immutable BEFORE UPDATE ON arc_pipeline_api_discovery_copies
BEGIN SELECT RAISE(ABORT,'api_discovery_commitment_immutable'); END;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_api_discovery_no_delete BEFORE DELETE ON arc_pipeline_api_discovery_copies
BEGIN SELECT RAISE(ABORT,'api_discovery_commitment_immutable'); END;
CREATE TABLE IF NOT EXISTS arc_pipeline_api_discovery_repairs(id INTEGER PRIMARY KEY,hour_start INTEGER NOT NULL,
 damaged_sha TEXT NOT NULL,restored_sha TEXT NOT NULL) STRICT;`;
function bodySha(db,hour){return hash({candidates:db.prepare(`SELECT candidate_key,hour_start,block_number,address,candidate_json,status,reason,result_json
 FROM compact_token_discoveries WHERE hour_start=? ORDER BY candidate_key`).all(hour).map(r=>({...r})),
 coverage:db.prepare('SELECT * FROM compact_intelligence_hours WHERE hour_start=? AND definition_version=? AND registry_digest=?')
 .get(hour,INTELLIGENCE_VERSION,registryDigest(INTELLIGENCE_REGISTRY))??null});}
export function createDiscoveryPublication(target){
 if(target.readOnly||target.db.prepare("SELECT value FROM arc_pipeline_meta WHERE key='version'").get()?.value!=='arc-independent-reduced-evidence-v1')fail('independent_writable_target_required');
 const store=createCompactStore(target.db,{archive:{config:archiveConfig({COMPACT_EVIDENCE_ARCHIVE_ENABLED:'false'})}});
 target.transaction(()=>target.db.exec(SQL));
 function publish(source,unitId,{beforeCommit,repairCache=false}={}){
  if(!source?.readOnly||source.coverage(unitId).status!=='complete')fail('discovery_complete_read_only_source_required');
  const u=source.db.prepare('SELECT * FROM arc_pipeline_units WHERE unit_id=?').get(unitId),spec=JSON.parse(readDefinition(u.unit_json));
  if(spec.source.id!=='creation_token_views'||spec.source.definition!=='canonical-creation-token-views-v1'
   ||spec.source.chainId!==5042||spec.source.registryDigest!==registryDigest(INTELLIGENCE_REGISTRY))fail('discovery_source_definition_conflict');
  const hour=target.db.prepare('SELECT * FROM compact_hours WHERE hour_start=?').get(u.hour_start);
  if(!hour||hour.first_block!==u.first_block||hour.last_block!==u.last_block||hour.last_hash!==u.anchor_hash)fail('discovery_canonical_conflict');
  const rows=[];for(const piece of source.summaries(unitId))for(const row of piece.rows){
   // This adapter's contract is explicitly bounded. Larger authorities require a paged adapter;
   // never truncate the candidates, silently expand the existing ingestion limit, or mark them complete.
   if(rows.length===500)fail('discovery_api_ingestion_budget');
   if(row.kind!=='verified_creation_token_result'||!['verified_erc20_like','rejected_not_erc20_like'].includes(row.result?.status)
    ||row.candidate?.kind!=='creation'||row.candidate.readBlock!==hour.last_block)fail('discovery_token_evidence_invalid');
   rows.push(row);
  }
  if(rows.length!==spec.source.candidateCount||new Set(rows.map(r=>r.candidate.key)).size!==rows.length)fail('discovery_candidates_incomplete');
  const range={hourStart:hour.hour_start,hourEnd:hour.hour_start+3600,firstBlock:hour.first_block,lastBlock:hour.last_block,
   parentHash:hour.parent_hash,firstHash:hour.first_hash,lastHash:hour.last_hash};
  const payload=createIntelligenceSink().finish({range,families:{},codePresent:()=>false,projections:{}});
  payload.discovery={...payload.discovery,status:'insufficient_coverage',reason:'independent_discovery_sources_incomplete',candidates:rows.map(r=>r.candidate)};
  payload.discoveryComponents={creations:true,uniswap_v3:false,uniswap_v4:false,launches:Object.fromEntries(INTELLIGENCE_REGISTRY.launches.map(e=>[e.id,false]))};
  payload.firstDex=[];payload.firstDexComplete=false;
  payload.launchSources=payload.launchSources.map(e=>({...e,status:'unavailable',reason:'registered_launch_scan_not_provided',counts:null,rawFlows:null}));
  payload.protocols=payload.protocols.map(e=>({...e,status:'unavailable',reason:'registered_protocol_scan_not_provided',counts:null,rawFlows:null}));
  const rowsSha=hash(rows),sourceSha=hash({unitId,source:spec.source,canonical:{hour:hour.hour_start,first:hour.first_block,last:hour.last_block,hash:hour.last_hash}});
  return target.transaction(()=>{
   const old=target.db.prepare('SELECT * FROM arc_pipeline_api_discovery_copies WHERE hour_start=?').get(hour.hour_start);
   if(old&&(old.source_sha!==sourceSha||old.rows_sha!==rowsSha))fail('discovery_publication_conflict');
   let damagedSha;
   if(old){
    try{damagedSha=bodySha(target.db,hour.hour_start);}catch{fail('discovery_api_cache_unreadable');}
    if(old.expected_sha===damagedSha)return{outcome:'unchanged',candidates:rows.length,rpcRequests:0};
    if(!repairCache)fail('discovery_api_cache_integrity_failed');
    // Only this adapter's derived cache is replaced, with the exact same complete accepted authority.
    // A reconstructed body must match the prior immutable commitment before this transaction can commit.
    target.db.prepare('DELETE FROM compact_token_discoveries WHERE hour_start=?').run(hour.hour_start);
    target.db.prepare('DELETE FROM compact_intelligence_hours WHERE hour_start=? AND definition_version=? AND registry_digest=?')
     .run(hour.hour_start,INTELLIGENCE_VERSION,registryDigest(INTELLIGENCE_REGISTRY));
   }
   store.intelligence.recordHour({range,intelligence:payload});
   const update=target.db.prepare('UPDATE compact_token_discoveries SET address=?,result_json=?,status=?,reason=?,not_before=? WHERE candidate_key=?');
   for(const row of rows){
    const saved=target.db.prepare('SELECT * FROM compact_token_discoveries WHERE candidate_key=?').get(row.candidate.key);
    if(!saved||saved.candidate_json!==json(row.candidate)||saved.status!=='pending')fail('discovery_candidate_cache_conflict');
    update.run(row.result.address,json(row.result),row.result.status,row.result.reason,(hour.hour_start+3600)*1000,row.candidate.key);
   }
   const expected=bodySha(target.db,hour.hour_start);
   if(old){
    if(old.expected_sha!==expected)fail('discovery_api_repair_evidence_conflict');
    target.db.prepare('INSERT INTO arc_pipeline_api_discovery_repairs(hour_start,damaged_sha,restored_sha) VALUES(?,?,?)').run(hour.hour_start,damagedSha,expected);
   }else target.db.prepare('INSERT INTO arc_pipeline_api_discovery_copies VALUES(?,?,?,?)').run(hour.hour_start,sourceSha,rowsSha,expected);
   beforeCommit?.();return{outcome:old?'repaired':'inserted',candidates:rows.length,verified:rows.filter(r=>r.result.status==='verified_erc20_like').length,
    discoveryCoverage:'insufficient_coverage',completeOtherSources:false,rpcRequests:0};
  },Buffer.byteLength(json(rows))*3+65536);
 }
 function reconcile(resolveSource,{maxHours=1,afterHour=-1}={}){
  if(typeof resolveSource!=='function'||maxHours!==1||!Number.isSafeInteger(afterHour))fail('discovery_reconcile_budget_invalid');
  const copies=target.db.prepare('SELECT * FROM arc_pipeline_api_discovery_copies WHERE hour_start>? ORDER BY hour_start LIMIT 1').all(afterHour),results=[];
  for(const row of copies){
   try{
    if(row.expected_sha===bodySha(target.db,row.hour_start)){results.push({hour:row.hour_start,status:'verified',rpcRequests:0});continue;}
    const input=resolveSource(row.hour_start),out=publish(input.pipeline,input.unitId,{repairCache:true});
    results.push({hour:row.hour_start,status:out.outcome,rpcRequests:0});
   }catch(e){results.push({hour:row.hour_start,status:'blocked',reason:e.code??'discovery_api_repair_failed'});}
  }
  return{results,afterHour:copies.at(-1)?.hour_start??afterHour,automaticActivation:false};
 }
 function audit(db=target.db){
  for(const row of db.prepare('SELECT * FROM arc_pipeline_api_discovery_copies').iterate()){
   if(row.expected_sha!==bodySha(db,row.hour_start))fail('discovery_api_cache_integrity_failed');
   const hour=db.prepare('SELECT * FROM compact_intelligence_hours WHERE hour_start=? AND definition_version=? AND registry_digest=?').get(row.hour_start,INTELLIGENCE_VERSION,registryDigest(INTELLIGENCE_REGISTRY));
   if(!hour||hour.discovery_status!=='insufficient_coverage')fail('discovery_api_coverage_integrity_failed');
  }
  return{ok:true};
 }
 return{publish,audit,reconcile};
}
