// Versioned, bounded binary JSON subset. Hex addresses/hashes remain exact, represented as bytes.
// No Node/V8 serialization dependency; object order, number/string types, missing fields and nulls survive.
import { fail } from './storage.js';
const LIMIT=1024*1024,NODES=100000;
const MAGIC=Buffer.from('ARCB1');
const COMPACT_MAGIC=Buffer.from('ARCB2');
export function encodeEvidence(value,{dictionary,stableSymbols,packedMemberships,compactIntegers=false}={}){
 const magic=stableSymbols?.size||packedMemberships?.size||compactIntegers?COMPACT_MAGIC:MAGIC;
 const chunks=[magic];let size=magic.length,nodes=0;
 const emit=b=>{size+=b.length;if(size>LIMIT)fail('binary_evidence_budget');chunks.push(b);};
 const byte=n=>emit(Buffer.from([n]));
 const integer=n=>{if(!Number.isSafeInteger(n)||n<0)fail('binary_evidence_invalid');const b=[];do{b.push(n%128+(n>=128?128:0));n=Math.floor(n/128);}while(n);emit(Buffer.from(b));};
 function write(x){if(++nodes>NODES)fail('binary_evidence_budget');if(x===null){byte(0);return;}if(x===false||x===true){byte(x?2:1);return;}
  if(typeof x==='number'){if(!Number.isFinite(x))fail('binary_evidence_invalid');if(Number.isSafeInteger(x)&&!Object.is(x,-0)){byte(x>=0?3:4);integer(Math.abs(x));}else{byte(5);const b=Buffer.alloc(8);b.writeDoubleLE(x);emit(b);}return;}
  if(typeof x==='string'){if(packedMemberships?.has(x)){byte(14);const ids=packedMemberships.get(x);integer(ids.length);for(const id of ids){if(id<1)fail('binary_evidence_invalid');integer(id);}return;}if(stableSymbols?.has(x)){byte(11);integer(stableSymbols.get(x));return;}if(dictionary?.has(x)){byte(10);integer(dictionary.get(x));return;}
   // Preserve canonical decimal STRINGS exactly, including values beyond JS safe integers.
   // Leading zeroes and negative zero use the original UTF-8 string representation.
   if(compactIntegers&&x.length>=3&&x.length<=256&&/^-?(?:0|[1-9][0-9]*)$/.test(x)&&x!=='-0'){
    const n=BigInt(x),m=n<0n?-n:n;let hex=m.toString(16);if(hex.length%2)hex='0'+hex;
    const b=Buffer.from(hex,'hex');byte(n<0n?13:12);integer(b.length);emit(b);return;
   }
   const hex=/^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(x);const b=Buffer.from(hex?x.slice(2):x,hex?'hex':'utf8');byte(hex?7:6);integer(b.length);emit(b);return;}
  if(Array.isArray(x)){byte(8);integer(x.length);for(const v of x)write(v);return;}
  if(x&&Object.getPrototypeOf(x)===Object.prototype){byte(9);const entries=Object.entries(x);integer(entries.length);for(const [k,v]of entries){write(k);write(v);}return;}fail('binary_evidence_invalid');
 }
 write(value);return Buffer.concat(chunks,size);
}
export function decodeEvidence(raw,{dictionary,resolveStableSymbol,resolveMembershipAddress}={}){
 if(!Buffer.isBuffer(raw))raw=Buffer.from(raw);const compact=raw.subarray(0,5).equals(COMPACT_MAGIC);if(raw.length>LIMIT||!compact&&!raw.subarray(0,5).equals(MAGIC))fail('binary_evidence_invalid');let at=5,nodes=0;
 const take=n=>{if(!Number.isSafeInteger(n)||n<0||at+n>raw.length)fail('binary_evidence_invalid');const b=raw.subarray(at,at+n);at+=n;return b;};
 const integer=()=>{let n=0,factor=1,count=0,b;do{b=take(1)[0];n+=(b%128)*factor;factor*=128;if(++count>8||!Number.isSafeInteger(n))fail('binary_evidence_invalid');}while(b>=128);if(count>1&&b===0)fail('binary_evidence_invalid');return n;};
 function read(depth=0){if(++nodes>NODES||depth>64)fail('binary_evidence_budget');const tag=take(1)[0];if(tag===0)return null;if(tag===1)return false;if(tag===2)return true;if(tag===3)return integer();if(tag===4)return -integer();if(tag===5){const n=take(8).readDoubleLE();if(!Number.isFinite(n))fail('binary_evidence_invalid');return n;}
  if(tag===10){const index=integer();if(!Array.isArray(dictionary)||typeof dictionary[index]!=='string')fail('binary_evidence_invalid');return dictionary[index];}
  if(tag===11){const id=integer();if(!compact||id<1||typeof resolveStableSymbol!=='function')fail('binary_evidence_invalid');const value=resolveStableSymbol(id);if(typeof value!=='string'||!/^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value))fail('binary_evidence_invalid');return value;}
  if(tag===12||tag===13){if(!compact)fail('binary_evidence_invalid');const b=take(integer());if(!b.length||b.length>107||b.length>1&&b[0]===0)fail('binary_evidence_invalid');const n=BigInt('0x'+b.toString('hex'));if(tag===13&&n===0n)fail('binary_evidence_invalid');const text=(tag===13?-n:n).toString();if(text.length>256)fail('binary_evidence_invalid');return text;}
  if(tag===14){if(!compact||typeof resolveMembershipAddress!=='function')fail('binary_evidence_invalid');const count=integer();if(count>100000)fail('binary_evidence_budget');const bytes=Buffer.alloc(count*20);for(let i=0;i<count;i++){const id=integer();if(id<1)fail('binary_evidence_invalid');const address=resolveMembershipAddress(id);if(!Buffer.isBuffer(address)||address.length!==20)fail('binary_evidence_invalid');address.copy(bytes,i*20);}return bytes.toString('base64');}
  if(tag===6||tag===7){const b=take(integer());if(tag===7){if(![20,32].includes(b.length))fail('binary_evidence_invalid');return '0x'+b.toString('hex');}const s=b.toString('utf8');if(!Buffer.from(s).equals(b))fail('binary_evidence_invalid');return s;}
  if(tag===8){const n=integer();if(n>NODES-nodes)fail('binary_evidence_budget');const out=[];for(let i=0;i<n;i++)out.push(read(depth+1));return out;}
  if(tag===9){const n=integer();if(n>NODES-nodes)fail('binary_evidence_budget');const out={};for(let i=0;i<n;i++){const k=read(depth+1);if(typeof k!=='string'||Object.hasOwn(out,k)||['__proto__','constructor','prototype'].includes(k))fail('binary_evidence_invalid');out[k]=read(depth+1);}return out;}fail('binary_evidence_invalid');
 }
 const value=read();if(at!==raw.length)fail('binary_evidence_invalid');return value;
}
