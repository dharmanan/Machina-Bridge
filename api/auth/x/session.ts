import { SESSION_COOKIE, decodeSignedCookie, json, parseCookies } from '../../_lib/session.js'

type Session = {
  authenticated: boolean
  wallet?: string
  user?: {
    id: string
    username: string
    name: string
    profileImageUrl?: string
  }
  expiresAt?: number
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return json(res, 405, { error: 'Method not allowed' })
  }

  const cookies = parseCookies(req.headers.cookie)
  const session = decodeSignedCookie<Session>(cookies[SESSION_COOKIE])

  if (!session || !session.authenticated || !session.expiresAt || session.expiresAt < Date.now()) {
    return json(res, 200, { authenticated: false })
  }

  return json(res, 200, {
    authenticated: true,
    wallet: session.wallet,
    user: session.user,
  })
}
