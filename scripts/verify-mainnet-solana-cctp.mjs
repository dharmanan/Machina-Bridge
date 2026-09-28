import { Connection, PublicKey } from '@solana/web3.js'

const RPC_URL = process.env.SOLANA_MAINNET_RPC || 'https://api.mainnet-beta.solana.com'
const IRIS_API_BASE = process.env.CIRCLE_IRIS_API_BASE || 'https://iris-api.circle.com'

const SOLANA_DOMAIN = 5
const ARC_DOMAIN = 26
const SOLANA_USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const MESSAGE_TRANSMITTER_V2 = new PublicKey('CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC')
const TOKEN_MESSENGER_MINTER_V2 = new PublicKey('CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe')

function record(checks, label, ok, detail = '') {
  checks.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

async function fetchFees(sourceDomain, destinationDomain) {
  const response = await fetch(
    `${IRIS_API_BASE}/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}`,
    { headers: { accept: 'application/json' } },
  )

  if (!response.ok) {
    throw new Error(`fee API HTTP ${response.status}`)
  }

  const payload = await response.json()
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : null

  if (!list) {
    throw new Error('invalid fee payload')
  }

  return list.map((item) => ({
    finalityThreshold: Number(item.finalityThreshold),
    minimumFee: Number(item.minimumFee),
  }))
}

async function main() {
  console.log('=== Machina Bridge Solana mainnet CCTP readiness ===')
  console.log('Read-only only. No wallet signature and no transaction broadcast.\n')

  const checks = []
  const connection = new Connection(RPC_URL, 'confirmed')

  try {
    const genesisHash = await connection.getGenesisHash()
    record(checks, 'Solana mainnet RPC', Boolean(genesisHash), genesisHash)
  } catch (error) {
    record(
      checks,
      'Solana mainnet RPC',
      false,
      error instanceof Error ? error.message : String(error),
    )
  }

  const accounts = await Promise.all([
    connection.getAccountInfo(SOLANA_USDC_MINT),
    connection.getAccountInfo(MESSAGE_TRANSMITTER_V2),
    connection.getAccountInfo(TOKEN_MESSENGER_MINTER_V2),
  ]).catch(() => null)

  if (!accounts) {
    record(checks, 'Solana CCTP account reads', false, 'one or more RPC reads failed')
  } else {
    const [usdcMint, messageTransmitter, tokenMessenger] = accounts

    record(
      checks,
      'Solana USDC mint',
      Boolean(usdcMint),
      SOLANA_USDC_MINT.toBase58(),
    )
    record(
      checks,
      'MessageTransmitterV2 program',
      Boolean(messageTransmitter?.executable),
      MESSAGE_TRANSMITTER_V2.toBase58(),
    )
    record(
      checks,
      'TokenMessengerMinterV2 program',
      Boolean(tokenMessenger?.executable),
      TOKEN_MESSENGER_MINTER_V2.toBase58(),
    )
  }

  for (const [source, destination, label] of [
    [SOLANA_DOMAIN, ARC_DOMAIN, 'Solana → Arc'],
    [ARC_DOMAIN, SOLANA_DOMAIN, 'Arc → Solana'],
  ]) {
    try {
      const fees = await fetchFees(source, destination)
      const hasStandard = fees.some((fee) => fee.finalityThreshold === 2000)
      const hasFast = fees.some((fee) => fee.finalityThreshold === 1000)

      record(
        checks,
        `${label} fee API`,
        fees.length > 0,
        `${fees.length} option(s)`,
      )
      record(
        checks,
        `${label} Standard CCTP`,
        hasStandard,
        hasStandard ? 'finality 2000 available' : 'missing',
      )

      if (source === SOLANA_DOMAIN) {
        record(
          checks,
          `${label} Fast CCTP`,
          hasFast,
          hasFast ? 'finality 1000 available' : 'missing',
        )
      }
    } catch (error) {
      record(
        checks,
        `${label} fee API`,
        false,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  const failed = checks.filter((check) => !check.ok)

  console.log('\n=== RESULT ===')
  console.log(`checks=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`)
  console.log(failed.length === 0
    ? 'MAINNET_SOLANA_CCTP_VERIFY=PASS'
    : 'MAINNET_SOLANA_CCTP_VERIFY=FAIL')
  console.log('TRANSACTION_BROADCAST=NO')

  if (failed.length) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`)
  console.log('TRANSACTION_BROADCAST=NO')
  process.exitCode = 1
})
