import {
  OAUTH_COOKIE,
  SESSION_COOKIE,
  clearCookieHeader,
  cookieHeader,
  decodeSignedCookie,
  encodeSignedCookie,
  json,
  parseCookies,
} from '../../_lib/session.js'

type OAuthState = {
  wallet: string
  state: string
  verifier: string
  redirectUri: string
  expiresAt: number
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return json(res, 405, { error: 'Method not allowed' })
  }

  const clientId = process.env.X_CLIENT_ID?.trim()
  const clientSecret = process.env.X_CLIENT_SECRET?.trim()
  if (!clientId) return json(res, 503, { error: 'X_CLIENT_ID is not configured.' })

  const cookies = parseCookies(req.headers.cookie)
  const oauth = decodeSignedCookie<OAuthState>(cookies[OAUTH_COOKIE])
  const state = String(req.query?.state || '')
  const code = String(req.query?.code || '')

  if (!oauth || oauth.expiresAt < Date.now() || oauth.state !== state || !code) {
    res.statusCode = 302
    res.setHeader('Location', '/countdown?x=error')
    res.setHeader('Set-Cookie', clearCookieHeader(OAUTH_COOKIE))
    return res.end()
  }

  try {
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: oauth.redirectUri,
      code_verifier: oauth.verifier,
      client_id: clientId,
    })

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    }
    if (clientSecret) {
      headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
    }

    const tokenResponse = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers,
      body: tokenBody,
    })
    const token = (await tokenResponse.json()) as { access_token?: string; error_description?: string }
    if (!tokenResponse.ok || !token.access_token) {
      throw new Error(token.error_description || 'X token exchange failed.')
    }

    const userResponse = await fetch('https://api.twitter.com/2/users/me?user.fields=profile_image_url', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    })
    const userPayload = (await userResponse.json()) as {
      data?: { id: string; username: string; name: string; profile_image_url?: string }
    }
    if (!userResponse.ok || !userPayload.data) throw new Error('Could not read the connected X profile.')

    const session = encodeSignedCookie({
      authenticated: true,
      wallet: oauth.wallet,
      user: {
        id: userPayload.data.id,
        username: userPayload.data.username,
        name: userPayload.data.name,
        profileImageUrl: userPayload.data.profile_image_url,
      },
      issuedAt: Date.now(),
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    })

    res.statusCode = 302
    res.setHeader('Location', '/countdown?x=connected')
    res.setHeader('Set-Cookie', [
      cookieHeader(SESSION_COOKIE, session),
      clearCookieHeader(OAUTH_COOKIE),
    ])
    return res.end()
  } catch {
    res.statusCode = 302
    res.setHeader('Location', '/countdown?x=error')
    res.setHeader('Set-Cookie', clearCookieHeader(OAUTH_COOKIE))
    return res.end()
  }
}
