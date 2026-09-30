import { ARC_RPC_URL, createArcRpcClient } from '../../api/_lib/arc-intelligence/rpc.js';

// One injected budget is shared by the chain follower and every receipt/log worker.
// A2 durable retries own backoff; each RPC invocation attempts the read once.
export function createA2RpcClient({ budget, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (!budget?.wrap || typeof fetchImpl !== 'function') throw new Error('invalid_a2_rpc');
  return budget.wrap({ url:ARC_RPC_URL,async request(method,params, { signal } = {}) {
    const client = createArcRpcClient({ url:ARC_RPC_URL,timeoutMs,maxAttempts:1,fetchImpl:async (url,init) => {
      if (signal?.aborted) throw new Error('operation_aborted');
      const response = await fetchImpl(url,{ ...init,signal:signal ? AbortSignal.any([signal,init.signal]) : init.signal });
      // Arm the shared cooldown before this invocation settles and releases its slot.
      if (response.status === 429) budget.notifyRateLimit();
      return response;
    } });
    if (signal?.aborted) throw new Error('operation_aborted');
    try { return await client.request(method,params); }
    catch { throw new Error(signal?.aborted ? 'operation_aborted' : 'required_read_unavailable'); }
  } });
}
