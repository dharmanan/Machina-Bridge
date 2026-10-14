// Exact, fixed-budget counters: no per-distinct-pool JS objects, full-array sorting, approximation or dropped pools.
// A slot owns all 20/32 key bytes; hashing is only placement, never identity/proof. Counts remain safe integers.
export const POOL_TOTAL_SLOTS = 262144;
export const POOL_TOTAL_MAX_KEYS = Math.floor(POOL_TOTAL_SLOTS * 0.8);
export const POOL_TOTAL_BUFFER_BYTES = POOL_TOTAL_SLOTS * (32 + 8 + 1);
const failure = detail => Object.assign(new Error('inconsistent_state'), { code:'inconsistent_state', detail });
export function createPoolTotals({ slots = POOL_TOTAL_SLOTS, errorFactory = failure } = {}) {
  if (!Number.isSafeInteger(slots) || slots < 8 || slots > POOL_TOTAL_SLOTS || (slots & (slots-1))) throw Error('invalid_pool_total_slots');
  const buffer = new ArrayBuffer(slots * 41), keys = new Uint8Array(buffer,0,slots*32);
  const counts = new Float64Array(buffer,slots*32,slots), tags = new Uint8Array(buffer,slots*40,slots);
  const scratch = new Uint8Array(32), mask = slots-1, limit = Math.floor(slots*0.8);
  let size = 0;
  const nibble = code => code >= 48 && code <= 57 ? code-48 : code >= 97 && code <= 102 ? code-87 : -1;
  const add = (protocol,pool,count) => {
    const tag = protocol === 'uniswap_v3' ? 1 : protocol === 'uniswap_v4' ? 2 : 0, length = tag===1 ? 20 : 32;
    if (!tag || typeof pool !== 'string' || pool.length !== length*2+2 || !pool.startsWith('0x')
      || !Number.isSafeInteger(count) || count < 0) throw errorFactory('pool_projection_malformed');
    let hash = Math.imul(2166136261 ^ tag,16777619);
    for(let i=0;i<length;i++) {
      const a=nibble(pool.charCodeAt(i*2+2)),b=nibble(pool.charCodeAt(i*2+3));
      if(a<0||b<0)throw errorFactory('pool_projection_malformed');
      const byte=a*16+b;scratch[i]=byte;hash=Math.imul(hash^byte,16777619);
    }
    if(count===0)return;
    let index=hash&mask;
    for(;;index=(index+1)&mask){
      if(tags[index]===0){
        if(size===limit)throw errorFactory('pool_ranking_memory_budget_exceeded');
        tags[index]=tag;keys.set(scratch.subarray(0,length),index*32);counts[index]=count;size++;return;
      }
      if(tags[index]!==tag)continue;
      let equal=true;
      for(let i=0;i<length;i++)if(keys[index*32+i]!==scratch[i]){equal=false;break;}
      if(!equal)continue;
      const total=counts[index]+count;if(!Number.isSafeInteger(total))throw errorFactory('pool_projection_malformed');
      counts[index]=total;return;
    }
  };
  const compare = (a,b,length) => {
    if(counts[a]!==counts[b])return counts[a]>counts[b] ? -1 : 1;
    for(let i=0;i<length;i++)if(keys[a*32+i]!==keys[b*32+i])return keys[a*32+i]-keys[b*32+i];
    return 0;
  };
  const top = (protocol,limit=10) => {
    if(!Number.isInteger(limit)||limit<1||limit>10)throw Error('invalid_pool_rank_limit');
    const tag=protocol==='uniswap_v3'?1:protocol==='uniswap_v4'?2:0,length=tag===1?20:32,chosen=[];
    if(!tag)throw errorFactory('pool_projection_malformed');
    for(let index=0;index<slots;index++){
      if(tags[index]!==tag)continue;
      if(chosen.length===limit && compare(index,chosen[limit-1],length)>=0)continue;
      let at=0;while(at<chosen.length&&compare(chosen[at],index,length)<0)at++;
      chosen.splice(at,0,index);if(chosen.length>limit)chosen.pop();
    }
    return new Map(chosen.map((index,rank)=>['0x'+Buffer.from(buffer,index*32,length).toString('hex'),{index:rank,total:counts[index]}]));
  };
  return { add, top, clear(){tags.fill(0);counts.fill(0);size=0;}, stats:()=>({keys:size,maxKeys:limit,bytes:buffer.byteLength}) };
}
