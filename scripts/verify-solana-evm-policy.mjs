import assert from 'node:assert/strict'
import{createRequire}from'node:module';import{readFileSync}from'node:fs'
const require=createRequire(import.meta.url),ts=require('typescript');require.extensions['.ts']=(m,p)=>m._compile(ts.transpileModule(readFileSync(p,'utf8').replaceAll('import.meta.env','({})'),{fileName:p,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX}}).outputText,p)
const v=require('viem'),P=require('../src/lib/solanaBridgeEvmPolicy.ts'),fx=JSON.parse(readFileSync(new URL('./fixtures/g1-evm-transactions.json',import.meta.url)))
const [good,bad]=fx.transactions,sol='8UsDvWtFPzYBjzrgrB3j4oufte5iwm4Mx5A2tZ7ocTGg'
const ctx={mode:'burn',owner:good.from,solanaOwner:sol,amount:100000n,maxFee:0n,finality:1000,current:()=>true}
const call=t=>({from:t.from,to:t.to,data:t.input,value:t.value,chainId:t.chainId})
const approval={from:good.from,to:'0x3600000000000000000000000000000000000000',data:v.encodeFunctionData({abi:P.G1_ABI,functionName:'increaseAllowance',args:[P.G1_KIT,100000n]}),value:'0x0'}
let count=0;async function test(n,f){await f();console.log('PASS '+n);count++}
function provider(c=ctx){const seen=[];return{seen,p:P.createEvmBridgePolicyProvider({request:async a=>{if(a.method==='eth_chainId')return'0x13b2';if(a.method==='eth_accounts')return[good.from];seen.push(a);return'0x'+'11'.repeat(32)}},c)}}
await test('full real successful burn calldata decodes with original recipient, zero fee and Fast finality',()=>assert.equal(P.assertEvmBridgeCall(call(good),ctx),'burn'))
await test('full real Pocket Universe fee calldata is rejected (also at altered input amount)',()=>{assert.throws(()=>P.assertEvmBridgeCall(call(bad),ctx));assert.throws(()=>P.assertEvmBridgeCall(call(bad),{...ctx,amount:98400n,solanaOwner:'7bJT7x7UBeMLS5PwhqazRZPjbZa5amnnRHbD9zrG8YQR'}))})
await test('real allowance transaction accepted',()=>assert.equal(P.assertEvmBridgeCall(call(fx.transactions[2]),ctx),'approval'))
await test('allowance exact increment only; no other spender/amount/unlimited/approve',()=>{assert.equal(P.assertEvmBridgeCall(approval,ctx),'approval');for(const args of [[P.G1_KIT,100001n],[good.from,100000n],[P.G1_KIT,v.maxUint256]])assert.throws(()=>P.assertEvmBridgeCall({...approval,data:v.encodeFunctionData({abi:P.G1_ABI,functionName:'increaseAllowance',args})},ctx))})
await test('all economic burn fields are independently bound',()=>{const [b]=v.decodeFunctionData({abi:P.G1_ABI,data:good.input}).args;for(const change of [{amount:1n},{maxFee:1n},{fee:1n},{mintRecipient:'0x'+'11'.repeat(32)},{destinationCaller:'0x'+'11'.repeat(32)},{burnToken:good.from},{feeRecipient:good.from},{destinationDomain:6},{minFinalityThreshold:2000}])assert.throws(()=>P.assertEvmBridgeCall({...call(good),data:v.encodeFunctionData({abi:P.G1_ABI,functionName:'bridgeWithPreapproval',args:[{...b,...change}]})},ctx))})
await test('sender, chain, value, extra bytes/conflicting input and authorization envelope rejected',()=>{for(const change of [{from:P.G1_KIT},{chainId:'0x1'},{value:'0x1'},{data:good.input+'00'},{input:'0x1234'},{authorizationList:[]}])assert.throws(()=>P.assertEvmBridgeCall({...call(good),...change},ctx))})
await test('all unknown write/sign routes blocked; ordinary reads and capability reads pass',async()=>{const x=provider();for(const method of ['eth_sign','personal_sign','eth_signTypedData_v4','eth_signTransaction','eth_sendRawTransaction','wallet_signCalls','wallet_unknown'])await assert.rejects(()=>x.p.request({method,params:[]}));for(const method of ['eth_call','eth_estimateGas','wallet_getCapabilities'])await x.p.request({method,params:[]});assert.equal(x.seen.length,3)})
await test('whole batch validated before forwarding; extra call/reordered/different context rejected',async()=>{const batch={version:'2.0.0',chainId:'0x13b2',from:good.from,calls:[{to:approval.to,data:approval.data},{to:good.to,data:good.input}]};const x=provider();await x.p.request({method:'wallet_sendCalls',params:[batch]});assert.equal(x.seen.length,1);for(const b of [{...batch,calls:[...batch.calls,{to:good.from,data:'0x'}]},{...batch,calls:batch.calls.toReversed()},{...batch,chainId:'0x1'},{...batch,capabilities:{paymasterService:{url:'bad'}}}]){const y=provider();await assert.rejects(()=>y.p.request({method:'wallet_sendCalls',params:[b]}));assert.equal(y.seen.length,0)}})
await test('read-only estimate provider cannot prompt for a transaction',async()=>{const x=provider({...ctx,mode:'read'});await assert.rejects(()=>x.p.request({method:'eth_sendTransaction',params:[call(good)]}));assert.equal(x.seen.length,0)})
await test('request snapshot cannot mutate during asynchronous wallet identity reads',async()=>{const a={method:'eth_sendTransaction',params:[call(good)]};const seen=[];const x=P.createEvmBridgePolicyProvider({request:async q=>{if(q.method==='eth_chainId'){a.params[0].data=bad.input;return'0x13b2'}if(q.method==='eth_accounts')return[good.from];seen.push(q)}},ctx);await x.request(a);assert.equal(seen[0].params[0].data,good.input)})
await test('exact verified receive message/attestation forwarded; changed message rejected',async()=>{const abi=P.G1_ABI,arc=require('../src/config/mainnetCctp.ts').getMainnetCctpChain(5042);const c={...ctx,mode:'receive',receive:async()=>({message:'0xaabb',attestation:'0xccdd'})};const x=provider(c),t={from:good.from,to:arc.messageTransmitterAddress,data:v.encodeFunctionData({abi,functionName:'receiveMessage',args:['0xaabb','0xccdd']})};await x.p.request({method:'eth_sendTransaction',params:[t]});const y=provider(c);await assert.rejects(()=>y.p.request({method:'eth_sendTransaction',params:[{...t,data:v.encodeFunctionData({abi,functionName:'receiveMessage',args:['0xaa','0xccdd']})}]}));assert.equal(y.seen.length,0)})
await test('real B1 composition: rejection never marks signing or reaches wallet',async()=>{const store=new Map();globalThis.localStorage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)};globalThis.window={localStorage,dispatchEvent(){},addEventListener(){},removeEventListener(){}};const{withSolanaSendGuard}=require('../src/lib/solanaSendRuntime.ts'),G=require('../src/lib/solanaSendGuard.ts');let wallets=0;await assert.rejects(()=>withSolanaSendGuard({direction:'arc-to-solana',amount:'0.1',evmWallet:good.from,solanaWallet:sol},async guard=>{const x=P.createEvmBridgePolicyProvider(guard.evm({request:async a=>{if(a.method==='eth_sendTransaction')wallets++;return null}}),ctx);await x.request({method:'eth_sendTransaction',params:[call(bad)]})},{arcLatestBlock:async()=>1000n}));assert.equal(wallets,0);assert.ok(G.readSolanaSendAttempts().every(a=>!a.signingAt))})
await test('SDK network selection allows only exact Arc switch in burn and receive contexts',async()=>{
 for(const mode of ['burn','receive']){
  const seen=[];let chain='0x1'
  const p=P.createEvmBridgePolicyProvider({request:async a=>{seen.push(a.method);if(a.method==='eth_accounts')return[good.from];if(a.method==='eth_chainId')return chain;if(a.method==='wallet_switchEthereumChain'){assert.deepEqual(a.params,[{chainId:'0x13b2'}]);chain='0x13b2';return null}assert.fail('unexpected method')}},{...ctx,mode})
  assert.equal(await p.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x13b2'}]}),null)
  assert.deepEqual(seen,['eth_accounts','wallet_switchEthereumChain','eth_chainId','eth_accounts'])
 }
})
await test('network selection rejects wrong chains, malformed envelopes, read-only and stale contexts before wallet',async()=>{
 const request={method:'wallet_switchEthereumChain',params:[{chainId:'0x13b2'}]}
 for(const params of [[],[null],[{chainId:'0x1'}],[{chainId:5042}],[{chainId:'0x13b2',rpcUrls:['https://bad.invalid']}],[{chainId:'0x13b2'},{chainId:'0x13b2'}]]){
  const x=provider();await assert.rejects(()=>x.p.request({...request,params}));assert.equal(x.seen.length,0)
 }
 for(const context of [{...ctx,mode:'read'},{...ctx,current:()=>false}]){const x=provider(context);await assert.rejects(()=>x.p.request(request));assert.equal(x.seen.length,0)}
 const x=provider();await assert.rejects(()=>x.p.request({...request,extra:true}));await assert.rejects(()=>x.p.request({method:'wallet_addEthereumChain',params:[{chainId:'0x13b2'}]}));assert.equal(x.seen.length,0)
})
await test('network selection snapshots the target and verifies live account, chain and context after await',async()=>{
 for(const failure of ['before-account','after-account','chain','context','rejection','mutation']){
  let switched=false,active=true,attempts=0
  const args={method:'wallet_switchEthereumChain',params:[{chainId:'0x13b2'}]}
  const p=P.createEvmBridgePolicyProvider({request:async a=>{
   if(a.method==='eth_accounts'){
    if(failure==='mutation')args.params[0].chainId='0x1'
    return[(failure==='before-account'||failure==='after-account'&&switched)?P.G1_KIT:good.from]
   }
   if(a.method==='eth_chainId')return failure==='chain'?'0x1':'0x13b2'
   assert.equal(a.method,'wallet_switchEthereumChain');assert.deepEqual(a.params,[{chainId:'0x13b2'}]);attempts++;switched=true
   if(failure==='context')active=false
   if(failure==='rejection')throw Object.assign(new Error('controlled rejection'),{code:4001})
   return null
  }},{...ctx,current:()=>active})
  if(failure==='mutation')await p.request(args);else await assert.rejects(()=>p.request(args))
  assert.equal(attempts,failure==='before-account'?0:1)
 }
})
await test('G1 → B1 composition: exact network switch creates no burn signing record; invalid switch never reaches wallet',async()=>{
 const store=new Map();globalThis.localStorage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)};globalThis.window={localStorage,dispatchEvent(){},addEventListener(){},removeEventListener(){}}
 const{withSolanaSendGuard}=require('../src/lib/solanaSendRuntime.ts'),G=require('../src/lib/solanaSendGuard.ts');let switches=0
 await withSolanaSendGuard({direction:'arc-to-solana',amount:'0.1',evmWallet:good.from,solanaWallet:sol},async guard=>{
  const x=P.createEvmBridgePolicyProvider(guard.evm({request:async a=>{if(a.method==='eth_accounts')return[good.from];if(a.method==='eth_chainId')return'0x13b2';assert.equal(a.method,'wallet_switchEthereumChain');switches++;return null}}),ctx)
  await assert.rejects(()=>x.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x1'}]}))
  await x.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x13b2'}]})
  assert.ok(G.readSolanaSendAttempts().every(a=>a.phase==='prepared'&&!a.signingAt))
 },{arcLatestBlock:async()=>1000n})
 assert.equal(switches,1);assert.ok(G.readSolanaSendAttempts().every(a=>a.phase==='released'&&!a.signingAt))
})
await test('installed Viem adapter browser switch path crosses G1 without transaction or signature requests',async()=>{
 const {createAdapterFromProvider}=await import('@circle-fin/adapter-viem-v2')
 const {BridgeKit}=await import('@circle-fin/bridge-kit')
 const arc=new BridgeKit({disableErrorReporting:true}).getSupportedChains().find(c=>c.chainId===5042)
 assert.ok(arc);assert.ok(globalThis.window,'exercise the browser branch, not the Node shortcut')
 const methods=[]
 const provider=P.createEvmBridgePolicyProvider({on(){},removeListener(){},request:async a=>{
  methods.push(a.method)
  if(a.method==='eth_accounts')return[good.from]
  if(a.method==='eth_chainId')return'0x13b2'
  if(a.method==='wallet_switchEthereumChain'){assert.deepEqual(a.params,[{chainId:'0x13b2'}]);return null}
  assert.fail('unexpected wallet/RPC method: '+a.method)
 }},ctx)
 const adapter=await createAdapterFromProvider({provider})
 await adapter.switchToChain(arc)
 assert.equal(methods.filter(m=>m==='wallet_switchEthereumChain').length,1)
 assert.ok(methods.every(m=>['eth_accounts','eth_chainId','wallet_switchEthereumChain'].includes(m)))
})
console.log(`RESULT ${count}/${count} G1 groups PASS; controlled providers only, no signatures or broadcasts`)
