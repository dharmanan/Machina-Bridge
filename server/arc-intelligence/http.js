import { createServer } from 'node:http';
import { statusReadModel } from './read-model.js';

const PATHS = new Set(['/health', '/v1/intelligence/status', '/v1/intelligence/latest',
  '/v1/intelligence/coverage', '/v1/intelligence/runtime', '/v1/intelligence/timeseries']);
const TIMESERIES_WINDOWS = new Set(['6h', '24h']);

export function parseAllowedOrigins(value = '') {
  const origins = new Set();
  for (const entry of value.split(',').map((part) => part.trim()).filter(Boolean)) {
    const url = new URL(entry);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== entry || url.username || url.password) {
      throw new Error('Invalid INTELLIGENCE_ALLOWED_ORIGINS');
    }
    origins.add(entry);
  }
  return origins;
}

export function createHandler({ repository, allowedOrigins = new Set(), runtimeMode = 'unknown' }) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    const send = (status, payload) => { res.writeHead(status); res.end(JSON.stringify(payload)); };
    // Exact paths only, except the strict allowlisted timeseries window.
    let path = req.url;
    let timeseriesWindow = null;
    if (req.url?.startsWith('/v1/intelligence/timeseries?')) {
      const parsed = new URL(req.url, 'http://127.0.0.1');
      const keys = [...parsed.searchParams.keys()];
      timeseriesWindow = parsed.searchParams.get('window');
      path = parsed.pathname;
      if (keys.length !== 1 || keys[0] !== 'window' || !TIMESERIES_WINDOWS.has(timeseriesWindow)) {
        return send(400, { error: 'unsupported_window' });
      }
    }
    if (!PATHS.has(path) || (req.url?.length ?? 0) > 160) return send(404, { error: 'not_found' });
    const origin = req.headers.origin;
    if (path !== '/health') {
      res.setHeader('Vary', 'Origin');
      if (origin && !allowedOrigins.has(origin)) return send(403, { error: 'origin_not_allowed' });
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    }
    if (req.method === 'OPTIONS' && path !== '/health' && origin && allowedOrigins.has(origin)) {
      if (req.headers['access-control-request-method'] !== 'GET' || req.headers['access-control-request-headers']) {
        return send(405, { error: 'method_not_allowed' });
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET');
      return send(200, {});
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return send(405, { error: 'method_not_allowed' });
    }
    if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) {
      return send(400, { error: 'body_not_allowed' });
    }
    try {
      if (path === '/health') {
        await repository.health();
        return send(200, { status: 'ok' });
      }
      if (path === '/v1/intelligence/runtime') return send(200, await repository.getA2RuntimeStatus(runtimeMode));
      if (path === '/v1/intelligence/timeseries') return send(200, await repository.getTimeseries(timeseriesWindow));
      if (path === '/v1/intelligence/status') return send(200, statusReadModel(await repository.getState()));
      const latest = await repository.getLatest();
      if (!latest) return send(503, { status: 'unavailable', reason: 'No complete bounded chunk has been persisted.' });
      return send(200, path.endsWith('/coverage')
        ? { window: latest.window, indexing: latest.indexing, generatedAt: latest.generatedAt, ...latest.coverage }
        : latest);
    } catch { return send(503, { error: 'intelligence_database_unavailable' }); }
  };
}

export function createHttpServer(options) {
  return createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000,
    keepAliveTimeout: 5000 }, createHandler(options));
}
