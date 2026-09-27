import { PublicKey } from '@solana/web3.js'

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function getRpcUrls() {
  return unique([
    process.env.SOLANA_MAINNET_RPC?.trim(),
    process.env.VITE_SOLANA_MAINNET_RPC?.trim(),
    'https://api.mainnet-beta.solana.com',
    'https://solana-rpc.publicnode.com',
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

async function readUsdcBalance(rpcUrl, owner) {
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

  const whole = raw / 1_000_000n
  const fraction = (raw % 1_000_000n).toString().padStart(6, '0')

  return {
    raw: raw.toString(),
    formatted: `${whole}.${fraction}`,
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

  const failures = []

  for (const rpcUrl of getRpcUrls()) {
    try {
      const balance = await readUsdcBalance(rpcUrl, owner)
      return res.status(200).json({
        ok: true,
        owner,
        mint: USDC_MINT,
        balance: balance.formatted,
        balanceRaw: balance.raw,
      })
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }

  return res.status(502).json({
    ok: false,
    error: 'Unable to read Solana mainnet USDC balance.',
    failures,
  })
}
