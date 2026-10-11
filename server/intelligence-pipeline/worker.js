// Explicit invocation only. No scheduler, production path, environment changes or automatic activation.
import { assertHeapBudget,fail } from './storage.js';
const BUDGET_FAILURES=new Set(['recovery_response_budget_exhausted','recovery_rpc_budget_exhausted','recovery_time_budget_exhausted']);
const SPLIT_FAILURES=new Set(['range_too_large','too_many_results','suspect_log_result_count','reduced_summary_too_large']);
export async function runBoundedUnit(p,{unitId,bounded,processJob,maxJobs=4096,afterAccept}={}){
  assertHeapBudget();if(!bounded?.provider?.canContinue||typeof processJob!=='function'||!Number.isInteger(maxJobs)||maxJobs<1||maxJobs>4096)fail('bounded_worker_required');
  let accepted=0,failed=0,reason=null;
  for(let n=0;n<maxJobs;n++){
    if(!bounded.provider.canContinue()){reason='bounded_run_yield';break;}
    // Preflight before RPC, including response/reduction storage and WAL headroom.
    p.guard(8*1024*1024);const j=p.claim({unitId});if(!j)break;
    try{const result=await processJob(j,bounded.provider);p.accept(j,result.summary,{facts:result.facts??[]});accepted++;afterAccept?.(j);}
    catch(e){
      // A crash injected after acceptance must not downgrade an already durable result.
      if(p.db.prepare('SELECT state FROM arc_pipeline_jobs WHERE job_id=?').get(j.job_id)?.state==='complete')throw e;
      reason=e.code??'source_failed';p.defer(j,reason,e,{split:SPLIT_FAILURES.has(reason)||BUDGET_FAILURES.has(reason),blocked:reason==='unsplittable_range',delayMs:reason==='bounded_run_yield'?0:60000});if(reason!=='bounded_run_yield')failed++;
      // Provider's failure latch and this exit ensure no further RPC in a failed invocation.
      break;
    }
  }
  return {accepted,failed,reason,usage:{...bounded.stats},coverage:p.coverage(unitId)};
}
