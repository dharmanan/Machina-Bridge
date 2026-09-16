import {
  createPublicClient,
  encodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  http,
  isAddress,
  padHex,
  parseAbi,
  parseUnits,
} from 'viem'

const BASE_CHAIN_ID = 8453
const ARC_CHAIN_ID = 5042
const BASE_DOMAIN = 6
const ARC_DOMAIN = 26
const BASE_RPC = process.env.BASE_MAINNET_RPC || 'https://mainnet.base.org'
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TOKEN_MESSENGER_V2 = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'
const IRIS_API_BASE = process.env.CIRCLE_IRIS_API_BASE || 'https://iris-api.circle.com'
const ZERO_BYTES32 = `0x${'00'.repeat(32)}`

const accountInput = process.env.MAINNET_SIMULATION_ACCOUNT?.trim()
const recipientInput = process.env.MAINNET_SIMULATION_RECIPIENT?.trim() || accountInput
const amountInput = process.env.MAINNET_SIMULATION_AMOUNT?.trim() || '1'
const mode = (process.env.MAINNET_SIMULATION_MODE?.trim().toLowerCase() || 'standard')

if (!accountInput || !isAddress(accountInput)) {
  console.error('Missing or invalid MAINNET_SIMULATION_ACCOUNT.')
  console.error('Usage:')
  console.error("  MAINNET_SIMULATION_ACCOUNT=0xYourPublicWallet MAINNET_SIMULATION_AMOUNT=1 node scripts/verify-mainnet-cctp-simulation.mjs")
  process.exit(2)
}

if (!recipientInput || !isAddress(recipientInput)) {
  console.error('MAINNET_SIMULATION_RECIPIENT is invalid.')
  process.exit(2)
}

if (mode !== 'standard' && mode !== 'fast') {
  console.error('MAINNET_SIMULATION_MODE must be standard or fast.')
  process.exit(2)
}

const account = getAddress(accountInput)
const recipient = getAddress(recipientInput)
const amountRaw = parseUnits(amountInput, 6)

if (amountRaw <= 0n) {
  console.error('MAINNET_SIMULATION_AMOUNT must be greater than zero.')
  process.exit(2)
}

const erc20Abi = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
])

const tokenMessengerAbi = parseAbi([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
])

const client = createPublicClient({
  transport: http(BASE_RPC, { timeout: 10_000, retryCount: 0 }),
})

function ceilDiv(value, divisor) {
  return (value + divisor - 1n) / divisor
}

async function fetchQuote() {
  const response = await fetch(`${IRIS_API_BASE}/v2/burn/USDC/fees/${BASE_DOMAIN}/${ARC_DOMAIN}`, {
    headers: { accept: 'application/json' },
  })

  if (!response.ok) {
    throw new Error(`Circle CCTP fee API HTTP ${response.status}`)
  }

  const fees = await response.json()
  if (!Array.isArray(fees)) {
    throw new Error('Circle CCTP fee API returned an invalid payload')
  }

  const finalityThreshold = mode === 'fast' ? 1000 : 2000
  const fee = fees.find((item) => Number(item?.finalityThreshold) === finalityThreshold)
  if (!fee || !Number.isFinite(Number(fee.minimumFee))) {
    throw new Error(`Circle did not return a ${mode} fee option`)
  }

  const minimumFeeBps = Number(fee.minimumFee)
  const hundredthBps = BigInt(Math.ceil(minimumFeeBps * 100))
  const protocolFeeRaw = ceilDiv(amountRaw * hundredthBps, 1_000_000n)
  const maxFeeRaw = mode === 'fast'
    ? ceilDiv(protocolFeeRaw * 120n, 100n)
    : protocolFeeRaw

  if (maxFeeRaw >= amountRaw) {
    throw new Error('Calculated maxFee is greater than or equal to transfer amount')
  }

  return {
    finalityThreshold,
    minimumFeeBps,
    protocolFeeRaw,
    maxFeeRaw,
  }
}

async function simulate(label, to, data, gasPrice, nativeBalance) {
  try {
    await client.call({ account, to, data, value: 0n })
    const estimatedGas = await client.estimateGas({ account, to, data, value: 0n })
    const estimatedGasCost = estimatedGas * gasPrice
    const enoughGas = nativeBalance >= estimatedGasCost

    console.log(`${enoughGas ? 'PASS' : 'BLOCK'}  ${label}`)
    console.log(`      estimatedGas=${estimatedGas}`)
    console.log(`      estimatedGasCost=${formatEther(estimatedGasCost)} ETH`)
    if (!enoughGas) {
      console.log('      reason=insufficient Base ETH for estimated gas cost')
    }

    return { ok: enoughGas, estimatedGas, estimatedGasCost }
  } catch (error) {
    console.log(`BLOCK  ${label}`)
    console.log(`      reason=${error instanceof Error ? error.message : String(error)}`)
    return { ok: false }
  }
}

async function main() {
  console.log('=== Machina Bridge mainnet CCTP source simulation ===')
  console.log(`Route: Base (${BASE_CHAIN_ID}, domain ${BASE_DOMAIN}) -> Arc (${ARC_CHAIN_ID}, domain ${ARC_DOMAIN})`)
  console.log(`Account: ${account}`)
  console.log(`Recipient: ${recipient}`)
  console.log(`Amount: ${amountInput} USDC`)
  console.log(`Mode: ${mode}`)
  console.log('Read-only only: no signature and no transaction broadcast.\n')

  const observedChainId = await client.getChainId()
  if (observedChainId !== BASE_CHAIN_ID) {
    throw new Error(`Base RPC chain mismatch: expected ${BASE_CHAIN_ID}, observed ${observedChainId}`)
  }
  console.log(`PASS  Base chain ID — ${observedChainId}`)

  const quote = await fetchQuote()
  console.log(`PASS  Circle production fee quote — ${quote.minimumFeeBps} bps, finality=${quote.finalityThreshold}`)
  console.log(`      protocolFee≈${formatUnits(quote.protocolFeeRaw, 6)} USDC, maxFee=${formatUnits(quote.maxFeeRaw, 6)} USDC`)

  const [usdcBalance, allowance, nativeBalance, gasPrice] = await Promise.all([
    client.readContract({
      address: BASE_USDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
    }),
    client.readContract({
      address: BASE_USDC,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account, TOKEN_MESSENGER_V2],
    }),
    client.getBalance({ address: account }),
    client.getGasPrice(),
  ])

  console.log(`INFO  Base USDC balance — ${formatUnits(usdcBalance, 6)} USDC`)
  console.log(`INFO  TokenMessenger allowance — ${formatUnits(allowance, 6)} USDC`)
  console.log(`INFO  Base native gas balance — ${formatEther(nativeBalance)} ETH`)
  console.log(`INFO  Base gas price — ${formatUnits(gasPrice, 9)} gwei`)

  const enoughUsdc = usdcBalance >= amountRaw
  console.log(`${enoughUsdc ? 'PASS' : 'BLOCK'}  USDC balance check`)

  const approvalRequired = allowance < amountRaw
  let approvalReady = true

  if (approvalRequired) {
    const approveData = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [TOKEN_MESSENGER_V2, amountRaw],
    })

    const approval = await simulate('USDC approve simulation', BASE_USDC, approveData, gasPrice, nativeBalance)
    approvalReady = approval.ok
  } else {
    console.log('PASS  Existing allowance already covers requested amount')
  }

  let burnReady = false
  if (!enoughUsdc) {
    console.log('SKIP  depositForBurn simulation — insufficient Base USDC')
  } else if (approvalRequired) {
    console.log('SKIP  depositForBurn simulation — allowance is not yet present onchain')
  } else {
    const burnData = encodeFunctionData({
      abi: tokenMessengerAbi,
      functionName: 'depositForBurn',
      args: [
        amountRaw,
        ARC_DOMAIN,
        padHex(recipient, { size: 32 }),
        BASE_USDC,
        ZERO_BYTES32,
        quote.maxFeeRaw,
        quote.finalityThreshold,
      ],
    })

    const burn = await simulate('CCTP V2 depositForBurn simulation', TOKEN_MESSENGER_V2, burnData, gasPrice, nativeBalance)
    burnReady = burn.ok
  }

  console.log('\n=== RESULT ===')
  console.log(`APPROVAL_REQUIRED=${approvalRequired ? 'YES' : 'NO'}`)
  console.log(`READY_FOR_APPROVAL=${approvalReady && approvalRequired ? 'YES' : approvalRequired ? 'NO' : 'NOT_NEEDED'}`)
  console.log(`READY_FOR_BURN=${burnReady ? 'YES' : 'NO'}`)
  console.log('TRANSACTION_BROADCAST=NO')
}

main().catch((error) => {
  console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
