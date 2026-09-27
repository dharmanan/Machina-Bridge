import { PublicKey } from '@solana/web3.js'

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const DEFAULT_SOLANA_MAINNET_RPC = 'https://api.mainnet.solana.com'

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

function formatRawUsdc(raw) {
  const amount = BigInt(raw)
  const whole = amount / 1_000_000n
  const fraction = (amount % 1_000_000n).toString().padStart(6, '0')
  return `${whole}.${fraction}`
}

async function readOwnerBalance(rpcUrl, owner) {
  const result = await rpcCall(
    rpcUrl,
    'getTokenAccountsByOwner',
    [
      owner,
      { mint: USDC_MINT },
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
  }
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

  const rpcUrl =
    process.env.SOLANA_MAINNET_RPC?.trim()
    || DEFAULT_SOLANA_MAINNET_RPC

  try {
    const balance = await readOwnerBalance(rpcUrl, owner)
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30')
    return res.status(200).json({
      ok: true,
      owner,
      mint: USDC_MINT,
      balance: balance.formatted,
      balanceRaw: balance.raw,
    })
  } catch {
    return res.status(502).json({
      ok: false,
      error: 'Unable to read Solana mainnet USDC balance.',
    })
  }
}
