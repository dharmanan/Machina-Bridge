import {
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  keccak256,
  padHex,
  parseAbi,
  parseEther,
  parseUnits,
  toHex,
} from 'viem'

const BASE_RPC = process.env.BASE_MAINNET_RPC || 'https://mainnet.base.org'
const IRIS_API_BASE = process.env.CIRCLE_IRIS_API_BASE || 'https://iris-api.circle.com'

const BASE_CHAIN_ID = 8453
const BASE_DOMAIN = 6
const ARC_DOMAIN = 26

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TOKEN_MESSENGER_V2 = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'

// Circle FiatToken storage layout is intentionally preserved across upgrades.
// balanceAndBlacklistStates = slot 9, allowed = slot 10.
const USDC_BALANCE_MAPPING_SLOT = 9n
const USDC_ALLOWANCE_MAPPING_SLOT = 10n

const VIRTUAL_USDC = parseUnits('100', 6)
const VIRTUAL_ETH = parseEther('0.1')
const ZERO_BYTES32 = `0x${'00'.repeat(32)}`

const accountInput = process.env.MAINNET_SIMULATION_ACCOUNT?.trim()
const recipientInput = process.env.MAINNET_SIMULATION_RECIPIENT?.trim() || accountInput
const amountInput = process.env.MAINNET_SIMULATION_AMOUNT?.trim() || '1'
const mode = process.env.MAINNET_SIMULATION_MODE?.trim().toLowerCase() || 'standard'

if (!accountInput || !isAddress(accountInput)) {
  console.error('Missing or invalid MAINNET_SIMULATION_ACCOUNT.')
  console.error('Usage:')
  console.error("  MAINNET_SIMULATION_ACCOUNT=0xYourPublicWallet MAINNET_SIMULATION_AMOUNT=1 node scripts/verify-mainnet-cctp-state-override.mjs")
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

if (amountRaw <= 0n || amountRaw >= VIRTUAL_USDC) {
  console.error('MAINNET_SIMULATION_AMOUNT must be greater than zero and less than 100 USDC.')
  process.exit(2)
}

const erc20Abi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
])

const tokenMessengerAbi = parseAbi([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
])

let rpcId = 0
async function rpc(method, params) {
  const response = await fetch(BASE_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })

  if (!response.ok) {
    throw new Error(`${method}: HTTP ${response.status}`)
  }

  const payload = await response.json()
  if (payload.error) {
    const error = new Error(`${method}: ${payload.error.message || JSON.stringify(payload.error)}`)
    error.rpcCode = payload.error.code
    error.rpcData = payload.error.data
    throw error
  }

  return payload.result
}

function mappingSlotAddress(address, slot) {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      [getAddress(address), slot],
    ),
  )
}

function nestedAllowanceSlot(owner, spender, slot) {
  const inner = mappingSlotAddress(owner, slot)
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes32' }],
      [getAddress(spender), inner],
    ),
  )
}

function asStorageWord(value) {
  return toHex(value, { size: 32 })
}

function asQuantity(value) {
  return toHex(value)
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
  const protocolFeeRaw = (amountRaw * hundredthBps + 999_999n) / 1_000_000n
  const maxFeeRaw = mode === 'fast'
    ? (protocolFeeRaw * 120n + 99n) / 100n
    : protocolFeeRaw

  if (maxFeeRaw >= amountRaw) {
    throw new Error('Calculated maxFee is greater than or equal to transfer amount')
  }

  return { finalityThreshold, minimumFeeBps, protocolFeeRaw, maxFeeRaw }
}

async function ethCall(to, data, stateOverride) {
  return rpc('eth_call', [
    {
      from: account,
      to,
      data,
      value: '0x0',
    },
    'latest',
    stateOverride,
  ])
}

function decodeUint256(hex) {
  return BigInt(hex)
}

async function main() {
  console.log('=== Machina Bridge Base -> Arc CCTP state-override simulation ===')
  console.log(`Account: ${account}`)
  console.log(`Recipient: ${recipient}`)
  console.log(`Requested transfer: ${amountInput} USDC`)
  console.log(`Mode: ${mode}`)
  console.log('Virtual state only: 100 USDC, 100 USDC allowance, 0.1 ETH.')
  console.log('No real balance changes, signatures, approvals, burns, mints, or broadcasts.\n')

  const chainIdHex = await rpc('eth_chainId', [])
  const observedChainId = Number.parseInt(chainIdHex, 16)
  if (observedChainId !== BASE_CHAIN_ID) {
    throw new Error(`Base RPC mismatch: expected ${BASE_CHAIN_ID}, observed ${observedChainId}`)
  }
  console.log(`PASS  Base chain ID — ${observedChainId}`)

  const quote = await fetchQuote()
  console.log(`PASS  Circle production fee quote — ${quote.minimumFeeBps} bps, finality=${quote.finalityThreshold}`)
  console.log(`      protocolFee≈${formatUnits(quote.protocolFeeRaw, 6)} USDC, maxFee=${formatUnits(quote.maxFeeRaw, 6)} USDC`)

  const balanceSlot = mappingSlotAddress(account, USDC_BALANCE_MAPPING_SLOT)
  const allowanceSlot = nestedAllowanceSlot(account, TOKEN_MESSENGER_V2, USDC_ALLOWANCE_MAPPING_SLOT)

  const stateOverride = {
    [account]: {
      balance: asQuantity(VIRTUAL_ETH),
    },
    [BASE_USDC]: {
      stateDiff: {
        [balanceSlot]: asStorageWord(VIRTUAL_USDC),
        [allowanceSlot]: asStorageWord(VIRTUAL_USDC),
      },
    },
  }

  const balanceData = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account],
  })

  const allowanceData = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account, TOKEN_MESSENGER_V2],
  })

  let overriddenBalance
  let overriddenAllowance

  try {
    overriddenBalance = decodeUint256(await ethCall(BASE_USDC, balanceData, stateOverride))
    overriddenAllowance = decodeUint256(await ethCall(BASE_USDC, allowanceData, stateOverride))
  } catch (error) {
    console.log('BLOCK  Base RPC state override')
    console.log(`      ${error instanceof Error ? error.message : String(error)}`)
    console.log('\n=== RESULT ===')
    console.log('STATE_OVERRIDE_SUPPORTED=NO')
    console.log('DEPOSIT_FOR_BURN_SIMULATED=NO')
    console.log('TRANSACTION_BROADCAST=NO')
    process.exitCode = 3
    return
  }

  const overrideBalanceOk = overriddenBalance === VIRTUAL_USDC
  const overrideAllowanceOk = overriddenAllowance === VIRTUAL_USDC

  console.log(`${overrideBalanceOk ? 'PASS' : 'FAIL'}  Virtual USDC balance — ${formatUnits(overriddenBalance, 6)} USDC`)
  console.log(`${overrideAllowanceOk ? 'PASS' : 'FAIL'}  Virtual TokenMessenger allowance — ${formatUnits(overriddenAllowance, 6)} USDC`)

  if (!overrideBalanceOk || !overrideAllowanceOk) {
    console.log('\n=== RESULT ===')
    console.log('STATE_OVERRIDE_SUPPORTED=PARTIAL_OR_INVALID')
    console.log('DEPOSIT_FOR_BURN_SIMULATED=NO')
    console.log('TRANSACTION_BROADCAST=NO')
    process.exitCode = 4
    return
  }

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

  try {
    const result = await ethCall(TOKEN_MESSENGER_V2, burnData, stateOverride)
    console.log('PASS  TokenMessengerV2 depositForBurn eth_call with virtual funds')
    console.log(`      return=${result}`)
  } catch (error) {
    console.log('FAIL  TokenMessengerV2 depositForBurn eth_call with virtual funds')
    console.log(`      ${error instanceof Error ? error.message : String(error)}`)
    console.log('\n=== RESULT ===')
    console.log('STATE_OVERRIDE_SUPPORTED=YES')
    console.log('DEPOSIT_FOR_BURN_SIMULATED=NO')
    console.log('TRANSACTION_BROADCAST=NO')
    process.exitCode = 5
    return
  }

  let gasEstimate = null
  try {
    const gasHex = await rpc('eth_estimateGas', [
      {
        from: account,
        to: TOKEN_MESSENGER_V2,
        data: burnData,
        value: '0x0',
      },
      'latest',
      stateOverride,
    ])
    gasEstimate = BigInt(gasHex)
    console.log(`PASS  State-override gas estimate — ${gasEstimate}`)
  } catch (error) {
    console.log('INFO  State-override gas estimate unavailable on this RPC')
    console.log(`      ${error instanceof Error ? error.message : String(error)}`)
  }

  console.log('\n=== RESULT ===')
  console.log('STATE_OVERRIDE_SUPPORTED=YES')
  console.log('VIRTUAL_USDC_BALANCE=100')
  console.log('VIRTUAL_ALLOWANCE=100')
  console.log('VIRTUAL_ETH_BALANCE=0.1')
  console.log('DEPOSIT_FOR_BURN_SIMULATED=YES')
  console.log(`GAS_ESTIMATE=${gasEstimate ?? 'UNAVAILABLE'}`)
  console.log('TRANSACTION_BROADCAST=NO')
}

main().catch((error) => {
  console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
