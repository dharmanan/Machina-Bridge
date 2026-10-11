// Sparse official pool birth witnesses for an independent lab. No global registry-coverage claim.
// Empty search ranges and found witnesses survive restart; raw transaction bodies are never requested.
import { normalizeLog } from '../../api/_lib/arc-intelligence/normalize.js';
import { poolRecordOf } from '../compact/registry.js';
import { v4PoolRecordOf, validV4Record } from '../compact/projections.js';
import { LOG_STREAMS, V4_INITIALIZE_STREAM } from '../compact/sources.js';
import { validateLogs } from '../compact/logs.js';
import { headerOf } from '../compact/spine.js';
import { codeIsPresent } from '../compact/registry.js';
import { v4StateSlot } from '../compact/tvl.js';
import { hash, json, fail, assertHeapBudget } from './storage.js';
const H=/^0x[0-9a-f]{64}$/,A=/^0x[0-9a-f]{40}$/;
const hex=n=>'0x'+n.toString(16);
const SQL=`CREATE TABLE IF NOT EXISTS arc_pipeline_pool_searches(search_sha TEXT PRIMARY KEY,definition_json TEXT NOT NULL,
  next_block INTEGER NOT NULL) STRICT;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_pool_search_definition_immutable BEFORE UPDATE OF search_sha,definition_json ON arc_pipeline_pool_searches
BEGIN SELECT RAISE(ABORT,'pool_search_definition_immutable'); END;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_pool_search_definition_no_delete BEFORE DELETE ON arc_pipeline_pool_searches
BEGIN SELECT RAISE(ABORT,'pool_search_definition_immutable'); END;
CREATE TABLE IF NOT EXISTS arc_pipeline_pool_search_ranges(search_sha TEXT NOT NULL,first_block INTEGER NOT NULL,last_block INTEGER NOT NULL,
  response_sha TEXT NOT NULL,PRIMARY KEY(search_sha,first_block)) STRICT,WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_pool_range_immutable BEFORE UPDATE ON arc_pipeline_pool_search_ranges
BEGIN SELECT RAISE(ABORT,'pool_search_range_immutable'); END;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_pool_range_no_delete BEFORE DELETE ON arc_pipeline_pool_search_ranges
BEGIN SELECT RAISE(ABORT,'pool_search_range_immutable'); END;
CREATE TABLE IF NOT EXISTS arc_pipeline_pool_witnesses(protocol TEXT NOT NULL,pool TEXT NOT NULL,
  source_sha TEXT NOT NULL,proof_json TEXT NOT NULL,proof_sha TEXT NOT NULL,PRIMARY KEY(protocol,pool)) STRICT,WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_pool_witness_immutable BEFORE UPDATE ON arc_pipeline_pool_witnesses
BEGIN SELECT RAISE(ABORT,'pool_witness_immutable'); END;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_pool_witness_no_delete BEFORE DELETE ON arc_pipeline_pool_witnesses
BEGIN SELECT RAISE(ABORT,'pool_witness_immutable'); END;`;
const STATE_SQL=`CREATE TABLE IF NOT EXISTS arc_pipeline_pool_state_points(search_sha TEXT NOT NULL,pool TEXT NOT NULL,
  block INTEGER NOT NULL,slot_value TEXT NOT NULL,wire_sha TEXT NOT NULL,PRIMARY KEY(search_sha,pool,block)) STRICT,WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_pool_state_point_immutable BEFORE UPDATE ON arc_pipeline_pool_state_points
BEGIN SELECT RAISE(ABORT,'pool_state_point_immutable'); END;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_pool_state_point_no_delete BEFORE DELETE ON arc_pipeline_pool_state_points
BEGIN SELECT RAISE(ABORT,'pool_state_point_immutable'); END;`;
const word=n=>BigInt(n).toString(16).padStart(64,'0');
export function readPoolWitness(db,protocol,pool) {
  const row=db.prepare('SELECT * FROM arc_pipeline_pool_witnesses WHERE protocol=? AND pool=?').get(protocol,pool);
  if(!row)return null;if(hash(row.proof_json)!==row.proof_sha)fail('pool_witness_corrupt');
  const proof=JSON.parse(row.proof_json),origin=db.prepare('SELECT definition_json FROM arc_pipeline_pool_searches WHERE search_sha=?').get(row.source_sha);
  if(!origin||hash(origin.definition_json)!==row.source_sha)fail('pool_witness_source_corrupt');
  const definition=JSON.parse(origin.definition_json),stream=protocol==='uniswap_v3'?LOG_STREAMS.find(s=>s.key==='v3Factory'):V4_INITIALIZE_STREAM;
  if(definition.version!=='official-pool-birth-witness-v1'||definition.chainId!==5042||definition.protocol!==protocol
    ||json(definition.stream)!==json(stream)||!definition.pools.includes(pool)||proof.sourceSha!==row.source_sha
    ||proof.definition!==definition.version||proof.protocol!==protocol||proof.emitter!==stream.address[0]
    ||json(proof.canonicalReference)!==json(definition.reference)||proof.blockHash!==proof.event.blockHash
    ||proof.record.createdBlock<definition.validFrom||proof.record.createdBlock>=definition.reference.firstBlock
    ||proof.transactionMembershipVerified!==true)fail('pool_witness_corrupt');
  const decoded=protocol==='uniswap_v3'?poolRecordOf(normalizeLog(proof.event)):v4PoolRecordOf(normalizeLog(proof.event));
  if(!decoded||json(decoded)!==json(proof.record)||(protocol==='uniswap_v4'&&!validV4Record(decoded))
    ||decoded[protocol==='uniswap_v3'?'address':'poolId']!==pool)fail('pool_witness_corrupt');
  return{...proof,proofSha:row.proof_sha};
}
export function createPoolWitnessLookup(p,{protocol,pools,reference,validFromBlock,v3Records=new Map(),lookupStrategy='reverse_ranges_v1'}={}) {
  assertHeapBudget();if(p.readOnly||!['uniswap_v3','uniswap_v4'].includes(protocol)||!Array.isArray(pools)
    ||pools.length<1||pools.length>256||new Set(pools).size!==pools.length
    ||!pools.every(v=>(protocol==='uniswap_v3'?A:H).test(v))||!Number.isSafeInteger(reference?.firstBlock)
    ||!Number.isSafeInteger(reference?.lastBlock)||!H.test(reference?.lastHash??'')
    ||!/^[0-9a-f]{64}$/.test(reference?.canonicalSha??'')||!Number.isSafeInteger(validFromBlock)
    ||validFromBlock<0||validFromBlock>=reference.firstBlock||reference.lastBlock<reference.firstBlock
    ||!['reverse_ranges_v1','slot0_transition_v1'].includes(lookupStrategy))fail('pool_witness_inputs_invalid');
  const stream=protocol==='uniswap_v3'?LOG_STREAMS.find(s=>s.key==='v3Factory'):V4_INITIALIZE_STREAM;
  const validFrom=validFromBlock;
  const definition={version:'official-pool-birth-witness-v1',chainId:5042,protocol,stream,
    validFrom,reference,pools:[...pools].sort(),scope:'requested_pool_witnesses_only',lookupStrategy};
  const definitionJson=json(definition),searchSha=hash(definitionJson);
  p.transaction(()=>{p.db.exec(SQL);p.db.exec(STATE_SQL);p.db.prepare('INSERT OR IGNORE INTO arc_pipeline_pool_searches VALUES(?,?,?)')
    .run(searchSha,definitionJson,reference.firstBlock-1);
    if(p.db.prepare('SELECT definition_json FROM arc_pipeline_pool_searches WHERE search_sha=?').get(searchSha)?.definition_json!==definitionJson)fail('pool_search_conflict');});
  const read=pool=>{
    const proof=readPoolWitness(p.db,protocol,pool);
    if(proof&&(proof.record.createdBlock<validFrom||proof.record.createdBlock>=reference.firstBlock))fail('pool_witness_reference_conflict');
    return proof;
  };
  function save(proof) {
    const text=json(proof),old=read(proof.record[protocol==='uniswap_v3'?'address':'poolId']);
    if(old&&json(old.record)!==json(proof.record))fail('pool_witness_conflict');
    if(!old)p.db.prepare('INSERT INTO arc_pipeline_pool_witnesses VALUES(?,?,?,?,?)')
      .run(protocol,proof.record[protocol==='uniswap_v3'?'address':'poolId'],proof.sourceSha,text,hash(text));
  }
  async function run(bounded,{maxSteps=128,afterAccept}={}) {
    if(!bounded?.provider?.canContinue||!Number.isInteger(maxSteps)||maxSteps<1||maxSteps>512)fail('bounded_pool_witness_worker_required');
    const unresolved=()=>definition.pools.filter(pool=>!read(pool));
    if(!unresolved().length)return{completeRequestedPoolWitnesses:true,additionalRequests:0,globalRegistryCoverageComplete:false};
    const provider=bounded.provider,priorRequests=bounded.stats.requests;
    p.guard(8*1024*1024);
    const anchor=await provider.request('eth_getBlockByNumber',[hex(reference.lastBlock),false]);
    if(headerOf(anchor,reference.lastBlock).hash!==reference.lastHash)fail('pool_witness_anchor_conflict');
    for(const n of[validFrom,reference.lastBlock])if(!codeIsPresent(await provider.request('eth_getCode',[stream.address[0],hex(n)])))fail('pool_witness_source_not_deployed');
    async function verify(raw) {
      const n=normalizeLog(raw).blockNumber;
      const block=await provider.request('eth_getBlockByNumber',[hex(n),false]),header=headerOf(block,n);
      if(!Array.isArray(block.transactions)||!block.transactions.every(h=>H.test(h)))fail('pool_witness_block_invalid');
      const logs=validateLogs([raw],stream,{fromBlock:n,toBlock:n,window:new Map([[n,{...header,txHashes:block.transactions}]]),seen:new Set()});
      const record=protocol==='uniswap_v3'?poolRecordOf(logs[0]):v4PoolRecordOf(logs[0]);
      if(!record||(protocol==='uniswap_v4'&&!validV4Record(record)))fail('pool_birth_invalid');
      const pool=record[protocol==='uniswap_v3'?'address':'poolId'];
      if(!definition.pools.includes(pool)||n<validFrom||n>=reference.firstBlock)fail('pool_birth_outside_scope');
      return{definition:definition.version,sourceSha:searchSha,protocol,record,emitter:stream.address[0],
        blockHash:header.hash,blockTimestamp:header.timestamp,event:{address:raw.address,topics:raw.topics,data:raw.data,
          blockNumber:raw.blockNumber,blockHash:raw.blockHash,transactionHash:raw.transactionHash,
          transactionIndex:raw.transactionIndex,logIndex:raw.logIndex,removed:false},
        transactionMembershipVerified:true,canonicalReference:reference};
    }
    async function initialized(pool,n) {
      let point=p.db.prepare('SELECT * FROM arc_pipeline_pool_state_points WHERE search_sha=? AND pool=? AND block=?').get(searchSha,pool,n);
      if(!point){
        // Same PoolManager.extsloadMany ABI and StateLibrary slot calculation as the existing verified TVL reader.
        // This predicate narrows a search only: an exact canonical Initialize event is still mandatory.
        const raw=await provider.request('eth_call',[{to:stream.address[0],data:'0xdbd035ff'+word(32)+word(1)+word(v4StateSlot(pool))},hex(n)]);
        if(typeof raw!=='string'||!/^0x[0-9a-f]{192}$/.test(raw)||raw.slice(2,66)!==word(32)||raw.slice(66,130)!==word(1))fail('pool_state_lookup_unverified');
        point={slot_value:raw.slice(130),wire_sha:hash(raw)};
        p.transaction(()=>p.db.prepare('INSERT INTO arc_pipeline_pool_state_points VALUES(?,?,?,?,?)').run(searchSha,pool,n,point.slot_value,point.wire_sha),65536);
      }
      if(!/^[0-9a-f]{64}$/.test(point.slot_value)||hash('0x'+word(32)+word(1)+point.slot_value)!==point.wire_sha)fail('pool_state_point_corrupt');
      return (BigInt('0x'+point.slot_value)&((1n<<160n)-1n))!==0n;
    }
    let acceptedRanges=0;
    for(let step=0;step<maxSteps&&unresolved().length&&provider.canContinue();step++) {
      p.guard(8*1024*1024);
      if(protocol==='uniswap_v3') {
        const pool=unresolved()[0],candidate=v3Records.get(pool);
        if(!candidate||candidate.created_block>=reference.firstBlock||!H.test(candidate.created_tx))fail('pool_birth_candidate_missing');
        const meta=JSON.parse(candidate.meta_json);
        if(!A.test(meta.token0)||!A.test(meta.token1)||!Number.isSafeInteger(meta.fee)||meta.fee<0)fail('pool_birth_candidate_invalid');
        // PoolCreated already proves a successful factory creation. Read its exact indexed event at
        // the candidate block; transaction receipts or complete transaction bodies are unnecessary.
        const logs=await provider.request('eth_getLogs',[{address:stream.address[0],
          topics:[stream.topics[0],'0x'+meta.token0.slice(2).padStart(64,'0'),'0x'+meta.token1.slice(2).padStart(64,'0'),
            '0x'+meta.fee.toString(16).padStart(64,'0')],fromBlock:hex(candidate.created_block),toBlock:hex(candidate.created_block)}]);
        if(!Array.isArray(logs)||logs.length>=10000)fail('pool_birth_response_invalid');
        const matches=logs.filter(l=>l.address===stream.address[0]&&l.topics?.[0]===stream.topics[0])
          .filter(l=>poolRecordOf(normalizeLog(l))?.address===pool);
        if(matches.length!==1)fail('pool_birth_evidence_missing');
        const proof=await verify(matches[0]);
        if(proof.record.createdTx!==candidate.created_tx||proof.record.createdLogIndex!==candidate.created_log_index)fail('pool_birth_candidate_conflict');
        for(const k of['token0','token1','fee','tickSpacing'])if(proof.record[k]!==meta[k])fail('pool_birth_candidate_conflict');
        p.transaction(()=>save(proof),Buffer.byteLength(json(proof))+65536);afterAccept?.();
      } else if(lookupStrategy==='slot0_transition_v1') {
        const pool=unresolved()[0];let low=validFrom,high=reference.firstBlock-1;
        if(!await initialized(pool,high))fail('pool_state_not_initialized_at_reference');
        if(await initialized(pool,low))high=low;
        else while(high-low>1){const middle=low+Math.floor((high-low)/2);
          if(await initialized(pool,middle))high=middle;else low=middle;}
        const raw=await provider.request('eth_getLogs',[{address:stream.address[0],topics:[stream.topics[0],pool],fromBlock:hex(high),toBlock:hex(high)}]);
        if(!Array.isArray(raw)||raw.length!==1)fail('pool_birth_event_missing_at_state_transition');
        const proof=await verify(raw[0]);if(proof.record.poolId!==pool||proof.record.createdBlock!==high)fail('pool_birth_state_transition_conflict');
        p.transaction(()=>save(proof),Buffer.byteLength(json(proof))+65536);afterAccept?.();
      } else {
        const last=p.db.prepare('SELECT next_block FROM arc_pipeline_pool_searches WHERE search_sha=?').get(searchSha).next_block;
        if(last<validFrom)break;const first=Math.max(validFrom,last-9999);
        const raw=await provider.request('eth_getLogs',[{address:stream.address[0],topics:[stream.topics[0],definition.pools],fromBlock:hex(first),toBlock:hex(last)}]);
        if(!Array.isArray(raw)||raw.length>=10000)fail('pool_birth_response_invalid');
        const proofs=[];for(const r of raw){const n=parseInt(r.blockNumber,16);if(n<first||n>last)fail('pool_birth_outside_range');proofs.push(await verify(r));}
        p.transaction(()=>{
          for(const proof of proofs)save(proof);
          p.db.prepare('INSERT INTO arc_pipeline_pool_search_ranges VALUES(?,?,?,?)').run(searchSha,first,last,hash(raw));
          const updated=p.db.prepare('UPDATE arc_pipeline_pool_searches SET next_block=? WHERE search_sha=? AND next_block=?').run(first-1,searchSha,last);
          if(updated.changes!==1)fail('pool_search_checkpoint_conflict');
        },Buffer.byteLength(json(proofs))+65536);acceptedRanges++;afterAccept?.();
      }
      assertHeapBudget();
    }
    return{completeRequestedPoolWitnesses:!unresolved().length,remainingPoolCount:unresolved().length,acceptedRanges,
      additionalRequests:bounded.stats.requests-priorRequests,globalRegistryCoverageComplete:false};
  }
  return{run,read,searchSha,definition};
}
