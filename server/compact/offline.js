// Compact engine: offline JSON-RPC transports for tests and replay. Nothing here opens a socket. Both return a
// fetch-compatible function for createProvider({ fetchImpl }).
//  - createRecordedFetch: answers only from recorded fixture calls, keyed by method + canonical params.
//  - createSyntheticChain: a deterministic Arc-shaped chain generated on demand, with provider limits and fault hooks.
import { USDC_SYSTEM_EMITTER, TRANSFER_TOPIC } from '../../api/_lib/arc-intelligence/usdc.js';
import { UNISWAP_EVENT_TOPICS, UNISWAP_REGISTRY } from '../../api/_lib/arc-intelligence/uniswap.js';
import { ARC_CHAIN_ID } from './provider.js';

const hex = (number) => `0x${number.toString(16)}`;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return typeof value === 'string' && value.startsWith('0x') ? value.toLowerCase() : value;
}
export const callKey = (method, params) => JSON.stringify([method, canonical(params ?? [])]);

function respond(body, answer) {
  const out = Array.isArray(body) ? body.map(answer) : answer(body);
  const text = JSON.stringify(out);
  return { status: 200, ok: true, text: async () => text };
}

export function createRecordedFetch(calls, { chainId = ARC_CHAIN_ID } = {}) {
  const table = new Map(calls.map((call) => [callKey(call.method, call.params), call]));
  const missing = [];
  const requests = [];
  const answer = (item) => {
    if (item.method === 'eth_chainId') return { jsonrpc: '2.0', id: item.id, result: hex(chainId) };
    const hit = table.get(callKey(item.method, item.params));
    if (!hit) {
      missing.push(callKey(item.method, item.params));
      return { jsonrpc: '2.0', id: item.id, error: { code: -32000, message: 'fixture call not recorded' } };
    }
    return hit.error ? { jsonrpc: '2.0', id: item.id, error: hit.error } : { jsonrpc: '2.0', id: item.id, result: structuredClone(hit.result) };
  };
  return {
    missing,
    requests,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      return respond(body, answer);
    },
  };
}

// 32-bit integer mixer: deterministic pseudo-randomness without hashing whole payloads.
function mix(value) {
  let x = value >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}
const rand = (seed, a, b = 0) => mix(seed ^ mix(a + 0x9e3779b9) ^ mix(Math.imul(b + 1, 0x85ebca6b)));
const filler = (seed, a, b, words) => Array.from({ length: words }, (_, index) => rand(seed, a, b * 31 + index).toString(16).padStart(8, '0')).join('');
// Unique by construction: tag, block and index are embedded, the rest is filler.
const fakeHash = (seed, tag, number, index = 0) => `0x${tag}${number.toString(16).padStart(14, '0')}${index.toString(16).padStart(8, '0')}${
  filler(seed, number, index + tag.length * 7919, 5).slice(0, 42 - tag.length)}`;
const address = (prefix, index) => `0x${prefix}${index.toString(16).padStart(40 - prefix.length, '0')}`;
const topicOf = (value) => `0x${value.slice(2).padStart(64, '0')}`;
const word = (value) => BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, '0');
const ZERO = '0x0000000000000000000000000000000000000000';

export const SYNTHETIC_CONTRACTS = Object.freeze({
  validV3Pool: address('c0de01', 1),
  foreignV3Emitter: address('c0de02', 2), // the first of the foreignV3Emitters synthetic V3-signature emitters
  tokenA: address('70ce0a', 10),
  tokenB: address('70ce0b', 11),
  eurc: '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1',
});
const V3_FEE = 3000;
// Real V4 Swap payloads captured on Arc mainnet (scripts/fixtures/compact-arc-capture-2026-10-01.json).
const V4_SWAP_DATA = [
  '0x000000000000000000000000000000000000000000000000000000000028f5f9ffffffffffffffffffffffffffffffffffffffffffffe76ccf776e6ff9a93ac5000000000000000000000000000000000c554d442217915d9d84794d5e5a88a800000000000000000000000000000000000000000000000015dba887cc46b791000000000000000000000000000000000000000000000000000000000005d7ff0000000000000000000000000000000000000000000000000000000000002710',
  '0x00000000000000000000000000000000000000000000000835935e74d2b87483fffffffffffffffffffffffffffffffffffffffffffce16b837f0bd0956bc2e6000000000000000000000000000000000000009e52f4431c3112dca39fe50e97000000000000000000000000000000000000000000022ee0e687744334dcf15a0000000000000000000000000000000000000000000000000000000000018bb100000000000000000000000000000000000000000000000000000000000009c4',
];
const V4_POOLS = ['0x96fbcfa73dfb947230681cb211fcd0fba8221fbcddbdb3375c795add2afad714', '0xa5edcec276913c24bb618b5836cbcc44e94f32e80f7fc74a8a4aa597e2af7ac9'];
const V4_ROUTER = '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1';

// Block spacing in 1/10,000 s: by default 0.5074 s with integer-second timestamps, so neighbours often share a second,
// like Arc. The official V3 factory has code from factoryDeployedAt; the official pool (validV3Pool) emits nothing before
// its PoolCreated at poolCreatedAt and swaps in that same block right after it. foreignV3Emitters distinct contracts emit
// V3-signature swaps every foreignV3Every blocks without ever appearing in a PoolCreated.
export function createSyntheticChain({ originNumber = 23_000_000, originTimestamp = 1_790_000_000, blockSpacing = 5074, txPerBlock = 6,
  usdcPerBlock = 10, v4PerBlock = 5, senderPool = 4000, recipientPool = 2500, assetEvery = 40, v3Every = 300,
  factoryDeployedAt = originNumber, poolCreatedAt = originNumber, foreignV3Emitters = 1, foreignV3Every = v3Every,
  head = originNumber + 20_000, limits = {}, faults = {}, seed = 0x6d61 } = {}) {
  const maxRange = limits.maxRange ?? 10000;
  const maxResults = limits.maxResults ?? Infinity;
  const timestampOf = (number) => originTimestamp + Math.floor(((number - originNumber) * blockSpacing) / 10000);
  const blockHash = (number) => fakeHash(seed, 'b10c', number);

  function transactionsOf(number) {
    const count = Math.max(0, txPerBlock - 2 + (rand(seed, number, 0) % 5));
    return Array.from({ length: count }, (_, index) => {
      const r = rand(seed, number, index + 1);
      const deployment = r % 997 === 0;
      const to = deployment ? null : r % 3 === 0 ? address('5e', (r >>> 9) % senderPool) : address('7e', (r >>> 9) % recipientPool);
      return { hash: fakeHash(seed, '7a', number, index), from: address('5e', r % senderPool), to };
    });
  }

  function rawBlock(number, full) {
    const transactions = transactionsOf(number);
    const block = {
      number: hex(number), hash: blockHash(number), parentHash: blockHash(number - 1), timestamp: hex(timestampOf(number)),
      gasUsed: hex(21000 * transactions.length + (rand(seed, number, 99) % 400000)), gasLimit: '0x1c9c380', baseFeePerGas: '0x4a817c800',
      miner: address('3a', 1), stateRoot: fakeHash(seed, '5700', number), receiptsRoot: fakeHash(seed, 'ec00', number),
      transactionsRoot: fakeHash(seed, '7700', number), logsBloom: `0x${'0'.repeat(512)}`, extraData: '0x', size: hex(800 + transactions.length * 300),
      transactions: full ? transactions.map((tx, index) => ({
        hash: tx.hash, blockHash: blockHash(number), blockNumber: hex(number), transactionIndex: hex(index), from: tx.from, to: tx.to,
        value: '0x0', nonce: hex(rand(seed, number, index + 500) % 5000), gas: '0x30d40', type: '0x2', chainId: hex(ARC_CHAIN_ID),
        maxFeePerGas: '0x9502f9000', maxPriorityFeePerGas: '0x0', accessList: [], yParity: '0x1', v: '0x1',
        r: fakeHash(seed, 'a0', number, index), s: fakeHash(seed, '50', number, index),
        input: `0xa9059cbb${filler(seed, number, index + 900, 16)}`,
      })) : transactions.map((tx) => tx.hash),
    };
    return faults.block ? faults.block(number, block, full) : block;
  }

  // Every log of one block, in logIndex order, with non-decreasing transaction index (as on a real chain).
  function logsOf(number) {
    const transactions = transactionsOf(number);
    if (!transactions.length) return [];
    const specs = [];
    const usdcCount = Math.max(0, usdcPerBlock - 3 + (rand(seed, number, 1000) % 7));
    const v4Count = Math.max(0, v4PerBlock - 2 + (rand(seed, number, 2000) % 5));
    for (let index = 0; index < usdcCount; index++) specs.push(['usdc', index]);
    for (let index = 0; index < v4Count; index++) specs.push([index % 7 === 6 ? 'v4Modify' : 'v4Swap', index]);
    if (number % 3001 === 0) specs.push(['v4Initialize', 0]);
    if (number % assetEvery === 0) specs.push(['eurc', 0]);
    const poolLive = number > poolCreatedAt;
    if (poolLive && number % v3Every === 0) specs.push(['v3Swap', 0]);
    if (number % foreignV3Every === 7 % foreignV3Every) specs.push(['v3ForeignSwap', Math.floor(number / foreignV3Every) % foreignV3Emitters]);
    if (poolLive && number % (v3Every * 2) === 11) specs.push(['v3Mint', 0]);
    if (number === poolCreatedAt) specs.push(['v3PoolCreated', 0], ['v3Swap', 0]);
    return specs.map(([kind, index], logIndex) => {
      const transactionIndex = Math.floor((logIndex * transactions.length) / specs.length);
      const r = rand(seed, number, 3000 + logIndex);
      const base = { blockHash: blockHash(number), blockNumber: hex(number), blockTimestamp: hex(timestampOf(number)),
        transactionHash: transactions[transactionIndex].hash, transactionIndex: hex(transactionIndex), logIndex: hex(logIndex), removed: false };
      if (kind === 'usdc' || kind === 'eurc') {
        const from = kind === 'usdc' && r % 113 === 0 ? ZERO : address('5e', r % senderPool);
        const to = kind === 'usdc' && r % 127 === 1 ? ZERO : address('7e', (r >>> 7) % recipientPool);
        return { ...base, address: kind === 'usdc' ? USDC_SYSTEM_EMITTER.toLowerCase() : SYNTHETIC_CONTRACTS.eurc,
          topics: [TRANSFER_TOPIC, topicOf(from), topicOf(to)], data: `0x${word(BigInt(r) * 1_000_000_000_000n)}` };
      }
      if (kind === 'v4Swap') {
        return { ...base, address: UNISWAP_REGISTRY.v4PoolManager.address, topics: [UNISWAP_EVENT_TOPICS.v4Swap, V4_POOLS[r % 2], topicOf(V4_ROUTER)],
          data: V4_SWAP_DATA[r % 2] };
      }
      if (kind === 'v4Modify') {
        return { ...base, address: UNISWAP_REGISTRY.v4PoolManager.address, topics: [UNISWAP_EVENT_TOPICS.v4ModifyLiquidity, V4_POOLS[r % 2], topicOf(V4_ROUTER)],
          data: `0x${word(-600)}${word(600)}${word(10n ** 15n)}${word(r)}` };
      }
      if (kind === 'v4Initialize') {
        return { ...base, address: UNISWAP_REGISTRY.v4PoolManager.address,
          topics: [UNISWAP_EVENT_TOPICS.v4Initialize, `0x${word(r)}`, topicOf(SYNTHETIC_CONTRACTS.tokenA), topicOf(SYNTHETIC_CONTRACTS.tokenB)],
          data: `0x${word(500)}${word(10)}${word(0)}${word(1n << 96n)}${word(0)}` };
      }
      if (kind === 'v3PoolCreated') {
        return { ...base, address: UNISWAP_REGISTRY.v3Factory.address,
          topics: [UNISWAP_EVENT_TOPICS.v3PoolCreated, topicOf(SYNTHETIC_CONTRACTS.tokenA), topicOf(SYNTHETIC_CONTRACTS.tokenB), `0x${word(V3_FEE)}`],
          data: `0x${word(60)}${word(BigInt(SYNTHETIC_CONTRACTS.validV3Pool))}` };
      }
      const pool = kind === 'v3ForeignSwap' ? address('c0de02', 2 + index) : SYNTHETIC_CONTRACTS.validV3Pool;
      if (kind === 'v3Mint') {
        return { ...base, address: pool, topics: [UNISWAP_EVENT_TOPICS.v3Mint, topicOf(V4_ROUTER), `0x${word(-600)}`, `0x${word(600)}`],
          data: `0x${word(BigInt(V4_ROUTER))}${word(10n ** 15n)}${word(r)}${word(r + 1)}` };
      }
      return { ...base, address: pool, topics: [UNISWAP_EVENT_TOPICS.v3Swap, topicOf(V4_ROUTER), topicOf(V4_ROUTER)],
        data: `0x${word(r)}${word(-(r + 1))}${word(1n << 96n)}${word(10n ** 18n)}${word(-120)}` };
    });
  }

  function getLogs(filter) {
    const from = Number(BigInt(filter.fromBlock));
    const to = Number(BigInt(filter.toBlock));
    if (to - from + 1 > maxRange) return { error: { code: -32012, message: 'requested range too large' } };
    const addresses = filter.address ? new Set([].concat(filter.address).map((value) => value.toLowerCase())) : null;
    const topics = new Set(filter.topics[0]);
    const out = [];
    for (let number = from; number <= to; number++) {
      for (const log of logsOf(number)) {
        if ((addresses && !addresses.has(log.address)) || !topics.has(log.topics[0])) continue;
        out.push(log);
      }
    }
    if (out.length > maxResults) return { error: { code: -32602, message: `query exceeds max results ${maxResults}` } };
    return { result: faults.logs ? faults.logs(filter, out) : out };
  }

  // Contract code by block: the V4 PoolManager always, the V3 factory from its deployment block.
  function codeAt(target, blockTag) {
    const at = /^0x[0-9a-f]+$/i.test(blockTag ?? '') ? Number(BigInt(blockTag)) : head;
    const present = target === UNISWAP_REGISTRY.v4PoolManager.address || (target === UNISWAP_REGISTRY.v3Factory.address && at >= factoryDeployedAt);
    return present ? '0x6080604052348015600f57600080fd5b50' : '0x';
  }

  function answer(item) {
    const envelope = (payload) => ({ jsonrpc: '2.0', id: item.id, ...payload });
    switch (item.method) {
      case 'eth_chainId': return envelope({ result: hex(ARC_CHAIN_ID) });
      case 'eth_blockNumber': return envelope({ result: hex(head) });
      case 'eth_getBlockByNumber': return envelope({ result: rawBlock(Number(BigInt(item.params[0])), item.params[1] === true) });
      case 'eth_getLogs': return envelope(getLogs(item.params[0]));
      case 'eth_getCode': return envelope({ result: codeAt(item.params[0].toLowerCase(), item.params[1]) });
      default: return envelope({ error: { code: -32601, message: 'method not found' } });
    }
  }

  const requests = [];
  return {
    timestampOf,
    blockHash,
    rawBlock,
    transactionsOf,
    logsOf,
    requests,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(Array.isArray(body) ? body.map((item) => item.method) : body.method);
      if (faults.request) {
        const override = faults.request(body);
        if (override !== undefined) {
          const text = typeof override === 'string' ? override : JSON.stringify(override);
          return { status: 200, ok: true, text: async () => text };
        }
      }
      return respond(body, answer);
    },
  };
}
