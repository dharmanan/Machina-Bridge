import { decodeFunctionData, encodeFunctionData, parseAbi, type Hex } from 'viem'
import { deriveSolanaUsdcAta } from './solana'
import { getMainnetCctpChain } from '../config/mainnetCctp'

export const G1_KIT = '0xB3FA262d0fB521cc93bE83d87b322b8A23DAf3F0'
export const G1_ABI = parseAbi([
 'function increaseAllowance(address spender,uint256 addedValue) returns(bool)',
 'function bridgeWithPreapproval((uint256 amount,uint256 maxFee,uint256 fee,bytes32 mintRecipient,bytes32 destinationCaller,address burnToken,address feeRecipient,uint32 destinationDomain,uint32 minFinalityThreshold) bridgeParams)',
 'function receiveMessage(bytes message,bytes attestation) returns(bool)',
])
export class EvmBridgePolicyError extends Error { constructor(readonly reason: string) { super(`Machina blocked the EVM bridge request before the wallet (${reason}).`); this.name='EvmBridgePolicyError' } }
const fail = (reason: string): never => { throw new EvmBridgePolicyError(reason) }
const same=(a:unknown,b:string)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase()
const zero=(x:unknown)=>x===undefined||x===0n||x===0||x==='0x0'||x==='0x00'
export type EvmBridgePolicy = {
 owner:string; solanaOwner:string; amount:bigint; maxFee:bigint; finality:1000|2000
 mode:'burn'|'receive'|'read'; current():boolean
 receive?():Promise<{message:Hex;attestation:Hex}>
}
export function assertEvmBridgeCall(tx:any,p:EvmBridgePolicy) {
 if(!p.current()||p.amount<=0n||p.maxFee<0n||p.maxFee>=p.amount)fail('context')
 if(!tx||typeof tx!=='object'||!same(tx.from,p.owner)||!zero(tx.value))fail('sender/value')
 if(tx.chainId!==undefined&&![5042,'0x13b2'].includes(tx.chainId))fail('chain')
 const allowed=['from','to','data','input','value','chainId','gas','gasPrice','maxFeePerGas','maxPriorityFeePerGas','nonce','type','accessList']
 if(tx.type!==undefined&&![0,1,2,'0x0','0x1','0x2'].includes(tx.type))fail('transaction type')
 if(Object.keys(tx).some(k=>!allowed.includes(k))||tx.accessList!==undefined&&(!Array.isArray(tx.accessList)||tx.accessList.length))fail('envelope')
 if(tx.data!==undefined&&tx.input!==undefined&&!same(tx.data,tx.input))fail('conflicting calldata')
 const data=tx.data??tx.input
 if(typeof data!=='string'||!/^0x(?:[0-9a-f]{2})+$/i.test(data)||data.length>8192)fail('calldata')
 let decoded:ReturnType<typeof decodeFunctionData<typeof G1_ABI>>
 try{decoded=decodeFunctionData({abi:G1_ABI,data:data as Hex})}catch{fail('selector/ABI')}
 if(!same(encodeFunctionData({abi:G1_ABI,functionName:decoded!.functionName,args:decoded!.args as any}),data))fail('noncanonical calldata')
 const arc=getMainnetCctpChain(5042)!
 if(p.mode==='burn'&&decoded!.functionName==='increaseAllowance'){
  const [spender,amount]=decoded!.args as [string,bigint]
  if(!same(tx.to,arc.usdcAddress)||!same(spender,G1_KIT)||amount!==p.amount)fail('allowance')
  return 'approval' as const
 }
 if(p.mode==='burn'&&decoded!.functionName==='bridgeWithPreapproval'){
  const [b]=decoded!.args as any
  if(!same(tx.to,G1_KIT)||b.amount!==p.amount||b.maxFee>p.maxFee||b.maxFee>=p.amount||b.fee!==0n||!same(b.feeRecipient,G1_KIT)||!same(b.burnToken,arc.usdcAddress)||b.destinationDomain!==5||!same(b.mintRecipient,deriveSolanaUsdcAta(p.solanaOwner,'mainnet').ataHex)||b.destinationCaller!=='0x'+'0'.repeat(64)||b.minFinalityThreshold!==p.finality)fail('burn economics/destination')
  return 'burn' as const
 }
 if(p.mode==='receive'&&decoded!.functionName==='receiveMessage'&&same(tx.to,arc.messageTransmitterAddress))return 'receive' as const
 fail('operation')
}
const reads=new Set(['eth_chainId','eth_accounts','eth_requestAccounts','eth_getBalance','eth_getTransactionCount','eth_call','eth_estimateGas','eth_gasPrice','eth_maxPriorityFeePerGas','eth_feeHistory','eth_getBlockByNumber','eth_getBlockByHash','eth_blockNumber','eth_getCode','eth_getStorageAt','eth_getLogs','eth_getTransactionReceipt','eth_getTransactionByHash','net_version','wallet_getCapabilities','wallet_getCallsStatus'])
export function createEvmBridgePolicyProvider<P extends {request(args:any):Promise<any>}>(provider:P,context:EvmBridgePolicy):P {
 const p={...context}; let burnForwarded=false,approvalForwarded=false,receiveForwarded=false
 return {...provider,request:async(input:any)=>{
  const args=structuredClone(input)
  if(reads.has(args.method))return provider.request(args)
  if(!p.current()||p.mode==='read')fail('read-only/context')
  let calls:any[],batch=false
  if(args.method==='eth_sendTransaction'&&Array.isArray(args.params)&&args.params.length===1)calls=args.params
  else if(args.method==='wallet_sendCalls'&&Array.isArray(args.params)&&args.params.length===1){
   batch=true;const b=args.params[0]
   if(!b||!same(b.from,p.owner)||b.chainId!=='0x13b2'||!['1.0','2.0.0'].includes(b.version)||b.capabilities&&Object.keys(b.capabilities).length||Object.keys(b).some(k=>!['from','chainId','version','calls','capabilities','atomicRequired'].includes(k))||b.atomicRequired!==undefined&&typeof b.atomicRequired!=='boolean'||!Array.isArray(b.calls)||b.calls.length<1||b.calls.length>2)fail('batch')
   calls=b.calls.map((c:any)=>{if(!c||Object.keys(c).some(k=>!['to','data','value'].includes(k)))fail('batch call');return{...c,from:b.from,chainId:b.chainId}})
  }else fail('RPC method')
  const kinds=calls!.map(tx=>assertEvmBridgeCall(tx,p))
  if(batch&&(p.mode!=='burn'||!(kinds.join(',')==='burn'||kinds.join(',')==='approval,burn')))fail('batch order')
  if(kinds.includes('burn')&&burnForwarded||kinds.includes('approval')&&approvalForwarded)fail('duplicate request')
  if(kinds.includes('receive')&&receiveForwarded)fail('duplicate receive')
  if(kinds.includes('receive')){
   if(!p.receive)fail('missing receive proof')
   const expected=await p.receive!(),actual=decodeFunctionData({abi:G1_ABI,data:(calls![0].data??calls![0].input) as Hex})
   if(actual.functionName!=='receiveMessage'||!same(actual.args[0],expected.message)||!same(actual.args[1],expected.attestation))fail('receive proof')
  }
  const chain=await provider.request({method:'eth_chainId'}),accounts=await provider.request({method:'eth_accounts'})
  if(chain!=='0x13b2'&&chain!==5042||!Array.isArray(accounts)||!same(accounts[0],p.owner)||!p.current())fail('live wallet identity')
  // Never forward caller-owned objects after an await (TOCTOU). Snapshot them.
  const forwarded=structuredClone(args)
  // Repeat full validation on the snapshot immediately before B1 sees it.
  if(!batch)assertEvmBridgeCall(forwarded.params[0],p)

  if(kinds.includes('burn'))burnForwarded=true
  if(kinds.includes('approval'))approvalForwarded=true
  if(kinds.includes('receive'))receiveForwarded=true
  return provider.request(forwarded)
 }} as P
}
