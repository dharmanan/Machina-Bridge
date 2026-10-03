// Compact engine: public read-only Intelligence HTTP API on the built-in node:http server. Exact request strings only: a
// route is one of six fixed URLs, so no query value, path variant or SQL-like input ever reaches the read model. GET only,
// no request body, bounded URL and response sizes, fixed error bodies (no messages, stack traces, paths or environment).
// Nothing here calls Arc RPC, indexes, or writes: every answer comes from the read-only model. No CORS headers: browsers
// reach this API through the Vercel proxy, not directly. `authorize` is the seam for a future auth header.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

export const MAX_URL_LENGTH = 128;
export const MAX_RESPONSE_BYTES = 256 * 1024;

const ROUTES = new Map([
  ['/health', { kind: 'health' }],
  ['/v1/intelligence/summary?window=1h', { kind: 'summary', window: '1h' }],
  ['/v1/intelligence/summary?window=6h', { kind: 'summary', window: '6h' }],
  ['/v1/intelligence/summary?window=24h', { kind: 'summary', window: '24h' }],
  ['/v1/intelligence/timeseries?window=6h', { kind: 'timeseries', window: '6h' }],
  ['/v1/intelligence/timeseries?window=24h', { kind: 'timeseries', window: '24h' }],
]);
const KNOWN_PATHS = new Set(['/health', '/v1/intelligence/summary', '/v1/intelligence/timeseries']);
// Read-model failures that may be named publicly; everything else is reported as `unavailable`.
const PUBLIC_READ_ERRORS = new Set(['not_ready']);

function headerValue(value) {
  return Array.isArray(value) ? value.join(',') : value;
}

function ifNoneMatchHits(header, etag) {
  const value = headerValue(header);
  if (typeof value !== 'string') return false;
  return value.split(',').map((part) => part.trim()).some((tag) => tag === '*' || tag === etag || tag === `W/${etag}`);
}

export function createIntelligenceHandler({ readModel, authorize = null, onFatal = null, maxResponseBytes = MAX_RESPONSE_BYTES,
  log = () => {} }) {
  if (!readModel || typeof readModel.health !== 'function' || typeof readModel.summary !== 'function'
    || typeof readModel.timeseries !== 'function') throw new Error('read_model_required');

  function send(res, status, body, headers = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...headers,
    });
    res.end(text);
  }

  return function handle(req, res) {
    try {
      const raw = req.url;
      if (typeof raw !== 'string' || !raw.startsWith('/')) return send(res, 400, { error: 'bad_request' });
      if (raw.length > MAX_URL_LENGTH) return send(res, 414, { error: 'uri_too_long' });
      const route = ROUTES.get(raw);
      if (!route) {
        const path = raw.split('?', 1)[0];
        return KNOWN_PATHS.has(path) ? send(res, 400, { error: 'bad_request' }) : send(res, 404, { error: 'not_found' });
      }
      if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
      const length = headerValue(req.headers['content-length']);
      if (req.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0')) {
        return send(res, 400, { error: 'body_not_allowed' });
      }
      if (authorize && authorize(req) !== true) return send(res, 401, { error: 'unauthorized' });

      const payload = route.kind === 'health' ? readModel.health()
        : route.kind === 'summary' ? readModel.summary(route.window) : readModel.timeseries(route.window);
      const text = JSON.stringify(payload);
      const bytes = Buffer.byteLength(text);
      if (bytes > maxResponseBytes) {
        log(`HTTP_RESPONSE_TOO_LARGE route=${route.kind} bytes=${bytes}`);
        return send(res, 503, { error: 'response_too_large' });
      }
      if (route.kind === 'health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes, 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        return res.end(text);
      }
      // The tag is the hash of the exact body, so it changes whenever any served byte (including freshness) changes.
      const etag = `"${createHash('sha256').update(text).digest('hex').slice(0, 40)}"`;
      const cacheHeaders = { ETag: etag, 'Cache-Control': 'no-cache' };
      if (ifNoneMatchHits(req.headers['if-none-match'], etag)) {
        res.writeHead(304, { ...cacheHeaders, 'X-Content-Type-Options': 'nosniff' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes, 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', ...cacheHeaders });
      return res.end(text);
    } catch (error) {
      const code = error?.code;
      if (code === 'incompatible') onFatal?.(error);
      log(`HTTP_READ_FAILED code=${typeof code === 'string' ? code : 'unknown'}`);
      try {
        return send(res, 503, { error: PUBLIC_READ_ERRORS.has(code) ? code : 'unavailable' });
      } catch {
        res.destroy();
      }
    }
  };
}

export function createIntelligenceServer(options) {
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 5_000, keepAliveTimeout: 5_000 },
    createIntelligenceHandler(options));
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });
  return server;
}
