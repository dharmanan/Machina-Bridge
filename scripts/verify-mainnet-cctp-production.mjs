import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  formatUnits,
  http,
  padHex,
  parseAbi,
  parseUnits,
} from 'viem'

const TOKEN_MESSENGER_V2 = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'
const MESSAGE_TRANSMITTER_V2 = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64'
const IRIS_API_BASE = process.env.CIRCLE_IRIS_API_BASE || 'https://iris-api.circle.com'
const AMOUNT_RAW = parseUnits(process.env.MAINNET_VERIFY_AMOUNT || '0.1', 6)
const DUMMY_WALLET = '0x000000000000000000000000000000000000dEaD'

const CHAINS = {
  arc: {
    name: 'Arc',
    chainId: 5042,
    domain: 26,
    rpc: process.env.ARC_MAINNET_RPC || 'https://rpc.mainnet.arc.io',
    usdc: '0x3600000000000000000000000000000000000000',
    mode: 'standard',
    threshold: 2000,
  },
  base: {
    name: 'Base',
    chainId: 8453,
    domain: 6,
    rpc: process.env.BASE_MAINNET_RPC || 'https://mainnet.base.org',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    mode: 'fast',
    threshold: 1000,
  },
}

const tokenMessengerAbi = parseAbi([
  'function remoteTokenMessengers(uint32 domain) view returns (bytes32)',
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
])
const messageTransmitterAbi = parseAbi([
  'function receiveMessage(bytes message, bytes attestation) returns (bool)',
])

function ceilDiv(value, divisor) {
  return (value + divisor - 1n) / divisor
}

function record(checks, label, ok, detail='') {
  checks.push({label,ok,detail})
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

async function fees(source, destination) {
  const response = await fetch(
    `${IRIS_API_BASE}/v2/burn/USDC/fees/${source.domain}/${destination.domain}`,
    { headers: { accept: 'application/json' } },
  )
  if (!response.ok) throw new Error(`fee API HTTP ${response.status}`)
  const payload = await response.json()
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : null
  if (!list) throw new Error('invalid fee payload')
  return list.map((item)=>({
    finalityThreshold:Number(item.finalityThreshold),
    minimumFee:Number(item.minimumFee),
  }))
}

function quote(amountRaw, minimumFeeBps, mode) {
  const milliBps=BigInt(Math.ceil(minimumFeeBps*1000))
  const protocolFeeRaw=milliBps===0n?0n:ceilDiv(amountRaw*milliBps,10_000_000n)
  const maxFeeRaw=mode==='fast'&&milliBps>0n
    ? ceilDiv(amountRaw*(milliBps+1000n),10_000_000n)
    : protocolFeeRaw>0n?protocolFeeRaw:1n
  return {protocolFeeRaw,maxFeeRaw}
}

async function verifyRoute(checks, source, destination) {
  const sourceClient=createPublicClient({transport:http(source.rpc,{timeout:10000,retryCount:0})})
  const destinationClient=createPublicClient({transport:http(destination.rpc,{timeout:10000,retryCount:0})})

  const [sid,did]=await Promise.all([sourceClient.getChainId(),destinationClient.getChainId()])
  record(checks,`${source.name} chain ID`,sid===source.chainId,String(sid))
  record(checks,`${destination.name} chain ID`,did===destination.chainId,String(did))

  const [sourceUsdc,tm,destUsdc,mt]=await Promise.all([
    sourceClient.getBytecode({address:source.usdc}),
    sourceClient.getBytecode({address:TOKEN_MESSENGER_V2}),
    destinationClient.getBytecode({address:destination.usdc}),
    destinationClient.getBytecode({address:MESSAGE_TRANSMITTER_V2}),
  ])
  record(checks,`${source.name} USDC bytecode`,Boolean(sourceUsdc&&sourceUsdc!=='0x'))
  record(checks,`${source.name} TokenMessengerV2 bytecode`,Boolean(tm&&tm!=='0x'))
  record(checks,`${destination.name} USDC bytecode`,Boolean(destUsdc&&destUsdc!=='0x'))
  record(checks,`${destination.name} MessageTransmitterV2 bytecode`,Boolean(mt&&mt!=='0x'))

  const remoteMessenger=await sourceClient.readContract({
    address:TOKEN_MESSENGER_V2,
    abi:tokenMessengerAbi,
    functionName:'remoteTokenMessengers',
    args:[destination.domain],
  })
  const expectedRemoteMessenger=padHex(TOKEN_MESSENGER_V2,{size:32})
  record(
    checks,
    `${source.name} → ${destination.name} remote TokenMessenger`,
    remoteMessenger.toLowerCase()===expectedRemoteMessenger.toLowerCase(),
    remoteMessenger,
  )

  const options=await fees(source,destination)
  const fee=options.find((x)=>x.finalityThreshold===source.threshold)
  record(
    checks,
    `${source.name} → ${destination.name} ${source.mode} fee option`,
    Boolean(fee&&Number.isFinite(fee.minimumFee)),
    fee?`${fee.minimumFee} bps @ ${source.threshold}`:'missing',
  )
  if(!fee)return

  const {protocolFeeRaw,maxFeeRaw}=quote(AMOUNT_RAW,fee.minimumFee,source.mode)
  record(
    checks,
    `${source.name} → ${destination.name} maxFee bounds`,
    maxFeeRaw>=protocolFeeRaw&&maxFeeRaw<AMOUNT_RAW,
    `fee≈${formatUnits(protocolFeeRaw,6)} maxFee=${formatUnits(maxFeeRaw,6)} USDC`,
  )

  const caller=padHex(DUMMY_WALLET,{size:32})
  const burn=encodeFunctionData({
    abi:tokenMessengerAbi,
    functionName:'depositForBurn',
    args:[AMOUNT_RAW,destination.domain,caller,source.usdc,caller,maxFeeRaw,source.threshold],
  })
  const decoded=decodeFunctionData({abi:tokenMessengerAbi,data:burn})
  const args=decoded.args
  record(
    checks,
    `${source.name} → ${destination.name} depositForBurn calldata`,
    decoded.functionName==='depositForBurn'
      &&args?.[0]===AMOUNT_RAW
      &&args?.[1]===destination.domain
      &&args?.[3].toLowerCase()===source.usdc.toLowerCase()
      &&args?.[4].toLowerCase()===caller.toLowerCase()
      &&args?.[5]===maxFeeRaw
      &&args?.[6]===source.threshold,
    `mode=${source.mode} destinationCaller=wallet`,
  )
}

async function main(){
  console.log('=== Machina Bridge CCTP V2 production verification ===')
  console.log('Read-only only. No wallet signature and no transaction broadcast.')
  console.log(`Verification amount: ${formatUnits(AMOUNT_RAW,6)} USDC\n`)

  const checks=[]
  record(checks,'Arc source mode',CHAINS.arc.mode==='standard','Standard / finality 2000')
  record(checks,'Base source mode',CHAINS.base.mode==='fast','Fast / finality 1000')

  await verifyRoute(checks,CHAINS.arc,CHAINS.base)
  console.log('')
  await verifyRoute(checks,CHAINS.base,CHAINS.arc)

  const mint=encodeFunctionData({
    abi:messageTransmitterAbi,
    functionName:'receiveMessage',
    args:['0x1234','0xabcd'],
  })
  const decodedMint=decodeFunctionData({abi:messageTransmitterAbi,data:mint})
  record(
    checks,
    'MessageTransmitterV2 receiveMessage calldata schema',
    decodedMint.functionName==='receiveMessage'
      &&decodedMint.args?.[0]==='0x1234'
      &&decodedMint.args?.[1]==='0xabcd',
    'receiveMessage(bytes,bytes)',
  )

  const failed=checks.filter((x)=>!x.ok)
  console.log('\n=== RESULT ===')
  console.log(`checks=${checks.length} passed=${checks.length-failed.length} failed=${failed.length}`)
  console.log(failed.length===0?'MAINNET_CCTP_PRODUCTION_VERIFY=PASS':'MAINNET_CCTP_PRODUCTION_VERIFY=FAIL')
  console.log('TRANSACTION_BROADCAST=NO')
  if(failed.length)process.exitCode=1
}

main().catch((error)=>{
  console.error(`FAIL  ${error instanceof Error?error.message:String(error)}`)
  console.log('TRANSACTION_BROADCAST=NO')
  process.exitCode=1
})
