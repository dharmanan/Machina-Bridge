import { PublicKey } from '@solana/web3.js'

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function getRpcUrls() {
  return unique([
    process.env.SOLANA_MAINNET_RPC?.trim(),
    'https://api.mainnet.solana.com',
    'https://rpc.ankr.com/solana',
    'https://solana-rpc.publicnode.com',
    'https://solana.drpc.org',
  ])
}

async function rpcCall(rpcUrl, method, params) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  })

  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status}`)
  }

  const payload = await response.json()
  if (payload?.error) {
    throw new Error(payload.error.message || 'Solana RPC error')
  }

  return payload?.result
}

function deriveUsdcAta(owner) {
  const ownerKey = new PublicKey(owner)
  const [ata] = PublicKey.findProgramAddressSync(
    [ownerKey.toBytes(), TOKEN_PROGRAM_ID.toBytes(), USDC_MINT.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )
  return ata.toBase58()
}

function formatRawUsdc(raw) {
  const amount = BigInt(raw)
  const whole = amount / 1_000_000n
  const fraction = (amount % 1_000_000n).toString().padStart(6, '0')
  return `${whole}.${fraction}`
}

async function readAtaBalance(rpcUrl, owner) {
  const ata = deriveUsdcAta(owner)

  try {
    const result = await rpcCall(
      rpcUrl,
      'getTokenAccountBalance',
      [ata, { commitment: 'confirmed' }],
    )

    const raw = result?.value?.amount
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
      throw new Error('Invalid token balance payload')
    }

    return {
      raw,
      formatted: formatRawUsdc(raw),
      method: 'ata',
      ata,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    if (
      message.toLowerCase().includes('could not find account')
      || message.toLowerCase().includes('invalid param')
    ) {
      return null
    }

    throw error
  }
}

async function readOwnerBalance(rpcUrl, owner) {
  const result = await rpcCall(
    rpcUrl,
    'getTokenAccountsByOwner',
    [
      owner,
      { mint: USDC_MINT.toBase58() },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ],
  )

  const accounts = Array.isArray(result?.value) ? result.value : []
  let raw = 0n

  for (const account of accounts) {
    const amount = account?.account?.data?.parsed?.info?.tokenAmount?.amount
    if (typeof amount === 'string' && /^\d+$/.test(amount)) {
      raw += BigInt(amount)
    }
  }

  return {
    raw: raw.toString(),
    formatted: formatRawUsdc(raw),
    method: 'owner-scan',
    ata: null,
  }
}

async function readUsdcBalance(rpcUrl, owner) {
  const ataBalance = await readAtaBalance(rpcUrl, owner)
  if (ataBalance) {
    return ataBalance
  }
  return readOwnerBalance(rpcUrl, owner)
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const owner = typeof req.query?.owner === 'string'
    ? req.query.owner.trim()
    : ''

  try {
    if (!owner) {
      return res.status(400).json({ error: 'Missing owner address' })
    }

    new PublicKey(owner)
  } catch {
    return res.status(400).json({ error: 'Invalid Solana address' })
  }

  for (const rpcUrl of getRpcUrls()) {
    try {
      const balance = await readUsdcBalance(rpcUrl, owner)
      res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30')
      return res.status(200).json({
        ok: true,
        owner,
        mint: USDC_MINT.toBase58(),
        balance: balance.formatted,
        balanceRaw: balance.raw,
        method: balance.method,
      })
    } catch {
      // Try the next configured RPC. Internal provider failures are not
      // exposed to the client.
    }
  }

  return res.status(502).json({
    ok: false,
    error: 'Unable to read Solana mainnet USDC balance.',
  })
}
