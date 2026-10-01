import assert from 'node:assert/strict';
import { ARC_RPC_URL } from '../../api/_lib/arc-intelligence/rpc.js';
import { createA2RpcClient } from '../../server/arc-intelligence/a2-rpc.js';
import { createRpcBudget } from '../../server/arc-intelligence/rpc-budget.js';
export const hash = (n) => `0x${n.toString(16).padStart(64,'0')}`;
export const address = (n) => `0x${n.toString(16).padStart(40,'0')}`;
export const transaction = (n,index=0) => ({hash:hash(100000+n*100+index),blockNumber:n,transactionIndex:index,
  from:address(1),to:index ? null : address(2),valueRaw:'900719925474099312345',inputSelector:'0x12345678'});
export const block = (n,count=1) => ({block_number:n,block_hash:hash(n+1),parent_hash:hash(n),timestamp:1700000000+n,
  transaction_count:count,transactions:Array.from({length:count},(_,i) => transaction(n,i))});
export function rawBlock(n,count=1) { return {number:`0x${n.toString(16)}`,hash:hash(n+1),parentHash:hash(n),timestamp:'0x6553f100',
  transactions:Array.from({length:count},(_,i) => ({...transaction(n,i),blockNumber:`0x${n.toString(16)}`,transactionIndex:`0x${i.toString(16)}`,
    blockHash:hash(n+1),value:'0x30d400000000000001',input:'0x12345678abcdef',from:address(1),to:i ? null : address(2)}))}; }
// Existing chain fixtures use the real A2 single/batch adapter with an injected transport.
export function fixtureChainRpc(rpc) {
  return createA2RpcClient({budget:createRpcBudget(),fetchImpl:async (url,init) => {
    assert.equal(url,ARC_RPC_URL);const body=JSON.parse(init.body);
    const respond=async ({id,method,params}) => ({jsonrpc:'2.0',id,result:await rpc.request(method,params,{signal:init.signal})});
    const payload=Array.isArray(body) ? await Promise.all(body.map(respond)) : await respond(body);
    return {status:200,ok:true,async json(){return payload;}};
  }});
}
const laneKey = (values) => JSON.stringify(values.slice(0,5));
const names = ['arc_intelligence_state','arc_intelligence_chunks','arc_intelligence_latest','arc_intelligence_runs'];
// SQL/state doubles follow the real repository calls. They do not certify a deployed Postgres instance.
export function fixturePool() {
  let store = { a1:{ id:1,chain_id:5042,source:ARC_RPC_URL,last_indexed_block:'99',last_indexed_hash:hash(100),next_block:'100' },
    migrations:new Map(),lanes:new Map(),blocks:new Map(),work:new Map(),coverage:new Map(),tables:new Set(names),nextId:1,transactions:new Map(),receipts:new Map(),logs:new Map(),reconciliation:new Map(),metricBuckets:new Map() };
  let clock = 1000000;
  let failure = null;
  const calls = [];
  function client() {
    let backup = null;
    let transactionOpen = false;
    return {
      async query(sql,values = []) {
        const text = sql.replace(/\s+/g,' ').trim();
        calls.push({text,values:structuredClone(values)});
        if (failure && text.includes(failure.operation)) { const message=failure.message;failure=null;throw new Error(message); }
        const rows = (value = []) => ({rows:structuredClone(value)});
        if (text === 'BEGIN') { backup=structuredClone(store); transactionOpen=true; return rows(); }
        if (text === 'COMMIT') { backup=null; transactionOpen=false; return rows(); }
        if (text === 'ROLLBACK') { if (backup) store=backup; transactionOpen=false; return rows(); }
        if (text.startsWith('SELECT pg_advisory_xact_lock')) { assert(transactionOpen); return rows(); }
        if (text.startsWith('CREATE TABLE') || text.startsWith('ALTER TABLE')) {
          for (const match of text.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)) store.tables.add(match[1]);
          return rows();
        }
        if (text.startsWith('SELECT * FROM arc_intelligence_migrations')) return rows(store.migrations.has(values[0]) ? [store.migrations.get(values[0])] : []);
        if (text.startsWith('INSERT INTO arc_intelligence_migrations')) {
          assert(!store.migrations.has(values[0]));
          store.migrations.set(values[0],{version:values[0],checksum:values[1],metadata:JSON.parse(values[2])}); return rows();
        }
        if (text === 'SELECT * FROM arc_intelligence_state WHERE id = 1') return rows(store.a1 ? [store.a1] : []);
        const parsed=text.match(/^\/\* (a2|receipts|metrics):(\w+) \*\//);
        const operation=parsed?.[1] !== 'a2' ? `${parsed?.[1]}_${parsed?.[2]}` : parsed?.[2];
        const lane = store.lanes.get(laneKey(values));
        switch (operation) {
          case 'metrics_hour': {
            if (text.endsWith('FOR SHARE OF b')) assert(transactionOpen);
            const blocks=[...store.blocks.values()].filter((b) => b.chain_id===values[0]);
            const ordered=blocks.sort((a,b) => a.timestamp-b.timestamp || a.block_number-b.block_number);
            const selected=[...ordered.filter((b) => b.timestamp>=values[5] && b.timestamp<values[6]).slice(0,values[7]).map((b) => ({...b,window_role:'inside'})),
              ...ordered.filter((b) => b.timestamp<values[5]).slice(-1).map((b) => ({...b,window_role:'before'})),
              ...ordered.filter((b) => b.timestamp>=values[6]).slice(0,1).map((b) => ({...b,window_role:'after'}))];
            return rows(selected.sort((a,b) => a.block_number-b.block_number).map((b) => {
              const c=[...store.coverage.values()].find((c) => laneKey(c.identity)===laneKey(values) && c.start===b.block_number
                && c.end===b.block_number && c.startHash===b.block_hash && c.endHash===b.block_hash && c.dimension==='receipts' && c.state==='complete');
              const certificate=(kind) => [...store.reconciliation.values()].find((r) => r.chain_id===values[0] && r.block_number===b.block_number
                && r.block_hash===b.block_hash && r.kind===kind && r.definition_version===values[4] && r.complete)?.evidence_digest ?? null;
              return {...b,receipts_digest:c?.digest ?? null,all_logs_digest:certificate('all_logs'),transfer_logs_digest:certificate('transfer_logs')};
            }));
          }
          case 'metrics_transactions': case 'metrics_receipts': {
            assert(!transactionOpen,'Heavy fact reads outside publish transaction');assert(text.includes('LIMIT $3'));
            const facts=operation==='metrics_transactions' ? store.transactions : store.receipts;
            return rows([...facts.values()].filter((r) => r.chain_id===values[0] && values[1].includes(r.block_number))
              .sort((a,b) => a.block_number-b.block_number || a.transaction_index-b.transaction_index).slice(0,values[2]));
          }
          case 'metrics_lock': assert(transactionOpen);return rows();
          case 'metrics_bucket': return rows(store.metricBuckets.has(JSON.stringify(values)) ? [store.metricBuckets.get(JSON.stringify(values))] : []);
          case 'metrics_upsert': {
            assert(transactionOpen);assert(text.includes('false,false'));assert(text.includes('WHERE arc_intelligence_metric_buckets.evidence_digest<>EXCLUDED.evidence_digest'));
            const columns=['chain_id','bucket_start','bucket_end','start_block','end_block','start_hash','end_hash','block_count',
              'definition_version','reducer_version','coverage_status','complete','metrics','coverage','evidence_digest'];
            const r=Object.fromEntries(columns.map((c,i) => [c,values[i]]));Object.assign(r,{period:'hour',required_reducers_complete:false,raw_prunable:false,
              metrics:JSON.parse(r.metrics),coverage:JSON.parse(r.coverage)});
            assert.equal(r.complete,r.coverage_status==='available');
            if (r.complete) for (const key of ['blockNumbersContiguous','parentHashesContinuous','timestampsMonotonic','receiptEvidenceComplete',
              'certificatesComplete','factSetsComplete','leftBoundaryCovered','rightBoundaryCovered','bounded']) assert.equal(r.coverage[key],true);
            const key=JSON.stringify([r.chain_id,r.period,r.bucket_start,r.definition_version,r.reducer_version]);
            if (store.metricBuckets.get(key)?.evidence_digest===r.evidence_digest) return rows();
            store.metricBuckets.set(key,r);return rows([r]);
          }
          case 'metrics_raw_counts': {
            const counts=Object.fromEntries(['transactions','receipts','logs','reconciliation'].map((table) => [table,String([...store[table].values()]
              .filter((r) => r.chain_id===values[0] && values[1].includes(r.block_number)).slice(0,values[2]).length)]));
            counts.coverage=String([...store.coverage.values()].filter((r) => r.identity[0]===values[0] && r.start>=values[3] && r.end<=values[4]).slice(0,values[2]).length);
            return rows([counts]);
          }
          case 'metrics_unresolved': {
            const counts=new Map();for (const w of store.work.values()) if (w.chain_id===values[0] && w.start_block<=values[2] && w.end_block>=values[1] && w.state!=='complete')
              counts.set(w.state,(counts.get(w.state) ?? 0)+1);
            return rows([...counts].map(([state,count]) => ({state,count:String(count)})));
          }
          case 'anchor': assert(text.endsWith('FOR UPDATE')); return rows(store.migrations.has(values[0]) ? [{metadata:store.migrations.get(values[0]).metadata}] : []);
          case 'capture_anchor': {
            assert(transactionOpen);
            const migration=store.migrations.get(values[0]);
            if (migration?.metadata.anchor === null) migration.metadata=JSON.parse(values[1]);
            return rows();
          }
          case 'initialize': {
            if (!lane) store.lanes.set(laneKey(values),{chain_id:values[0],lane:values[1],scope_id:values[2],epoch:values[3],definition_version:values[4],
              origin_block:values[5],anchor_block:values[6],anchor_hash:values[7],anchor_next_block:values[5],processed_through:null,
              contiguous_complete_through:null,checkpoint_hash:null,observed_head:null,status:'starting',current_error_code:null,last_success_at:null});
            return rows();
          }
          case 'lane': return rows(lane ? [lane] : []);
          case 'status': {
            if (lane && lane.status !== 'continuity_error') Object.assign(lane,{status:values[5],current_error_code:values[6],observed_head:values[7] ?? lane.observed_head});
            return rows();
          }
          case 'neighbors': return rows([...store.blocks.values()].filter((b) => b.block_number >= values[1] && b.block_number <= values[2]).sort((a,b) => a.block_number-b.block_number));
          case 'halt': Object.assign(lane,{status:'continuity_error',current_error_code:values[5]}); return rows();
          case 'block': {
            if (!store.blocks.has(values[1])) store.blocks.set(values[1],{chain_id:values[0],block_number:values[1],block_hash:values[2],parent_hash:values[3],
              timestamp:values[4],transaction_count:values[5],receipt_count:null,receipt_complete:false,
              all_log_reconciliation_complete:false,transfer_log_reconciliation_complete:false,core_complete:false,transactions_complete:false,receipt_bulk_attempted:false,receipt_evidence_conflict:false});
            return rows();
          }
          case 'transactions': return rows([...store.transactions.values()].filter((t) => t.block_number === values[1] || values[2].includes(t.transaction_hash)).sort((a,b) => a.transaction_index-b.transaction_index));
          case 'transaction': {
            const columns=['chain_id','block_number','block_hash','transaction_index','transaction_hash','from_address','to_address','value_raw','input_selector'];
            const t=Object.fromEntries(columns.map((c,i) => [c,values[i]]));
            if (!store.transactions.has(t.transaction_hash)) store.transactions.set(t.transaction_hash,t);
            return rows();
          }
          case 'transaction_count': return rows([{count:String([...store.transactions.values()].filter((t) => t.block_number === values[1]).length)}]);
          case 'transactions_complete': store.blocks.get(values[1]).transactions_complete=true; return rows();
          case 'advance': return rows([...store.blocks.values()].filter((b) => b.block_number >= values[1]).sort((a,b) => a.block_number-b.block_number).slice(0,values[2]));
          case 'coverage': {
            assert.equal(values[9],'chain_manifest','Chain repository emits only chain manifest evidence');
            store.coverage.set(JSON.stringify([...values.slice(0,7),values[9]]),{identity:values.slice(0,5),start:values[5],end:values[6],
              startHash:values[7],endHash:values[8],dimension:values[9],digest:values[10],state:values[11]}); return rows();
          }
          case 'promote_coverage': {
            for (const record of store.coverage.values()) if (laneKey(record.identity) === laneKey(values) && record.end <= values[5]) record.state='complete';
            return rows();
          }
          case 'progress': Object.assign(lane,{processed_through:values[5],contiguous_complete_through:values[6],checkpoint_hash:values[7],
            status:'indexing',current_error_code:null,last_success_at:clock}); return rows();
          case 'work_existing': return rows([...store.work.values()].filter((w) => laneKey([w.chain_id,w.lane,w.scope_id,w.epoch,w.definition_version]) === laneKey(values)
            && w.component === values[5] && w.logical_key === values[6]));
          case 'followups_existing': {
            assert(transactionOpen);assert(text.includes('component=ANY($6::text[])'));assert(text.endsWith('LIMIT 2'));
            assert(values[5].length<=2 && new Set(values[5]).size===values[5].length);
            assert(values[5].every((c) => ['all_logs','transfer_logs'].includes(c)));
            return rows([...store.work.values()].filter((w) => laneKey([w.chain_id,w.lane,w.scope_id,w.epoch,w.definition_version])===laneKey(values)
              && values[5].includes(w.component) && w.logical_key===values[6]).slice(0,2));
          }
          case 'work_count': return rows([{count:String([...store.work.values()].filter((w) => w.state !== 'complete').length)}]);
          case 'prune_complete': {
            assert(transactionOpen);assert(text.includes("w.state='complete'"));assert(text.includes('FOR UPDATE OF w SKIP LOCKED'));
            const obsolete=[...store.work.values()].filter((w) => w.state === 'complete').sort((a,b) => Number(b.id)-Number(a.id)).slice(values[0],values[0]+values[1]);
            for (const w of obsolete) store.work.delete(w.id);return rows();
          }
          case 'enqueue': {
            const id=String(store.nextId++);
            const work={id,chain_id:values[0],lane:values[1],scope_id:values[2],epoch:values[3],definition_version:values[4],component:values[5],logical_key:values[6],
              start_block:values[7],end_block:values[8],block_hash:values[9],state:'pending',attempts:0,not_before:clock,
              lease_owner:null,lease_until:null,fencing_token:'0',reason_code:null};
            store.work.set(id,work); return rows([work]);
          }
          case 'enqueue_followups': {
            assert(transactionOpen);assert(text.includes('FROM unnest($6::text[])'));assert(text.endsWith('RETURNING *'));
            assert(values[5].length>0 && values[5].length<=2 && new Set(values[5]).size===values[5].length);
            const inserted=values[5].map((component) => {
              assert(['all_logs','transfer_logs'].includes(component));
              assert(![...store.work.values()].some((w) => laneKey([w.chain_id,w.lane,w.scope_id,w.epoch,w.definition_version])===laneKey(values)
                && w.component===component && w.logical_key===values[6]),'Logical work identity remains unique');
              const id=String(store.nextId++),work={id,chain_id:values[0],lane:values[1],scope_id:values[2],epoch:values[3],definition_version:values[4],
                component,logical_key:values[6],start_block:values[7],end_block:values[7],block_hash:values[6],state:'pending',attempts:0,
                not_before:clock,lease_owner:null,lease_until:null,fencing_token:'0',reason_code:null};
              store.work.set(id,work);return work;
            });return rows(inserted);
          }
          case 'claim': {
            assert(text.includes('FOR UPDATE SKIP LOCKED'));
            const work=[...store.work.values()].filter((w) => laneKey([w.chain_id,w.lane,w.scope_id,w.epoch,w.definition_version]) === laneKey(values)
              && w.not_before <= clock && (['pending','retrying'].includes(w.state) || (w.state === 'leased' && w.lease_until <= clock)))
              .sort((a,b) => Number(b.component === values[7])-Number(a.component === values[7])
                || a.not_before-b.not_before || (BigInt(a.id)<BigInt(b.id) ? -1 : 1))[0];
            if (!work) return rows();
            Object.assign(work,{state:'leased',attempts:work.attempts+1,fencing_token:(BigInt(work.fencing_token)+1n).toString(),lease_owner:values[5],lease_until:clock+values[6]});
            return rows([work]);
          }
          case 'receipts_claim_logs': {
            assert(transactionOpen);assert(text.includes('FOR UPDATE SKIP LOCKED'));assert(text.includes('ORDER BY start_block,not_before,id LIMIT $11'));
            assert(['all_logs','transfer_logs'].includes(values[7]));assert(values[9]-values[8]<50);assert(values[10]>=1 && values[10]<50);
            const jobs=[...store.work.values()].filter((w) => laneKey([w.chain_id,w.lane,w.scope_id,w.epoch,w.definition_version])===laneKey(values)
              && w.component===values[7] && w.start_block>=values[8] && w.start_block<=values[9] && w.end_block===w.start_block
              && !w.locked && w.not_before<=clock && (['pending','retrying'].includes(w.state) || (w.state==='leased' && w.lease_until<=clock)))
              .sort((a,b) => a.start_block-b.start_block || a.not_before-b.not_before || (BigInt(a.id)<BigInt(b.id) ? -1 : 1)).slice(0,values[10]);
            for (const w of jobs) Object.assign(w,{state:'leased',attempts:w.attempts+1,fencing_token:(BigInt(w.fencing_token)+1n).toString(),
              lease_owner:values[5],lease_until:clock+values[6]});
            return rows(jobs);
          }
          case 'lease_guard': {
            assert(transactionOpen); assert(text.endsWith('FOR UPDATE'));
            const work=store.work.get(String(values[0]));
            return rows(work?.state === 'leased' && work.lease_owner === values[1] && work.fencing_token === String(values[2]) && work.lease_until > clock ? [work] : []);
          }
          case 'finish': Object.assign(store.work.get(String(values[0])),{state:'complete',lease_owner:null,lease_until:null,reason_code:null}); return rows();
          case 'result': {
            const work=store.work.get(String(values[0]));
            Object.assign(work,{state:values[1],reason_code:values[2],not_before:clock+values[3],lease_owner:null,lease_until:null}); return rows([work]);
          }
          case 'receipts_deferred': {
            assert(text.includes('ORDER BY block_number LIMIT $7'));
            return rows([...store.blocks.values()].filter((b) => b.block_number>=values[5]).sort((a,b) => a.block_number-b.block_number).slice(0,values[6]).map((b) => ({
              block_number:b.block_number,needs_followups:b.transactions_complete && b.receipt_complete && !b.receipt_evidence_conflict
                && ['all_logs','transfer_logs'].some((component) => ![...store.reconciliation.values()].some((r) => r.block_number===b.block_number
                  && r.block_hash===b.block_hash && r.kind===component && r.definition_version===values[4] && r.complete)
                  && ![...store.work.values()].some((w) => laneKey([w.chain_id,w.lane,w.scope_id,w.epoch,w.definition_version])===laneKey(values)
                    && w.component===component && w.logical_key===b.block_hash)),
            })));
          }
          case 'receipts_work_pressure': {
            assert(text.includes("state <> 'complete'"));assert.equal(values.length,5);
            const jobs=[...store.work.values()].filter((w) => laneKey([w.chain_id,w.lane,w.scope_id,w.epoch,w.definition_version]) === laneKey(values)
              && w.state !== 'complete');
            return rows([{outstanding:String(jobs.length)}]);
          }
          case 'receipts_work_counts': {
            assert(text.includes("state IN ('pending','retrying','leased')"));
            const jobs=[...store.work.values()].filter((w) => laneKey([w.chain_id,w.lane,w.scope_id,w.epoch,w.definition_version]) === laneKey(values));
            return rows([{pending:String(jobs.filter((w) => w.state==='pending').length),
              retrying:String(jobs.filter((w) => w.state==='retrying').length),leased:String(jobs.filter((w) => w.state==='leased').length)}]);
          }
          case 'receipts_recent': {
            assert.equal(values[4],5042);assert.equal(values[5],'receipts_logs');assert.equal(values[6],'canonical_receipts_logs');
            assert.equal(typeof values[7],'string');assert.equal(typeof values[8],'string');
            const hasWork=(b,component) => [...store.work.values()].some((w) =>
              laneKey([w.chain_id,w.lane,w.scope_id,w.epoch,w.definition_version])===laneKey(values.slice(4))
              && w.component===component && w.logical_key===b.block_hash && w.block_hash===b.block_hash
              && w.start_block===b.block_number && w.end_block===b.block_number);
            return rows([...store.blocks.values()].filter((b) => b.block_number >= values[1] && b.block_number <= values[2]
            && b.transactions_complete && !b.receipt_evidence_conflict
            && !(b.receipt_complete && b.all_log_reconciliation_complete && b.transfer_log_reconciliation_complete)
            && ((!b.receipt_complete && !hasWork(b,'receipts'))
              || (b.receipt_complete && !b.all_log_reconciliation_complete && !hasWork(b,'all_logs'))
              || (b.receipt_complete && !b.transfer_log_reconciliation_complete && !hasWork(b,'transfer_logs'))))
            .sort((a,b) => a.block_number-b.block_number).slice(0,values[3]).map((b) => ({block_number:b.block_number})));
          }
          case 'receipts_block': {
            if (text.endsWith('FOR UPDATE')) assert(transactionOpen);
            return rows(store.blocks.has(values[1]) ? [store.blocks.get(values[1])] : []);
          }
          case 'receipts_facts': {
            assert.equal((text.match(/ UNION ALL /g) ?? []).length,3);
            assert(text.endsWith('ORDER BY fact_kind,transaction_index,log_index'));
            assert(!/json|row_to_json/i.test(text));
            const tables=['transactions','receipts','logs','reconciliation'];
            return rows(tables.flatMap((table,fact_kind) => [...store[table].values()]
              .filter((r) => r.chain_id===values[0] && r.block_number===values[1]
                && (table!=='reconciliation' || r.definition_version===values[2]))
              .sort((a,b) => table==='logs' ? a.log_index-b.log_index
                : table==='reconciliation' ? 0 : a.transaction_index-b.transaction_index)
              .map((r) => ({fact_kind,...r}))));
          }
          case 'receipts_transactions': return rows([...store.transactions.values()].filter((t) => t.block_number === values[1]).sort((a,b) => a.transaction_index-b.transaction_index));
          case 'receipts_receipts': return rows([...store.receipts.values()].filter((r) => r.block_number === values[1]).sort((a,b) => a.transaction_index-b.transaction_index));
          case 'receipts_logs': return rows([...store.logs.values()].filter((l) => l.block_number === values[1]).sort((a,b) => a.log_index-b.log_index));
          case 'receipts_evidence': return rows([...store.reconciliation.values()].filter((r) => r.block_number === values[1] && r.definition_version === values[2]));
          case 'receipts_lane': return rows(lane ? [lane] : []);
          case 'receipts_bulk_attempted': store.blocks.get(values[1]).receipt_bulk_attempted=true; return rows();
          case 'receipts_insert_receipt': {
            const columns=['chain_id','block_number','block_hash','transaction_index','transaction_hash','status','gas_used_raw','effective_gas_price_raw','contract_address'];
            const r=Object.fromEntries(columns.map((c,i) => [c,values[i]]));
            const t=store.transactions.get(r.transaction_hash);
            assert(t && t.block_number === r.block_number && t.block_hash === r.block_hash && t.transaction_index === r.transaction_index,'Known transaction FK');
            assert(!store.receipts.has(r.transaction_hash),'Receipt primary key'); store.receipts.set(r.transaction_hash,r); return rows();
          }
          case 'receipts_insert_log': {
            const columns=['chain_id','block_number','block_hash','transaction_index','transaction_hash','log_index','address','topics','data','removed'];
            const l=Object.fromEntries(columns.map((c,i) => [c,values[i]]));
            assert(store.receipts.has(l.transaction_hash),'Receipt FK');
            const key=`${l.block_number}:${l.log_index}`; if (!store.logs.has(key)) store.logs.set(key,l); return rows();
          }
          case 'receipts_certify': {
            const b=store.blocks.get(values[1]); if (values[2]) b.receipt_count=values[3]; b.receipt_complete ||= values[2]; return rows();
          }
          case 'receipts_coverage': {
            assert(['receipts','all_log_reconciliation','transfer_log_reconciliation'].includes(values[7]));
            const key=JSON.stringify([...values.slice(0,5),values[5],values[5],values[7]]);
            if (store.coverage.get(key)?.state !== 'complete') store.coverage.set(key,{identity:values.slice(0,5),start:values[5],end:values[5],
              startHash:values[6],endHash:values[6],dimension:values[7],digest:values[8],state:values[9]}); return rows();
          }
          case 'receipts_advance': return rows([...store.blocks.values()].filter((b) => b.block_number >= values[1] && b.block_number <= values[7]).sort((a,b) => a.block_number-b.block_number).slice(0,values[2]).map((b) => ({...b,
            receipt_coverage_complete:[...store.coverage.values()].some((c) => c.identity[1] === values[4] && c.identity[2] === values[5] && c.identity[3] === values[6] && c.identity[4] === values[3]
              && c.start === b.block_number && c.dimension === 'receipts' && c.state === 'complete'),
            all_evidence_complete:[...store.reconciliation.values()].some((r) => r.block_number === b.block_number && r.kind === 'all_logs' && r.definition_version === values[3] && r.complete),
            transfer_evidence_complete:[...store.reconciliation.values()].some((r) => r.block_number === b.block_number && r.kind === 'transfer_logs' && r.definition_version === values[3] && r.complete),
          })));
          case 'receipts_retry_count': return rows([{count:String([...store.work.values()].filter((w) => laneKey([w.chain_id,w.lane,w.scope_id,w.epoch,w.definition_version]) === laneKey(values)
            && (w.state === 'retrying' || (w.state === 'leased' && w.reason_code !== null))).length)}]);
          case 'receipts_progress': Object.assign(lane,{processed_through:values[5],contiguous_complete_through:values[6],checkpoint_hash:values[7],status:values[8],current_error_code:values[9]}); return rows();
          case 'receipts_reconciliation': {
            const columns=['chain_id','block_number','block_hash','kind','definition_version','receipt_log_count','queried_log_count','missing_count','extra_count','duplicate_receipt_count',
              'duplicate_query_count','identityless_receipt_count','identityless_query_count','payload_mismatch_count','query_complete','complete','evidence_digest','reason_code'];
            const r=Object.fromEntries(columns.map((c,i) => [c,values[i]])); const key=`${r.block_number}:${r.kind}:${r.definition_version}`;
            if (!store.reconciliation.get(key)?.complete) store.reconciliation.set(key,r); return rows();
          }
          case 'receipts_log_certify': {
            const b=store.blocks.get(values[1]); const key=text.includes('SET all_log_reconciliation_complete') ? 'all_log_reconciliation_complete' : 'transfer_log_reconciliation_complete';
            b[key] ||= values[2]; return rows();
          }
          case 'receipts_conflict_count': return rows([{count:String([...store.work.values()].filter((w) => laneKey([w.chain_id,w.lane,w.scope_id,w.epoch,w.definition_version]) === laneKey(values) && w.state === 'persistent_partial' && w.reason_code === 'manifest_conflict').length)}]);
          case 'receipts_conflict': { const b=store.blocks.get(Number(values[1])); Object.assign(b,{receipt_evidence_conflict:true,receipt_complete:false,all_log_reconciliation_complete:false,transfer_log_reconciliation_complete:false,core_complete:false}); return rows(); }
          case 'receipts_invalidate_coverage': {
            assert(transactionOpen);
            assert(text.includes('start_block=$6 AND end_block=$6'));
            for (const c of store.coverage.values()) {
              if (laneKey(c.identity) === laneKey(values) && c.start === values[5] && c.end === values[5]
                && c.state === 'complete' && ['receipts','all_log_reconciliation','transfer_log_reconciliation'].includes(c.dimension)) c.state='partial';
            }
            return rows();
          }
          default: throw new Error(`Unhandled SQL fixture: ${text}`);
        }
      },
      release() { assert.equal(transactionOpen,false,'No transaction survives repository return'); },
    };
  }
  return {calls,get store() {return store;},advance(ms) {clock+=ms;},fail(operation,message='Injected failure') {failure={operation,message};},
    async connect() {return client();},async query(...args) {return client().query(...args);} };
}
