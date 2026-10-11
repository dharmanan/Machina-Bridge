// Reuses the verified hour's sparse deployment attempts. Never re-downloads full transaction bodies.
// Each receipt commits independently before the range commits, so interruption preserves completed reads.
// This proves contract deployment evidence only; token identity/metadata remains a separate source unit.
import { createHash } from 'node:crypto';
import { hash,json,fail } from './storage.js';
import { normalizeAddress,quantityToSafeNumber } from '../../api/_lib/arc-intelligence/normalize.js';
const SQL=`CREATE TABLE IF NOT EXISTS arc_pipeline_creation_receipts(receipt_key TEXT PRIMARY KEY,payload_json TEXT NOT NULL,payload_sha TEXT NOT NULL) STRICT,WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_creation_receipt_immutable BEFORE UPDATE ON arc_pipeline_creation_receipts BEGIN SELECT RAISE(ABORT,'creation_receipt_immutable'); END;`;
const code=()=>fail('creation_receipt_unverified');
export function reduceCreationReceipt(raw,attempt){
  try{
    if(!raw||raw.transactionHash?.toLowerCase()!==attempt.txHash||raw.blockHash?.toLowerCase()!==attempt.blockHash
      ||quantityToSafeNumber(raw.blockNumber,'block')!==attempt.blockNumber||quantityToSafeNumber(raw.transactionIndex,'index')!==attempt.transactionIndex
      ||normalizeAddress(raw.from)!==attempt.deployer||raw.to!==null||!['0x0','0x1'].includes(raw.status)||!Array.isArray(raw.logs))code();
    const success=raw.status==='0x1',address=success?normalizeAddress(raw.contractAddress):null;
    // Arc's block-receipt source can return the predicted address even when status=0x0.
    // Receipt status proves failure; a reported/predicted address never proves deployed code.
    const reportedFailedAddress=!success&&raw.contractAddress!==null?normalizeAddress(raw.contractAddress):null;
    const digest=createHash('sha256');for(const log of raw.logs)digest.update(json(log)+'\n');
    return {...attempt,kind:'top_level_contract_creation',address,status:success?'verified_contract_creation':'verified_failed_deployment',verificationBasis:'canonical_top_level_transaction_and_matching_receipt',tokenIdentity:{status:'unverified',reason:'token_metadata_not_checked'},receiptLogsSha256:digest.digest('hex'),...(reportedFailedAddress?{rpcReportedFailedAddress:reportedFailedAddress}:{})};
  }catch{code();}
}
export function createCreationsProcessor(p,{networkUnitId,afterReceiptCommit,receiptMethod='eth_getBlockReceipts'}={}){
  if(!['eth_getBlockReceipts','eth_getTransactionReceipt'].includes(receiptMethod))fail('receipt_source_invalid');
  const seal=p.getSeal(networkUnitId);if(!seal||seal.summary.format!=='arc-network-hour-v1')fail('verified_network_seal_required');
  p.transaction(()=>p.db.exec(SQL));
  const canonicalSealSha=p.db.prepare('SELECT seal_sha FROM arc_pipeline_seals WHERE unit_id=?').get(networkUnitId).seal_sha;
  const attempts=seal.summary.creations;
  const source={id:'contract_creation_receipts',definition:'canonical-creation-receipts-v2',chainId:5042,canonicalSealSha,receiptMethod};
  async function processJob(j,provider){
    if(hash(j.spec.source)!==hash(source)||j.spec.anchorHash!==seal.anchorHash)fail('creation_source_conflict');
    // Revalidate the persisted seal rather than trust a stale in-memory copy after corruption.
    if(p.db.prepare('SELECT seal_sha FROM arc_pipeline_seals WHERE unit_id=?').get(networkUnitId)?.seal_sha!==canonicalSealSha)fail('creation_source_conflict');p.getSeal(networkUnitId);
    const candidates=attempts.filter(a=>a.blockNumber>=j.first_block&&a.blockNumber<=j.last_block),rows=[],digest=createHash('sha256');let successful=0,failed=0;
    const keyOf=a=>hash([hash(source),seal.anchorHash,a.txHash]),read=p.db.prepare('SELECT * FROM arc_pipeline_creation_receipts WHERE receipt_key=?');
    const groups=receiptMethod==='eth_getBlockReceipts'?[...new Set(candidates.map(a=>a.blockNumber))].map(n=>candidates.filter(a=>a.blockNumber===n))
      :Array.from({length:Math.ceil(candidates.length/16)},(_,i)=>candidates.slice(i*16,i*16+16));
    for(const group of groups){
      const missing=group.filter(a=>!read.get(keyOf(a)));
      if(missing.length){
        if(!provider.canContinue(receiptMethod==='eth_getBlockReceipts'?1:missing.length))fail('bounded_run_yield');
        p.guard(missing.length*8192);
        let receipts;
        if(receiptMethod==='eth_getBlockReceipts'){
          const all=await provider.request(receiptMethod,['0x'+missing[0].blockNumber.toString(16)]);
          if(!Array.isArray(all))fail('creation_block_receipts_unverified');
          const byHash=new Map(),positions=new Set();for(const r of all){
            if(!/^0x[0-9a-f]{64}$/i.test(r?.transactionHash??'')||r.blockHash?.toLowerCase()!==missing[0].blockHash
              ||quantityToSafeNumber(r.blockNumber,'block')!==missing[0].blockNumber||byHash.has(r.transactionHash.toLowerCase()))fail('creation_block_receipts_unverified');
            const index=quantityToSafeNumber(r.transactionIndex,'index');if(positions.has(index))fail('creation_block_receipts_unverified');positions.add(index);byHash.set(r.transactionHash.toLowerCase(),r);
          }
          receipts=missing.map(a=>byHash.get(a.txHash));
        }else receipts=await provider.batch(missing.map(a=>['eth_getTransactionReceipt',[a.txHash]]));
        if(!Array.isArray(receipts)||receipts.length!==missing.length)fail('creation_receipt_unverified');
        const reduced=receipts.map((r,i)=>reduceCreationReceipt(r,missing[i]));
        // Commit the entire fetched group before any injected interruption or another RPC.
        p.transaction(()=>{for(let i=0;i<missing.length;i++){
          const key=keyOf(missing[i]),text=json(reduced[i]);if(Buffer.byteLength(text)>4096)fail('creation_receipt_size');
          p.db.prepare('INSERT OR IGNORE INTO arc_pipeline_creation_receipts VALUES(?,?,?)').run(key,text,hash(text));
          const r=read.get(key);if(r.payload_json!==text||r.payload_sha!==hash(text))fail('creation_receipt_conflict');
        }},missing.length*8192);
        for(const a of missing)afterReceiptCommit?.(a);
      }
      for(const a of group){const stored=read.get(keyOf(a));if(!stored||hash(stored.payload_json)!==stored.payload_sha)fail('creation_receipt_corrupt');const reduced=JSON.parse(stored.payload_json);
        for(const k of ['txHash','blockHash','blockNumber','transactionIndex','deployer','timestamp'])if(reduced[k]!==a[k])fail('creation_source_conflict');
        if(!['verified_contract_creation','verified_failed_deployment'].includes(reduced.status))fail('creation_receipt_corrupt');
        rows.push(reduced);digest.update(json(reduced)+'\n');if(reduced.status==='verified_contract_creation')successful++;else failed++;
      }
    }
    return {summary:{format:'arc-reduced-source-v1',first:j.first_block,last:j.last_block,sourceKey:hash(source),anchorHash:seal.anchorHash,inputSha256:digest.digest('hex'),status:'verified',reason:null,counts:{attempts:rows.length,successful,failed},rows}};
  }
  return {source,processJob,attemptCount:attempts.length,canonicalSealSha};
}
