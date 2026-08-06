import { SESSION_COOKIE, clearCookieHeader, json } from '../../_lib/session.js'

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return json(res, 405, { error: 'Method not allowed' })
  }

  res.setHeader('Set-Cookie', clearCookieHeader(SESSION_COOKIE))
  return json(res, 200, { ok: true })
}
