const {resolve}=require('node:path'),root=resolve(__dirname,'../..')+'/',v=require('viem'),r=require(root+'src/lib/mainnetCctpRecovery.ts')
const owner='0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321',other='0x'+'22'.repeat(20),hash='0x'+'11'.repeat(32),bh='0x'+'aa'.repeat(32),nonce='0x'+'99'.repeat(32)
const cfg=require(root+'src/config/mainnetCctp.ts'),source=cfg.getMainnetCctpChain(5042),dest=cfg.getMainnetCctpChain(8453),sc=require(root+'src/config/mainnetSolana.ts').SOLANA_MAINNET_CCTP
const zero=v.toHex(0n,{size:32}),u=(n,size=32)=>v.toHex(BigInt(n),{size}),word=r.cctpWord
function message(over={}) {const m={src:26,dst:6,nonce:zero,sender:word(source.tokenMessengerAddress),recipient:word(dest.tokenMessengerAddress),caller:word(owner),min:2000,executed:0,burn:word(source.usdcAddress),mint:word(owner),amount:100000,from:word(owner),max:100,fee:0,expires:0,...over};return v.concatHex([u(1,4),u(m.src,4),u(m.dst,4),m.nonce,m.sender,m.recipient,m.caller,u(m.min,4),u(m.executed,4),u(1,4),m.burn,m.mint,u(m.amount),m.from,u(m.max),u(m.fee),u(m.expires)])}
function fixture() {
 const raw=message(),signed=message({nonce,executed:2000,fee:1}),sig='0x'+'ab'.repeat(65)
 const logs=[{address:source.messageTransmitterAddress,topics:v.encodeEventTopics({abi:r.CCTP_RECOVERY_ABI,eventName:'MessageSent'}),data:v.encodeAbiParameters([{type:'bytes'}],[raw]),logIndex:1},{address:source.tokenMessengerAddress,topics:v.encodeEventTopics({abi:r.CCTP_RECOVERY_ABI,eventName:'DepositForBurn',args:{burnToken:source.usdcAddress,depositor:owner,minFinalityThreshold:2000}}),data:v.encodeAbiParameters(v.parseAbiParameters('uint256,bytes32,uint32,bytes32,bytes32,uint256,bytes'),[100000n,word(owner),6,word(dest.tokenMessengerAddress),word(owner),100n,'0x']),logIndex:2}]
 for (const log of logs) Object.assign(log,{transactionHash:hash,blockHash:bh,blockNumber:100n})
 const tx={hash,from:owner,blockHash:bh,blockNumber:100n},receipt={status:'success',transactionHash:hash,blockHash:bh,blockNumber:100n,logs}
 const block={number:100n,hash:bh},s={getChainId:async()=>5042,getTransaction:async()=>tx,getTransactionReceipt:async()=>receipt,getBlock:async()=>block},d={getChainId:async()=>8453,getBlock:async()=>block,readContract:async()=>0n}
 const messages=[{status:'complete',message:signed,attestation:sig,eventNonce:nonce}]
 const fetcher=async()=>Response.json({messages}),input={sourceChainId:5042,sourceTxHash:hash,owner},run=()=>r.inspectMainnetTransferRecovery(input,{source:s,destination:d,fetcher})
 return {raw,signed,sig,logs,tx,receipt,block,s,d,messages,fetcher,input,run}
}

module.exports={owner,other,hash,bh,nonce,zero,u,word,message,fixture,cfg,source,dest,sc}
