// No network, funded wallet, signature, approval, fork writes or transaction submission.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const ts = require('typescript')
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file,
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file)
const root = fileURLToPath(new URL('..', import.meta.url))
let external = 0
globalThis.fetch = async () => { external++; throw Error('network_forbidden') }
const p = require(`${root}src/lib/uniswapArcPolicy.ts`)
const s = require(`${root}api/_lib/uniswap-arc-preview.ts`)
const { createUniswapArcPreviewReader } = require(`${root}src/lib/uniswapArcPreview.ts`)
const handler = require(`${root}api/uniswap-arc-preview.ts`).handleDevelopmentArcPreview
const { encodeAbiParameters: abi, encodeFunctionData: fn, keccak256 } = require('viem')
const runtime = readFileSync(`${root}scripts/fixtures/uniswap-arc/router-runtime.hex`, 'utf8').trim()
const owner = '0x1111111111111111111111111111111111111111'
const wrong = '0x2222222222222222222222222222222222222222'
const request = { chainId: 5042, tokenIn: 'USDC', tokenOut: 'EURC', owner, recipient: owner, amount: '1', minimumOutput: '900000', slippageBps: 100, maxNetworkFee: '100000000000000000' }
const now = Date.now()
let count = 0
async function test(name, run) { await run(); count++; console.log(`PASS ${name}`) }
function fixture(r = request, changes = {}) {
  const output = p.ARC_OUTPUTS[r.tokenOut].address
  const swap = { poolKey: { currency0: p.ARC_NATIVE, currency1: output, fee: 500, tickSpacing: 10, hooks: p.ARC_NATIVE }, zeroForOne: true, amountIn: p.nativeAmount(r.amount), amountOutMinimum: 990000n, hookData: '0x', ...changes.swap }
  const params = changes.params ?? [abi(p.V4_SINGLE, [swap]), abi(p.CURRENCY_AMOUNT, [p.ARC_NATIVE, p.nativeAmount(r.amount)]), abi(p.CURRENCY_AMOUNT, [output, 990000n])]
  const input = abi(p.V4_ENVELOPE, [changes.actions ?? '0x060c0f', params])
  const refund = abi(p.NATIVE_REFUND,[p.ARC_NATIVE,changes.refundRecipient ?? r.recipient,0n])
  const data = fn({ abi: p.EXECUTE_ABI, functionName: 'execute', args: [changes.commands ?? '0x1004', [input,refund], changes.deadline ?? BigInt(Math.floor(now / 1000) + 120)] })
  return { routing: 'CLASSIC', isTokenApprovalApplicable: false, permitData: null,
    quote: { chainId: 5042, swapper: owner, input: { token: p.ARC_NATIVE, amount: p.nativeAmount(r.amount).toString() }, output: { token: output, amount: '1000000', recipient: owner } },
    swapTransaction: { chainId: 5042, from: owner, to: p.ARC_ROUTER, value: p.nativeAmount(r.amount).toString(), data } }
}
function service(options = {}) {
  const calls = []
  const rpc = {
    getChainId: async () => 5042, getBlockNumber: async () => 27114546n,
    getCode: async ({ address }) => address === p.ARC_ROUTER ? runtime : '0x6000',
    readContract: async ({ address }) => address.toLowerCase() === p.ARC_OUTPUTS.EURC.address.toLowerCase() ? 6 : 8,
    getBalance: async () => 10n ** 20n, getGasPrice: async () => 25000000000n,
    call: async args => { calls.push(['call', args]); return { data: '0x' } },
    estimateGas: async args => { calls.push(['estimateGas', args]); return 100000n },
    ...options.rpc,
  }
  const fetcher = options.fetch ?? (async (url, init) => {
    calls.push(['fetch', url, init])
    assert.equal(url, 'https://trade-api.gateway.uniswap.org/v1/quote')
    assert.equal(init.headers['x-api-key'], 'server-test-key')
    assert.equal(init.redirect, 'error')
    return Response.json(options.raw ?? fixture(options.request ?? request))
  })
  return { calls, run: s.createArcPreviewService({ client: rpc, fetch: fetcher, now: options.now ?? (() => now) }) }
}
await test('only native USDC to EURC/cirBTC; reverse/WETH/wrong chain and unknown request fields blocked', () => {
  for (const tokenOut of ['EURC','cirBTC']) p.validateArcRequest({ ...request, tokenOut })
  for (const delta of [{ chainId: 1 }, { tokenIn: 'EURC' }, { tokenIn: 'cirBTC' }, { tokenOut: 'USDC' }, { tokenOut: 'WETH' }, { apiKey: 'forbidden' }, { recipient: wrong }, { amount: '11' }, { amount: '0' }, { amount: '1e18' }, { slippageBps: 101 }, { minimumOutput: '0' }, { maxNetworkFee: '100000000000000001' }]) assert.throws(() => p.validateArcRequest({ ...request, ...delta }))
})
await test('official router runtime fixture matches pinned hash', () => assert.equal(keccak256(runtime), p.ARC_ROUTER_HASH))
await test('both outputs decode exact native value, token path, minimum and implicit locker recipient', () => {
  for (const tokenOut of ['EURC','cirBTC']) {
    const r = { ...request, tokenOut }
    const result = s.parsePreparedQuote(fixture(r), r, now)
    assert.equal(result.economics.minimumOutput, '990000')
    assert.equal(result.transaction.value, '1000000000000000000')
  }
})
await test('CLASSIC V4 no-hooks, exact input, exact Permit2 cap and server-owned recipient request', () => {
  const body = s.quoteBody(request)
  assert.equal(body.tokenIn, p.ARC_USDC); assert.equal(body.amount, '1000000')
  assert.deepEqual(body.protocols, ['V4']); assert.equal(body.hooksOptions, 'V4_NO_HOOKS')
  assert.equal(body.recipient, owner); assert.equal(body.permitAmount, 'EXACT')
})
await test('approval, permits, UniswapX, failed simulation and missing prepared transaction blocked', () => {
  for (const delta of [{ routing: 'DUTCH_V2' }, { isTokenApprovalApplicable: true }, { permitData: {} }, { permitTransaction: {} }, { approval: {} }, { txFailureReasons: ['failed'] }, { swapTransaction: null }]) assert.throws(() => s.parsePreparedQuote({ ...fixture(), ...delta }, request, now))
})
await test('API echoes cannot authorize wrong owner/token/amount/output or extra fees', () => {
  for (const delta of [{ chainId: 1 }, { swapper: wrong }, { input: { token: p.ARC_OUTPUTS.EURC.address, amount: '1' } }, { output: { token: wrong, amount: '1000000' } }, { portionBips: 1 }]) {
    const raw = fixture(); raw.quote = { ...raw.quote, ...delta }; assert.throws(() => s.parsePreparedQuote(raw, request, now))
  }
})
await test('wrong router/from/native value/chain and extra transaction authorizations rejected', () => {
  for (const delta of [{ to: wrong }, { from: wrong }, { value: '1' }, { chainId: 1 }, { authorizationList: [] }]) {
    const raw = fixture(); raw.swapTransaction = { ...raw.swapTransaction, ...delta }; assert.throws(() => s.parsePreparedQuote(raw, request, now))
  }
})
await test('independent decoder rejects lowered minimum, altered input, hooks, token and payer direction', () => {
  for (const swap of [{ amountIn: 1n }, { amountOutMinimum: 1n }, { hookData: '0x01' }, { zeroForOne: false }, { poolKey: { currency0: p.ARC_NATIVE, currency1: wrong, fee: 500, tickSpacing: 10, hooks: p.ARC_NATIVE } }, { poolKey: { currency0: p.ARC_NATIVE, currency1: p.ARC_OUTPUTS.EURC.address, fee: 500, tickSpacing: 10, hooks: wrong } }]) assert.throws(() => s.parsePreparedQuote(fixture(request, { swap }), request, now))
})
await test('flags/subplans/splits/arbitrary actions/fee transfers and approval commands rejected', () => {
  for (const commands of ['0x90','0x10ff','0x21','0x0a','0x00']) assert.throws(() => s.parsePreparedQuote(fixture(request, { commands }), request, now))
  for (const actions of ['0x060b0f','0x060c0e','0x060c0f10']) assert.throws(() => s.parsePreparedQuote(fixture(request, { actions }), request, now))
})
await test('leftover native funds must refund explicitly to the observed wallet', () => {
  assert.throws(()=>s.parsePreparedQuote(fixture(request,{commands:'0x10'}),request,now))
  assert.throws(()=>s.parsePreparedQuote(fixture(request,{refundRecipient:wrong}),request,now))
})
await test('settlement currency, max native debit, output token and output floor bound independently', () => {
  const output = p.ARC_OUTPUTS.EURC.address
  const base = fixture()
  const outer = require('viem').decodeFunctionData({ abi: p.EXECUTE_ABI, data: base.swapTransaction.data })
  const [,params] = require('viem').decodeAbiParameters(p.V4_ENVELOPE, outer.args[1][0])
  for (const [index, data] of [[1, abi(p.CURRENCY_AMOUNT,[wrong,10n**18n])], [1, abi(p.CURRENCY_AMOUNT,[p.ARC_NATIVE,10n**18n+1n])], [2, abi(p.CURRENCY_AMOUNT,[output,1n])], [2,abi(p.CURRENCY_AMOUNT,[wrong,990000n])]]) {
    const mutated = [...params]; mutated[index] = data; assert.throws(() => s.parsePreparedQuote(fixture(request,{params:mutated}),request,now))
  }
})
await test('canonical outer ABI and deadline limits enforced', () => {
  const raw = fixture(); raw.swapTransaction.data += '00'
  assert.throws(() => s.parsePreparedQuote(raw,request,now))
  for (const deadline of [1n, BigInt(Math.floor(now/1000)+1801)]) assert.throws(() => s.parsePreparedQuote(fixture(request,{deadline}),request,now))
})
let goodReview
await test('server service prepares both directions and simulates exact calldata at checked block', async () => {
  for (const tokenOut of ['EURC','cirBTC']) {
    const r = { ...request, tokenOut }; const test = service({request:r}); const review = await test.run(r,'server-test-key')
    assert.equal(review.executionBound,false); assert.equal(review.writesEnabled,false)
    assert.equal(review.gasLimit,'130000'); assert.equal(review.maxFeePerGas,'50000000000')
    assert.equal(review.transaction.data,test.calls.find(c=>c[0]==='call')[1].data)
    assert.equal(test.calls.find(c=>c[0]==='call')[1].blockNumber,27114546n)
    assert.ok(!JSON.stringify(review).includes('server-test-key'))
    if(tokenOut==='EURC') goodReview=review
  }
})
await test('router identity, output decimals/code and RPC chain fail before upstream', async () => {
  for (const rpc of [{getChainId:async()=>1}, {getCode:async()=> '0x6000'}, {readContract:async()=>18}]) {
    const test=service({rpc});await assert.rejects(test.run(request,'server-test-key'));assert.equal(test.calls.length,0)
  }
})
await test('simulation failure, gas estimate failure, huge gas/fee, insufficient funds and unknown gas price reject', async () => {
  for(const rpc of [{call:async()=>{throw Error('revert')}},{estimateGas:async()=>{throw Error('gas unknown')}},{estimateGas:async()=>3000000n},{getBalance:async()=>10n**18n},{getGasPrice:async()=>0n},{getGasPrice:async()=>50000000001n}]) await assert.rejects(service({rpc}).run(request,'server-test-key'))
  await assert.rejects(service().run({...request,maxNetworkFee:'1'},'server-test-key'))
})
await test('upstream HTTP errors/oversize/no key are closed and no raw payload returned', async () => {
  await assert.rejects(service().run(request,''),/api_key_missing/)
  for(const response of [new Response('secret',{status:401}),Response.json({bad:'x'.repeat(140000)}),new Response('not json')]) await assert.rejects(service({fetch:async()=>response}).run(request,'server-test-key'))
})
await test('late upstream work cannot produce a fresh review', async () => {
  let tick=0
  await assert.rejects(service({now:()=>tick++===0?now:now+30001}).run(request,'server-test-key'),/expired|timeout/)
})
await test('server preparation concurrency is bounded and blocked calls do not call upstream', async () => {
  const waiting=[]
  const test=service({fetch:()=>new Promise(resolve=>waiting.push(resolve))})
  const first=test.run(request,'server-test-key'), second=test.run(request,'server-test-key')
  for(let i=0;i<10&&waiting.length<2;i++)await new Promise(resolve=>setImmediate(resolve))
  await assert.rejects(test.run(request,'server-test-key'),/preview_busy/)
  assert.equal(waiting.length,2)
  waiting.forEach(resolve=>resolve(Response.json(fixture())))
  await Promise.all([first,second])
})
await test('expired or mutated review, wallet disconnect/change/chain change and fee forgery reject', () => {
  const ctx={owner,chainId:5042,connected:true}
  p.validateArcReview(goodReview,ctx,now)
  for(const context of [{...ctx,owner:wrong},{...ctx,connected:false},{...ctx,chainId:1}]) assert.throws(()=>p.validateArcReview(goodReview,context,now))
  assert.equal(goodReview.estimatedOutput, '1000000')
  for(const delta of [{expiresAt:now},{expiresAt:now+31000},{networkFee:'0'},{routerHash:'0x00'},{executionBound:true},{writesEnabled:true},{estimatedOutput:undefined},{estimatedOutput:'0'},{estimatedOutput:'989999'},{estimatedOutput:'99999999999999999'}]) assert.throws(()=>p.validateArcReview({...goodReview,...delta},ctx,now))
})
await test('submission hard stop prevents repeated sends before any dependency', async () => {
  assert.equal(p.UNISWAP_ARC_WRITES_ENABLED,true)
  for(let i=0;i<3;i++)await assert.rejects(p.submitUniswapArcSwap(),/writes_disabled/)
  for(const method of ['eth_sendTransaction','eth_sendRawTransaction','personal_sign','eth_signTypedData_v4','wallet_sendCalls'])assert.throws(()=>s.assertArcReadMethod(method),/read_only_rpc/)
})
await test('browser reads same-origin only, verifies response, and invalidates changed contexts', async () => {
  let ctx={owner,chainId:5042,connected:true}
  const reader=createUniswapArcPreviewReader(()=>ctx,async(url,init)=>{assert.equal(url,'/api/uniswap-arc-preview');assert.equal(Object.keys(init.headers).length,2);return Response.json(goodReview,{headers:{'X-Preview-Request-Id':init.headers['X-Preview-Request-Id'],'X-Preview-Server-Time':String(Date.now())}})})
  await reader.read(request);assert.ok(reader.current(request,now));assert.equal(reader.current({...request,amount:'2'},now),null)
  await reader.read(request);ctx={...ctx,owner:wrong};assert.equal(reader.current(request,now),null)
  await assert.rejects(reader.read(request),error=>error.code==='context')
})
await test('browser cancellation and concurrent duplicate readers cannot publish stale reviews', async () => {
  let release
  const ctx={owner,chainId:5042,connected:true}
  const reader=createUniswapArcPreviewReader(()=>ctx,()=>new Promise(resolve=>{release=resolve}))
  const pending=reader.read(request)
  await assert.rejects(createUniswapArcPreviewReader(()=>ctx).read(request),error=>error.code==='busy')
  reader.invalidate();release(Response.json(goodReview));await assert.rejects(pending,error=>error.code==='cancelled');assert.equal(reader.current(request),null)
})
await test('private development handler requires configured origin, rejects methods/body and sanitizes failures', async () => {
  const previousOrigin=process.env.UNISWAP_ARC_ALLOWED_ORIGIN, previousKey=process.env.UNISWAP_TRADING_API_KEY
  const runtime = Object.fromEntries(['NODE_ENV','VERCEL','VERCEL_ENV'].map(key=>[key,process.env[key]]))
  process.env.NODE_ENV='development';delete process.env.VERCEL;delete process.env.VERCEL_ENV
  process.env.UNISWAP_ARC_ALLOWED_ORIGIN='https://example.test';delete process.env.UNISWAP_TRADING_API_KEY
  async function run(req){let status=0,body;const headers={};const res={setHeader:(k,v)=>{headers[k]=v},status:n=>{status=n;return res},json:v=>{body=v}};await handler(req,res);return {status,body,headers}}
  try {
    assert.equal((await run({method:'GET',headers:{}})).status,405)
    assert.equal((await run({method:'POST',headers:{origin:'https://evil.test'}})).status,403)
    const headers={origin:'https://example.test','content-type':'application/json'}
    assert.equal((await run({method:'POST',headers,body:'x'.repeat(9000)})).status,413)
    const failed=await run({method:'POST',headers,body:request});assert.equal(failed.status,503);assert.equal(failed.headers['Cache-Control'],'no-store');assert.equal(JSON.stringify(failed.body).includes('api_key'),false)
  } finally {
    if(previousOrigin===undefined)delete process.env.UNISWAP_ARC_ALLOWED_ORIGIN;else process.env.UNISWAP_ARC_ALLOWED_ORIGIN=previousOrigin
    if(previousKey===undefined)delete process.env.UNISWAP_TRADING_API_KEY;else process.env.UNISWAP_TRADING_API_KEY=previousKey
    for(const [key,value] of Object.entries(runtime))if(value===undefined)delete process.env[key];else process.env[key]=value
  }
})
const originalGroups = count
assert.equal(originalGroups,23,'retain every original safety group')
const evidence = Object.fromEntries(['EURC','cirBTC'].map(symbol => [symbol, JSON.parse(readFileSync(`${root}scripts/fixtures/uniswap-arc/USDC-${symbol}.json`,'utf8'))]))
const provenance = JSON.parse(readFileSync(`${root}scripts/fixtures/uniswap-arc/quote-evidence-provenance.json`,'utf8'))
function evidenceRequest(symbol) {
  const raw=evidence[symbol]
  return {...request,owner:raw.swapTransaction.from,recipient:raw.quote.output.recipient,tokenOut:symbol,slippageBps:50,minimumOutput:raw.quote.output.minimumAmount}
}
function inspect(symbol, raw=evidence[symbol], r=evidenceRequest(symbol)) { return s.inspectCapturedArcQuote(raw,r,Date.now()) }
function alterPlan(symbol, update) {
  const raw=structuredClone(evidence[symbol])
  const decoded=require('viem').decodeFunctionData({abi:p.EXECUTE_ABI,data:raw.swapTransaction.data})
  const original=fn({abi:p.EXECUTE_ABI,functionName:'execute',args:decoded.args})
  const tail=raw.swapTransaction.data.slice(original.length)
  const plan={commands:decoded.args[0],inputs:[...decoded.args[1]],deadline:decoded.args[2]}
  update(plan)
  raw.swapTransaction.data=fn({abi:p.EXECUTE_ABI,functionName:'execute',args:[plan.commands,plan.inputs,plan.deadline]})+tail
  return raw
}
function alterV4(update) {
  return alterPlan('EURC',plan=>{
    const [actions,decoded]=require('viem').decodeAbiParameters(p.V4_ENVELOPE,plan.inputs[0])
    const v4={actions,params:[...decoded]};update(v4)
    plan.inputs[0]=abi(p.V4_ENVELOPE,[v4.actions,v4.params])
  })
}
await test('uploaded quote JSON bytes match recorded SHA256, not fabricated fixtures',()=>{
  for(const symbol of ['EURC','cirBTC']) {
    const name=`USDC-${symbol}.json`
    assert.equal(require('node:crypto').createHash('sha256').update(readFileSync(`${root}scripts/fixtures/uniswap-arc/${name}`)).digest('hex'),provenance.files[name])
  }
})
for(const symbol of ['EURC','cirBTC']) await test(`REAL archived USDC→${symbol}: unchanged calldata independently verifies economics; remains expired and non-executable`,()=>{
  const raw=evidence[symbol],r=evidenceRequest(symbol),out=inspect(symbol)
  assert.equal(out.evidenceStatus,'ECONOMICS_VERIFIED_ARCHIVE')
  assert.equal(out.economics.minimumOutput,raw.quote.output.minimumAmount)
  assert.equal(out.economics.inputToken,p.ARC_USDC)
  assert.equal(out.economics.outputToken,p.ARC_OUTPUTS[symbol].address)
  assert.equal(out.economics.profile,symbol==='EURC'?'arc-usdc-v4-single-hop':'arc-usdc-v3-single-hop')
  assert.equal(out.economics.poolIdentity.toLowerCase(),raw.quote.route[0][0].address.toLowerCase())
  assert.equal(out.economics.suffix,'unix-0000-quote-uuid')
  assert.equal(out.economics.calldataHash,keccak256(raw.swapTransaction.data))
  assert.equal(p.transactionValue(out.transaction.value),1000000000000000000n)
  assert.equal(out.expired,true);assert.equal(out.liveEligible,false)
  assert.equal(out.permissionEvidence,'REQUIRES_FRESH_LIVE_RESPONSE')
  assert.equal(out.executionBound,false);assert.equal(out.writesEnabled,false)
  assert.throws(()=>s.parsePreparedQuote(raw,r,Date.now()),/approval_evidence_missing/)
  assert.throws(()=>p.verifyNativeCalldata(raw.swapTransaction,r,BigInt(r.minimumOutput),Date.now(),raw.quote.quoteId),/deadline/)
  assert.throws(()=>p.validateArcReview(out,{owner:r.owner,chainId:5042,connected:true}))
})
await test('decimal and hex native values map exactly to 6-decimal USDC units; malformed/unsafe values reject',()=>{
  for(const symbol of ['EURC','cirBTC']){
    const raw=structuredClone(evidence[symbol]);raw.swapTransaction.value='1000000000000000000';inspect(symbol,raw)
    for(const value of ['1000000','0x0',1e18,'1e18','-1','0x','0x'+ 'f'.repeat(65),'01000000000000000000']){
      const changed=structuredClone(raw);changed.swapTransaction.value=value;assert.throws(()=>inspect(symbol,changed))
    }
    const changed=structuredClone(raw);changed.quote.input.amount='1000000000000000000';assert.throws(()=>inspect(symbol,changed))
  }
})
await test('only exact unix + 0000 + matching quote UUID is allowed at canonical ABI boundary',()=>{
  for(const symbol of ['EURC','cirBTC']){
    const raw=evidence[symbol],data=raw.swapTransaction.data,body=data.slice(0,-44),suffix=data.slice(-44)
    for(const tail of [suffix+'00',suffix.slice(2),`deadbeef${suffix.slice(8)}`,`${suffix.slice(0,8)}0001${suffix.slice(12)}`,`${suffix.slice(0,-2)}ff`,'00'.repeat(22)]){
      const changed=structuredClone(raw);changed.swapTransaction.data=body+tail;assert.throws(()=>inspect(symbol,changed))
    }
    const changed=structuredClone(raw);changed.quote.quoteId='00000000-0000-0000-0000-000000000000';assert.throws(()=>inspect(symbol,changed))
  }
})
await test('discrete output floor matches API without an arbitrary one-unit exception',()=>{
  assert.equal(p.minimumAtSlippage(890112n,50),885661n)
  assert.equal(p.minimumAtSlippage(1193n,50),1187n)
  for(const symbol of ['EURC','cirBTC']){
    const raw=structuredClone(evidence[symbol]);const lower=(BigInt(raw.quote.output.minimumAmount)-1n).toString()
    raw.quote.output.minimumAmount=lower;raw.quote.aggregatedOutputs[0].minAmount=lower
    assert.throws(()=>inspect(symbol,raw,{...evidenceRequest(symbol),minimumOutput:lower}),/invalid_api_minimum/)
    const stronger={...evidenceRequest(symbol),minimumOutput:(BigInt(evidence[symbol].quote.output.minimumAmount)+1n).toString()}
    assert.throws(()=>inspect(symbol,evidence[symbol],stronger),/economic_mismatch/)
  }
})
await test('100% single aggregated output must match amount/token/recipient/floor, with no fee or hidden fields',()=>{
  for(const symbol of ['EURC','cirBTC']){
    const raw=evidence[symbol]
    for(const change of [{bps:9999},{recipient:wrong},{token:wrong},{amount:'1'},{minAmount:'1'},{fee:'1'},{unreviewed:true}]){
      const changed=structuredClone(raw);Object.assign(changed.quote.aggregatedOutputs[0],change);assert.throws(()=>inspect(symbol,changed))
    }
    for(const records of [[],[raw.quote.aggregatedOutputs[0],raw.quote.aggregatedOutputs[0]],null]){
      const changed=structuredClone(raw);changed.quote.aggregatedOutputs=records;assert.throws(()=>inspect(symbol,changed))
    }
  }
})
await test('real V4 path rejects multiple hops, hooks, different amount/token and nonempty opaque price arrays',()=>{
  const decoded=require('viem').decodeFunctionData({abi:p.EXECUTE_ABI,data:evidence.EURC.swapTransaction.data})
  const [,params]=require('viem').decodeAbiParameters(p.V4_ENVELOPE,decoded.args[1][0])
  const [swap]=require('viem').decodeAbiParameters(p.V4_PATH,params[0])
  for(const change of [{currencyIn:p.ARC_NATIVE},{amountIn:1000000000000000000n},{amountOutMinimum:1n},{path:[swap.path[0],swap.path[0]]},{path:[{...swap.path[0],hooks:wrong}]},{path:[{...swap.path[0],hookData:'0x01'}]},{maxHopSlippage:[1n]}]){
    const altered=alterV4(v=>{v.params[0]=abi(p.V4_PATH,[{...swap,...change}])});assert.throws(()=>inspect('EURC',altered))
  }
})
await test('real V4 SETTLE/TAKE enforce router payer, exact open-delta sentinels and same wallet recipient',()=>{
  for(const [index,data] of [[1,abi(p.V4_SETTLE,[p.ARC_USDC,0n,true])],[1,abi(p.V4_SETTLE,[wrong,0n,false])],[1,abi(p.V4_SETTLE,[p.ARC_USDC,1n,false])],[1,abi(p.V4_SETTLE,[p.ARC_USDC,2n**255n,false])],[2,abi(p.V4_TAKE,[p.ARC_OUTPUTS.EURC.address,wrong,0n])],[2,abi(p.V4_TAKE,[p.ARC_OUTPUTS.EURC.address,evidence.EURC.swapTransaction.from,1n])]]){
    assert.throws(()=>inspect('EURC',alterV4(v=>{v.params[index]=data})))
  }
})
await test('real V3 exact-input payer/path/recipient/minimum are independently enforced',()=>{
  const decoded=require('viem').decodeFunctionData({abi:p.EXECUTE_ABI,data:evidence.cirBTC.swapTransaction.data})
  const args=require('viem').decodeAbiParameters(p.V3_INPUT,decoded.args[1][0])
  for(const [index,value] of [[0,wrong],[1,1000000000000000000n],[1,0n],[2,1n],[3,args[3]+args[3].slice(42)],[3,'0x'+wrong.slice(2)+args[3].slice(42)],[4,true],[5,[1n]]]){
    assert.throws(()=>inspect('cirBTC',alterPlan('cirBTC',v=>{const changed=[...args];changed[index]=value;v.inputs[0]=abi(p.V3_INPUT,changed)})))
  }
})
await test('real calldata rejects additional commands/actions, wrong refunds, router/from and chain',()=>{
  for(const symbol of ['EURC','cirBTC']){
    for(const commands of ['0x0a04','0x2104','0x9004','0x000410','0x100400'])assert.throws(()=>inspect(symbol,alterPlan(symbol,v=>{v.commands=commands})))
    const refund=abi(p.NATIVE_REFUND,[p.ARC_NATIVE,wrong,0n]);assert.throws(()=>inspect(symbol,alterPlan(symbol,v=>{v.inputs[1]=refund})))
    for(const delta of [{to:wrong},{from:wrong},{chainId:1},{authorizationList:[]}]){const raw=structuredClone(evidence[symbol]);Object.assign(raw.swapTransaction,delta);assert.throws(()=>inspect(symbol,raw))}
  }
  for(const actions of ['0x070b0e0a','0x070c0e','0x070b0f'])assert.throws(()=>inspect('EURC',alterV4(v=>{v.actions=actions})))
})
await test('real route metadata must agree with decoded single-hop plan; split, mismatched fees or pool types reject',()=>{
  for(const symbol of ['EURC','cirBTC']){
    for(const update of [q=>q.route.push(q.route[0]),q=>q.route[0].push(q.route[0][0]),q=>{q.route[0][0].address=wrong},q=>{q.route[0][0].fee='1'},q=>{q.route[0][0].type='v2-pool'},q=>{q.slippage=1},q=>{q.tradeType='EXACT_OUTPUT'}]){
      const raw=structuredClone(evidence[symbol]);update(raw.quote);assert.throws(()=>inspect(symbol,raw))
    }
  }
})
await test('live approval information is mandatory; archive missing fields never become false/null permission proof',()=>{
  for(const symbol of ['EURC','cirBTC']){
    const raw=evidence[symbol];assert.equal(Object.hasOwn(raw,'permitData'),false);assert.equal(Object.hasOwn(raw,'isTokenApprovalApplicable'),false)
    assert.equal(inspect(symbol).liveEligible,false)
    for(const delta of [{permitData:{}},{isTokenApprovalApplicable:true},{permitTransaction:{}},{approval:{}}])assert.throws(()=>inspect(symbol,{...raw,...delta}))
  }
})
await test('server requests pin actual ERC-20 quote representation and approved protocol by direction',()=>{
  for(const symbol of ['EURC','cirBTC']){
    const body=s.quoteBody(evidenceRequest(symbol));assert.equal(body.tokenIn,p.ARC_USDC);assert.equal(body.amount,'1000000')
    assert.deepEqual(body.protocols,symbol==='EURC'?['V4']:['V3']);assert.equal(body.permitAmount,'EXACT')
  }
})
assert.equal(external,0)
console.log(`${count} Uniswap Arc security checks PASS (${originalGroups} retained groups + ${count-originalGroups} evidence/negative groups). Real uploaded calldata verified offline; no external requests, signatures or transactions.`)
