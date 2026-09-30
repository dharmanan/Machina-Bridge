import assert from 'node:assert/strict';
import { ARC_RPC_URL } from '../../api/_lib/arc-intelligence/rpc.js';
export const hash = (n) => `0x${n.toString(16).padStart(64,'0')}`;
export const address = (n) => `0x${n.toString(16).padStart(40,'0')}`;
export const transaction = (n,index=0) => ({hash:hash(100000+n*100+index),blockNumber:n,transactionIndex:index,
  from:address(1),to:index ? null : address(2),valueRaw:'900719925474099312345',inputSelector:'0x12345678'});
export const block = (n,count=1) => ({block_number:n,block_hash:hash(n+1),parent_hash:hash(n),timestamp:1700000000+n,
  transaction_count:count,transactions:Array.from({length:count},(_,i) => transaction(n,i))});
export function rawBlock(n,count=1) { return {number:`0x${n.toString(16)}`,hash:hash(n+1),parentHash:hash(n),timestamp:'0x6553f100',
  transactions:Array.from({length:count},(_,i) => ({...transaction(n,i),blockNumber:`0x${n.toString(16)}`,transactionIndex:`0x${i.toString(16)}`,
    blockHash:hash(n+1),value:'0x30d400000000000001',input:'0x12345678abcdef',from:address(1),to:i ? null : address(2)}))}; }
const laneKey = (values) => JSON.stringify(values.slice(0,5));
const names = ['arc_intelligence_state','arc_intelligence_chunks','arc_intelligence_latest','arc_intelligence_runs'];
// SQL/state doubles follow the real repository calls. They do not certify a deployed Postgres instance.
export function fixturePool() {
  let store = { a1:{ id:1,chain_id:5042,source:ARC_RPC_URL,last_indexed_block:'99',last_indexed_hash:hash(100),next_block:'100' },
    migrations:new Map(),lanes:new Map(),blocks:new Map(),work:new Map(),coverage:new Map(),tables:new Set(names),nextId:1,transactions:new Map(),receipts:new Map(),logs:new Map(),reconciliation:new Map() };
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
        if (failure && text.includes(failure)) { failure = null; throw new Error('Injected failure'); }
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
        const parsed=text.match(/^\/\* (a2|receipts):(\w+) \*\//);
        const operation=parsed?.[1] === 'receipts' ? `receipts_${parsed[2]}` : parsed?.[2];
        const lane = store.lanes.get(laneKey(values));
        switch (operation) {
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
          case 'receipts_work_counts': {
            assert(text.includes("state IN ('pending','retrying','leased')"));
            const jobs=[...store.work.values()].filter((w) => laneKey([w.chain_id,w.lane,w.scope_id,w.epoch,w.definition_version]) === laneKey(values));
            return rows([{pending:String(jobs.filter((w) => w.state==='pending').length),
              retrying:String(jobs.filter((w) => w.state==='retrying').length),leased:String(jobs.filter((w) => w.state==='leased').length)}]);
          }
          case 'receipts_recent': return rows([...store.blocks.values()].filter((b) => b.block_number >= values[1] && b.block_number <= values[2]
            && b.transactions_complete && !b.receipt_evidence_conflict
            && !(b.receipt_complete && b.all_log_reconciliation_complete && b.transfer_log_reconciliation_complete))
            .sort((a,b) => a.block_number-b.block_number).slice(0,values[3]).map((b) => ({block_number:b.block_number})));
          case 'receipts_block': return rows(store.blocks.has(values[1]) ? [store.blocks.get(values[1])] : []);
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
  return {calls,get store() {return store;},advance(ms) {clock+=ms;},fail(operation) {failure=operation;},
    async connect() {return client();},async query(...args) {return client().query(...args);} };
}
