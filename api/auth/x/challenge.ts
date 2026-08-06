import { CHALLENGE_COOKIE, cookieHeader, encodeSignedCookie, json, randomToken } from '../../_lib/session.js'

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return json(res, 405, { error: 'Method not allowed' })
  }

  const wallet = String(req.query?.wallet || '').trim()
  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return json(res, 400, { error: 'A valid EVM wallet address is required.' })
  }

  const nonce = randomToken(20)
  const issuedAt = new Date().toISOString()
  const expiresAt = Date.now() + 10 * 60 * 1000
  const message = [
    'Link this wallet to Machina Countdown.',
    '',
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    '',
    'This signature does not authorize a transaction or transfer assets.',
  ].join('\n')

  res.setHeader(
    'Set-Cookie',
    cookieHeader(CHALLENGE_COOKIE, encodeSignedCookie({ wallet: wallet.toLowerCase(), message, expiresAt }), 10 * 60),
  )
  return json(res, 200, { message })
}
