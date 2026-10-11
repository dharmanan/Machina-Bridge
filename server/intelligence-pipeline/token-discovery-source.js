// Independent historical ERC20-like qualification. Accepted canonical creation receipts are reused,
// while required token views and the negative control are read at the exact hour-end block.
import { verifyTokenCandidate } from '../compact/intelligence.js';
import { registryDigest,INTELLIGENCE_REGISTRY } from '../compact/intelligence-registry.js';
import { hash,json,fail,readDefinition } from './storage.js';
const SQL=`CREATE TABLE IF NOT EXISTS arc_pipeline_token_view_results(candidate_key TEXT PRIMARY KEY,source_key TEXT NOT NULL,
  result_json TEXT NOT NULL,result_sha TEXT NOT NULL) STRICT,WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_token_view_immutable BEFORE UPDATE ON arc_pipeline_token_view_results
BEGIN SELECT RAISE(ABORT,'token_view_result_immutable'); END;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_token_view_no_delete BEFORE DELETE ON arc_pipeline_token_view_results
BEGIN SELECT RAISE(ABORT,'token_view_result_immutable'); END;`;
export function createCreationTokenProcessor(target,{creationPipeline,creationUnitId,afterCandidateCommit}={}) {
  if(!creationPipeline?.readOnly||creationPipeline.coverage(creationUnitId).status!=='complete')fail('verified_read_only_creation_source_required');
  const u=creationPipeline.db.prepare('SELECT * FROM arc_pipeline_units WHERE unit_id=?').get(creationUnitId);
  const spec=JSON.parse(readDefinition(u.unit_json));
  if(spec.source.id!=='contract_creation_receipts'||spec.source.definition!=='canonical-creation-receipts-v2'
    ||spec.source.chainId!==5042)fail('creation_token_source_invalid');
  const network=creationPipeline.db.prepare('SELECT u.unit_id FROM arc_pipeline_seals s JOIN arc_pipeline_units u USING(unit_id) WHERE s.seal_sha=?').get(spec.source.canonicalSealSha);
  if(!network)fail('creation_token_canonical_source_required');
  const seal=creationPipeline.getSeal(network.unit_id);
  if(seal.summary.format!=='arc-network-hour-v1'||seal.first!==u.first_block||seal.last!==u.last_block
    ||seal.anchorHash!==u.anchor_hash)fail('creation_token_canonical_source_required');
  const attempts=new Map(seal.summary.creations.map(row=>[row.txHash,row]));
  if(attempts.size!==seal.summary.creations.length)fail('creation_token_source_invalid');
  const receipts=new Map();
  for(const piece of creationPipeline.summaries(creationUnitId))for(const row of piece.rows){
    if(row.kind!=='top_level_contract_creation'||!['verified_contract_creation','verified_failed_deployment'].includes(row.status)
      ||!/^0x[0-9a-f]{64}$/.test(row.txHash)||!/^0x[0-9a-f]{64}$/.test(row.blockHash)||receipts.has(row.txHash)
      ||row.blockNumber<u.first_block||row.blockNumber>u.last_block)fail('creation_token_source_invalid');
    const attempt=attempts.get(row.txHash);
    if(!attempt||['txHash','blockHash','blockNumber','transactionIndex','deployer','timestamp'].some(k=>attempt[k]!==row[k])
      ||row.status==='verified_contract_creation'&&!/^0x[0-9a-f]{40}$/.test(row.address??'')
      ||row.status==='verified_failed_deployment'&&row.address!==null)fail('creation_token_source_invalid');
    receipts.set(row.txHash,row);
  }
  if(receipts.size!==attempts.size)fail('creation_token_receipts_incomplete');
  const source={id:'creation_token_views',definition:'canonical-creation-token-views-v1',chainId:5042,
    creationSourceKey:u.source_key,creationUnitId,creationReceiptsSha:hash([...receipts.values()]),
    registryDigest:registryDigest(INTELLIGENCE_REGISTRY),verification:'unchanged_required_token_views_and_negative_control',
    historicalBlock:u.last_block,candidateCount:receipts.size};
  target.transaction(()=>target.db.exec(SQL));
  const sourceKey=hash(source);
  function candidate(receipt){return{key:receipt.txHash,kind:'creation',address:null,txHash:receipt.txHash,blockHash:receipt.blockHash,
    blockNumber:receipt.blockNumber,transactionIndex:receipt.transactionIndex,deployer:receipt.deployer,
    timestamp:receipt.timestamp,readBlock:u.last_block};}
  function read(receipt){
    const key=hash([sourceKey,receipt.txHash]),row=target.db.prepare('SELECT * FROM arc_pipeline_token_view_results WHERE candidate_key=?').get(key);
    if(!row)return null;if(row.source_key!==sourceKey||hash(row.result_json)!==row.result_sha)fail('token_view_result_corrupt');
    const result=JSON.parse(row.result_json),c=candidate(receipt);
    for(const k of Object.keys(c).filter(k=>k!=='address'))if(result[k]!==c[k])fail('token_view_result_corrupt');
    if(!['verified_erc20_like','rejected_not_erc20_like'].includes(result.status))fail('partial_token_cannot_publish');
    if(result.status==='verified_erc20_like'&&(result.address!==receipt.address||result.directDeploymentVerified!==true
      ||result.reason!==null||result.verification?.blockTag!=='0x'+u.last_block.toString(16)
      ||result.launch?.status!=='direct_deployment'))fail('token_view_result_corrupt');
    return result;
  }
  async function processJob(job,provider){
    if(hash(job.spec.source)!==sourceKey||job.spec.anchorHash!==u.anchor_hash)fail('creation_token_source_conflict');
    creationPipeline.getSeal(network.unit_id);
    if(creationPipeline.coverage(creationUnitId).status!=='complete')fail('creation_token_source_conflict');
    const rows=[],counts={candidates:0,verified:0,rejected:0};let providerFailure;
    for(const receipt of receipts.values()){
      if(receipt.blockNumber<job.first_block||receipt.blockNumber>job.last_block)continue;
      let result=read(receipt);
      if(!result){
        if(!provider.canContinue(8))fail('bounded_run_yield');
        // Reconstruct only the verified receipt fields this existing verifier needs. This is not
        // a fabricated full receipt; identity/status/address came from the accepted canonical source.
        const verifiedReceipt={transactionHash:receipt.txHash,blockHash:receipt.blockHash,
          blockNumber:'0x'+receipt.blockNumber.toString(16),transactionIndex:'0x'+receipt.transactionIndex.toString(16),
          from:receipt.deployer,to:null,status:receipt.status==='verified_contract_creation'?'0x1':'0x0',contractAddress:receipt.address};
        const wrapped={request:async(method,params)=>{
          if(method==='eth_getTransactionReceipt'){
            if(params[0]!==receipt.txHash)fail('creation_token_receipt_scope_conflict');return verifiedReceipt;
          }
          try{return await provider.request(method,params);}catch(e){providerFailure=e;throw e;}
        },batch:async(...args)=>{try{return await provider.batch(...args);}catch(e){providerFailure=e;throw e;}}};
        target.guard(1024*1024);
        result=await verifyTokenCandidate(wrapped,candidate(receipt));
        if(providerFailure)throw providerFailure;
        if(result.status==='unverified')fail('token_views_unverified');
        if(!['verified_erc20_like','rejected_not_erc20_like'].includes(result.status))fail('partial_token_cannot_publish');
        const text=json(result);if(Buffer.byteLength(text)>32768)fail('token_view_result_budget');
        target.transaction(()=>{
          target.db.prepare('INSERT OR IGNORE INTO arc_pipeline_token_view_results VALUES(?,?,?,?)').run(hash([sourceKey,receipt.txHash]),sourceKey,text,hash(text));
          read(receipt);
        },Buffer.byteLength(text)+65536);afterCandidateCommit?.(result);
      }
      rows.push({kind:'verified_creation_token_result',receiptSha:hash(receipt),candidate:candidate(receipt),result});
      counts.candidates++;counts[result.status==='verified_erc20_like'?'verified':'rejected']++;
    }
    return{summary:{format:'arc-reduced-source-v1',first:job.first_block,last:job.last_block,sourceKey,
      anchorHash:u.anchor_hash,inputSha256:hash(rows),status:'verified',reason:null,counts,rows}};
  }
  return{source,processJob,candidateCount:receipts.size,canonical:{hour:u.hour_start,first:u.first_block,last:u.last_block,hash:u.anchor_hash}};
}
