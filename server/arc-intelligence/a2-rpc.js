import { ARC_RPC_URL, createArcRpcClient } from '../../api/_lib/arc-intelligence/rpc.js';
import { MAX_WINDOW_SIZE } from '../../api/_lib/arc-intelligence/core.js';

// One injected budget is shared by the chain follower and every receipt/log worker.
// A2 durable retries own backoff; each RPC invocation attempts the read once.
export function createA2RpcClient({ budget, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (!budget?.wrap || !budget?.run || typeof fetchImpl !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('invalid_a2_rpc');
  const single = budget.wrap({ url:ARC_RPC_URL,async request(method,params, { signal } = {}) {
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
  return Object.freeze({ ...single,
    requestBlockRange(start,end,{signal} = {}) {
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end < start
        || end-start+1 > MAX_WINDOW_SIZE) throw new Error('invalid_block_batch');
      const requests = Array.from({length:end-start+1},(_,i) => ({jsonrpc:'2.0',id:i+1,
        method:'eth_getBlockByNumber',params:[`0x${(start+i).toString(16)}`,true]}));
      // A whole bounded batch occupies one shared transport slot, with no internal retries.
      return budget.run(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(),timeoutMs);
        const activeSignal = signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
        try {
          if (activeSignal.aborted) throw new Error('operation_aborted');
          const response = await fetchImpl(ARC_RPC_URL,{method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify(requests),signal:activeSignal});
          if (response.status === 429) budget.notifyRateLimit();
          if (!response.ok) throw new Error('required_read_unavailable');
          const payload = await response.json();
          if (activeSignal.aborted || !Array.isArray(payload) || payload.length !== requests.length) throw new Error('required_read_unavailable');
          const results = new Map();
          for (const item of payload) {
            if (!item || item.jsonrpc !== '2.0' || !Number.isSafeInteger(item.id) || item.id < 1 || item.id > requests.length
              || results.has(item.id) || Object.hasOwn(item,'error') || !item.result
              || typeof item.result !== 'object' || Array.isArray(item.result)) throw new Error('required_read_unavailable');
            results.set(item.id,item.result);
          }
          return requests.map(({id}) => results.get(id));
        } catch { throw new Error(signal?.aborted ? 'operation_aborted' : 'required_read_unavailable'); }
        finally { clearTimeout(timeout); }
      },{signal});
    },
  });
}
