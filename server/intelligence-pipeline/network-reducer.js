// Transient canonical bodies -> exact network results, membership and sparse deployment-attempt evidence.
// No transaction bodies or complete per-block transaction spine is stored in the result.
import { createHash } from 'node:crypto';
import { spineBlockOf } from '../compact/spine.js';
import { hash, json, fail } from './storage.js';
const ADDRESS=/^0x[0-9a-f]{40}$/, HASH=/^0x[0-9a-f]{64}$/;
function packed(set){const values=[...set].sort(),out=Buffer.allocUnsafe(values.length*20);for(let i=0;i<values.length;i++)Buffer.from(values[i].slice(2),'hex').copy(out,i*20);return out.toString('base64');}
export function* unpackAddresses(value){
  if(typeof value!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))fail('address_membership_invalid');
  const raw=Buffer.from(value,'base64');if(raw.length%20||raw.toString('base64')!==value)fail('address_membership_invalid');
  let previous='';for(let i=0;i<raw.length;i+=20){const address='0x'+raw.subarray(i,i+20).toString('hex');if(address<=previous)fail('address_membership_invalid');previous=address;yield address;}
}
export function createNetworkReducer({first,last,before,hourStart,hourEnd,source,anchorHash}){
  if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||last<first||last-first+1>125||before?.number!==first-1||!HASH.test(before.hash)||!Number.isSafeInteger(before.timestamp)||!Number.isSafeInteger(hourStart)||hourEnd!==hourStart+3600||!HASH.test(anchorHash))fail('canonical_range_invalid');
  let previous=before,firstTimestamp=null,blocks=0,transactions=0,gas=0n;
  const senders=new Set(),recipients=new Set(),creations=[],input=createHash('sha256');
  if(!['arc-canonical-reduction-v1','arc-canonical-reduction-v2'].includes(source?.definition))fail('canonical_source_definition_unknown');
  input.update(source.definition+'\n');
  function addVerifiedSpine(block){
    if(block.number!==first+blocks||block.number>last||block.parentHash!==previous.hash||block.timestamp<previous.timestamp||block.timestamp<hourStart||block.timestamp>=hourEnd||!HASH.test(block.hash)||typeof block.gasUsed!=='bigint'||block.gasUsed<0n||!Array.isArray(block.txHashes)||block.txHashes.length!==block.txFrom.length||block.txHashes.length!==block.txTo.length)fail('canonical_block_invalid');
    const seen=new Set();for(let i=0;i<block.txHashes.length;i++){
      const tx=block.txHashes[i],from=block.txFrom[i],to=block.txTo[i];
      if(!HASH.test(tx)||!ADDRESS.test(from)||to!==null&&!ADDRESS.test(to)||seen.has(tx))fail('canonical_transaction_invalid');seen.add(tx);senders.add(from);if(to)recipients.add(to);
      else creations.push({txHash:tx,blockHash:block.hash,blockNumber:block.number,timestamp:block.timestamp,transactionIndex:i,deployer:from,status:'deployment_attempt_receipt_required'});
    }
    // v2 hashes only fixed ordered required inputs. RPC object property order and incidental fields
    // cannot make an identical block fail a later reconstruction checksum. v1 lab evidence is
    // preserved under its own definition; it is never relabelled as v2-compatible evidence.
    const evidence=source.definition==='arc-canonical-reduction-v2'
      ?[block.number,block.hash,block.parentHash,block.timestamp,block.gasUsed.toString(),block.txHashes,block.txFrom,block.txTo]:block;
    input.update(json(evidence)+'\n');blocks++;transactions+=block.txHashes.length;gas+=block.gasUsed;firstTimestamp??=block.timestamp;previous=block;
  }
  return {
    addRaw(raw){addVerifiedSpine(spineBlockOf(raw,first+blocks));},
    // Only for already independently verified exported spine, never for unvalidated RPC responses.
    addVerifiedSpine,
    finish({after}={}){
      if(blocks!==last-first+1)fail('partial_cannot_complete');
      if(after&&(after.number!==last+1||after.parentHash!==previous.hash||after.timestamp<previous.timestamp))fail('canonical_boundary_invalid');
      let active=senders.size;for(const a of recipients)if(!senders.has(a))active++;
      return {format:'arc-reduced-source-v1',first,last,sourceKey:hash(source),anchorHash,inputSha256:input.digest('hex'),status:'verified',reason:null,
        counts:{blockCount:blocks,transactionCount:transactions,gasUsedRaw:gas.toString(),uniqueSenders:senders.size,uniqueRecipients:recipients.size,uniqueActiveAddresses:active,deploymentAttempts:creations.length},
        rows:[{kind:'canonical_range',firstParentHash:before.hash,lastHash:previous.hash,firstTimestamp,lastTimestamp:previous.timestamp,senderMembership:packed(senders),recipientMembership:packed(recipients),creations}]};
    }
  };
}
