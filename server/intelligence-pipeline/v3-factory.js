// Sparse official factory evidence; validates one event block at a time, without a whole-hour spine in memory.
import { createHash } from 'node:crypto';
import { validateLogs } from '../compact/logs.js';
import { poolRecordOf } from '../compact/registry.js';
import { logFilter,LOG_STREAMS } from '../compact/sources.js';
import { normalizeLog } from '../../api/_lib/arc-intelligence/normalize.js';
import { hash,json,fail,assertHeapBudget } from './storage.js';
export function createV3FactoryProcessor({loadVerifiedWindow}={}){
  if(typeof loadVerifiedWindow!=='function')fail('canonical_verifier_required');const stream=LOG_STREAMS.find(s=>s.key==='v3Factory');
  return async(j,provider)=>{
    assertHeapBudget();const raw=await provider.request('eth_getLogs',[logFilter(stream,j.first_block,j.last_block)]);
    if(!Array.isArray(raw))fail('factory_events_unverified');if(raw.length>=10000)fail('suspect_log_result_count');
    const seen=new Set(),rows=[],input=createHash('sha256'),addresses=new Set();let lastWindow=null,previousPosition=null;
    // Sorting normalization also rejects malformed ABI envelopes; only one block proof is retained at a time.
    const ordered=raw.map(normalizeLog).sort((a,b)=>a.blockNumber-b.blockNumber||a.logIndex-b.logIndex);
    const rawByPosition=new Map(raw.map(r=>{const l=normalizeLog(r);return [l.blockNumber+':'+l.logIndex,r];}));
    for(const l of ordered){if(previousPosition===l.blockNumber+':'+l.logIndex)fail('duplicate_factory_event');previousPosition=l.blockNumber+':'+l.logIndex;
      if(!lastWindow?.has(l.blockNumber))lastWindow=loadVerifiedWindow(l.blockNumber,l.blockNumber);
      const checked=validateLogs([rawByPosition.get(previousPosition)],stream,{fromBlock:j.first_block,toBlock:j.last_block,window:lastWindow,seen})[0],record=poolRecordOf(checked);
      if(!record||addresses.has(record.address))fail('factory_pool_unverified');addresses.add(record.address);input.update(json(checked)+'\n');
      rows.push({...record,kind:'official_v3_pool_created',blockHash:checked.blockHash,timestamp:lastWindow.get(checked.blockNumber).timestamp,emitter:checked.address,sourceKey:hash(j.spec.source)});
    }
    return {summary:{format:'arc-reduced-source-v1',first:j.first_block,last:j.last_block,sourceKey:hash(j.spec.source),anchorHash:j.spec.anchorHash,inputSha256:input.digest('hex'),status:'verified',reason:null,counts:{poolCreatedCount:rows.length},rows},
      facts:rows.map(r=>({kind:'v3_pool_created',key:r.address,value:r}))};
  };
}
