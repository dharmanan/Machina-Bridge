const TITLES = [
  'First Signal','Boot Sequence','Green Pulse','Relay Online','Vector Lock','Machine Heart','Proof of Motion','Route Found','Channel Open','Network Pulse',
  'Flow State','Stable Current','Liquidity Thread','Crosschain Echo','Packet Forward','Deterministic','Settlement Beam','Finality Mark','Threshold Near','Threshold',
  'Engine Sync','Route Matrix','Signal Mesh','Chain Link','Liquidity Route','Proof Layer','Relay Core','State Verified','Forward Motion','Final Approach',
  'Ignition Key','Mainnet Vector','Launch Window','Orbit Locked','Systems Ready','Signal Six','Signal Five','Signal Four','Last Orbit','Mainnet Ignition',
]

const SUBTITLES = [
  'The journey begins.','Systems come online.','The network wakes.','The first route opens.','Direction confirmed.','Core systems active.','Momentum is visible.','A path is established.','Value can now move.','The network responds.',
  'The current stabilizes.','Stable value in motion.','Liquidity begins to connect.','A signal crosses chains.','The message moves forward.','Settlement becomes predictable.','The path to settlement.','State becomes final.','The minimum is close.','Mainnet eligibility begins.',
  'The engine synchronizes.','Routes become a system.','Signals become a network.','Chains begin to align.','Liquidity finds its route.','The record grows stronger.','The relay remains active.','The state is confirmed.','Momentum continues.','We are getting closer.',
  'The launch sequence starts.','Mainnet is in sight.','The window is opening.','The final orbit begins.','All systems are ready.','Six signals remain.','Five signals remain.','Four signals remain.','One final orbit.','The future is onchain.',
]

function parseDay(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value) return 0
  const clean = String(value).replace(/^0x/i, '')
  const isHex = clean.length === 64 || /[a-f]/i.test(clean)
  const parsed = Number.parseInt(clean, isHex ? 16 : 10)
  return Number.isFinite(parsed) ? parsed : 0
}

export default function handler(req, res) {
  const day = parseDay(req.query?.id)
  if (day < 1 || day > 40) {
    res.status(404).json({ error: 'Invalid countdown token id' })
    return
  }

  const protocol = req.headers['x-forwarded-proto'] || 'https'
  const host = req.headers['x-forwarded-host'] || req.headers.host
  const base = `${protocol}://${host}`
  const padded = String(day).padStart(2, '0')

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600')
  res.status(200).json({
    name: `Arc Mainnet Countdown - Day ${padded}`,
    description: `${TITLES[day - 1]}. ${SUBTITLES[day - 1]} Daily participation NFT from the Machina community countdown to Arc Mainnet.`,
    image: `${base}/api/countdown-image?id=${day}`,
    external_url: `${base}/countdown`,
    attributes: [
      { trait_type: 'Day', value: day },
      { trait_type: 'Total Days', value: 40 },
      { trait_type: 'Signal', value: TITLES[day - 1] },
      { trait_type: 'Network', value: 'Arc Testnet' },
      { trait_type: 'Collection', value: 'Arc Mainnet Countdown' },
    ],
  })
}
