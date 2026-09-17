const BASE = {
  name: 'Base',
  chainId: 8453,
  domain: 6,
  rpcUrl: process.env.BASE_MAINNET_RPC || 'https://mainnet.base.org',
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
}

const ARC = {
  name: 'Arc',
  chainId: 5042,
  domain: 26,
  rpcUrl: process.env.ARC_MAINNET_RPC || 'https://rpc.mainnet.arc.io',
  usdc: '0x3600000000000000000000000000000000000000',
}

const TOKEN_MESSENGER_V2 = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'
const MESSAGE_TRANSMITTER_V2 = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64'
const IRIS_API_BASE = process.env.CIRCLE_IRIS_API_BASE || 'https://iris-api.circle.com'

async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })

  if (!response.ok) {
    throw new Error(`${method}: HTTP ${response.status}`)
  }

  const payload = await response.json()
  if (payload.error) {
    throw new Error(`${method}: ${payload.error.message || JSON.stringify(payload.error)}`)
  }

  return payload.result
}

function hasCode(code) {
  return typeof code === 'string' && code !== '0x' && code !== '0x0'
}

function record(checks, label, ok, detail) {
  checks.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

async function checkChain(checks, chain) {
  try {
    const chainIdHex = await rpc(chain.rpcUrl, 'eth_chainId')
    const observed = Number.parseInt(chainIdHex, 16)
    record(checks, `${chain.name} chain ID`, observed === chain.chainId, `expected ${chain.chainId}, observed ${observed}`)
  } catch (error) {
    record(checks, `${chain.name} chain ID`, false, error instanceof Error ? error.message : String(error))
  }
}

async function checkCode(checks, chain, label, address) {
  try {
    const code = await rpc(chain.rpcUrl, 'eth_getCode', [address, 'latest'])
    record(checks, `${chain.name} ${label}`, hasCode(code), hasCode(code) ? `bytecode bytes=${(code.length - 2) / 2}` : 'no runtime bytecode')
  } catch (error) {
    record(checks, `${chain.name} ${label}`, false, error instanceof Error ? error.message : String(error))
  }
}

async function checkFees(checks) {
  const url = `${IRIS_API_BASE}/v2/burn/USDC/fees/${BASE.domain}/${ARC.domain}`

  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    if (!response.ok) {
      record(checks, 'Circle production CCTP fee API', false, `HTTP ${response.status}`)
      return
    }

    const payload = await response.json()
    const usable = Array.isArray(payload)
      && payload.length > 0
      && payload.every((item) => Number.isFinite(Number(item?.finalityThreshold)) && Number.isFinite(Number(item?.minimumFee)))

    record(
      checks,
      'Circle production CCTP fee API',
      usable,
      usable ? JSON.stringify(payload) : 'invalid or empty fee payload',
    )
  } catch (error) {
    record(checks, 'Circle production CCTP fee API', false, error instanceof Error ? error.message : String(error))
  }
}

async function main() {
  console.log('=== Machina Bridge mainnet CCTP read-only probe ===')
  console.log(`Route: ${BASE.name} (${BASE.chainId}, domain ${BASE.domain}) -> ${ARC.name} (${ARC.chainId}, domain ${ARC.domain})`)
  console.log('No wallet, signature, approval, burn, mint, or transaction is performed.\n')

  const checks = []

  await checkChain(checks, BASE)
  await checkChain(checks, ARC)
  await checkCode(checks, BASE, 'USDC', BASE.usdc)
  await checkCode(checks, BASE, 'TokenMessengerV2', TOKEN_MESSENGER_V2)
  await checkCode(checks, ARC, 'USDC', ARC.usdc)
  await checkCode(checks, ARC, 'MessageTransmitterV2', MESSAGE_TRANSMITTER_V2)
  await checkFees(checks)

  const failed = checks.filter((check) => !check.ok)

  console.log('\n=== RESULT ===')
  console.log(`checks=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`)
  console.log(failed.length === 0 ? 'MAINNET_CCTP_BASE_TO_ARC_PREFLIGHT=PASS' : 'MAINNET_CCTP_BASE_TO_ARC_PREFLIGHT=FAIL')

  if (failed.length > 0) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
