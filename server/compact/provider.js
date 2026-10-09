// Compact engine: JSON-RPC provider adapter for exactly one free, keyless endpoint. There is no failover: production
// uses the primary Arc RPC only, and a secondary endpoint is a separate provider created explicitly for validation.
// Every failure is an error: nothing here ever turns a provider limit, malformed batch or rate limit into an empty result.
import { setTimeout as delay } from 'node:timers/promises';

export const ARC_CHAIN_ID = 5042;
export const ARC_PRIMARY_ENDPOINT = Object.freeze({ name: 'circle', url: 'https://rpc.mainnet.arc.io' });
// Diagnostics and validation only (scripts/validate-compact-hour.mjs --secondary). Never a production fallback.
export const ARC_SECONDARY_ENDPOINT = Object.freeze({ name: 'drpc', url: 'https://arc.drpc.org' });

const DETAIL_LIMIT = 160;
const detailOf = (value) => (typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim().slice(0, DETAIL_LIMIT) : null);

// code: rate_limited | range_too_large | too_many_results | rpc_error | invalid_response | transport | chain_mismatch
// httpStatus and detail (a short response excerpt, RPC message or transport cause) are diagnostics only.
export class ProviderError extends Error {
  constructor(code, { rpcCode = null, endpoint = null, httpStatus = null, detail = null } = {}) {
    super(code);
    this.code = code;
    this.rpcCode = rpcCode;
    this.endpoint = endpoint;
    this.httpStatus = httpStatus;
    this.detail = detailOf(detail);
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

export function createProvider({ endpoint = ARC_PRIMARY_ENDPOINT, fetchImpl = globalThis.fetch, minIntervalMs = 1000,
  maxAttempts = 3, cooldownMs = 15000, timeoutMs = 20000, sleep = (ms) => delay(ms), now = () => performance.now(),
  chainId = ARC_CHAIN_ID } = {}) {
  if (typeof endpoint?.name !== 'string' || typeof endpoint?.url !== 'string' || typeof fetchImpl !== 'function'
    || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 6) throw new Error('invalid_provider');
  const name = endpoint.name;
  let nextStart = -Infinity;
  let chainVerified = false;
  // responseBytes: decoded response text (fetch has already removed any gzip), not wire bytes.
  // calls: JSON-RPC calls per method, counting every batch item, retry and chain check.
  const stats = { requests: 0, responseBytes: 0, retries: 0, calls: {} };
  const fail = (code, details = {}) => new ProviderError(code, { endpoint: name, ...details });

  async function post(payload) {
    const wait = nextStart - now();
    if (wait > 0) await sleep(wait);
    nextStart = now() + minIntervalMs;
    stats.requests++;
    for (const { method } of [].concat(payload)) stats.calls[method] = (stats.calls[method] ?? 0) + 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response, text;
    try {
      response = await fetchImpl(endpoint.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload), signal: controller.signal });
      text = await response.text();
    } catch (error) {
      throw fail('transport', { httpStatus: response?.status ?? null, detail: controller.signal.aborted ? `timeout after ${timeoutMs} ms`
        : [error?.name, error?.message, error?.cause?.code ?? error?.cause?.message].filter(Boolean).join(': ') });
    } finally { clearTimeout(timer); }
    stats.responseBytes += text.length;
    if (response.status === 429) {
      nextStart = Math.max(nextStart, now() + cooldownMs);
      throw fail('rate_limited', { httpStatus: 429, detail: text });
    }
    if (!response.ok) throw fail('transport', { httpStatus: response.status ?? null, detail: text });
    try { return JSON.parse(text); } catch { throw fail('invalid_response', { httpStatus: response.status ?? null, detail: text }); }
  }

  const rpcFailure = (error) => {
    const code = classifyRpcError(error);
    if (code === 'rate_limited') nextStart = Math.max(nextStart, now() + cooldownMs);
    return fail(code, { rpcCode: error.code ?? null, detail: String(error.message ?? '') });
  };

  function single(body) {
    if (!validEnvelope(body) || body.id !== 1) throw fail('invalid_response');
    if (body.error) throw rpcFailure(body.error);
    if (!Object.hasOwn(body, 'result')) throw fail('invalid_response');
    return body.result;
  }

  // Exactly one well-formed answer per request id. Item-level rate limits fail the whole batch (retryable).
  function batch(body, size, allowItemErrors) {
    if (!Array.isArray(body) || body.length !== size) throw fail('invalid_response');
    const byId = new Map();
    for (const item of body) {
      if (!validEnvelope(item) || item.id < 1 || item.id > size || byId.has(item.id)) throw fail('invalid_response');
      if (item.error) {
        if (classifyRpcError(item.error) === 'rate_limited' || !allowItemErrors) throw rpcFailure(item.error);
        byId.set(item.id, { error: { code: item.error.code ?? null, message: String(item.error.message ?? '').slice(0, 120) } });
      } else if (!Object.hasOwn(item, 'result')) throw fail('invalid_response');
      else byId.set(item.id, allowItemErrors ? { result: item.result } : item.result);
    }
    return Array.from({ length: size }, (_, index) => byId.get(index + 1));
  }

  async function ensureChain() {
    if (chainVerified) return;
    const result = single(await post({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }));
    if (typeof result !== 'string' || Number.parseInt(result, 16) !== chainId) throw fail('chain_mismatch', { detail: String(result) });
    chainVerified = true;
  }

  // Bounded retries with backoff on this one endpoint. Limit errors and a wrong chain propagate to the caller at once.
  async function run(execute, { retryRateLimited = true } = {}) {
    for (let attempt = 1; ; attempt++) {
      try {
        await ensureChain();
        return await execute();
      } catch (error) {
        if (!(error instanceof ProviderError) || !RETRYABLE.has(error.code) || attempt >= maxAttempts
          || (error.code === 'rate_limited' && !retryRateLimited)) throw error;
        stats.retries++;
        await sleep(error.code === 'rate_limited' ? cooldownMs : 1000 * attempt);
      }
    }
  }

  return Object.freeze({
    endpoint: Object.freeze({ name, url: endpoint.url }),
    stats,
    request(method, params = []) {
      return run(async () => single(await post({ jsonrpc: '2.0', id: 1, method, params })));
    },
    batch(calls, { allowItemErrors = false, retryRateLimited = true } = {}) {
      if (!Array.isArray(calls) || !calls.length || calls.length > 50) throw new Error('invalid_batch');
      const payload = calls.map(([method, params], index) => ({ jsonrpc: '2.0', id: index + 1, method, params }));
      return run(async () => batch(await post(payload), calls.length, allowItemErrors), { retryRateLimited });
    },
  });
}
