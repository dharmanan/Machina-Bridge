// Physical SQLite capacity workload based on one REAL dense hour, not 720 real blockchain hours.
// Every hour writes another physical copy: no content-addressed deduplication or guessed compression ratio.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,readFileSync,writeFileSync,statSync,statfsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash,inspectCapacity,directoryBytes,assertHeapBudget } from '../server/intelligence-pipeline/storage.js';
const [inputPath,outputPath]=process.argv.slice(2);if(!inputPath?.startsWith('/tmp/')||!outputPath?.startsWith('/tmp/'))throw Error('isolated_lab_reports_required');
const input=JSON.parse(readFileSync(inputPath));if(!input.root?.startsWith('/tmp/arc-dex-compact-proof-'))throw Error('verified_real_reduced_hour_required');
const inventory=JSON.parse(readFileSync(new URL('../docs/arc-intelligence-pipeline/production-capacity.json',import.meta.url)));
const source=new DatabaseSync(join(input.root,'reduced.sqlite'),{readOnly:true}),root=mkdtempSync(join(tmpdir(),'arc-storage-720-capacity-')),path=join(root,'capacity.sqlite'),db=new DatabaseSync(path);
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; PRAGMA wal_autocheckpoint=256; CREATE TABLE capacity_objects(hour_ordinal INTEGER,kind TEXT,object_key TEXT,payload BLOB,sha TEXT,PRIMARY KEY(hour_ordinal,kind,object_key)) STRICT;');
const insert=db.prepare('INSERT INTO capacity_objects VALUES(?,?,?,?,?)');let hours=0,payloadBytes=0,peakManagedBytes=0,peakWal=0,peakHeap=0;
const budgets={liveGrowthBytes:268435456,additionalWalBytes:134217728,temporaryWorkBytes:134217728,safetyReserveBytes:inventory.safetyReserveBytes};
const guard=()=>{const fs=statfsSync(root,{bigint:true}),used=directoryBytes(root);peakManagedBytes=Math.max(peakManagedBytes,used);peakWal=Math.max(peakWal,statSync(path+'-wal').size);peakHeap=Math.max(peakHeap,process.memoryUsage().heapUsed);assertHeapBudget();const c=inspectCapacity({volumeLimitBytes:inventory.volumeLimitBytes,knownOtherBytes:inventory.usedBytes+budgets.liveGrowthBytes+budgets.additionalWalBytes+budgets.temporaryWorkBytes,plannedBytes:1048576,capacity:()=>({usedBytes:used,freeBytes:Number(fs.bavail*fs.bsize)})});if(!c.ok)throw Object.assign(Error(c.reason),{capacity:c});};
const streams=[['arc_pipeline_dex_shards','sha','payload_gzip'],['arc_pipeline_seals','unit_id','payload_gzip'],['arc_pipeline_results','result_sha','payload_gzip'],['arc_pipeline_sources','source_key','definition_json'],['arc_pipeline_units','unit_id','unit_json']];
let stopped=null;
try{
 for(let hour=0;hour<720;hour++){
  guard();db.exec('BEGIN IMMEDIATE');try{
   for(const [table,key,column]of streams)for(const r of source.prepare(`SELECT ${key} key,${column} value FROM ${table}`).iterate()){const b=typeof r.value==='string'?Buffer.from(r.value):Buffer.from(r.value);insert.run(hour,table,r.key,b,hash(b));payloadBytes+=b.length;}
   for(const r of source.prepare('SELECT * FROM arc_pipeline_jobs').iterate()){const b=Buffer.from(JSON.stringify(r));insert.run(hour,'arc_pipeline_jobs',r.job_id,b,hash(b));payloadBytes+=b.length;}
   guard();db.exec('COMMIT');hours++;
  }catch(e){db.exec('ROLLBACK');throw e;}
  if(hours%120===0)console.log(JSON.stringify({hours,physicalBytes:statSync(path).size,walBytes:statSync(path+'-wal').size}));
 }
}catch(e){stopped={reason:e.message,capacity:e.capacity??null};}
const pageSize=db.prepare('PRAGMA page_size').get().page_size,pageCount=db.prepare('PRAGMA page_count').get().page_count;
let checks=0;for(const r of db.prepare('SELECT * FROM capacity_objects WHERE hour_ordinal IN(0,359,719)').iterate()){if(hash(r.payload)!==r.sha)throw Error('copied_payload_checksum_mismatch');checks++;}
if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('sqlite_integrity_failed');db.close();
const sourceTables=source.prepare('SELECT name,sum(pgsize) bytes FROM dbstat GROUP BY name').all(),addressDictionaryBytes=sourceTables.filter(r=>r.name==='arc_pipeline_addresses'||r.name==='sqlite_autoindex_arc_pipeline_addresses_1').reduce((n,r)=>n+r.bytes,0),addresses=source.prepare('SELECT count(*) n FROM arc_pipeline_addresses').get().n;
source.close();
const storedBytes=statSync(path).size,sharedAddressScenarioBytes=storedBytes+addressDictionaryBytes,totalWithReservedBudgets=inventory.usedBytes+sharedAddressScenarioBytes+Object.values(budgets).reduce((n,x)=>n+x,0);
// Explicit contrasting scenario: each dense hour introduces that hour's entire address set anew.
// This is a scaling estimate from MEASURED SQLite table/index bytes, not actual 720H address history.
const allNovelAddressEstimatedBytes=addressDictionaryBytes*720,allNovelTotalEstimate=totalWithReservedBudgets-addressDictionaryBytes+allNovelAddressEstimatedBytes;
const report={scope:'720-copy physical SQLite storage workload from verified 2026-09-16 12 UTC DEX inputs; not actual 720 mainnet hours and not an all-84-field qualification',root,hoursCompleted:hours,checks,stopped,payloadBytes,storedBytes,pageSize,pageCount,peakManagedBytes,peakWalBytes:peakWal,sampledHeapBytes:peakHeap,heapBudget:assertHeapBudget(),maxRSSBytes:process.resourceUsage().maxRSS*1024,rpcRequests:0,productionAccess:false,inventory,budgets,addressDictionaryBytes,addresses,sharedAddressScenarioBytes,totalWithReservedBudgets,remainingForUnmeasured84FieldsBytes:inventory.volumeLimitBytes-totalWithReservedBudgets,allNovelAddressEstimatedBytes,allNovelTotalEstimate,allNovelFits:allNovelTotalEstimate<=inventory.volumeLimitBytes,sharedAddressScenarioFits:hours===720&&totalWithReservedBudgets<=inventory.volumeLimitBytes,conditions:['Every hourly DEX payload and source/job/seal definition is no larger than the tested dense hour. No payload deduplication assumed.','All 720 hours use the measured union of addresses; further unique addresses consume additional storage. This overlap has NOT been established for real 30D history.','Derived fact index is a regenerable cache; it is excluded because original verified factory summary remains durable.','All additional network/creation/valuation/lending/cross-chain/discovery/API evidence must fit within remainingForUnmeasured84FieldsBytes. It is NOT measured by this test.','256 MiB live growth, 128 MiB additional WAL, 128 MiB temporary work and 512 MiB safety reserve are explicit operational reservations, not measured 12-month growth.','Independent backup target remains unconfigured; no production backup guarantee.'],decision:'NO_GO for full product: real 720-hour novelty and other required fields remain unmeasured'};
writeFileSync(outputPath,JSON.stringify(report,null,2));console.log(JSON.stringify({hours,storedBytes,totalWithReservedBudgets,remainingForUnmeasured84FieldsBytes:report.remainingForUnmeasured84FieldsBytes,allNovelTotalEstimate,checks,stopped}));
