// Accepted network results are reduced to exact hour membership using one immutable address dictionary.
// Temporary piece memberships expire only after an independently checked hour representation commits.
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { hash, json, fail,readDefinition } from './storage.js';
import { unpackAddresses } from './network-reducer.js';
import { sha256Of } from '../compact/projections.js';
const SQL=`CREATE TABLE IF NOT EXISTS arc_pipeline_addresses(id INTEGER PRIMARY KEY,address BLOB NOT NULL UNIQUE CHECK(length(address)=20)) STRICT;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_address_immutable BEFORE UPDATE ON arc_pipeline_addresses BEGIN SELECT RAISE(ABORT,'verified_address_immutable'); END;
CREATE TRIGGER IF NOT EXISTS arc_pipeline_address_no_delete BEFORE DELETE ON arc_pipeline_addresses BEGIN SELECT RAISE(ABORT,'verified_address_immutable'); END;
CREATE TABLE IF NOT EXISTS arc_pipeline_network_membership_stage(unit_id TEXT NOT NULL,kind TEXT NOT NULL,address_id INTEGER NOT NULL REFERENCES arc_pipeline_addresses,PRIMARY KEY(unit_id,kind,address_id)) STRICT,WITHOUT ROWID;`;
function encodeIds(ids){let previous=0;const bytes=[];for(const id of ids){if(!Number.isSafeInteger(id)||id<=previous)fail('membership_id_invalid');let gap=id-previous;while(gap>=128){bytes.push(gap%128+128);gap=Math.floor(gap/128);}bytes.push(gap);previous=id;}return Buffer.from(bytes).toString('base64');}
export function* decodeIds(text){
  if(typeof text!=='string')fail('membership_id_invalid');const bytes=Buffer.from(text,'base64');if(bytes.toString('base64')!==text)fail('membership_id_invalid');
  let previous=0,gap=0,factor=1;for(const b of bytes){gap+=(b%128)*factor;if(!Number.isSafeInteger(gap))fail('membership_id_invalid');if(b<128){const id=previous+gap;if(!Number.isSafeInteger(id)||id<=previous||factor>1&&b===0)fail('membership_id_invalid');yield id;previous=id;gap=0;factor=1;}else{factor*=128;if(factor>2**49)fail('membership_id_invalid');}}if(factor!==1)fail('membership_id_invalid');
}
function membership(db,ids,onProgress){const digest=createHash('sha256'),read=db.prepare('SELECT lower(hex(address)) address FROM arc_pipeline_addresses WHERE id=?'),bytes=Buffer.alloc(20);let count=0;
  for(const id of ids){const a=read.get(id)?.address;if(!/^[0-9a-f]{40}$/.test(a??''))fail('verified_address_missing');bytes.write(a,0,20,'hex');digest.update(bytes);if(++count%256===0)onProgress();}return {count,sha:digest.digest('hex')};
}
function unionCount(left,right){const a=left[Symbol.iterator](),b=right[Symbol.iterator]();let x=a.next(),y=b.next(),n=0;while(!x.done||!y.done){n++;if(y.done||!x.done&&x.value<y.value)x=a.next();else if(x.done||y.value<x.value)y=b.next();else{x=a.next();y=b.next();}}return n;}
export function verifyNetworkSeal(db,seal,u,{onProgress=()=>{}}={}){
  const s=seal.summary;if(s?.format!=='arc-network-hour-v1'||s.hourStart!==u.hour_start||!Number.isSafeInteger(u.hour_start))fail('network_seal_invalid');
  const senders=membership(db,decodeIds(s.senderIds),onProgress),recipients=membership(db,decodeIds(s.recipientIds),onProgress);
  if(senders.sha!==s.senderSha256||recipients.sha!==s.recipientSha256||senders.count!==s.network.uniqueSenders||recipients.count!==s.network.uniqueRecipients||unionCount(decodeIds(s.senderIds),decodeIds(s.recipientIds))!==s.network.uniqueActiveAddresses)fail('network_membership_corrupt');
  if(sha256Of({definitionVersion:s.definitionVersion,range:s.range,network:s.network})!==s.canonicalSha256||s.range.hourStart!==u.hour_start||s.range.firstBlock!==u.first_block||s.range.lastBlock!==u.last_block||s.range.lastHash!==u.anchor_hash)fail('network_canonical_conflict');
  let blocks=0,txs=0,gas=0n,attempts=0,previous=s.range.parentHash,previousTimestamp=u.hour_start;
  for(const segment of seal.segments){
    if(segment.status!=='verified'||segment.firstParentHash!==previous||segment.firstTimestamp<previousTimestamp||segment.lastTimestamp<segment.firstTimestamp||segment.lastTimestamp>=u.hour_start+3600||segment.counts.blockCount!==segment.last-segment.first+1)fail('network_segment_corrupt');
    blocks+=segment.counts.blockCount;txs+=segment.counts.transactionCount;gas+=BigInt(segment.counts.gasUsedRaw);attempts+=segment.counts.deploymentAttempts;previous=segment.lastHash;previousTimestamp=segment.lastTimestamp;
  }
  if(previous!==u.anchor_hash||blocks!==s.network.blockCount||txs!==s.network.transactionCount||gas.toString()!==s.network.gasUsedRaw||attempts!==s.network.internal.deploymentAttempts||s.creations.length!==attempts)fail('network_segment_corrupt');onProgress();
}
export function createNetworkHourStore(p,{onProgress=()=>{}}={}){
  p.transaction(()=>p.db.exec(SQL));
  function publish(unitId,canonical,{beforeCommit,afterCommit}={}){
    const already=p.getSeal(unitId);if(already)return already;
    if(p.coverage(unitId).status!=='complete')fail('partial_cannot_publish');
    const u=p.db.prepare('SELECT * FROM arc_pipeline_units WHERE unit_id=?').get(unitId),spec=JSON.parse(readDefinition(u.unit_json));
    if(spec.source.id!=='network'||canonical.hour_start!==u.hour_start||canonical.first_block!==u.first_block||canonical.last_block!==u.last_block||canonical.last_hash!==u.anchor_hash)fail('network_canonical_conflict');
    const network=JSON.parse(canonical.network_json),plannedBytes=(network.uniqueSenders+network.uniqueRecipients)*160+262144;
    const seal=p.transaction(()=>{
      const insert=p.db.prepare('INSERT OR IGNORE INTO arc_pipeline_addresses(address) VALUES(?)'),read=p.db.prepare('SELECT id FROM arc_pipeline_addresses WHERE address=?'),add=p.db.prepare('INSERT OR IGNORE INTO arc_pipeline_network_membership_stage VALUES(?,?,?)');
      const creations=[],segments=[];let observed=0;
      for(const job of p.db.prepare("SELECT * FROM arc_pipeline_jobs WHERE unit_id=? AND state='complete' ORDER BY first_block").iterate(unitId)){
        const result=p.getResult(job.result_sha),row=result.rows[0];if(row?.kind!=='canonical_range'||result.rows.length!==1)fail('network_summary_invalid');
        for(const [kind,packed] of [['sender',row.senderMembership],['recipient',row.recipientMembership]])for(const a of unpackAddresses(packed)){
          const bytes=Buffer.from(a.slice(2),'hex');insert.run(bytes);add.run(unitId,kind,read.get(bytes).id);if(++observed%256===0)onProgress();
        }
        for(const creation of row.creations)creations.push(creation);
        segments.push({first:job.first_block,last:job.last_block,resultSha:job.expected_sha,inputSha256:result.inputSha256,status:result.status,counts:result.counts,firstParentHash:row.firstParentHash,lastHash:row.lastHash,firstTimestamp:row.firstTimestamp,lastTimestamp:row.lastTimestamp});
      }
      const range={kind:'hour',hourStart:u.hour_start,hourEnd:u.hour_start+3600,startUtc:new Date(u.hour_start*1000).toISOString(),endUtc:new Date((u.hour_start+3600)*1000).toISOString(),firstBlock:u.first_block,lastBlock:u.last_block,parentHash:canonical.parent_hash,firstHash:canonical.first_hash,lastHash:canonical.last_hash,firstTimestamp:segments[0].firstTimestamp,lastTimestamp:segments.at(-1).lastTimestamp};
      if(sha256Of({definitionVersion:canonical.definition_version,range,network})!==canonical.network_sha256)fail('network_canonical_conflict');
      const ids=kind=>(function*(){for(const r of p.db.prepare('SELECT address_id FROM arc_pipeline_network_membership_stage WHERE unit_id=? AND kind=? ORDER BY address_id').iterate(unitId,kind))yield r.address_id;})();
      const summary={format:'arc-network-hour-v1',hourStart:u.hour_start,definitionVersion:canonical.definition_version,canonicalSha256:canonical.network_sha256,range,network,senderIds:encodeIds(ids('sender')),recipientIds:encodeIds(ids('recipient')),senderSha256:membership(p.db,ids('sender'),onProgress).sha,recipientSha256:membership(p.db,ids('recipient'),onProgress).sha,creations};
      const seal={format:'arc-unit-seal-v1',sourceKey:u.source_key,anchorHash:u.anchor_hash,first:u.first_block,last:u.last_block,segments,summary};verifyNetworkSeal(p.db,seal,u,{onProgress});
      const plain=Buffer.from(json(seal));if(plain.length>8*1024*1024)fail('unit_seal_too_large');const sha=hash(plain);
      p.db.prepare('INSERT INTO arc_pipeline_seals VALUES(?,?,?,?)').run(unitId,sha,gzipSync(plain,{level:3}),plain.length);p.getSeal(unitId);beforeCommit?.();return seal;
    },plannedBytes);
    // Crash after this commit retains both the permanent hour result and all original pieces.
    afterCommit?.();return seal;
  }
  function compact(unitId,{beforeCommit}={}){
    if(!p.getSeal(unitId))fail('committed_seal_required');
    if(p.db.prepare('SELECT 1 FROM arc_pipeline_fact_rows WHERE unit_id=? LIMIT 1').get(unitId))fail('unsealed_fact_evidence');
    return p.transaction(()=>{
      p.getSeal(unitId);const shas=p.db.prepare('SELECT DISTINCT result_sha FROM arc_pipeline_jobs WHERE unit_id=? AND result_sha IS NOT NULL').all(unitId);
      p.db.prepare("UPDATE arc_pipeline_jobs SET result_sha=NULL WHERE unit_id=? AND state='complete'").run(unitId);
      const del=p.db.prepare('DELETE FROM arc_pipeline_results WHERE result_sha=? AND NOT EXISTS(SELECT 1 FROM arc_pipeline_jobs WHERE result_sha=?)');
      let deleted=0;for(const r of shas)deleted+=del.run(r.result_sha,r.result_sha).changes;
      p.db.prepare('DELETE FROM arc_pipeline_network_membership_stage WHERE unit_id=?').run(unitId);p.getSeal(unitId);beforeCommit?.();return {removedTransientPieces:deleted,permanentNetworkEvidenceVerified:true};
    });
  }
  return {publish,compact};
}
