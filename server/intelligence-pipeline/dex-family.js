// A rebuildable, independently versioned family result from durable verified range results.
// Every dependency remains stored. No production family record is overwritten.
import { hash,fail,readDefinition } from './storage.js';
import { unpackAddresses } from './network-reducer.js';
import { FAMILY_VERSIONS } from '../compact/sources.js';
export function deriveDexFamily(p,{baseUnit,supplementUnit=null,supplementUnits,factoryUnit=null,protocol}={}){
  if(!['uniswap_v3','uniswap_v4'].includes(protocol)||protocol==='uniswap_v3'&&!factoryUnit)fail('dex_family_dependencies_missing');
  const supplements=supplementUnits??(supplementUnit?[supplementUnit]:[]);
  if(!Array.isArray(supplements)||new Set(supplements).size!==supplements.length)fail('dex_family_dependencies_invalid');
  const units=[baseUnit,...supplements,...(factoryUnit?[factoryUnit]:[])],base=p.db.prepare('SELECT * FROM arc_pipeline_units WHERE unit_id=?').get(baseUnit);
  if(!base)fail('dex_family_dependencies_missing');const dependencies=[];
  for(const id of units){const u=p.db.prepare('SELECT * FROM arc_pipeline_units WHERE unit_id=?').get(id);
    if(!u||u.first_block!==base.first_block||u.last_block!==base.last_block||u.anchor_hash!==base.anchor_hash||u.hour_start!==base.hour_start||p.coverage(id).status!=='complete')fail('dex_family_dependency_incomplete');
    dependencies.push({unitId:id,sourceKey:u.source_key,pieces:p.db.prepare("SELECT first_block,last_block,expected_sha FROM arc_pipeline_jobs WHERE unit_id=? AND state='complete' ORDER BY first_block").all(id)});
  }
  const created=new Set();let poolCreatedCount=0;
  if(factoryUnit)for(const s of p.summaries(factoryUnit))for(const pool of s.rows){if(pool.kind!=='official_v3_pool_created'||created.has(pool.address))fail('factory_evidence_conflict');created.add(pool.address);poolCreatedCount++;}
  if(supplements.length>1){const seen=new Set();for(const id of supplements){const u=p.db.prepare('SELECT unit_json FROM arc_pipeline_units WHERE unit_id=?').get(id),addresses=JSON.parse(readDefinition(u.unit_json)).source.stream?.address;if(!Array.isArray(addresses)||!addresses.length||addresses.length>16)fail('supplement_scope_invalid');for(const a of addresses){if(!created.has(a)||seen.has(a))fail('supplement_scope_overlap');seen.add(a);}}if(seen.size!==created.size)fail('supplement_scope_incomplete');}
  const traders=new Set(),swapPools=new Set(),foreign=new Set();let swaps=0,mints=0,burns=0,initialized=0,modified=0,foreignEvents=0,supplementEvents=0;
  for(const [id,extra] of [[baseUnit,false],...supplements.map(id=>[id,true])])for(const summary of p.summaries(id)){
    const member=summary.rows[0];if(member.kind!=='dex_range_membership'||!Array.isArray(member.foreignEmitters))fail('dex_family_evidence_invalid');
    for(const a of unpackAddresses(member.traderMembership))traders.add(a);for(const a of member.foreignEmitters)foreign.add(a);
    foreignEvents+=summary.counts.foreignEvents;
    if(extra){if(summary.counts.foreignEvents!==0)fail('supplement_pool_unverified');supplementEvents+=summary.counts.acceptedEvents;}
    for(const pool of summary.rows.slice(1)){
      if(pool.kind!=='dex_pool_range'||pool.protocol!==protocol||supplements.length&&(extra?!created.has(pool.pool):created.has(pool.pool)))fail('dex_family_pool_overlap');
      swaps+=pool.swapCount;mints+=pool.mintCount;burns+=pool.burnCount;initialized+=pool.initializeCount;modified+=pool.liquidityIncreaseCount+pool.liquidityDecreaseCount+pool.liquidityPokeCount;if(pool.swapCount)swapPools.add(pool.pool);
    }
  }
  if(supplements.length){foreignEvents-=supplementEvents;for(const a of created)foreign.delete(a);}if(foreignEvents<0)fail('dex_family_evidence_conflict');
  const metrics=protocol==='uniswap_v3'?{poolCreatedCount,swapCount:swaps,mintCount:mints,burnCount:burns,uniqueTraders:traders.size,poolsWithSwaps:swapPools.size,foreignEmitterCount:foreign.size,foreignEventCount:foreignEvents}
    :{initializeCount:initialized,swapCount:swaps,modifyLiquidityCount:modified,uniqueTraders:traders.size,poolsWithSwaps:swapPools.size};
  const originalVersion=FAMILY_VERSIONS[protocol==='uniswap_v3'?'uniswapV3':'uniswapV4'],source={id:protocol+'_family',definition:'verified-dex-derived-family-v1',originalVersion,chainId:5042,dependencies};
  const unitId=p.defineUnit({source,first:base.first_block,last:base.last_block,hourStart:base.hour_start,anchorHash:base.anchor_hash,registryDigest:hash(dependencies)},{chunkBlocks:10000});
  const summary={format:'arc-reduced-source-v1',first:base.first_block,last:base.last_block,sourceKey:hash(source),anchorHash:base.anchor_hash,inputSha256:hash(dependencies),status:'verified',reason:null,counts:metrics,rows:[{kind:'verified_dex_family',protocol,definitionVersion:originalVersion,metrics}]};
  if(p.coverage(unitId).status!=='complete'){const j=p.claim({unitId});if(!j)fail('derived_unit_not_claimable');p.accept(j,summary);}
  const stored=[...p.summaries(unitId)];if(stored.length!==1||hash(stored[0])!==hash(summary))fail('dex_family_result_conflict');
  return {unitId,metrics,dependencies:units,computedWithoutRpc:true};
}
