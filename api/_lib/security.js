import crypto from 'node:crypto';
import { json } from './http.js';
import { redisExpire, redisIncr, redisSetNx } from './redis.js';

const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 60;
const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 5 * 60;

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }

  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }

  return 'unknown';
}

function parseAllowlist() {
  const raw = process.env.CORS_ALLOWLIST || '';
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function applyCors(req, res, allowedMethods = ['GET', 'POST', 'OPTIONS']) {
  const allowlist = parseAllowlist();
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';

  if (allowlist.length === 0) {
    // Default safe mode for same-origin/browser fetches.
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && allowlist.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (origin && !allowlist.includes(origin)) {
    return json(res, 403, { error: 'Origin is not allowed' });
  }

  res.setHeader('Access-Control-Allow-Methods', allowedMethods.join(', '));
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Idempotency-Key, X-Request-Timestamp, X-Request-Signature');

  if (req.method === 'OPTIONS') {
    return json(res, 200, { ok: true });
  }

  return null;
}

export async function enforceRateLimit(req, res, routeScope, options = {}) {
  const windowSeconds = Number(options.windowSeconds || process.env.API_RATE_LIMIT_WINDOW_SECONDS || DEFAULT_RATE_LIMIT_WINDOW_SECONDS);
  const maxRequests = Number(options.maxRequests || process.env.API_RATE_LIMIT_MAX_REQUESTS || DEFAULT_RATE_LIMIT_MAX_REQUESTS);
  const ip = getClientIp(req);
  const nowWindow = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = `ratelimit:${routeScope}:${ip}:${nowWindow}`;

  const count = Number(await redisIncr(key));
  if (count === 1) {
    await redisExpire(key, windowSeconds);
  }

  if (count > maxRequests) {
    return json(res, 429, { error: 'Too many requests. Please retry shortly.' });
  }

  return null;
}

export async function enforceIdempotency(req, res, routeScope, options = {}) {
  const headerValue = req.headers['x-idempotency-key'];
  const idempotencyKey = typeof headerValue === 'string' ? headerValue.trim() : '';

  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    return json(res, 400, { error: 'Missing or invalid X-Idempotency-Key header' });
  }

  const ttl = Number(options.ttlSeconds || process.env.API_IDEMPOTENCY_TTL_SECONDS || DEFAULT_IDEMPOTENCY_TTL_SECONDS);
  const redisKey = `idempotency:${routeScope}:${idempotencyKey}`;
  const created = await redisSetNx(redisKey, String(Date.now()), ttl);

  if (created !== 'OK') {
    return json(res, 409, { error: 'Duplicate request detected for this idempotency key' });
  }

  return null;
}

function stableBodyString(body) {
  if (!body) return '';
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch {
    return '';
  }
}

export function enforceRequestSignature(req, res) {
  const secret = process.env.BRIDGE_API_SIGNING_SECRET;
  if (!secret) {
    return null;
  }

  const timestamp = typeof req.headers['x-request-timestamp'] === 'string' ? req.headers['x-request-timestamp'] : '';
  const signature = typeof req.headers['x-request-signature'] === 'string' ? req.headers['x-request-signature'] : '';

  if (!timestamp || !signature) {
    return json(res, 401, { error: 'Missing request signature headers' });
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > 300) {
    return json(res, 401, { error: 'Request signature timestamp is out of range' });
  }

  const payload = `${timestamp}.${req.method}.${req.url}.${stableBodyString(req.body)}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length || !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) {
    return json(res, 401, { error: 'Invalid request signature' });
  }

  return null;
}
