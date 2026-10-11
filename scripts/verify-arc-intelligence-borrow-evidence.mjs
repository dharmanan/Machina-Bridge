// Actual owner-supplied mainnet capture, replayed through the unchanged proxy and identity validator.
// Mutations below are negative regressions; they are never counted as real mainnet acceptance.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { hash, assertHeapBudget } from '../server/intelligence-pipeline/storage.js';
import { BORROW_MARKETS_UPSTREAM_URL, normalizeBorrowMarketsPage, compatibleBorrowMarkets,
  handleBorrowMarketsProxy, BORROW_MARKETS_SCHEMA } from '../api/_lib/borrow-markets-proxy.js';
const [capturePath, reportPath] = process.argv.slice(2);
if(!capturePath?.startsWith('/tmp/')||!reportPath?.startsWith('/tmp/'))throw Error('isolated_capture_paths_required');
const capture=JSON.parse(readFileSync(capturePath)),body=JSON.stringify(capture.response);
assertHeapBudget();let checks=0;
const test=async(name,f)=>{await f();checks++;console.log('PASS '+name);};
async function proxy(payload=capture.response,{status=200}={}) {
  let requests=0,reply;
  await handleBorrowMarketsProxy({method:'GET',send:r=>{reply=r;},fetchImpl:async(url,options)=>{
    requests++;assert.equal(url,BORROW_MARKETS_UPSTREAM_URL);assert.equal(options.method,'GET');
    assert.equal(options.redirect,'manual');assert.deepEqual(options.headers,{accept:'application/json'});
    return{status,text:async()=>JSON.stringify(payload)};
  }});
  assert.equal(requests,1);return reply;
}
await test('real Codespaces mainnet page has reproducible original bytes and hash',()=>{
  assert.equal(capture.endpoint,BORROW_MARKETS_UPSTREAM_URL);assert.equal(capture.httpStatus,200);
  assert.equal(capture.requests,1);assert.equal(Buffer.byteLength(body),7491);
  assert.equal(hash(body),'70ae7375da0dd94260ffbd176befc51de9494a8ff9f32a72f04c40096d8a310a');
  assert.equal(hash(body),capture.responseSha256);assert.equal(capture.heapLimitBytes,56623104);
});
await test('all fourteen source rows validate; only two canonical cirBTC/USDC markets qualify',()=>{
  const all=normalizeBorrowMarketsPage(capture.response);assert.equal(all.length,14);
  const compatible=compatibleBorrowMarkets(all);assert.equal(compatible.length,2);
  assert.deepEqual(compatible.map(m=>m.liquidity.amount),['0.01','977415.429911']);
  assert.deepEqual(compatible.map(m=>m.borrowAssets.amount),['15037.812135','193993947.167902']);
  assert.deepEqual(compatible.map(m=>m.borrowApy),[0.018983,0.024118]);
});
await test('the unchanged public proxy publishes the actual verified market pair',async()=>{
  const r=await proxy();assert.equal(r.status,200);const p=JSON.parse(r.body);
  assert.equal(p.schema,BORROW_MARKETS_SCHEMA);assert.equal(p.chain,'Arc');assert.equal(p.markets.length,2);
});
await test('canonical token decimal or symbol mismatch fails the whole page',async()=>{
  for(const field of['decimals','symbol']){
    const p=structuredClone(capture.response);const token=p.data.markets.find(m=>m.marketName==='cirBTC/USDC').collateralAsset;
    token[field]=field==='decimals'?18:'BTC';assert.equal((await proxy(p)).status,502);
  }
});
await test('duplicate compatible market IDs and wrong chain fail closed',async()=>{
  const p=structuredClone(capture.response);p.data.markets.push(p.data.markets.find(m=>m.marketName==='cirBTC/USDC'));
  assert.equal((await proxy(p)).status,502);
  p.data.markets.pop();p.data.markets[0].chain='ARC_TESTNET';assert.equal((await proxy(p)).status,502);
});
await test('absent terms remain null, without a zero or inferred liquidity',async()=>{
  const p=structuredClone(capture.response);for(const m of p.data.markets){m.liquidity=null;m.borrowApy=null;}
  const r=await proxy(p);assert.equal(r.status,200);
  for(const m of JSON.parse(r.body).markets){assert.equal(m.liquidity,null);assert.equal(m.borrowApy,null);}
});
await test('HTTP authorization failure makes one request and does not invent a paid-service need',async()=>{
  const r=await proxy(null,{status:401});assert.equal(r.status,502);
});
const report={checks,source:'Owner-supplied real Codespaces HTTP response, with byte-exact checksum replay',
  capturedAt:capture.checkedAt,responseBytes:capture.responseBytes,responseSha256:capture.responseSha256,
  originalRequestDurationMs:capture.durationMs,sourceMarketCount:14,compatibleMarketCount:2,
  heapBudget:assertHeapBudget(),liveRpcOrHttpRequestsInThisTest:0,walletOperations:0,productionAccess:false,
  acceptance:{marketPageAndProxyVerified:true,allPagesVerified:false,mainnetBorrowTransactionVerified:false,full84Fields:false}};
writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
