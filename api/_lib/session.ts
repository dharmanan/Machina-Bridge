import crypto from 'node:crypto'

export const SESSION_COOKIE = 'machina_countdown_session'
export const CHALLENGE_COOKIE = 'machina_countdown_challenge'
export const OAUTH_COOKIE = 'machina_countdown_oauth'

const DEFAULT_MAX_AGE = 60 * 60 * 24 * 7

function getSecret() {
  const secret = process.env.COUNTDOWN_SESSION_SECRET?.trim()
  if (!secret) throw new Error('COUNTDOWN_SESSION_SECRET is not configured')
  return secret
}

function base64url(input: string | Buffer) {
  return Buffer.from(input).toString('base64url')
}

function sign(encoded: string) {
  return crypto.createHmac('sha256', getSecret()).update(encoded).digest('base64url')
}

export function encodeSignedCookie(value: unknown) {
  const encoded = base64url(JSON.stringify(value))
  return `${encoded}.${sign(encoded)}`
}

export function decodeSignedCookie<T>(raw?: string): T | null {
  if (!raw) return null
  const [encoded, signature] = raw.split('.')
  if (!encoded || !signature) return null

  const expected = sign(encoded)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T
  } catch {
    return null
  }
}

export function parseCookies(header?: string) {
  const result: Record<string, string> = {}
  if (!header) return result

  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    result[key] = decodeURIComponent(value)
  }

  return result
}

export function cookieHeader(name: string, value: string, maxAge = DEFAULT_MAX_AGE) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

export function clearCookieHeader(name: string) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url')
}

export function sha256base64url(value: string) {
  return crypto.createHash('sha256').update(value).digest('base64url')
}

export function getOrigin(req: any) {
  const configured = process.env.COUNTDOWN_PUBLIC_URL?.trim()
  if (configured) return configured.replace(/\/$/, '')

  const proto = req.headers['x-forwarded-proto'] || 'https'
  const host = req.headers['x-forwarded-host'] || req.headers.host
  return `${proto}://${host}`
}

export function json(res: any, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

export function readJsonBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk: Buffer | string) => {
      raw += chunk.toString()
      if (raw.length > 1_000_000) reject(new Error('Request body is too large'))
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}
