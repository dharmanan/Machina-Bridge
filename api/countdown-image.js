const HEAD_JPEG = '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'

const TITLES = ['First Signal','Boot Sequence','Green Pulse','Relay Online','Vector Lock','Machine Heart','Proof of Motion','Route Found','Channel Open','Network Pulse','Flow State','Stable Current','Liquidity Thread','Crosschain Echo','Packet Forward','Deterministic','Settlement Beam','Finality Mark','Threshold Near','Threshold','Engine Sync','Route Matrix','Signal Mesh','Chain Link','Liquidity Route','Proof Layer','Relay Core','State Verified','Forward Motion','Final Approach','Ignition Key','Mainnet Vector','Launch Window','Orbit Locked','Systems Ready','Signal Six','Signal Five','Signal Four','Last Orbit','Mainnet Ignition']

function parseDay(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw
  const parsed = Number.parseInt(String(value || ''), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function escapeXml(value) {
  return String(value).replace(/[<>&'\"]/g, (char) => ({ '<':'&lt;','>':'&gt;','&':'&amp;','\'':'&apos;','\"':'&quot;' }[char]))
}

export default function handler(req, res) {
  const day = parseDay(req.query?.id)
  if (day < 1 || day > 40) {
    res.status(404).send('Invalid token id')
    return
  }

  const activeSegments = Array.from({ length: 40 }, (_, index) => {
    const angle = index * 9
    const active = index < day
    return `<rect x="496" y="120" width="12" height="52" rx="6" fill="${active ? '#78ef3a' : '#263029'}" transform="rotate(${angle} 502 512)" ${active ? 'filter="url(#glow)"' : ''}/>`
  }).join('')

  const title = escapeXml(TITLES[day - 1].toUpperCase())
  const padded = String(day).padStart(2, '0')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1250" viewBox="0 0 1000 1250">
    <defs>
      <radialGradient id="bg" cx="50%" cy="35%"><stop offset="0" stop-color="#102516"/><stop offset="0.48" stop-color="#071009"/><stop offset="1" stop-color="#020504"/></radialGradient>
      <pattern id="noise" width="5" height="5" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.7" fill="#cfe0d1" opacity="0.12"/></pattern>
      <filter id="glow"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <clipPath id="portrait"><circle cx="500" cy="512" r="150"/></clipPath>
    </defs>
    <rect width="1000" height="1250" rx="38" fill="#060a07"/>
    <rect x="12" y="12" width="976" height="1226" rx="32" fill="url(#bg)" stroke="#68756d" stroke-width="5"/>
    <rect x="28" y="28" width="944" height="1194" rx="26" fill="url(#noise)" stroke="#29342d" stroke-width="2"/>
    <path d="M55 90h120M825 90h120M55 1160h120M825 1160h120" stroke="#66746b" stroke-width="2"/>
    <text x="70" y="95" fill="#83f154" font-family="Arial,sans-serif" font-size="24" font-weight="700" letter-spacing="7">ARC MAINNET COUNTDOWN</text>
    <text x="70" y="158" fill="#c8d1cb" font-family="Arial,sans-serif" font-size="24" letter-spacing="8">DAY</text>
    <text x="70" y="252" fill="#fff" font-family="Arial,sans-serif" font-size="100" font-weight="300">${padded}</text>
    <text x="70" y="310" fill="#c8d1cb" font-family="Arial,sans-serif" font-size="36">/ 40</text>
    <circle cx="500" cy="512" r="300" fill="#030704" stroke="#2e4536" stroke-width="3"/>
    ${activeSegments}
    <circle cx="500" cy="512" r="158" fill="#020403" stroke="#3c6247" stroke-width="3"/>
    <path d="M500 380L650 630H350Z" fill="none" stroke="#4ec72c" stroke-width="6" opacity="0.8"/>
    <image href="data:image/jpeg;base64,${HEAD_JPEG}" x="365" y="370" width="270" height="275" preserveAspectRatio="xMidYMid slice" clip-path="url(#portrait)"/>
    <line x1="70" x2="930" y1="850" y2="850" stroke="#27342c" stroke-width="2"/>
    <text x="500" y="930" text-anchor="middle" fill="#fff" font-family="Arial,sans-serif" font-size="54" font-weight="600">${title}</text>
    <text x="500" y="985" text-anchor="middle" fill="#9ca9a0" font-family="Arial,sans-serif" font-size="24">DAY ${padded} OF 40</text>
    <g>${Array.from({length:8},(_,i)=>`<rect x="${80+i*55}" y="1110" width="40" height="9" rx="4" fill="${i<Math.ceil(day/5)?'#78ef3a':'#253029'}"/>`).join('')}</g>
    <text x="920" y="1120" text-anchor="end" fill="#9ca9a0" font-family="Arial,sans-serif" font-size="17" letter-spacing="3">MACHINA</text>
  </svg>`

  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600')
  res.status(200).send(svg)
}
