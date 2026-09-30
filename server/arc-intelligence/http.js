import { createServer } from 'node:http';
import { statusReadModel } from './read-model.js';

const PATHS = new Set(['/health', '/v1/intelligence/status', '/v1/intelligence/latest', '/v1/intelligence/coverage']);

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

export function createHandler({ repository, allowedOrigins = new Set() }) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    const send = (status, payload) => { res.writeHead(status); res.end(JSON.stringify(payload)); };
    // Exact paths only: no parameters, queries, request bodies, or dynamic lookups.
    if (!PATHS.has(req.url) || (req.url?.length ?? 0) > 128) return send(404, { error: 'not_found' });
    const origin = req.headers.origin;
    if (req.url !== '/health') {
      res.setHeader('Vary', 'Origin');
      if (origin && !allowedOrigins.has(origin)) return send(403, { error: 'origin_not_allowed' });
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    }
    if (req.method === 'OPTIONS' && req.url !== '/health' && origin && allowedOrigins.has(origin)) {
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
      if (req.url === '/health') {
        await repository.health();
        return send(200, { status: 'ok' });
      }
      if (req.url === '/v1/intelligence/status') return send(200, statusReadModel(await repository.getState()));
      const latest = await repository.getLatest();
      if (!latest) return send(503, { status: 'unavailable', reason: 'No complete bounded chunk has been persisted.' });
      return send(200, req.url.endsWith('/coverage')
        ? { window: latest.window, indexing: latest.indexing, generatedAt: latest.generatedAt, ...latest.coverage }
        : latest);
    } catch { return send(503, { error: 'intelligence_database_unavailable' }); }
  };
}

export function createHttpServer(options) {
  return createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000,
    keepAliveTimeout: 5000 }, createHandler(options));
}
