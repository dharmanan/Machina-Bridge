// Real, sparse historical birth reads for pools missing from one independent API lab's capped Activity.
// No production, raw blocks, migrations, backups or global registry-completeness claims.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openPipeline,hash,assertHeapBudget } from '../server/intelligence-pipeline/storage.js';
import { createPoolWitnessLookup } from '../server/intelligence-pipeline/pool-witness-source.js';
import { boundedRecoveryProvider } from './recover-compact-discovery.mjs';
import { providerDiagnostics } from '../server/compact/provider.js';
const [apiPath,referencePath,reportPath,resumeRoot]=process.argv.slice(2);
if(!apiPath?.startsWith('/tmp/arc-api-real-')||!referencePath?.startsWith('/tmp/machina-recovery-proof/')
  ||!reportPath?.startsWith('/tmp/')||resumeRoot&&!resumeRoot.startsWith('/tmp/arc-pool-witness-real-'))throw Error('isolated_paths_required');
const api=new DatabaseSync(apiPath,{readOnly:true}),referenceDb=new DatabaseSync(referencePath,{readOnly:true});
for(const d of[api,referenceDb])d.exec('PRAGMA query_only=ON; PRAGMA cache_size=-2048; BEGIN');
const hour=api.prepare('SELECT * FROM compact_hours').get();
assert.equal(hour.network_sha256,referenceDb.prepare('SELECT network_sha256 FROM compact_hours WHERE hour_start=?').get(hour.hour_start).network_sha256);
const reference={firstBlock:hour.first_block,lastBlock:hour.last_block,lastHash:hour.last_hash,canonicalSha:hour.network_sha256};
const args=[];
for(const protocol of['uniswap_v3','uniswap_v4']){
  const pools=api.prepare(`SELECT DISTINCT pool FROM compact_dex_activity a WHERE protocol=?
    AND NOT EXISTS(SELECT 1 FROM compact_registry r WHERE r.kind=a.protocol||'_pool' AND r.address=a.pool) ORDER BY pool`).all(protocol).map(r=>r.pool);
  assert(pools.length<=256,'this bounded fixture supports one batch; never truncate larger sets');
  const coverage=referenceDb.prepare('SELECT from_block FROM compact_registry_coverage WHERE kind=?').get(protocol+'_pool');
  assert(coverage);
  const v3Records=new Map();if(protocol==='uniswap_v3')for(const pool of pools){
    const row=referenceDb.prepare('SELECT * FROM compact_registry WHERE kind=? AND address=?').get(protocol+'_pool',pool);
    assert(row,'missing V3 birth candidate');v3Records.set(pool,row);
  }
  args.push({protocol,pools,reference,validFromBlock:coverage.from_block,v3Records,lookupStrategy:'slot0_transition_v1'});
}
const root=resumeRoot??mkdtempSync(join(tmpdir(),'arc-pool-witness-real-'));
let p=openPipeline({path:join(root,'witness.sqlite'),create:!resumeRoot,knownOtherBytes:1981427712,volumeLimitBytes:4838498304});
const report=resumeRoot?JSON.parse(readFileSync(reportPath)):{root,scope:'169 missing capped-Activity pool birth witnesses, not all pool history or 84-field acceptance',
  canonicalReference:reference,runs:[],heapBudget:assertHeapBudget(),productionAccess:false,backupsCreated:false,fullTransactionBodiesRequested:false};
let heap=report.sampledHeapBytes??0,interrupted=!!resumeRoot,error=null;const started=performance.now();
if(resumeRoot){report.acceptedWitnessesBeforeRestart=p.db.prepare('SELECT protocol,COUNT(*) count FROM arc_pipeline_pool_witnesses GROUP BY protocol').all();
  report.interruptedAttemptUsageUnavailable=true;delete report.error;}
try{
  for(const arg of args){if(!arg.pools.length)continue;
    for(let run=0;run<6;run++){
      const lookup=createPoolWitnessLookup(p,arg),bounded=boundedRecoveryProvider();
      const before=p.db.prepare('SELECT COUNT(*) n FROM arc_pipeline_pool_witnesses WHERE protocol=?').get(arg.protocol).n;
      try{
        const result=await lookup.run(bounded,{maxSteps:384,afterAccept:()=>{
          heap=Math.max(heap,process.memoryUsage().heapUsed);
          if(!interrupted){interrupted=true;throw Object.assign(Error('intentional_lab_restart'),{code:'intentional_lab_restart'});}
        }});
        report.runs.push({protocol:arg.protocol,...result,usage:{...bounded.stats},previousAcceptedWitnesses:before});
        if(result.completeRequestedPoolWitnesses)break;
      }catch(e){report.runs.push({protocol:arg.protocol,reason:e.code??e.message,usage:{...bounded.stats},diagnostics:providerDiagnostics(e),previousAcceptedWitnesses:before});
        if(!['intentional_lab_restart','recovery_response_budget_exhausted','recovery_rpc_budget_exhausted','recovery_time_budget_exhausted'].includes(e.code))throw e;
      }finally{bounded.close();}
      writeFileSync(reportPath,JSON.stringify(report,null,2));const path=p.path;p.close();p=openPipeline({path,knownOtherBytes:1981427712,volumeLimitBytes:4838498304});
    }
  }
  report.sources=args.map(arg=>{const lookup=createPoolWitnessLookup(p,arg);return{protocol:arg.protocol,requested:arg.pools.length,
    verified:arg.pools.filter(pool=>lookup.read(pool)).length,globalRegistryCoverageComplete:false};});
  report.requestedPoolWitnessesComplete=report.sources.every(s=>s.requested===s.verified);
  for(const arg of args){if(!arg.pools.length)continue;const lookup=createPoolWitnessLookup(p,arg),bounded=boundedRecoveryProvider();
    try{if(report.requestedPoolWitnessesComplete)assert.equal((await lookup.run(bounded)).additionalRequests,0);}finally{bounded.close();}}
  p.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');report.storage=p.metrics();
}catch(e){error=e.code??e.message;process.exitCode=1;}
finally{Object.assign(report,{error,sampledHeapBytes:heap,durationMs:(report.durationMs??0)+Math.round(performance.now()-started),
  globalRegistryCoverageComplete:false,all84FieldsVerified:false});writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  p.close();for(const d of[api,referenceDb]){d.exec('COMMIT');d.close();}}
