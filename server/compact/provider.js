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
const categoryOf = code => code === 'recovery_response_budget_exhausted' ? 'response_budget'
  : code === 'recovery_time_budget_exhausted' ? 'time_budget'
    : code === 'recovery_rpc_budget_exhausted' ? 'rpc_budget'
      : ['rate_limited', 'invalid_response', 'transport'].includes(code) ? code : 'rpc_error';
const CATEGORIES = new Set(['transport', 'http', 'timeout', 'body_read', 'response_budget', 'time_budget', 'rpc_budget',
  'rate_limited', 'invalid_response', 'rpc_error']);
const PHASES = new Set(['fetch', 'body_read', 'http', 'decode', 'rpc', 'budget']);
const CAUSES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);

// Recovery logs and durable retry metadata use ONLY these allowlisted fields. Never include raw detail,
// error messages, URLs, headers, RPC parameters or response bodies (even if the provider echoes credentials).
export function providerDiagnostics(error) {
  if (!(error instanceof ProviderError)) return null;
  const integer = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
  const range = error.blockRange;
  return { category: CATEGORIES.has(error.category) ? error.category : categoryOf(error.code),
    phase: PHASES.has(error.phase) ? error.phase : null,
    endpoint: /^[a-z][a-z0-9_-]{0,31}$/.test(error.endpoint ?? '') ? error.endpoint : null,
    httpStatus: Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? error.httpStatus : null,
    rpcCode: Number.isSafeInteger(error.rpcCode) ? error.rpcCode : null,
    causeCode: CAUSES.has(error.causeCode) ? error.causeCode : null,
    methods: Array.isArray(error.methods) ? [...new Set(error.methods.filter(m => /^eth_[A-Za-z0-9]{1,40}$/.test(m)))].slice(0, 50) : [],
    batchSize: integer(error.batchSize), requestNumber: integer(error.requestNumber), durationMs: integer(error.durationMs),
    timeoutMs: integer(error.timeoutMs),
    blockRange: range && integer(range.first) !== null && integer(range.last) !== null && range.first <= range.last
      ? { first: range.first, last: range.last } : null,
    recoveryUsage: error.recoveryUsage ? { requests: integer(error.recoveryUsage.requests),
      calls: integer(error.recoveryUsage.calls), bytes: integer(error.recoveryUsage.bytes) } : null };
}

function requestContext(payload) {
  const items = [].concat(payload), blocks = [];
  const add = tag => { if (typeof tag === 'string' && /^0x[0-9a-f]+$/i.test(tag)) {
    const n = Number(BigInt(tag)); if (Number.isSafeInteger(n) && n >= 0) blocks.push(n);
  } };
  for (const item of items) {
    if (item.method === 'eth_getLogs') { add(item.params?.[0]?.fromBlock); add(item.params?.[0]?.toBlock); }
    else if (item.method === 'eth_getBlockByNumber') add(item.params?.[0]);
    else if (['eth_getCode', 'eth_call', 'eth_getBalance'].includes(item.method)) add(item.params?.[1]);
  }
  return { methods: [...new Set(items.map(i => i.method))], batchSize: items.length,
    blockRange: blocks.length ? { first: Math.min(...blocks), last: Math.max(...blocks) } : null };
}

// code: rate_limited | range_too_large | too_many_results | rpc_error | invalid_response | transport | chain_mismatch
// httpStatus and detail (a short response excerpt, RPC message or transport cause) are diagnostics only.
export class ProviderError extends Error {
  constructor(code, { rpcCode = null, endpoint = null, httpStatus = null, detail = null, category = categoryOf(code),
    phase = null, causeCode = null } = {}) {
    super(code);
    this.code = code;
    this.rpcCode = rpcCode;
    this.endpoint = endpoint;
    this.httpStatus = httpStatus;
    this.detail = detailOf(detail);
    this.category = category;
    this.phase = phase;
    this.causeCode = causeCode;
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
    const started = now(), context = { ...requestContext(payload), requestNumber: stats.requests, timeoutMs };
    const decorate = error => Object.assign(error, context, { durationMs: Math.max(0, Math.floor(now() - started)) });
    let response, text, phase = 'fetch';
    try {
      response = await fetchImpl(endpoint.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload), signal: controller.signal });
      phase = 'body_read'; text = await response.text();
    } catch (error) {
      // In particular, the bounded recovery reader can throw a response-budget ProviderError.
      // Preserve its original code instead of relabelling it as an RPC/network transport failure.
      if (error instanceof ProviderError) { error.endpoint ??= name; error.httpStatus ??= response?.status ?? null; throw decorate(error); }
      throw decorate(fail('transport', { httpStatus: response?.status ?? null,
        category: controller.signal.aborted ? 'timeout' : phase === 'body_read' ? 'body_read' : 'transport', phase,
        causeCode: error?.cause?.code ?? error?.code ?? null,
        detail: controller.signal.aborted ? `timeout after ${timeoutMs} ms`
          : [error?.name, error?.message, error?.cause?.code ?? error?.cause?.message].filter(Boolean).join(': ') }));
    } finally { clearTimeout(timer); }
    stats.responseBytes += text.length;
    if (response.status === 429) {
      nextStart = Math.max(nextStart, now() + cooldownMs);
      throw decorate(fail('rate_limited', { httpStatus: 429, detail: text, phase: 'http' }));
    }
    if (!response.ok) throw decorate(fail('transport', { httpStatus: response.status ?? null, detail: text, category: 'http', phase: 'http' }));
    try { return JSON.parse(text); } catch { throw decorate(fail('invalid_response', { httpStatus: response.status ?? null, detail: text, phase: 'decode' })); }
  }

  const rpcFailure = (error) => {
    const code = classifyRpcError(error);
    if (code === 'rate_limited') nextStart = Math.max(nextStart, now() + cooldownMs);
    return fail(code, { rpcCode: error.code ?? null, detail: String(error.message ?? ''), phase: 'rpc' });
  };
  async function answer(payload, parse) {
    const started = now();
    try { return parse(await post(payload)); }
    catch (error) {
      if (error instanceof ProviderError && !error.methods) Object.assign(error, requestContext(payload),
        { requestNumber: stats.requests, durationMs: Math.max(0, Math.floor(now() - started)), timeoutMs });
      throw error;
    }
  }

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
    const result = await answer({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }, single);
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
      const payload = { jsonrpc: '2.0', id: 1, method, params };
      return run(() => answer(payload, single));
    },
    batch(calls, { allowItemErrors = false, retryRateLimited = true } = {}) {
      if (!Array.isArray(calls) || !calls.length || calls.length > 50) throw new Error('invalid_batch');
      const payload = calls.map(([method, params], index) => ({ jsonrpc: '2.0', id: index + 1, method, params }));
      return run(() => answer(payload, body => batch(body, calls.length, allowItemErrors)), { retryRateLimited });
    },
  });
}
