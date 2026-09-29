export const ARC_CHAIN_ID = 5042;
export const ARC_RPC_URL = 'https://rpc.mainnet.arc.io';

const READ_ONLY_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockReceipts',
  'eth_getTransactionReceipt',
  'eth_getLogs',
  'eth_getCode',
  'eth_call',
]);

const RETRYABLE_RPC_CODES = new Set([-32005, -32016, -32603]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryableRpcMessage(message = '') {
  return /rate.?limit|too many requests|temporar|timeout|timed out|try again|overloaded/i.test(message);
}

export function createArcRpcClient({
  url = ARC_RPC_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
  maxAttempts = 3,
  baseDelayMs = 180,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Fetch is unavailable');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('Invalid RPC timeout');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new RangeError('RPC maxAttempts must be between 1 and 3');
  }

  let requestId = 0;

  async function request(method, params = []) {
    if (!READ_ONLY_METHODS.has(method)) throw new Error(`Unsupported or non-read RPC method: ${method}`);

    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let shouldRetry = false;

      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
          signal: controller.signal,
        });

        if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
          shouldRetry = true;
          lastError = new Error(`RPC ${method} returned HTTP ${response.status}`);
        } else if (!response.ok) {
          throw new Error(`RPC ${method} returned HTTP ${response.status}`);
        } else {
          const payload = await response.json();
          if (payload?.error) {
            const code = Number.isSafeInteger(payload.error.code) ? payload.error.code : null;
            const message = typeof payload.error.message === 'string' ? payload.error.message : '';
            shouldRetry = RETRYABLE_RPC_CODES.has(code) || retryableRpcMessage(message);
            lastError = new Error(`RPC ${method} returned JSON-RPC error${code === null ? '' : ` ${code}`}`);
            if (!shouldRetry) throw lastError;
          } else if (!Object.prototype.hasOwnProperty.call(payload ?? {}, 'result')) {
            throw new Error(`RPC ${method} returned a malformed response`);
          } else {
            return payload.result;
          }
        }
      } catch (error) {
        const timedOut = error?.name === 'AbortError';
        const networkFailure = error instanceof TypeError;
        if (timedOut || networkFailure) {
          shouldRetry = true;
          lastError = new Error(`RPC ${method} timed out or could not connect`);
        } else if (!lastError || error !== lastError) {
          throw error;
        }
      } finally {
        clearTimeout(timeout);
      }

      if (!shouldRetry || attempt === maxAttempts) break;
      await delay(baseDelayMs * (2 ** (attempt - 1)));
    }

    throw lastError ?? new Error(`RPC ${method} failed after bounded retries`);
  }

  return Object.freeze({ url, request });
}
