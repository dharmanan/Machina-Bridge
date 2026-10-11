// Independent, opt-in lab infrastructure. This file is not imported by the live service.
// Only reduced evidence/results are durable. Full RPC blocks, transactions and log responses are transient.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { openSync, closeSync, existsSync, statSync, statfsSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { getHeapStatistics } from 'node:v8';
import { providerDiagnostics } from '../compact/provider.js';
import { encodeEvidence, decodeEvidence } from './binary-evidence.js';
import { packedMemberships, membershipAddressReader } from './result-membership-codec.js';

export const VOLUME_LIMIT_BYTES = 5_000_000_000; // Conservative decimal GB, includes WAL/indexes/temp and reserve.
export const FREE_RESERVE_BYTES = 512 * 1024 * 1024;
export const HEAP_LIMIT_BYTES = 64 * 1024 * 1024;
export const PIPELINE_VERSION = 'arc-independent-reduced-evidence-v1';
export const json = value => JSON.stringify(value, (_k,v) => typeof v === 'bigint' ? v.toString() : v);
export const hash = value => createHash('sha256').update(typeof value === 'string' || ArrayBuffer.isView(value) ? value : json(value)).digest('hex');
export const fail = code => { throw Object.assign(new Error(code), { code }); };
const DEFINITION_PREFIX='ARCMETA1:';
export function storeDefinition(text){
  if(typeof text!=='string'||Buffer.byteLength(text)>1048576)fail('definition_budget');
  return DEFINITION_PREFIX+gzipSync(Buffer.from(text),{level:9}).toString('base64');
}
export function readDefinition(text){
  if(typeof text!=='string'||text.length>2097152)fail('definition_corrupt');
  if(!text.startsWith(DEFINITION_PREFIX))return text;
  const encoded=text.slice(DEFINITION_PREFIX.length),packed=Buffer.from(encoded,'base64');if(packed.toString('base64')!==encoded)fail('definition_corrupt');
  let raw;try{raw=gunzipSync(packed,{maxOutputLength:1048576});}catch{fail('definition_corrupt');}
  const out=raw.toString('utf8');if(!Buffer.from(out).equals(raw))fail('definition_corrupt');return out;
}
// --max-old-space-size alone does not bound the entire V8 heap: young-space also counts.
// Refuse an unsafe worker before opening/creating files. Native buffers and SQLite RSS are
// measured separately; this check must never be described as a 64 MiB process/RSS limit.
export function assertHeapBudget(){
  const configuredLimitBytes=getHeapStatistics().heap_size_limit;
  if(configuredLimitBytes>HEAP_LIMIT_BYTES||process.memoryUsage().heapUsed>HEAP_LIMIT_BYTES)fail('heap_budget_configuration');
  return {configuredLimitBytes,maximumHeapBytes:HEAP_LIMIT_BYTES};
}
const identifier = /^[a-z][a-z0-9_-]{0,80}$/;
const bytes = p => existsSync(p) ? statSync(p).size : 0;
const SQL = `
CREATE TABLE arc_pipeline_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT,WITHOUT ROWID;
CREATE TABLE arc_pipeline_sources(source_key TEXT PRIMARY KEY,definition_json TEXT NOT NULL,definition_sha TEXT NOT NULL) STRICT,WITHOUT ROWID;
CREATE TABLE arc_pipeline_units(unit_id TEXT PRIMARY KEY,source_key TEXT NOT NULL REFERENCES arc_pipeline_sources,first_block INTEGER NOT NULL,last_block INTEGER NOT NULL,hour_start INTEGER,anchor_hash TEXT NOT NULL,registry_digest TEXT NOT NULL,unit_json TEXT NOT NULL,UNIQUE(source_key,first_block,last_block,anchor_hash,registry_digest)) STRICT,WITHOUT ROWID;
CREATE INDEX arc_pipeline_units_window ON arc_pipeline_units(source_key,registry_digest,hour_start);
CREATE TABLE arc_pipeline_jobs(job_id TEXT PRIMARY KEY,unit_id TEXT NOT NULL REFERENCES arc_pipeline_units,first_block INTEGER NOT NULL,last_block INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','running','complete','split','blocked','retryable')),priority INTEGER NOT NULL,parent_id TEXT,attempts INTEGER NOT NULL DEFAULT 0,not_before INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,lease_token TEXT,expected_sha TEXT,result_sha TEXT,reason TEXT,UNIQUE(unit_id,first_block,last_block)) STRICT,WITHOUT ROWID;
CREATE INDEX arc_pipeline_due ON arc_pipeline_jobs(state,not_before,priority,first_block);
CREATE INDEX arc_pipeline_jobs_unit ON arc_pipeline_jobs(unit_id,first_block,last_block);
CREATE TABLE arc_pipeline_results(result_sha TEXT PRIMARY KEY,payload_gzip BLOB NOT NULL,plain_bytes INTEGER NOT NULL,format TEXT NOT NULL) STRICT,WITHOUT ROWID;
CREATE TABLE arc_pipeline_failures(id INTEGER PRIMARY KEY,job_id TEXT NOT NULL,reason TEXT NOT NULL,at_ms INTEGER NOT NULL,diagnostics_json TEXT NOT NULL) STRICT;
CREATE TABLE arc_pipeline_fact_rows(unit_id TEXT NOT NULL,fact_kind TEXT NOT NULL,fact_key TEXT NOT NULL,payload_json TEXT NOT NULL,payload_sha TEXT NOT NULL,PRIMARY KEY(unit_id,fact_kind,fact_key)) STRICT,WITHOUT ROWID;
CREATE INDEX arc_pipeline_fact_kind ON arc_pipeline_fact_rows(fact_kind,unit_id,fact_key);
CREATE TABLE arc_pipeline_seals(unit_id TEXT PRIMARY KEY REFERENCES arc_pipeline_units,seal_sha TEXT NOT NULL,payload_gzip BLOB NOT NULL,plain_bytes INTEGER NOT NULL) STRICT,WITHOUT ROWID;
CREATE TRIGGER arc_pipeline_seal_immutable BEFORE UPDATE ON arc_pipeline_seals BEGIN SELECT RAISE(ABORT,'unit_seal_immutable'); END;
CREATE TRIGGER arc_pipeline_source_immutable BEFORE UPDATE ON arc_pipeline_sources BEGIN SELECT RAISE(ABORT,'source_definition_immutable'); END;
CREATE TRIGGER arc_pipeline_unit_immutable BEFORE UPDATE ON arc_pipeline_units BEGIN SELECT RAISE(ABORT,'canonical_unit_immutable'); END;
CREATE TRIGGER arc_pipeline_result_immutable BEFORE UPDATE ON arc_pipeline_results BEGIN SELECT RAISE(ABORT,'result_immutable'); END;
`;

// No symlinks: an inventory must not accidentally follow paths outside its managed directory.
export function directoryBytes(root, { maxEntries = 20000 } = {}) {
  let size=0,count=0;const pending=[resolve(root)];
  while(pending.length)for(const entry of readdirSync(pending.pop(),{withFileTypes:true})){
    if(++count>maxEntries)fail('storage_inventory_limit');
    const p=join(entry.parentPath,entry.name),s=lstatSync(p);
    if(s.isSymbolicLink())fail('storage_symlink_forbidden');
    if(s.isDirectory()){size+=s.blocks*512;pending.push(p);}else if(s.isFile())size+=Math.max(s.size,s.blocks*512);else fail('storage_special_file_forbidden');
  }
  return size;
}
export function inspectCapacity({ directory, knownOtherBytes=0, plannedBytes=0, reserveBytes=FREE_RESERVE_BYTES, volumeLimitBytes=VOLUME_LIMIT_BYTES, capacity }={}){
  try{
    if(![knownOtherBytes,plannedBytes,reserveBytes].every(n=>Number.isSafeInteger(n)&&n>=0)||!Number.isSafeInteger(volumeLimitBytes)||volumeLimitBytes<=reserveBytes||volumeLimitBytes>VOLUME_LIMIT_BYTES)fail('capacity_invalid');
    const measured=capacity?capacity():{usedBytes:directoryBytes(directory),freeBytes:Number(statfsSync(directory,{bigint:true}).bavail*statfsSync(directory,{bigint:true}).bsize)};
    if(![measured.usedBytes,measured.freeBytes].every(n=>Number.isSafeInteger(n)&&n>=0))fail('capacity_unknown');
    const allowance=plannedBytes*4; // Pages, indexes and WAL; actual usage is checked again after commit.
    const totalBytes=measured.usedBytes+knownOtherBytes;
    const reason=totalBytes+allowance+reserveBytes>volumeLimitBytes?'volume_5gb_budget':measured.freeBytes-allowance<reserveBytes?'storage_low_space':null;
    return {...measured,totalBytes,knownOtherBytes,plannedBytes,reserveBytes,allowance,volumeLimitBytes,ok:reason===null,reason};
  }catch{return {ok:false,reason:'capacity_unknown',volumeLimitBytes};}
}

function decodeResult(row,db){
  if(!row||!['reduced-evidence-v1','reduced-evidence-v2'].includes(row.format)||row.plain_bytes>8*1024*1024)fail('result_missing_or_corrupt');
  let raw;try{raw=gunzipSync(row.payload_gzip,{maxOutputLength:8*1024*1024});}catch{fail('result_missing_or_corrupt');}
  if(row.format==='reduced-evidence-v2')try{raw=Buffer.from(json(decodeEvidence(raw,{resolveMembershipAddress:membershipAddressReader(db)})));}catch{fail('result_missing_or_corrupt');}
  if(raw.length!==row.plain_bytes||hash(raw)!==row.result_sha)fail('result_missing_or_corrupt');
  try{const payload=JSON.parse(raw.toString());if(!payload.summary||!Array.isArray(payload.facts))fail('result_missing_or_corrupt');return payload;}catch{fail('result_missing_or_corrupt');}
}

export function openPipeline({path,create=false,readOnly=false,directory=dirname(path),knownOtherBytes=0,volumeLimitBytes=VOLUME_LIMIT_BYTES,capacity,now=Date.now,verifySeal,readSealSummaries,compactDefinitions=false,compactMemberships=false}={}){
  assertHeapBudget();
  if(typeof readOnly!=='boolean'||readOnly&&create)fail('invalid_read_only_pipeline');
  path=resolve(path);directory=realpathSync(directory);
  if(dirname(path)!==directory||path===':memory:')fail('independent_path_required');
  if(create){const fd=openSync(path,'wx',0o600);closeSync(fd);}
  if(!existsSync(path))fail('independent_database_missing');
  const db=new DatabaseSync(path,{readOnly});
  try{
    const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    if(!create&&( !tables.some(t=>t.name==='arc_pipeline_meta')||db.prepare("SELECT value FROM arc_pipeline_meta WHERE key='version'").get()?.value!==PIPELINE_VERSION))fail('independent_database_marker_required');
    if(create&&tables.length)fail('database_must_be_empty');
    const guard=n=>{assertHeapBudget();const c=inspectCapacity({directory,knownOtherBytes,plannedBytes:n,volumeLimitBytes,capacity});if(!c.ok)fail(c.reason);return c;};
    guard(64*1024);
    // SQLite readOnly protects the main file while allowing bounded disposable TEMP membership queries.
    // query_only would also prohibit those TEMP writes. No journal/checkpoint/schema pragma on source evidence.
    db.exec(readOnly?'PRAGMA busy_timeout=1000; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE;'
      :'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE;');
    if(create){db.exec('BEGIN IMMEDIATE');try{db.exec(SQL);db.prepare('INSERT INTO arc_pipeline_meta VALUES (?,?)').run('version',PIPELINE_VERSION);db.prepare('INSERT INTO arc_pipeline_meta VALUES (?,?)').run('created',String(now()));db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
    const tx=(fn,planned=64*1024)=>{if(readOnly)fail('pipeline_read_only');guard(planned);db.exec('BEGIN IMMEDIATE');try{const r=fn();guard(0);db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
    const evidenceRow=sha=>db.prepare('SELECT result_sha,CASE WHEN length(payload_gzip)<=8388608 THEN payload_gzip ELSE NULL END AS payload_gzip,plain_bytes,format FROM arc_pipeline_results WHERE result_sha=?').get(sha);
    const getEvidence=sha=>decodeResult(evidenceRow(sha),db);
    const getResult=sha=>getEvidence(sha).summary;
    function checkUnit(u){
      const text=readDefinition(u.unit_json),spec=JSON.parse(text),s=db.prepare('SELECT * FROM arc_pipeline_sources WHERE source_key=?').get(u.source_key);
      if(hash(text)!==u.unit_id||!s||hash(readDefinition(s.definition_json))!==u.source_key||s.definition_sha!==u.source_key||hash(spec.source)!==u.source_key||spec.first!==u.first_block||spec.last!==u.last_block||spec.anchorHash!==u.anchor_hash||spec.registryDigest!==u.registry_digest||(spec.hourStart??null)!==u.hour_start)fail('canonical_unit_conflict');
    }
    function getSeal(unitId){
      const r=db.prepare('SELECT seal_sha,plain_bytes,CASE WHEN length(payload_gzip)<=8388608 THEN payload_gzip ELSE NULL END payload_gzip FROM arc_pipeline_seals WHERE unit_id=?').get(unitId);if(!r)return null;
      let raw,seal;try{raw=gunzipSync(r.payload_gzip,{maxOutputLength:8*1024*1024});seal=JSON.parse(raw);}catch{fail('unit_seal_corrupt');}
      if(raw.length!==r.plain_bytes||hash(raw)!==r.seal_sha||seal.format!=='arc-unit-seal-v1'||!Array.isArray(seal.segments))fail('unit_seal_corrupt');
      const u=db.prepare('SELECT * FROM arc_pipeline_units WHERE unit_id=?').get(unitId);
      if(!u||seal.sourceKey!==u.source_key||seal.anchorHash!==u.anchor_hash||seal.first!==u.first_block||seal.last!==u.last_block)fail('unit_seal_binding_invalid');
      checkUnit(u);
      let next=u.first_block;
      for(const segment of seal.segments){
        if(segment.first!==next||!['verified','not_applicable'].includes(segment.status)||!/^[0-9a-f]{64}$/.test(segment.resultSha))fail('unit_seal_coverage_invalid');
        const j=db.prepare('SELECT * FROM arc_pipeline_jobs WHERE unit_id=? AND first_block=? AND last_block=?').get(unitId,segment.first,segment.last);
        if(!j||j.state!=='complete'||j.expected_sha!==segment.resultSha||j.last_block<j.first_block)fail('unit_seal_coverage_invalid');next=j.last_block+1;
      }
      if(next!==u.last_block+1)fail('unit_seal_coverage_invalid');
      if(typeof verifySeal!=='function')fail('seal_verifier_required');verifySeal(db,seal,u);return seal;
    }
    const job=id=>db.prepare('SELECT * FROM arc_pipeline_jobs WHERE job_id=?').get(id);
    const addJob=(unit,first,last,priority,parent=null,expected=null)=>{
      const id=hash([unit,first,last]);db.prepare("INSERT OR IGNORE INTO arc_pipeline_jobs(job_id,unit_id,first_block,last_block,state,priority,parent_id,expected_sha) VALUES(?,?,?,?,'pending',?,?,?)").run(id,unit,first,last,priority,parent,expected);return id;
    };
    function defineUnit(spec,{chunkBlocks=125,priority=2}={}){
      if(!identifier.test(spec.source.id)||!Number.isSafeInteger(spec.first)||!Number.isSafeInteger(spec.last)||spec.first<0||spec.last<spec.first||!/^[0-9a-f]{64}$/.test(spec.registryDigest)||!/^0x[0-9a-f]{64}$/.test(spec.anchorHash)||!Number.isInteger(chunkBlocks)||chunkBlocks<1||chunkBlocks>10000||!Number.isInteger(priority)||priority<0||priority>2)fail('unit_invalid');
      if(Math.ceil((spec.last-spec.first+1)/chunkBlocks)>4096)fail('unit_plan_must_be_segmented');
      const sourceJson=json(spec.source),sourceKey=hash(spec.source),unitId=hash(spec);
      return tx(()=>{
        db.prepare('INSERT OR IGNORE INTO arc_pipeline_sources VALUES (?,?,?)').run(sourceKey,compactDefinitions?storeDefinition(sourceJson):sourceJson,sourceKey);
        if(readDefinition(db.prepare('SELECT definition_json FROM arc_pipeline_sources WHERE source_key=?').get(sourceKey)?.definition_json)!==sourceJson)fail('source_conflict');
        db.prepare('INSERT OR IGNORE INTO arc_pipeline_units VALUES(?,?,?,?,?,?,?,?)').run(unitId,sourceKey,spec.first,spec.last,spec.hourStart??null,spec.anchorHash,spec.registryDigest,compactDefinitions?storeDefinition(json(spec)):json(spec));
        if(readDefinition(db.prepare('SELECT unit_json FROM arc_pipeline_units WHERE unit_id=?').get(unitId)?.unit_json)!==json(spec))fail('canonical_unit_conflict');
        if(db.prepare('SELECT 1 FROM arc_pipeline_jobs WHERE unit_id=? LIMIT 1').get(unitId))return unitId;
        const sealed=db.prepare('SELECT u.unit_id FROM arc_pipeline_units u JOIN arc_pipeline_seals s USING(unit_id) WHERE u.source_key=? AND u.anchor_hash=? AND u.first_block=? AND u.last_block=? ORDER BY u.unit_id LIMIT 1').get(sourceKey,spec.anchorHash,spec.first,spec.last);
        if(sealed){const seal=getSeal(sealed.unit_id),stored=db.prepare('SELECT * FROM arc_pipeline_seals WHERE unit_id=?').get(sealed.unit_id);
          for(const segment of seal.segments){const id=addJob(unitId,segment.first,segment.last,priority,null,segment.resultSha);db.prepare("UPDATE arc_pipeline_jobs SET state='complete' WHERE job_id=?").run(id);}
          db.prepare('INSERT INTO arc_pipeline_seals VALUES(?,?,?,?)').run(unitId,stored.seal_sha,stored.payload_gzip,stored.plain_bytes);getSeal(unitId);return unitId;
        }
        for(let first=spec.first;first<=spec.last;first+=chunkBlocks){const last=Math.min(spec.last,first+chunkBlocks-1);
          const reusable=db.prepare("SELECT j.result_sha FROM arc_pipeline_jobs j JOIN arc_pipeline_units u USING(unit_id) WHERE u.source_key=? AND u.anchor_hash=? AND j.first_block=? AND j.last_block=? AND j.state='complete' AND j.result_sha IS NOT NULL ORDER BY j.job_id LIMIT 1").get(sourceKey,spec.anchorHash,first,last);
          const id=addJob(unitId,first,last,priority);
          if(reusable){const evidence=getEvidence(reusable.result_sha);indexFacts(unitId,evidence.facts);db.prepare("UPDATE arc_pipeline_jobs SET state='complete',result_sha=?,expected_sha=? WHERE job_id=? AND state='pending'").run(reusable.result_sha,reusable.result_sha,id);}
        }return unitId;
      });
    }
    function claim({leaseMs=600000,unitId=null}={}){
      if(!Number.isSafeInteger(leaseMs)||leaseMs<1||leaseMs>600000)fail('lease_invalid');
      if(unitId!==null&&!/^[0-9a-f]{64}$/.test(unitId))fail('unit_invalid');
      return tx(()=>{
        db.prepare("UPDATE arc_pipeline_jobs SET state='retryable',reason='worker_restart',lease_token=NULL WHERE state='running' AND lease_until<=?").run(now());
        // Live first; background jobs are bounded per invocation rather than sharing the live production DB.
        const next=db.prepare("SELECT * FROM arc_pipeline_jobs WHERE state IN('pending','retryable') AND not_before<=? AND (? IS NULL OR unit_id=?) ORDER BY priority,attempts,first_block,job_id LIMIT 1").get(now(),unitId,unitId);
        if(!next)return null;const token=randomUUID();db.prepare("UPDATE arc_pipeline_jobs SET state='running',lease_token=?,lease_until=?,attempts=attempts+1 WHERE job_id=?").run(token,now()+leaseMs,next.job_id);const specText=readDefinition(db.prepare('SELECT unit_json FROM arc_pipeline_units WHERE unit_id=?').get(next.unit_id).unit_json);if(hash(specText)!==next.unit_id)fail('canonical_unit_conflict');return {...job(next.job_id),spec:JSON.parse(specText)};
      });
    }
    const owns=current=>{const live=job(current.job_id);if(live?.state!=='running'||live.lease_token!==current.lease_token||live.lease_until<=now())fail('lease_lost');return live;};
    function indexFacts(unitId,facts,{repairCache=false}={}){
      for(const f of facts){const text=json(f.value),digest=hash(text);
        const old=db.prepare('SELECT payload_json,payload_sha FROM arc_pipeline_fact_rows WHERE unit_id=? AND fact_kind=? AND fact_key=?').get(unitId,f.kind,f.key);
        if(old&&(old.payload_sha!==digest||old.payload_json!==text)){
          if(!repairCache)fail('accepted_fact_conflict');
          db.prepare('DELETE FROM arc_pipeline_fact_rows WHERE unit_id=? AND fact_kind=? AND fact_key=?').run(unitId,f.kind,f.key);
        }
        db.prepare('INSERT OR IGNORE INTO arc_pipeline_fact_rows VALUES(?,?,?,?,?)').run(unitId,f.kind,f.key,text,digest);
      }
    }
    function accept(current,summary,{facts=[],beforeCommit}={}){
      // The reduction contract excludes full blocks/transactions/raw logs. Only explicit structured summaries pass.
      if(!summary||summary.format!=='arc-reduced-source-v1'||summary.first!==current.first_block||summary.last!==current.last_block||!summary.inputSha256||!/^[0-9a-f]{64}$/.test(summary.inputSha256)||summary.sourceKey!==hash(current.spec.source)||summary.anchorHash!==current.spec.anchorHash||!Array.isArray(summary.rows)||Object.keys(summary).some(k=>!['format','first','last','inputSha256','sourceKey','anchorHash','rows','counts','status','reason'].includes(k)))fail('reduced_summary_invalid');
      if(!['verified','not_applicable'].includes(summary.status)||summary.status==='not_applicable'&&!summary.reason)fail('partial_cannot_complete');
      if(!Array.isArray(facts)||facts.length>4096||facts.some(f=>!identifier.test(f.kind)||typeof f.key!=='string'||f.key.length>256||Buffer.byteLength(json(f.value))>65536))fail('fact_invalid');
      const uniqueFacts=new Set(facts.map(f=>f.kind+':'+f.key));if(uniqueFacts.size!==facts.length)fail('duplicate_fact');
      const plain=Buffer.from(json({summary,facts})),sha=hash(plain);if(plain.length>8*1024*1024)fail('reduced_summary_too_large');
      const compressed=gzipSync(plain,{level:3});
      return tx(()=>{
        const live=owns(current);if(live.expected_sha&&live.expected_sha!==sha)fail('repair_evidence_conflict');
        const old=evidenceRow(sha);
        if(old)try{decodeResult(old,db);}catch{if(live.expected_sha!==sha)fail('unverified_object_replacement');db.prepare('DELETE FROM arc_pipeline_results WHERE result_sha=?').run(sha);}
        let payload=compressed,format='reduced-evidence-v1';
        if(compactMemberships){
          const ids=packedMemberships(db,{summary,facts});
          // Oversized objects retain the original representation; no budget or completeness rule is relaxed.
          try{const packed=gzipSync(encodeEvidence({summary,facts},{packedMemberships:ids,compactIntegers:true}),{level:9});if(packed.length<payload.length){payload=packed;format='reduced-evidence-v2';}}
          catch(e){if(e.code!=='binary_evidence_budget')throw e;}
        }
        db.prepare('INSERT OR IGNORE INTO arc_pipeline_results VALUES(?,?,?,?)').run(sha,payload,plain.length,format);getResult(sha);
        indexFacts(current.unit_id,facts);
        db.prepare("UPDATE arc_pipeline_jobs SET state='complete',result_sha=?,expected_sha=COALESCE(expected_sha,?),reason=NULL,lease_token=NULL,lease_until=0 WHERE job_id=?").run(sha,sha,current.job_id);beforeCommit?.();return sha;
      },compressed.length+facts.reduce((n,f)=>n+json(f.value).length,0)+(compactMemberships?Math.min(8*1024*1024,plain.length*3):0));
    }
    function defer(current,reason,error=null, {split=false,blocked=false,delayMs=60000}={}){
      if(!Number.isSafeInteger(delayMs)||delayMs<0||delayMs>86400000)fail('retry_delay_invalid');
      if(!identifier.test(reason))reason='source_failed';return tx(()=>{
        const live=owns(current);db.prepare('INSERT INTO arc_pipeline_failures(job_id,reason,at_ms,diagnostics_json) VALUES(?,?,?,?)').run(current.job_id,reason,now(),json(providerDiagnostics(error)));
        if(split&&current.first_block<current.last_block&&!live.expected_sha){const middle=Math.floor((current.first_block+current.last_block)/2);addJob(current.unit_id,current.first_block,middle,current.priority,current.job_id);addJob(current.unit_id,middle+1,current.last_block,current.priority,current.job_id);db.prepare("UPDATE arc_pipeline_jobs SET state='split',reason=?,lease_token=NULL,lease_until=0 WHERE job_id=?").run(reason,current.job_id);}
        else db.prepare("UPDATE arc_pipeline_jobs SET state=?,reason=?,not_before=?,lease_token=NULL,lease_until=0 WHERE job_id=?").run(blocked?'blocked':'retryable',reason,now()+delayMs,current.job_id);
      });
    }
    function audit({limit=256,after=''}={}){
      if(!Number.isInteger(limit)||limit<1||limit>4096)fail('audit_limit_invalid');const broken=[],sealedRepairUnits=new Map();
      const rows=db.prepare("SELECT * FROM arc_pipeline_jobs WHERE state='complete' AND job_id>? ORDER BY job_id LIMIT ?").all(after,limit);
      const seals=new Map();for(const r of rows)try{
        if(!seals.has(r.unit_id))seals.set(r.unit_id,getSeal(r.unit_id));if(seals.get(r.unit_id))continue;
        const result=getResult(r.result_sha);if(result.first!==r.first_block||result.last!==r.last_block||r.expected_sha!==r.result_sha)fail('result_missing_or_corrupt');
      }catch(e){
        // A damaged compact object must not turn every already accepted range back into an RPC job.
        // Retain the exact completed job/checksum ledger; a source-specific object audit/backup repair
        // resolves the damaged object. Coverage stays partial until the full seal verifies again.
        if(db.prepare('SELECT 1 FROM arc_pipeline_seals WHERE unit_id=?').get(r.unit_id)){sealedRepairUnits.set(r.unit_id,e.code??'unit_seal_corrupt');seals.set(r.unit_id,{invalid:true});}
        else broken.push(r.job_id);
      }
      // Fact rows are an indexed cache; reconstruct only from a verified immutable reduced result, without RPC.
      for(const r of rows)if(!broken.includes(r.job_id)&&!seals.get(r.unit_id)){const evidence=getEvidence(r.result_sha);tx(()=>indexFacts(r.unit_id,evidence.facts,{repairCache:true}),Buffer.byteLength(json(evidence.facts)));}
      if(broken.length)tx(()=>{for(const id of broken)db.prepare("UPDATE arc_pipeline_jobs SET state='pending',reason='evidence_missing_or_corrupt',result_sha=NULL WHERE job_id=?").run(id);});
      return {checked:rows.length,repairQueued:broken.length,sealedRepairUnits:[...sealedRepairUnits].map(([unitId,reason])=>({unitId,reason})),after:rows.at(-1)?.job_id??after,hasMore:rows.length===limit};
    }
    function coverage(unitId){
      const u=db.prepare('SELECT * FROM arc_pipeline_units WHERE unit_id=?').get(unitId);if(!u)fail('unit_missing');let next=u.first_block,verified=0,reason=null;
      try{checkUnit(u);if(getSeal(unitId))return {unitId,status:'complete',first:u.first_block,last:u.last_block,verifiedBlocks:u.last_block-u.first_block+1,requiredBlocks:u.last_block-u.first_block+1,reason:null,registryDigest:u.registry_digest,sourceKey:u.source_key,compacted:true};}catch(e){return {unitId,status:'partial',first:u.first_block,last:u.last_block,verifiedBlocks:0,requiredBlocks:u.last_block-u.first_block+1,reason:e.code??'definition_corrupt',registryDigest:u.registry_digest,sourceKey:u.source_key};}
      for(const j of db.prepare("SELECT * FROM arc_pipeline_jobs WHERE unit_id=? AND state<>'split' ORDER BY first_block,last_block").iterate(unitId)){
        if(j.first_block!==next){reason='coverage_gap_or_overlap';break;}if(j.state!=='complete'){reason=j.reason??'source_incomplete';break;}
        try{getResult(j.result_sha);}catch{reason='evidence_missing_or_corrupt';break;}verified+=j.last_block-j.first_block+1;next=j.last_block+1;
      }const complete=next===u.last_block+1&&!reason;
      return {unitId,status:complete?'complete':'partial',first:u.first_block,last:u.last_block,verifiedBlocks:verified,requiredBlocks:u.last_block-u.first_block+1,reason:complete?null:reason??'coverage_gap',registryDigest:u.registry_digest,sourceKey:u.source_key};
    }
    // This index is a cache. Expiry never deletes the checksummed factory/discovery facts in results.
    // A bounded audit recreates it from those exact durable inputs, without blockchain reads.
    function expireFactCache(unitId){
      if(coverage(unitId).status!=='complete'||getSeal(unitId))fail('durable_fact_inputs_required');
      return tx(()=>{
        let verified=0;
        const del=db.prepare('DELETE FROM arc_pipeline_fact_rows WHERE unit_id=? AND fact_kind=? AND fact_key=? AND payload_sha=?');
        for(const r of db.prepare("SELECT result_sha FROM arc_pipeline_jobs WHERE unit_id=? AND state='complete' ORDER BY first_block").iterate(unitId))for(const f of getEvidence(r.result_sha).facts){
          if(++verified>4096)fail('fact_cache_work_budget');del.run(unitId,f.kind,f.key,hash(json(f.value)));
        }
        if(db.prepare('SELECT 1 FROM arc_pipeline_fact_rows WHERE unit_id=? LIMIT 1').get(unitId))fail('unverified_fact_cache');
        return {verifiedFacts:verified,immutableInputsRetained:true};
      });
    }
    function* summaries(unitId){if(coverage(unitId).status!=='complete')fail('source_not_complete');const seal=getSeal(unitId);if(seal){if(seal.summary.format==='arc-dex-hour-v1'){if(typeof readSealSummaries!=='function')fail('seal_reader_required');yield* readSealSummaries(db,seal);}else yield seal.summary;return;}for(const r of db.prepare("SELECT result_sha FROM arc_pipeline_jobs WHERE unit_id=? AND state='complete' ORDER BY first_block").iterate(unitId))yield getResult(r.result_sha);}
    return {db,path,directory,readOnly,guard,transaction:tx,defineUnit,claim,accept,defer,audit,coverage,summaries,getResult,getSeal,expireFactCache,
      metrics:()=>({databaseBytes:bytes(path),walBytes:bytes(path+'-wal'),directoryBytes:directoryBytes(directory),pageSize:db.prepare('PRAGMA page_size').get().page_size,pageCount:db.prepare('PRAGMA page_count').get().page_count,freelistCount:db.prepare('PRAGMA freelist_count').get().freelist_count,capacity:inspectCapacity({directory,knownOtherBytes,volumeLimitBytes,capacity})}),
      close:()=>db.close()};
  }catch(e){db.close();throw e;}
}
