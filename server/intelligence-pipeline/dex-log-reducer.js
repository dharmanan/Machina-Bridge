// Exact per-range DEX raw statistics and sparse observed evidence; no raw event archive.
// Does not claim USD valuation, token identity, first-ever activity, TVL or complete hour coverage.
import { createHash } from 'node:crypto';
import { decodeV3Swap,decodeV3Mint,decodeV3Burn,decodeV4Swap,decodeV4Initialize,decodeV4ModifyLiquidity,UNISWAP_EVENT_TOPICS as T } from '../../api/_lib/arc-intelligence/uniswap.js';
import { v4PoolRecordOf } from '../compact/projections.js';
import { validateLogs } from '../compact/logs.js';
import { logFilter } from '../compact/sources.js';
import { hash,json,fail,assertHeapBudget } from './storage.js';
const decoders=new Map([[T.v3Swap,['swap',decodeV3Swap]],[T.v3Mint,['mint',decodeV3Mint]],[T.v3Burn,['burn',decodeV3Burn]],
 [T.v4Swap,['swap',decodeV4Swap]],[T.v4Initialize,['initialize',decodeV4Initialize]],[T.v4ModifyLiquidity,['modify_liquidity',decodeV4ModifyLiquidity]]]);
const packed=set=>Buffer.concat([...set].sort().map(a=>Buffer.from(a.slice(2),'hex'))).toString('base64');
export function reduceDexLogs(raw,{stream,first,last,window,isOfficialV3,source,anchorHash}={}){
  assertHeapBudget();
  if(!['v3Pools','v4'].includes(stream?.key)||!Array.isArray(raw))fail('dex_source_invalid');
  if(raw.length>=10000)fail('suspect_log_result_count');
  const logs=validateLogs(raw,stream,{fromBlock:first,toBlock:last,window,seen:new Set()}),pools=new Map(),foreign=new Set(),traders=new Set(),input=createHash('sha256');
  let foreignEvents=0,accepted=0;
  for(const l of logs){
    input.update(json(l)+'\n');
    if(stream.key==='v3Pools'&&isOfficialV3(l)!==true){foreign.add(l.address);foreignEvents++;continue;}
    const [kind,decode]=decoders.get(l.topics[0])??[];const e=decode?.(l);if(!e)fail('dex_event_unverified');
    if(kind==='initialize')v4PoolRecordOf(l); // Existing keccak(PoolKey) verifier, no relaxed ABI.
    const id=e.poolId??l.address,p=pools.get(id)??{kind:'dex_pool_range',protocol:stream.key==='v3Pools'?'uniswap_v3':'uniswap_v4',pool:id,swapCount:0,mintCount:0,burnCount:0,initializeCount:0,liquidityIncreaseCount:0,liquidityDecreaseCount:0,liquidityPokeCount:0,swapAmount0AbsRaw:0n,swapAmount1AbsRaw:0n,mintAmount0Raw:0n,mintAmount1Raw:0n,burnAmount0Raw:0n,burnAmount1Raw:0n,observedSwap:null,observedLiquidity:null,latestPoolState:null,tokenIdentityStatus:'not_checked',valuationStatus:'not_checked'};
    const proof={blockNumber:l.blockNumber,blockHash:l.blockHash,transactionHash:l.transactionHash,transactionIndex:l.transactionIndex,logIndex:l.logIndex,timestamp:window.get(l.blockNumber).timestamp,emitter:l.address,sourceKey:hash(source),firstProven:false};
    if(kind==='swap'){
      p.swapCount++;const a=BigInt(e.amount0Raw),b=BigInt(e.amount1Raw);p.swapAmount0AbsRaw+=a<0n?-a:a;p.swapAmount1AbsRaw+=b<0n?-b:b;
      const sender=window.get(l.blockNumber).txFrom[l.transactionIndex];if(!/^0x[0-9a-f]{40}$/.test(sender??''))fail('trader_identity_unverified');traders.add(sender);p.observedSwap??=proof;
      p.latestPoolState={...proof,sqrtPriceX96Raw:e.sqrtPriceX96Raw,liquidityRaw:e.liquidityRaw,tick:e.tick,...(e.fee!==undefined?{appliedSwapFee:e.fee}:{})};
    }else if(kind==='mint'||kind==='burn'){
      p[kind+'Count']++;p[kind+'Amount0Raw']+=BigInt(e.amount0Raw);p[kind+'Amount1Raw']+=BigInt(e.amount1Raw);p.observedLiquidity??=proof;
    }else if(kind==='initialize'){p.initializeCount++;p.initializedPool=v4PoolRecordOf(l);}
    else if(e.classification==='increase'){p.liquidityIncreaseCount++;p.observedLiquidity??=proof;}
    else if(e.classification==='decrease')p.liquidityDecreaseCount++;else p.liquidityPokeCount++;
    pools.set(id,p);accepted++;
  }
  return {format:'arc-reduced-source-v1',first,last,sourceKey:hash(source),anchorHash,inputSha256:input.digest('hex'),status:'verified',reason:null,
    counts:{receivedEvents:logs.length,acceptedEvents:accepted,foreignEvents,foreignEmitters:foreign.size,uniqueTraders:traders.size},
    rows:[{kind:'dex_range_membership',traderMembership:packed(traders),foreignEmitters:[...foreign].sort()},...[...pools.values()].sort((a,b)=>a.pool.localeCompare(b.pool)).map(p=>JSON.parse(json(p)))]};
}
export function createDexLogProcessor({stream,loadVerifiedWindow,isOfficialV3,sparseWindow=false}={}){
  if(typeof loadVerifiedWindow!=='function'||stream?.key==='v3Pools'&&typeof isOfficialV3!=='function')fail('dex_verification_dependencies_missing');
  return async(j,provider)=>{
    let cached;
    const window=sparseWindow?{get(n){if(!cached?.has(n))cached=loadVerifiedWindow(n,n);if(!(cached instanceof Map)||cached.size!==1)fail('canonical_window_incomplete');return cached.get(n);}}:loadVerifiedWindow(j.first_block,j.last_block);
    if(!sparseWindow&&(!(window instanceof Map)||window.size!==j.last_block-j.first_block+1))fail('canonical_window_incomplete');
    const raw=await provider.request('eth_getLogs',[logFilter(stream,j.first_block,j.last_block)]);
    return {summary:reduceDexLogs(raw,{stream,first:j.first_block,last:j.last_block,window,isOfficialV3,source:j.spec.source,anchorHash:j.spec.anchorHash})};
  };
}
