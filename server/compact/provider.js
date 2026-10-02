// Compact engine: replaceable JSON-RPC provider adapter. Free, keyless endpoints only. Every failure is an error:
// nothing here ever turns a provider limit, malformed batch or rate limit into an empty result.
import { setTimeout as delay } from 'node:timers/promises';

export const ARC_CHAIN_ID = 5042;
export const COMPACT_ENDPOINTS = Object.freeze([
  Object.freeze({ name: 'circle', url: 'https://rpc.mainnet.arc.io' }),
  Object.freeze({ name: 'drpc', url: 'https://arc.drpc.org' }),
]);

// code: rate_limited | range_too_large | too_many_results | rpc_error | invalid_response | transport | chain_mismatch
export class ProviderError extends Error {
  constructor(code, { rpcCode = null, endpoint = null } = {}) {
    super(code);
    this.code = code;
    this.rpcCode = rpcCode;
    this.endpoint = endpoint;
  }
}
const RETRYABLE = new Set(['rate_limited', 'transport', 'invalid_response']);

// Observed Arc limits: -32005 rate limit (also per batch item inside HTTP 200), -32012 range too large,
// -32602 "max results" on some load-balanced backends. Only the latter two are split by callers.
export function classifyRpcError(error) {
  const code = Number.isSafeInteger(error?.code) ? error.code : null;
  const message = typeof error?.message === 'string' ? error.message : '';
  if (code === -32005 || /rate limit/i.test(message)) return 'rate_limited';
  if (code === -32012 || /range too large/i.test(message)) return 'range_too_large';
  if (code === -32602 && /max results|max allowed range|too many/i.test(message)) return 'too_many_results';
  return 'rpc_error';
}

function validEnvelope(item) {
  return item && typeof item === 'object' && !Array.isArray(item) && item.jsonrpc === '2.0' && Number.isSafeInteger(item.id);
}

export function createProvider({ endpoints = COMPACT_ENDPOINTS, fetchImpl = globalThis.fetch, minIntervalMs = 1000,
  maxAttempts = 3, cooldownMs = 15000, timeoutMs = 20000, sleep = (ms) => delay(ms), now = () => performance.now(),
  chainId = ARC_CHAIN_ID } = {}) {
  if (!Array.isArray(endpoints) || !endpoints.length || typeof fetchImpl !== 'function'
    || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 6) throw new Error('invalid_provider');
  const state = endpoints.map((endpoint) => ({ ...endpoint, nextStart: -Infinity, chainVerified: false }));
  // responseBytes: decoded response text (fetch has already removed any gzip), not wire bytes.
  // calls: JSON-RPC calls per method, counting every batch item, retry and chain check.
  const stats = { requests: 0, responseBytes: 0, retries: 0, failovers: 0, calls: {},
    byEndpoint: Object.fromEntries(endpoints.map((e) => [e.name, 0])) };

  async function post(endpoint, payload) {
    const wait = endpoint.nextStart - now();
    if (wait > 0) await sleep(wait);
    endpoint.nextStart = now() + minIntervalMs;
    stats.requests++; stats.byEndpoint[endpoint.name]++;
    for (const { method } of [].concat(payload)) stats.calls[method] = (stats.calls[method] ?? 0) + 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response, text;
    try {
      response = await fetchImpl(endpoint.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload), signal: controller.signal });
      text = await response.text();
    } catch { throw new ProviderError('transport', { endpoint: endpoint.name }); } finally { clearTimeout(timer); }
    stats.responseBytes += text.length;
    if (response.status === 429) {
      endpoint.nextStart = Math.max(endpoint.nextStart, now() + cooldownMs);
      throw new ProviderError('rate_limited', { endpoint: endpoint.name });
    }
    if (!response.ok) throw new ProviderError('transport', { endpoint: endpoint.name });
    try { return JSON.parse(text); } catch { throw new ProviderError('invalid_response', { endpoint: endpoint.name }); }
  }

  function single(endpoint, body) {
    if (!validEnvelope(body) || body.id !== 1) throw new ProviderError('invalid_response', { endpoint: endpoint.name });
    if (body.error) throw new ProviderError(classifyRpcError(body.error), { rpcCode: body.error.code ?? null, endpoint: endpoint.name });
    if (!Object.hasOwn(body, 'result')) throw new ProviderError('invalid_response', { endpoint: endpoint.name });
    return body.result;
  }

  // Exactly one well-formed answer per request id. Item-level rate limits fail the whole batch (retryable).
  function batch(endpoint, body, size, allowItemErrors) {
    if (!Array.isArray(body) || body.length !== size) throw new ProviderError('invalid_response', { endpoint: endpoint.name });
    const byId = new Map();
    for (const item of body) {
      if (!validEnvelope(item) || item.id < 1 || item.id > size || byId.has(item.id)) throw new ProviderError('invalid_response', { endpoint: endpoint.name });
      if (item.error) {
        const code = classifyRpcError(item.error);
        if (code === 'rate_limited' || !allowItemErrors) throw new ProviderError(code, { rpcCode: item.error.code ?? null, endpoint: endpoint.name });
        byId.set(item.id, { error: { code: item.error.code ?? null, message: String(item.error.message ?? '').slice(0, 120) } });
      } else if (!Object.hasOwn(item, 'result')) throw new ProviderError('invalid_response', { endpoint: endpoint.name });
      else byId.set(item.id, allowItemErrors ? { result: item.result } : item.result);
    }
    return Array.from({ length: size }, (_, index) => byId.get(index + 1));
  }

  async function ensureChain(endpoint) {
    if (endpoint.chainVerified) return;
    const result = single(endpoint, await post(endpoint, { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }));
    if (typeof result !== 'string' || Number.parseInt(result, 16) !== chainId) throw new ProviderError('chain_mismatch', { endpoint: endpoint.name });
    endpoint.chainVerified = true;
  }

  // Bounded retries per endpoint with backoff, then the next endpoint. Limit errors propagate to the caller at once.
  // The endpoint that last answered stays preferred, so a dead primary is not retried on every request.
  let preferred = 0;
  async function run(execute) {
    let lastError = new ProviderError('transport');
    for (let step = 0; step < state.length; step++) {
      const index = (preferred + step) % state.length;
      const endpoint = state[index];
      if (step > 0) stats.failovers++;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await ensureChain(endpoint);
          const result = await execute(endpoint);
          preferred = index;
          return result;
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          lastError = error;
          if (error.code === 'chain_mismatch') break; // never retry an endpoint on the wrong chain; try the next one
          if (!RETRYABLE.has(error.code)) throw error;
          if (attempt < maxAttempts) {
            stats.retries++;
            await sleep(error.code === 'rate_limited' ? cooldownMs : 1000 * attempt);
          }
        }
      }
    }
    throw lastError;
  }

  return Object.freeze({
    stats,
    request(method, params = []) {
      return run(async (endpoint) => single(endpoint, await post(endpoint, { jsonrpc: '2.0', id: 1, method, params })));
    },
    batch(calls, { allowItemErrors = false } = {}) {
      if (!Array.isArray(calls) || !calls.length || calls.length > 50) throw new Error('invalid_batch');
      const payload = calls.map(([method, params], index) => ({ jsonrpc: '2.0', id: index + 1, method, params }));
      return run(async (endpoint) => batch(endpoint, await post(endpoint, payload), calls.length, allowItemErrors));
    },
  });
}
