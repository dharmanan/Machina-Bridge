// Fee authorization only: real validator/hook/B1, controlled SDK/read/wallet ports.
// No network, real wallet signatures, simulation, broadcast or retry.
import assert from 'node:assert/strict'
import {createRequire, Module} from 'node:module'
import {readFileSync} from 'node:fs'
const require=createRequire(import.meta.url),ts=require('typescript')
require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(readFileSync(f,'utf8').replaceAll('import.meta.env','({})'),{fileName:f,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f)
const F=require('../src/lib/solanaFeeEstimate.ts')
const EVM='0xafbb6cc5c0a9c0eb1bff8db2ed807e83aab8e321',SOL='7bJT7x7UBeMLS5PwhqazRZPjbZa5amnnRHbD9zrG8YQR'
const intent={direction:'solana-to-arc',amount:'0.1',evmWallet:EVM,solanaWallet:SOL}
const quote=(fee='0.000003')=>({amount:'0.1',bridgeFee:fee,binding:{direction:intent.direction,evmWallet:EVM,solanaWallet:SOL,checkedAt:Date.now()}})
let count=0
async function test(name,fn){await fn();count++;console.log('PASS '+name)}
await test('positive fee and confirmed zero are accepted; absent, expired and future quotes are refused',()=>{
 assert.equal(F.assertSolanaFeeEstimate(quote(),intent),3n);assert.equal(F.assertSolanaFeeEstimate(quote('0'),intent),0n)
 for(const q of [null,{}, {...quote(),binding:{...quote().binding,checkedAt:Date.now()-60000}},{...quote(),binding:{...quote().binding,checkedAt:Date.now()+60000}}])assert.ok(F.solanaFeeEstimateIssue(q,intent))
})
await test('direction, amount and both connected wallets must match; Solana casing is significant',()=>{
 for(const change of [{direction:'arc-to-solana'},{amount:'0.2'},{evmWallet:'0x'+'11'.repeat(20)},{solanaWallet:SOL.toLowerCase()},{evmWallet:null},{solanaWallet:null}])assert.ok(F.solanaFeeEstimateIssue(quote(),{...intent,...change}))
 assert.equal(F.solanaFeeEstimateIssue(quote(),{...intent,evmWallet:EVM.toUpperCase()}),null)
})
await test('invalid fee data never normalizes into zero; SDK empty successful fee array permits zero',()=>{
 F.validateSolanaSdkFees({fees:[]});F.validateSolanaSdkFees({fees:[{token:'USDC',amount:'0',type:'provider'}]})
 for(const fees of [undefined,[{token:'USDC',amount:null,error:{}}],[{token:'USDC',amount:null}],[{token:'USDC',amount:'bad'}],[{token:'USDC',amount:'0.0000001'}],[{token:'SOL',amount:'0'}]])assert.throws(()=>F.validateSolanaSdkFees({fees}))
 for(const fee of ['-1','NaN','0.1','0.100001','0.0000001'])assert.ok(F.solanaFeeEstimateIssue(quote(fee),intent))
})
const journal=new Map()
globalThis.localStorage={getItem:k=>journal.get(k)??null,setItem:(k,v)=>journal.set(k,v)}
globalThis.window={location:{origin:'https://machina.test'},localStorage,dispatchEvent(){},addEventListener(){},removeEventListener(){},setTimeout,clearTimeout}
const R=require('../src/lib/solanaSendRuntime.ts'),G=require('../src/lib/solanaSendGuard.ts')
Object.assign(R.solanaSendEvidence,{arcLatestBlock:async()=>1n,arcBurnsSince:async()=>[],arcReceipt:async()=>null,arcNothingPending:async()=>true,solanaSignatureStatus:async()=>({found:false}),solanaBlockhashValid:async()=>true,solanaBurnsSince:async()=>[]})
const realViem=require('viem'),originalLoad=Module._load
let states=[],refs=[],effects=[],effectQueue=[],si=0,ri=0,ei=0,latestState,estimateTask,bridgeConfig,walletCalls,adapters,bridgeTask,source=SOL,evm=EVM
const wallet={transport:{request:async({method})=>{walletCalls++;return method==='eth_chainId'?'0x13b2':method==='eth_accounts'?[evm]:null}}}
const phantom={publicKey:{toBase58:()=>source},isConnected:true,signTransaction:async()=>assert.fail('No signature is needed by this suite')}
const chains=[{name:'Solana',isTestnet:false},{name:'Arc',chainId:5042}]
const React={useCallback:f=>f,useMemo:f=>f(),useRef:initial=>{const i=ri++;return refs[i]??(refs[i]={current:initial})},useState:initial=>{const i=si++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return [states[i],v=>{states[i]=typeof v==='function'?v(states[i]):v;if(states[i]&&typeof states[i]==='object'&&'isLoading'in states[i])latestState=states[i]}]},useEffect:(f,deps)=>{const i=ei++;if(!effects[i]||deps.some((d,j)=>d!==effects[i][j])){effects[i]=deps;effectQueue.push(f)}}}
Module._load=function(name,...args){
 if(name==='react')return React
 if(name==='wagmi')return {useAccount:()=>({address:evm}),useWalletClient:()=>({data:wallet})}
 if(name==='@circle-fin/bridge-kit')return {BridgeKit:class{getSupportedChains(){return chains}async estimate(args){return estimateTask(args)}async bridge(args){bridgeConfig=args.config;return bridgeTask?bridgeTask(args):{state:'success'}}}}
 if(name==='@circle-fin/adapter-solana')return {createSolanaAdapterFromProvider:async opts=>{adapters++;if(opts.connection){assert.equal(opts.connection.rpcEndpoint,'https://solana-rpc.publicnode.com');assert.equal(opts.connection._rpcWsEndpoint,'wss://solana-rpc.publicnode.com')}return opts}}
 if(name==='@circle-fin/adapter-viem-v2')return {createAdapterFromProvider:async opts=>{adapters++;return opts}}
 if(name==='viem')return {...realViem,createPublicClient:()=>({readContract:async()=>1000000n})}
 return originalLoad.call(this,name,...args)
}
let useHook
try{({useMainnetSolanaCctp:useHook}=require('../src/hooks/useMainnetSolanaCctp.ts'))}finally{Module._load=originalLoad}
globalThis.fetch=async(url,options)=>{
 assert.equal(url,'/api/solana-rpc','unexpected external read forbidden')
 assert.equal(JSON.parse(options.body).method,'getMinimumBalanceForRentExemption')
 return {ok:true,json:async()=>({result:3900000})}
}
const sdkFees=(fee='0.000003')=>({amount:'0.1',fees:fee==='0'?[]:[{type:'provider',token:'USDC',amount:fee}],gasFees:[]})
function reset(){journal.clear();states=[];refs=[];effects=[];effectQueue=[];latestState=null;bridgeConfig=null;bridgeTask=null;walletCalls=0;adapters=0;source=SOL;evm=EVM;estimateTask=async()=>sdkFees()}
function render(){si=ri=ei=0;const h=useHook(phantom,source);const queue=effectQueue;effectQueue=[];queue.forEach(f=>f());return h}
async function blocked(h,amount='0.1'){const oldAdapters=adapters;await assert.rejects(h.runCanary('solana-to-arc',amount),/fee|estimate/i);assert.equal(G.readSolanaSendAttempts().length,0);assert.equal(walletCalls,0);assert.equal(adapters,oldAdapters);assert.equal(bridgeConfig,null)}
await test('real runCanary refuses absent quote before B1 journal, SDK adapters and any wallet request',async()=>{reset();await blocked(render())})
await test('real estimate → cap=3 → Bridge Kit config is preserved; validated zero also works',async()=>{
 for(const fee of ['0.000003','0']){reset();let h=render();estimateTask=async()=>sdkFees(fee);await h.estimateCanary('solana-to-arc','0.1');h=render();assert.equal(h.feeEstimateIssue('solana-to-arc','0.1'),null);await h.runCanary('solana-to-arc','0.1');assert.equal(bridgeConfig.maxFee,fee);assert.equal(G.readSolanaSendAttempts().length,1)}
})
await test('real hook blocks different amount, direction, wallet and disconnect/reconnect reuse',async()=>{
 reset();let h=render();await h.estimateCanary('arc-to-solana','0.1');h=render();await blocked(h)
 reset();h=render();await h.estimateCanary('solana-to-arc','0.1');h=render();await blocked(h,'0.2')
 for(const change of [()=>{source='8UsDvWtFPzYBjzrgrB3j4oufte5iwm4Mx5A2tZ7ocTGg'},()=>{evm='0x'+'11'.repeat(20)},()=>{source=null}]){
  reset();h=render();await h.estimateCanary('solana-to-arc','0.1');change();render();source=SOL;evm=EVM;h=render();await blocked(h)
 }
})
await test('a failed SDK fee lookup cannot create a usable zero estimate',async()=>{
 reset();let h=render();estimateTask=async()=>({amount:'0.1',fees:[{type:'provider',token:'USDC',amount:null,error:{}}],gasFees:[]});await assert.rejects(h.estimateCanary('solana-to-arc','0.1'),/valid fee estimate/);h=render();await blocked(h)
})
await test('failed refresh invalidates a previously valid quote; an in-flight refresh also blocks sending',async()=>{
 reset();let h=render();await h.estimateCanary('solana-to-arc','0.1');let reject;estimateTask=()=>new Promise((_resolve,r)=>{reject=r});const p=h.estimateCanary('solana-to-arc','0.1');await new Promise(setImmediate);await blocked(render());reject(new Error('controlled fee timeout'));await assert.rejects(p,/timeout/);await blocked(render())
})
await test('older asynchronous results cannot replace the latest transfer quote',async()=>{
 reset();const h=render();let resolve;estimateTask=()=>new Promise(r=>{resolve=r});const older=h.estimateCanary('solana-to-arc','0.1');await new Promise(setImmediate);estimateTask=async()=>sdkFees();await h.estimateCanary('solana-to-arc','0.1');resolve(sdkFees('0.000009'));await assert.rejects(older,/request changed/);const current=render();assert.equal(current.feeEstimate.bridgeFee,'0.000003');await current.runCanary('solana-to-arc','0.1');assert.equal(bridgeConfig.maxFee,'0.000003')
})
await test('quote expiry is enforced again before B1 journal even if it expires while acquiring locks',async()=>{
 reset();let h=render();await h.estimateCanary('solana-to-arc','0.1');h=render();const now=Date.now,manager=navigator.locks,request=manager.request.bind(manager);manager.request=async(name,opts,cb)=>request(name,opts,lock=>{if(name.includes(':sol:'))Date.now=()=>now()+60001;return cb(lock)})
 try{await blocked(h)}finally{Date.now=now;manager.request=request}
})
await test('a quote response for a disconnected wallet is discarded before it can authorize a later transfer',async()=>{
 reset();const h=render();let resolve;estimateTask=()=>new Promise(r=>{resolve=r});const p=h.estimateCanary('solana-to-arc','0.1');await new Promise(setImmediate);source=null;render();resolve(sdkFees());await assert.rejects(p,/request changed/);source=SOL;await blocked(render())
})
await test('fee expiry detected before the burn request remains an actionable fee error, not a generic G2/network failure',async()=>{
 reset();let h=render();await h.estimateCanary('solana-to-arc','0.1');h=render();const now=Date.now
 bridgeTask=async args=>{Date.now=()=>now()+60001;try{await args.from.adapter.provider.signTransaction({})}catch{return {state:'error'}};assert.fail('expiry must stop before wallet')}
 try{await h.runCanary('solana-to-arc','0.1');assert.match(latestState.error,/fee estimate expired.*Recalculate/i);assert.equal(G.readSolanaSendAttempts()[0].signingAt,undefined);assert.equal(G.readSolanaSendAttempts()[0].phase,'released')}finally{Date.now=now}
})
await test('Arc → Solana retains its existing path without imposing the source-Solana quote requirement',async()=>{reset();await render().runCanary('arc-to-solana','0.1');assert.equal(bridgeConfig.maxFee,'0')})
await test('Arc receipt succeeded but burn proof is unreadable: retain hash, do not claim a verified burn or start recovery',async()=>{
 reset();const hash='0x'+'12'.repeat(32)
 R.solanaSendEvidence.arcReceipt=async()=> 'success'
 bridgeTask=async()=>{G.updateSolanaSendAttempt(G.readSolanaSendAttempts()[0].id,{phase:'sent',burnTxHash:hash});return{state:'error',steps:[{name:'burn',state:'success',txHash:hash},{name:'mint',state:'error'}]}}
 try{const result=await render().runCanary('arc-to-solana','0.1');assert.equal(result.sourceTxHash,hash);assert.equal(result.destinationVerified,false);assert.equal(result.sourceBurnVerified,false);assert.match(latestState.status,/source outcome is not yet verified/);assert.equal(G.readSolanaSendAttempts()[0].phase,'burned')}
 finally{R.solanaSendEvidence.arcReceipt=async()=>null}
})
await test('SDK estimate attempts an ATA setup: the actual read-only provider stops it before the wallet',async()=>{
 reset();estimateTask=async args=>{await args.to.adapter.provider.signTransaction({});assert.fail('a quote cannot continue through a wallet request')}
 await assert.rejects(render().estimateCanary('arc-to-solana','0.1'),/No wallet request is allowed while estimating/)
 assert.equal(G.readSolanaSendAttempts().length,0)
})
console.log(`RESULT ${count}/${count} Solana fee authorization groups PASS; controlled SDK/wallet/read ports; no simulation or real signatures/sends.`)
