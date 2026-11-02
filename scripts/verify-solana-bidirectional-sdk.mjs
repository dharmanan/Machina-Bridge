// Real Bridge Kit + EVM/Solana adapters. Every RPC, wallet and Circle response is
// a deterministic local transport fixture. No actual signing, broadcast or retry.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFileSync} from 'node:fs'
import {BridgeKit} from '@circle-fin/bridge-kit'
import {createSolanaAdapterFromProvider} from '@circle-fin/adapter-solana'
import {createAdapterFromProvider} from '@circle-fin/adapter-viem-v2'
import {Connection,PublicKey,VersionedTransaction} from '@solana/web3.js'
import {BorshAccountsCoder,BN} from '@coral-xyz/anchor'
import {deflate} from 'pako'
import {encodeAbiParameters,decodeFunctionData} from 'viem'
const require=createRequire(import.meta.url),ts=require('typescript')
require.extensions['.ts']=(m,p)=>m._compile(ts.transpileModule(readFileSync(p,'utf8').replaceAll('import.meta.env','({})'),{fileName:p,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,p)
const C=require('../src/lib/solanaBridgeConnection.ts'),R=require('../src/lib/solanaSendRuntime.ts'),G=require('../src/lib/solanaSendGuard.ts'),E=require('../src/lib/arcSolanaReceiveEvidence.ts')
const store=new Map();globalThis.localStorage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)}
const locks=new Set();Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(name,opts,fn)=>{if(locks.has(name))return fn(null);locks.add(name);try{return await fn({name})}finally{locks.delete(name)}}}}})
const P=require('../src/lib/solanaBridgeTxPolicy.ts'),G1=require('../src/lib/solanaBridgeEvmPolicy.ts')
const FX=JSON.parse(readFileSync(new URL('./fixtures/solana-bridge-real-tx.json',import.meta.url)))
const IDL=JSON.parse(readFileSync(new URL('./fixtures/solana-cctp-idl.json',import.meta.url)));IDL.TokenMessenger=JSON.parse(readFileSync(new URL('./fixtures/solana-token-messenger-idl.json',import.meta.url)))
const owner=FX.burn.owner,evm=FX.burn.evmRecipient,blockhash=VersionedTransaction.deserialize(Buffer.from(FX.burn.base64,'base64')).message.recentBlockhash
const idlAccounts=new Map(),dataAccounts=new Map(),pub=new PublicKey(owner)
const account=(owner,data)=>({owner,lamports:100000000,executable:false,rentEpoch:0,data:[Buffer.from(data).toString('base64'),'base64']})
function defaults(t,idl){if(typeof t==='string'){if(t==='pubkey')return pub;if(t==='bool')return false;if(['u64','u128','i64','i128'].includes(t))return new BN(0);return 0}if(t.array)return Array.from({length:t.array[1]},()=>defaults(t.array[0],idl));if(t.vec)return[];if(t.option)return null;if(t.defined){const def=idl.types.find(x=>x.name===(t.defined.name??t.defined));return Object.fromEntries(def.type.fields.map(f=>[f.name,defaults(f.type,idl)]))}throw Error('unknown IDL type')}
for(const name of ['KitBridge','MessageTransmitterV2','TokenMessenger']){
 const idl=IDL[name],program=new PublicKey(idl.address),base=PublicKey.findProgramAddressSync([],program)[0],address=await PublicKey.createWithSeed(base,'anchor:idl',program)
 const zip=Buffer.from(deflate(Buffer.from(JSON.stringify(idl)))),length=Buffer.alloc(4);length.writeUInt32LE(zip.length)
 idlAccounts.set(address.toBase58(),account(idl.address,Buffer.concat([Buffer.alloc(40),length,zip])))
 if(name==='KitBridge'||name==='TokenMessenger'){
  const type=name==='KitBridge'?'State':'TokenMessenger',def=idl.types.find(t=>t.name===type),values=Object.fromEntries(def.type.fields.map(f=>[f.name,defaults(f.type,idl)]))
  const seed=name==='KitBridge'?'state':'token_messenger',pda=PublicKey.findProgramAddressSync([Buffer.from(seed)],program)[0]
  dataAccounts.set(pda.toBase58(),account(idl.address,await new BorshAccountsCoder(idl).encode(type,values)))
 }
}
let s
const word=a=>a.slice(2).padStart(64,'0')
function attestation(direction){
 // Controlled message fixture; Circle signatures are not cryptographically
 // attested on this fake chain. Mainnet attestation verification is NOT claimed.
 const recv=VersionedTransaction.deserialize(Buffer.from(FX.receive.base64,'base64')).message.compiledInstructions.at(-1).data
 let b=Buffer.from(recv.subarray(12,12+376));b.writeUInt32BE(direction==='solana-to-arc'?5:26,4);b.writeUInt32BE(direction==='solana-to-arc'?26:5,8)
 Buffer.from(direction==='solana-to-arc'?word(evm):new PublicKey(P.solanaAta(owner)).toBuffer().toString('hex'),'hex').copy(b,148+36)
 b.fill(0,148+68,148+100);b.writeBigUInt64BE(100000n,148+92)
 b.fill(0,148+164,148+196);b.writeBigUInt64BE(3n,148+188)
 return {status:'complete',message:'0x'+b.toString('hex'),attestation:'0x'+'11'.repeat(130),eventNonce:'0x'+'01'.repeat(32),cctpVersion:2,decodedMessage:{sourceDomain:direction==='solana-to-arc'?'5':'26',destinationDomain:direction==='solana-to-arc'?'26':'5',minFinalityThreshold:'1000',decodedMessageBody:{messageSender:direction==='solana-to-arc'?owner:G1.G1_KIT,mintRecipient:direction==='solana-to-arc'?evm:P.solanaAta(owner),burnToken:direction==='solana-to-arc'?P.SOLANA_USDC_MINT:'0x3600000000000000000000000000000000000000',amount:'100000',feeExecuted:'3',expirationBlock:'0'}},delay:0}
}
function solRpc(method,params){
 if(method==='getAccountInfo'){
  const a=params[0];if(s.rpc403)throw Error('controlled RPC 403');if(a===P.solanaAta(owner)&&!s.ataExists)return{context:{slot:1},value:null};if(idlAccounts.has(a))return{context:{slot:1},value:idlAccounts.get(a)};if(dataAccounts.has(a))return{context:{slot:1},value:dataAccounts.get(a)}
  if(a===FX.cctpAlt.address)return{context:{slot:1},value:account('AddressLookupTab1e1111111111111111111111111',Buffer.from(FX.cctpAlt.base64,'base64'))}
  const b=Buffer.alloc(165);new PublicKey(P.SOLANA_USDC_MINT).toBuffer().copy(b);pub.toBuffer().copy(b,32);b.writeBigUInt64LE(10000000n,64);b[108]=1
  return{context:{slot:1},value:account(P.SOLANA_BRIDGE_PROGRAMS.token,b)}
 }
 if(method==='getGenesisHash')return'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
 if(method==='getLatestBlockhash')return{context:{slot:1},value:{blockhash,lastValidBlockHeight:1000}}
 if(method==='getBlockHeight')return 1
 if(method==='isBlockhashValid')return{context:{slot:1},value:!s.expired}
 if(method==='getBalance')return{context:{slot:1},value:1000000000}
 if(method==='getMinimumBalanceForRentExemption')return3900000
 if(method==='getTokenAccountBalance')return{context:{slot:1},value:{amount:'10000000',decimals:6,uiAmount:10,uiAmountString:'10'}}
 if(method==='getFeeForMessage')return{context:{slot:1},value:10000}
 if(method==='simulateTransaction')return{context:{slot:1},value:{err:s.simulationFail?{InstructionError:[0,'Custom']}:null,logs:[],unitsConsumed:83702}}
 if(method==='getTransaction'){const tx=s.solTx,m=tx.message;return{slot:1,blockTime:1,version:0,meta:{err:null,fee:10000,preBalances:[],postBalances:[],logMessages:[],innerInstructions:[],loadedAddresses:{writable:[],readonly:[]}},transaction:{signatures:tx.signatures.map(x=>require('bs58').encode(x)),message:{header:m.header,accountKeys:m.staticAccountKeys.map(x=>x.toBase58()),recentBlockhash:m.recentBlockhash,addressTableLookups:m.addressTableLookups.map(l=>({accountKey:l.accountKey.toBase58(),writableIndexes:Array.from(l.writableIndexes),readonlyIndexes:Array.from(l.readonlyIndexes)})),instructions:m.compiledInstructions.map(i=>({programIdIndex:i.programIdIndex,accounts:Array.from(i.accountKeyIndexes),data:require('bs58').encode(i.data)}))}}}}
 if(method==='getSignatureStatuses')return{context:{slot:1},value:params[0].map(()=>({slot:1,confirmations:1,err:null,confirmationStatus:'confirmed'}))}
 if(method==='sendTransaction'){
  const tx=VersionedTransaction.deserialize(Buffer.from(params[0],'base64'));s.solAttempts++;if(s.broadcastFail)throw Error('controlled broadcast failure');s.solPackets++;s.solTx=tx;s.ataExists=true;if(s.direction==='solana-to-arc')s.sourceLanded=true;else s.destinationLanded=true
  return require('bs58').encode(tx.signatures[0])
 }
 throw Error('UNHANDLED_SOL_RPC '+method)
}
function evmRpc(method,params){
 if(method==='eth_chainId')return'0x13b2'
 if(method==='eth_getBalance')return'0x56bc75e2d63100000'
 if(method==='eth_call')return encodeAbiParameters([{type:'uint256'}],[params[0].data?.startsWith('0x313ce567')?6n:10000000n])
 if(method==='eth_estimateGas')return'0x7a120'
 if(method==='eth_gasPrice'||method==='eth_maxPriorityFeePerGas')return'0x1'
 if(method==='eth_blockNumber')return'0x10'
 if(method==='eth_getTransactionCount')return'0x1'
 if(method==='eth_getTransactionReceipt')return{transactionHash:params[0],transactionIndex:'0x0',blockNumber:'0x10',blockHash:'0x'+'12'.repeat(32),from:evm,to:G1.G1_KIT,cumulativeGasUsed:'0x10',gasUsed:'0x10',effectiveGasPrice:'0x1',logs:[],logsBloom:'0x'+'00'.repeat(256),status:'0x1',type:'0x2'}
 if(method==='eth_getBlockByNumber')return{number:'0x10',hash:'0x'+'12'.repeat(32),timestamp:'0x1',baseFeePerGas:'0x1',gasLimit:'0x1000000',gasUsed:'0x1000',transactions:[],parentHash:'0x'+'00'.repeat(32),sha3Uncles:'0x'+'00'.repeat(32),logsBloom:'0x'+'00'.repeat(256),transactionsRoot:'0x'+'00'.repeat(32),stateRoot:'0x'+'00'.repeat(32),receiptsRoot:'0x'+'00'.repeat(32),miner:evm,difficulty:'0x0',totalDifficulty:'0x0',extraData:'0x',size:'0x1',nonce:'0x0000000000000000',mixHash:'0x'+'00'.repeat(32),uncles:[]}
 throw Error('UNHANDLED_EVM_RPC '+method)
}
globalThis.fetch=async(url,init)=>{
 const u=String(url);s.calls.push(u.includes('iris-api')?'circle':JSON.parse(init.body).method)
 if(u.includes('iris-api.circle.com')&&u.includes('/fees/'))return new Response(JSON.stringify([{finalityThreshold:1000,minimumFee:'0.3'},{finalityThreshold:2000,minimumFee:'0'}]),{status:200})
 if(u.includes('iris-api.circle.com')){assert.ok(!init?.method||init.method==='GET','no re-attestation POST');return new Response(JSON.stringify(s.badAttestation?{messages:[{...s.attestation,message:null}]}:{messages:[s.attestation]}),{status:200})}
 const q=JSON.parse(init.body);const run=x=>({jsonrpc:'2.0',id:x.id,result:x.method.startsWith('eth_')?evmRpc(x.method,x.params):solRpc(x.method,x.params)})
 if(!q||(!Array.isArray(q)&&q.jsonrpc!=='2.0'))throw Error('NETWORK_FORBIDDEN')
 return new Response(JSON.stringify(Array.isArray(q)?q.map(run):run(q)),{status:200})
}
globalThis.window={location:{origin:'https://fixture.invalid'},localStorage,dispatchEvent(){},addEventListener(){},removeEventListener(){},setTimeout,clearTimeout}
globalThis.WebSocket=class{constructor(url){queueMicrotask(()=>url.includes('working.fixture')?this.onerror?.():this.onopen?.())}send(raw){const q=JSON.parse(raw);queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({id:q.id,result:1})}))}close(){}}
async function scenario(direction,options={}){
 store.clear()
 s={direction,calls:[],evmPackets:0,solPackets:0,solAttempts:0,wallets:0,ataExists:!options.missingAta,attestation:attestation(direction),...options}
 if(options.wrongAttestation)s.attestation.decodedMessage.decodedMessageBody.amount='999999'
 if(options.tamperedMessage){const b=Buffer.from(s.attestation.message.slice(2),'hex');b[184]^=1;s.attestation.message='0x'+b.toString('hex')}
 const kit=new BridgeKit({disableErrorReporting:true});const chains=kit.getSupportedChains()
 const sol={...chains.find(x=>x.name==='Solana'),rpcEndpoints:['https://sol.fixture.invalid']},arc={...chains.find(x=>x.chainId===5042),rpcEndpoints:['https://arc.fixture.invalid']}
 const expected=direction==='solana-to-arc'?{kind:'burn',owner,amountRaw:100000n,evmRecipient:evm,maxFeeRaw:3n}:{kind:'receive',owner,amountRaw:100000n,exactMessage:s.attestation.message}
 const connection=options.legacy?new Connection('https://working.fixture.invalid/api/solana-rpc',{commitment:'confirmed',fetch:(...a)=>globalThis.fetch(...a)}):C.createSolanaBridgeConnection(window.location.origin)
 connection.confirmTransaction=async()=>{if(s.confirmationFail)throw Error('Signature has expired: block height exceeded');return{context:{slot:1},value:{err:null}}}
 const evidence={arcLatestBlock:async()=>1n,arcBurnsSince:async()=>[],arcReceipt:async()=>s.sourceLanded?'success':null,arcNothingPending:async()=>true,solanaSignatureStatus:async()=>({found:!!s.sourceLanded,confirmed:!!s.sourceLanded,err:null}),solanaBlockhashValid:async()=>!s.expired,solanaBurnsSince:async()=>[],now:()=>Date.now()};
 return R.withSolanaSendGuard({direction,amount:'0.1',evmWallet:evm,solanaWallet:owner},async guard=>{
 const phantom={publicKey:pub,isConnected:true,connect:async()=>assert.fail('no connect'),disconnect:async()=>{},signTransaction:async t=>{s.wallets++;if(s.securityBlocked){if(s.ataRace)s.ataExists=true;throw Object.assign(new Error('controlled Phantom security block'),{code:-32603})}if(s.reject)throw Object.assign(new Error('controlled rejection'),{code:4001});t.signatures[0]=new Uint8Array(64).fill(41+s.wallets);if(s.expireAfterWallet)s.expired=true;return t}}
 const reads={nonceUsedA:async()=>!!s.destinationLanded,nonceUsedB:async()=>!!s.destinationLanded,signatureStatus:async()=>({found:!!s.destinationLanded,err:null,confirmationStatus:'confirmed'}),blockhashValid:async()=>!s.expired,signaturesTouching:async()=>0}
 const receiveSession=()=>E.createBoundReceiveSigner(phantom,{reads,prepare:async()=>({sourceTxHash:G.readSolanaSendAttempts()[0]?.burnTxHash??'0x'+'01'.repeat(32),owner,message:s.attestation.message}),validate:(t,m)=>P.assertSolanaBridgeSigningRequest(phantom,t,{...expected,exactMessage:m})})
 let session=direction==='arc-to-solana'&&!options.legacy?receiveSession():null
 const legacySol=provider=>({get publicKey(){return{toString:()=>provider.publicKey.toString()}},get isConnected(){return provider.isConnected},connect:()=>provider.connect(),disconnect:()=>provider.disconnect(),signTransaction:t=>provider.signTransaction(t)})
 const solana=await createSolanaAdapterFromProvider({connection,provider:guard.solana((options.legacy?legacySol:P.createStrictSolanaProvider)(session??phantom,expected),t=>{if(!options.legacy)P.assertSolanaBridgeSigningRequest(phantom,t,expected)}),capabilities:{addressContext:'user-controlled',supportedChains:[sol]}})
 const enforceEvm=options.legacy?provider=>provider:G1.createEvmBridgePolicyProvider
 const evmAdapter=await createAdapterFromProvider({provider:enforceEvm(guard.evm({on(){},removeListener(){},request:async a=>{
  if(a.method==='eth_accounts'||a.method==='eth_requestAccounts')return[evm]
  if(a.method==='wallet_switchEthereumChain')return null
  if(a.method==='wallet_getCapabilities')return{}
  if(a.method==='eth_sendTransaction'){s.evmPackets++;const f=decodeFunctionData({abi:G1.G1_ABI,data:a.params[0].data}).functionName;if(f==='bridgeWithPreapproval')s.sourceLanded=true;if(f==='receiveMessage')s.destinationLanded=true;return'0x'+String(s.evmPackets).padStart(64,'0')}
  return evmRpc(a.method,a.params)
 }}),{mode:direction==='solana-to-arc'?'receive':'burn',owner:evm,solanaOwner:owner,amount:100000n,maxFee:3n,finality:1000,current:()=>true,receive:async()=>s.attestation}),capabilities:{addressContext:'user-controlled',supportedChains:[arc]}})
 const args=direction==='solana-to-arc'?{from:{adapter:solana,chain:sol},to:{adapter:evmAdapter,chain:arc,recipientAddress:evm}}:{from:{adapter:evmAdapter,chain:arc},to:{adapter:solana,chain:sol,recipientAddress:owner}}
 if(options.readonlyEstimate){
  solana.options.signer.signTransaction=t=>P.createReadOnlySolanaProvider(phantom,expected).signTransaction(t)
  const quote=await kit.estimate({...args,amount:'0.1',config:{maxFee:'0.000003'}})
  assert.equal(s.wallets,0);assert.equal(s.solPackets,0);assert.equal(s.evmPackets,0)
  assert.ok(quote);console.log('PASS real SDK estimate missing ATA never requests wallet access or signature');return
 }
 const result=await kit.bridge({...args,amount:'0.1',...(options.legacy?{}:{config:{maxFee:'0.000003'}})})

 if(result.state==='error')session?.fail(new Error('controlled SDK result error'))
 const before={evm:s.evmPackets,sol:s.solPackets,wallets:s.wallets}
 if(direction==='arc-to-solana'&&result.state==='error'&&s.destinationLanded){const gate=await E.openReceiveAttempt({sourceTxHash:G.readSolanaSendAttempts()[0].burnTxHash,owner,message:s.attestation.message},reads);assert.equal(gate.kind,'already-received');assert.equal(s.wallets,before.wallets)}
 if(options.recover){
  assert.equal(result.state,'error');assert.equal(s.sourceLanded,true,'only a proven burn may be recovered')
  s.reject=false;s.confirmationFail=false;s.expired=false;s.broadcastFail=false
  if(direction==='arc-to-solana'){
   session=receiveSession()
   // Reuse the real adapter with a NEW evidence-gated receive session only after
   // the controlled explicit recovery action. No kit.retry / source operation.
   solana.options.signer.signTransaction=t=>P.createStrictSolanaProvider(session,expected).signTransaction(t)
  }
  const destination=direction==='arc-to-solana'?solana:evmAdapter,fromChain=direction==='arc-to-solana'?arc:sol,toChain=direction==='arc-to-solana'?sol:arc
  const action=await destination.prepareAction('cctp.v2.receiveMessage',{fromChain,toChain,message:s.attestation.message,attestation:s.attestation.attestation,eventNonce:s.attestation.eventNonce,destinationAddress:direction==='arc-to-solana'?owner:evm},{chain:toChain,address:direction==='arc-to-solana'?owner:evm})
  await action.execute()
  assert.equal(s.destinationLanded,true)
  if(direction==='arc-to-solana')assert.equal(s.evmPackets,before.evm,'recovery must not approve or burn again')
  else assert.equal(s.solPackets,before.sol,'recovery must not burn again')
 }
 if(options.expectedError)assert.equal(result.state,'error')
 else assert.equal(result.state,'success',result.steps.find(x=>x.state==='error')?.errorMessage)
 if(options.reject||options.securityBlocked||options.simulationFail||options.rpc403||options.expireAfterWallet)assert.equal(before.sol,0)
 if(options.simulationFail||options.rpc403||options.wrongAttestation||options.tamperedMessage)assert.equal(before.wallets,0)
 if(options.reject||options.securityBlocked||options.broadcastFail||options.expireAfterWallet||options.confirmationFail)assert.ok(before.wallets<=1,'no automatic second wallet request')
 if(options.missingAta&&!options.expectedError)assert.ok(s.wallets<=2,'only ATA then receive')
 assert.equal(locks.size,2,'B1 retains both locks through the whole SDK run')
 console.log(`PASS real SDK ${direction} ${options.name??'complete lifecycle'}: ${result.state}, ${result.steps.map(x=>x.name+':'+x.state).join(', ')}; controlled wallet=${s.wallets}, EVM=${s.evmPackets}, Solana=${s.solPackets}`)
 return {result,before,state:s}
 },evidence)
}
const cases=[
 ['solana-to-arc',{name:'2d042f2-compatible provider baseline',legacy:true}],['arc-to-solana',{name:'2d042f2-compatible provider baseline',legacy:true}],['solana-to-arc',{}],['arc-to-solana',{}],['arc-to-solana',{readonlyEstimate:true,missingAta:true}],['arc-to-solana',{name:'missing ATA',missingAta:true}],
 ['solana-to-arc',{name:'simulation refusal',simulationFail:true,expectedError:true}],
 ['solana-to-arc',{name:'wallet rejection',reject:true,expectedError:true}],
 ['solana-to-arc',{name:'broadcast uncertainty',broadcastFail:true,expectedError:true}],
 ['solana-to-arc',{name:'blockhash expires in wallet',expireAfterWallet:true,expectedError:true}],
 ['solana-to-arc',{name:'source confirmation lost / destination-only recovery',confirmationFail:true,recover:true,expectedError:true}],
 ['arc-to-solana',{name:'Phantom rejection / explicit receive-only recovery',reject:true,recover:true,expectedError:true}],
 ['arc-to-solana',{name:'receive blockhash expires',expireAfterWallet:true,expectedError:true}],
 ['arc-to-solana',{name:'confirmation lost; nonce prevents another receive',confirmationFail:true,expectedError:true}],
 ['arc-to-solana',{name:'RPC 403 before wallet',rpc403:true,expectedError:true}],
 ['arc-to-solana',{name:'Phantom security block; no automatic recovery',securityBlocked:true,expectedError:true}],
 ['arc-to-solana',{name:'ATA wallet blocked, external ATA race cannot cause another prompt',missingAta:true,securityBlocked:true,ataRace:true,expectedError:true}],
 ['arc-to-solana',{name:'attestation amount mismatch',wrongAttestation:true,expectedError:true}],
 ['arc-to-solana',{name:'raw message recipient differs from decoded API fields',tamperedMessage:true,expectedError:true}],
]
for(const[direction,options]of cases)await scenario(direction,options)
assert.equal(locks.size,0)
console.log(`RESULT ${cases.length}/${cases.length} real SDK lifecycle groups PASS; all transports controlled; no real signatures, network broadcast or kit.retry`)
