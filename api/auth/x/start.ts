import { verifyMessage } from 'viem'
import {
  CHALLENGE_COOKIE,
  OAUTH_COOKIE,
  clearCookieHeader,
  cookieHeader,
  decodeSignedCookie,
  encodeSignedCookie,
  getOrigin,
  json,
  parseCookies,
  randomToken,
  readJsonBody,
  sha256base64url,
} from '../../_lib/session.js'

type Challenge = {
  wallet: string
  message: string
  expiresAt: number
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return json(res, 405, { error: 'Method not allowed' })
  }

  const clientId = process.env.X_CLIENT_ID?.trim()
  if (!clientId) {
    return json(res, 503, { error: 'X_CLIENT_ID is not configured for this preview.' })
  }

  try {
    const body = await readJsonBody(req)
    const wallet = String(body.wallet || '').toLowerCase()
    const message = String(body.message || '')
    const signature = String(body.signature || '') as `0x${string}`
    const cookies = parseCookies(req.headers.cookie)
    const challenge = decodeSignedCookie<Challenge>(cookies[CHALLENGE_COOKIE])

    if (!challenge || challenge.expiresAt < Date.now()) {
      return json(res, 400, { error: 'Wallet-link challenge expired. Please try again.' })
    }
    if (challenge.wallet !== wallet || challenge.message !== message) {
      return json(res, 400, { error: 'Wallet-link challenge does not match this request.' })
    }

    const valid = await verifyMessage({
      address: wallet as `0x${string}`,
      message,
      signature,
    })
    if (!valid) return json(res, 401, { error: 'Wallet signature could not be verified.' })

    const state = randomToken(24)
    const verifier = randomToken(48)
    const challengeCode = sha256base64url(verifier)
    const origin = getOrigin(req)
    const redirectUri = `${origin}/api/auth/x/callback`
    const authorizeUrl = new URL('https://twitter.com/i/oauth2/authorize')
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('client_id', clientId)
    authorizeUrl.searchParams.set('redirect_uri', redirectUri)
    authorizeUrl.searchParams.set('scope', 'tweet.read users.read offline.access')
    authorizeUrl.searchParams.set('state', state)
    authorizeUrl.searchParams.set('code_challenge', challengeCode)
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')

    res.setHeader('Set-Cookie', [
      cookieHeader(
        OAUTH_COOKIE,
        encodeSignedCookie({ wallet, state, verifier, redirectUri, expiresAt: Date.now() + 10 * 60 * 1000 }),
        10 * 60,
      ),
      clearCookieHeader(CHALLENGE_COOKIE),
    ])
    return json(res, 200, { authorizeUrl: authorizeUrl.toString() })
  } catch (error) {
    return json(res, 400, { error: error instanceof Error ? error.message : 'Could not start X authorization.' })
  }
}
