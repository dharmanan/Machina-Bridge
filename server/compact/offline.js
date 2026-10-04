// Compact engine: offline JSON-RPC transports for tests and replay. Nothing here opens a socket. Both return a
// fetch-compatible function for createProvider({ fetchImpl }).
//  - createRecordedFetch: answers only from recorded fixture calls, keyed by method + canonical params.
//  - createSyntheticChain: a deterministic Arc-shaped chain generated on demand, with provider limits and fault hooks.
import { USDC_SYSTEM_EMITTER, TRANSFER_TOPIC } from '../../api/_lib/arc-intelligence/usdc.js';
import { UNISWAP_EVENT_TOPICS, UNISWAP_REGISTRY } from '../../api/_lib/arc-intelligence/uniswap.js';
import { encodeCall } from './abi.js';
import { v4PoolIdOf } from './projections.js';
import { AAVE_V4_ARC, AAVE_V4_EVENTS } from './protocols/aave.js';
import { ACROSS_ARC, ACROSS_EVENTS } from './protocols/across.js';
import { CCTP_EVENTS, CIRCLE_ARC, GATEWAY_EVENTS } from './protocols/circle.js';
import { ERC4626_EVENTS, MORPHO_ARC, MORPHO_BLUE_EVENTS } from './protocols/morpho.js';
import { PROTOCOL_FAMILIES } from './protocols/index.js';
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
export const SYNTHETIC_V4_HOOKS = address('400c', 1);
// The PoolKey behind each synthetic Initialize (every 3001st block): native currency (0x0) in every third pool, a hooked
// pool in every other one, and a tickSpacing unique per block, so every poolId is distinct and equals keccak256(PoolKey).
export function syntheticV4PoolKey(number) {
  const n = Math.floor(number / 3001);
  return { currency0: n % 3 === 0 ? ZERO : SYNTHETIC_CONTRACTS.tokenA, currency1: SYNTHETIC_CONTRACTS.tokenB, fee: 500,
    tickSpacing: 1 + (n % 32767), hooks: n % 2 === 1 ? SYNTHETIC_V4_HOOKS : ZERO };
}

// Protocol families (Stage 3): official emitters from protocols/*.js, plus synthetic markets, reserves and vaults.
const USDC_INTERFACE = CIRCLE_ARC.usdc;
const CIRBTC = '0x171a4217b86a807a64eb94757db6849fb4bdbaa0';
const WETH = '0x128cc466b61f542da60c70e3aa11c10e19b84edb';
export const SYNTHETIC_PROTOCOL = Object.freeze({
  // Aave V4 reserves per spoke: [underlying, decimals].
  aaveReserves: Object.freeze({ [AAVE_V4_ARC.mainSpoke]: [[USDC_INTERFACE, 6], [SYNTHETIC_CONTRACTS.eurc, 6], [CIRBTC, 8]],
    [AAVE_V4_ARC.forexSpoke]: [[SYNTHETIC_CONTRACTS.eurc, 6], [USDC_INTERFACE, 6]] }),
  // Morpho Blue markets: id -> [loanToken, collateralToken, lltv].
  morphoMarkets: Object.freeze({ [`0x${'a1'.repeat(32)}`]: [USDC_INTERFACE, CIRBTC, 860_000_000_000_000_000n],
    [`0x${'b2'.repeat(32)}`]: [SYNTHETIC_CONTRACTS.eurc, WETH, 770_000_000_000_000_000n] }),
  morphoCreatedMarket: `0x${'c3'.repeat(32)}`,
  // Vault V2 vaults (proven by the factory) -> asset; foreignVault emits ERC-4626 events but is not a Vault V2.
  morphoVaults: Object.freeze({ [address('fa01', 1)]: USDC_INTERFACE, [address('fa02', 2)]: SYNTHETIC_CONTRACTS.eurc }),
  foreignVault: address('fa0f', 15),
  cctpDomains: Object.freeze([0, 2, 3, 6]),
  gatewayDomains: Object.freeze([0, 26, 6]),
  acrossChains: Object.freeze([1n, 8453n, 42161n]),
});
const PROTOCOL_CODE = new Set([...PROTOCOL_FAMILIES.flatMap((family) => family.codeAddresses), ...Object.keys(SYNTHETIC_PROTOCOL.morphoVaults),
  SYNTHETIC_PROTOCOL.foreignVault]);
const bytes32Of = (value) => `0x${value.slice(2).padStart(64, '0')}`;

function encodeWord(type, value) {
  if (type === 'address' || type === 'bytes32') return value.slice(2).toLowerCase().padStart(64, '0');
  if (type === 'bool') return value ? word(1) : word(0);
  return word(value);
}

// The ABI encoding of one event (test-side inverse of abi.js defineEvent(...).decode).
export function encodeEventLog(definition, values) {
  const topics = [definition.topic];
  const head = [];
  const tails = [];
  let tailOffset = definition.inputs.filter((input) => !input.indexed).reduce((sum, input) => sum + (input.components?.length ?? 1), 0) * 32;
  for (const input of definition.inputs) {
    const value = values[input.name];
    if (input.indexed) topics.push(`0x${encodeWord(input.type, value)}`);
    else if (input.components) for (const component of input.components) head.push(encodeWord(component.type, value[component.name]));
    else if (input.dynamic) {
      const content = (value ?? '0x').slice(2);
      const words = Math.ceil(content.length / 64);
      head.push(word(tailOffset));
      tails.push(`${word(content.length / 2)}${content.padEnd(words * 64, '0')}`);
      tailOffset += 32 + words * 32;
    } else head.push(encodeWord(input.type, value));
  }
  return { topics, data: `0x${head.join('')}${tails.join('')}` };
}

// Deterministic protocol events of one block: [family, kind, emitter, definition, values], in emission order.
function protocolActivityOf(seed, number, senderPool, recipientPool) {
  const out = [];
  const r = rand(seed, number, 7000);
  const amount = BigInt(1 + (r % 5000)) * 1_000_000n;
  const user = address('7e', r % recipientPool);
  const pick = (list) => list[r % list.length];
  if (number % 97 === 0) {
    out.push(['cctp', 'depositForBurn', CIRCLE_ARC.tokenMessenger, CCTP_EVENTS.depositForBurn, { burnToken: USDC_INTERFACE, amount,
      depositor: address('5e', r % senderPool), mintRecipient: bytes32Of(user), destinationDomain: pick(SYNTHETIC_PROTOCOL.cctpDomains),
      destinationTokenMessenger: bytes32Of(CIRCLE_ARC.tokenMessenger), destinationCaller: bytes32Of(ZERO), maxFee: r % 1000,
      minFinalityThreshold: 2000, hookData: r % 2 ? '0x' : '0x1234abcd' }]);
  }
  if (number % 89 === 0) {
    out.push(['cctp', 'mintAndWithdraw', CIRCLE_ARC.tokenMessenger, CCTP_EVENTS.mintAndWithdraw, { mintRecipient: user, amount,
      mintToken: USDC_INTERFACE, feeCollected: r % 777 }]);
    out.push(['cctp', 'messageReceived', CIRCLE_ARC.messageTransmitter, CCTP_EVENTS.messageReceived, { caller: address('5e', r % senderPool),
      sourceDomain: pick(SYNTHETIC_PROTOCOL.cctpDomains), nonce: `0x${word(r)}`, sender: bytes32Of(CIRCLE_ARC.tokenMessenger),
      finalityThresholdExecuted: 2000, messageBody: `0x${'ab'.repeat(100 + (r % 40))}` }]);
  }
  if (number % 113 === 0) {
    out.push(['gateway', 'deposited', CIRCLE_ARC.gatewayWallet, GATEWAY_EVENTS.deposited, { token: USDC_INTERFACE, depositor: user,
      sender: address('5e', r % senderPool), value: amount }]);
  }
  if (number % 127 === 0) {
    out.push(['gateway', 'gatewayBurned', CIRCLE_ARC.gatewayWallet, GATEWAY_EVENTS.gatewayBurned, { token: USDC_INTERFACE, depositor: user,
      transferSpecHash: `0x${word(r + 1)}`, destinationDomain: pick(SYNTHETIC_PROTOCOL.gatewayDomains), destinationRecipient: bytes32Of(user),
      signer: user, value: amount, fee: r % 999, fromAvailable: amount, fromWithdrawing: 0 }]);
  }
  if (number % 131 === 0) {
    out.push(['gateway', 'attestationUsed', CIRCLE_ARC.gatewayMinter, GATEWAY_EVENTS.attestationUsed, { token: USDC_INTERFACE, recipient: user,
      transferSpecHash: `0x${word(r + 2)}`, sourceDomain: pick([0, 6]), sourceDepositor: bytes32Of(user), sourceSigner: bytes32Of(user), value: amount }]);
  }
  if (number % 251 === 0) {
    out.push(['gateway', 'withdrawalInitiated', CIRCLE_ARC.gatewayWallet, GATEWAY_EVENTS.withdrawalInitiated, { token: USDC_INTERFACE,
      depositor: user, value: amount, remainingAvailable: 0, totalWithdrawing: amount, withdrawalBlock: number + 100 }]);
  }
  if (number % 257 === 0) {
    out.push(['gateway', 'withdrawalCompleted', CIRCLE_ARC.gatewayWallet, GATEWAY_EVENTS.withdrawalCompleted, { token: USDC_INTERFACE,
      depositor: user, value: amount }]);
  }
  if (number % 71 === 0) {
    out.push(['across', 'fundsDeposited', ACROSS_ARC.spokePool, ACROSS_EVENTS.fundsDeposited, { inputToken: bytes32Of(pick([USDC_INTERFACE, WETH])),
      outputToken: bytes32Of(`0x${'0b'.repeat(20)}`), inputAmount: amount, outputAmount: amount - 1000n, destinationChainId: pick(SYNTHETIC_PROTOCOL.acrossChains),
      depositId: number, quoteTimestamp: 1, fillDeadline: 2, exclusivityDeadline: 0, depositor: bytes32Of(user), recipient: bytes32Of(user),
      exclusiveRelayer: bytes32Of(ZERO), message: '0x' }]);
  }
  if (number % 73 === 0) {
    out.push(['across', 'filledRelay', ACROSS_ARC.spokePool, ACROSS_EVENTS.filledRelay, { inputToken: bytes32Of(`0x${'0c'.repeat(20)}`),
      outputToken: bytes32Of(USDC_INTERFACE), inputAmount: amount, outputAmount: amount - 500n, repaymentChainId: 1, originChainId: pick(SYNTHETIC_PROTOCOL.acrossChains),
      depositId: number, fillDeadline: 2, exclusivityDeadline: 0, exclusiveRelayer: bytes32Of(ZERO), relayer: bytes32Of(address('5e', 1)),
      depositor: bytes32Of(user), recipient: bytes32Of(user), messageHash: `0x${word(0)}`,
      relayExecutionInfo: { updatedRecipient: bytes32Of(user), updatedMessageHash: `0x${word(0)}`, updatedOutputAmount: amount - 400n, fillType: r % 3 } }]);
  }
  const spoke = pick([AAVE_V4_ARC.mainSpoke, AAVE_V4_ARC.forexSpoke]);
  const reserveId = r % SYNTHETIC_PROTOCOL.aaveReserves[spoke].length;
  const aave = { reserveId, caller: address('5e', r % senderPool), user };
  const premiumDelta = { sharesDelta: -5, offsetRayDelta: 7, restoredPremiumRay: 3 };
  if (number % 41 === 0) out.push(['aaveV4', 'supply', spoke, AAVE_V4_EVENTS.supply, { ...aave, suppliedShares: amount - 1n, suppliedAmount: amount }]);
  if (number % 43 === 0) out.push(['aaveV4', 'withdraw', spoke, AAVE_V4_EVENTS.withdraw, { ...aave, withdrawnShares: amount - 1n, withdrawnAmount: amount }]);
  if (number % 47 === 0) out.push(['aaveV4', 'borrow', spoke, AAVE_V4_EVENTS.borrow, { ...aave, drawnShares: amount - 1n, drawnAmount: amount }]);
  if (number % 53 === 0) {
    out.push(['aaveV4', 'repay', spoke, AAVE_V4_EVENTS.repay, { ...aave, drawnShares: amount - 1n, totalAmountRepaid: amount + 10n, premiumDelta }]);
  }
  if (number % 577 === 0) {
    out.push(['aaveV4', 'liquidationCall', AAVE_V4_ARC.mainSpoke, AAVE_V4_EVENTS.liquidationCall, { collateralReserveId: 2, debtReserveId: 0, user,
      liquidator: address('5e', 2), receiveShares: r % 2 === 0, debtAmountRestored: amount, drawnSharesLiquidated: amount - 1n, premiumDelta,
      collateralAmountRemoved: amount / 1000n + 1n, collateralSharesLiquidated: 9, collateralSharesToLiquidator: 1 }]);
  }
  const market = pick(Object.keys(SYNTHETIC_PROTOCOL.morphoMarkets));
  const blue = { id: market, caller: address('5e', r % senderPool), onBehalf: user, receiver: user };
  if (number % 59 === 0) out.push(['morphoBlue', 'supply', MORPHO_ARC.blue, MORPHO_BLUE_EVENTS.supply, { ...blue, assets: amount, shares: amount * 10n }]);
  if (number % 61 === 0) out.push(['morphoBlue', 'withdraw', MORPHO_ARC.blue, MORPHO_BLUE_EVENTS.withdraw, { ...blue, assets: amount, shares: amount * 10n }]);
  if (number % 67 === 0) out.push(['morphoBlue', 'borrow', MORPHO_ARC.blue, MORPHO_BLUE_EVENTS.borrow, { ...blue, assets: amount, shares: amount * 10n }]);
  if (number % 79 === 0) out.push(['morphoBlue', 'repay', MORPHO_ARC.blue, MORPHO_BLUE_EVENTS.repay, { ...blue, assets: amount, shares: amount * 10n }]);
  if (number % 83 === 0) out.push(['morphoBlue', 'supplyCollateral', MORPHO_ARC.blue, MORPHO_BLUE_EVENTS.supplyCollateral, { ...blue, assets: amount }]);
  if (number % 101 === 0) out.push(['morphoBlue', 'withdrawCollateral', MORPHO_ARC.blue, MORPHO_BLUE_EVENTS.withdrawCollateral, { ...blue, assets: amount }]);
  if (number % 613 === 0) {
    out.push(['morphoBlue', 'liquidate', MORPHO_ARC.blue, MORPHO_BLUE_EVENTS.liquidate, { id: market, caller: address('5e', 3), borrower: user,
      repaidAssets: amount, repaidShares: amount * 10n, seizedAssets: amount / 100n, badDebtAssets: r % 3 === 0 ? 5n : 0n, badDebtShares: 0 }]);
  }
  if (number % 2999 === 0) {
    out.push(['morphoBlue', 'createMarket', MORPHO_ARC.blue, MORPHO_BLUE_EVENTS.createMarket, { id: SYNTHETIC_PROTOCOL.morphoCreatedMarket,
      marketParams: { loanToken: USDC_INTERFACE, collateralToken: WETH, oracle: address('0c', 1), irm: address('0d', 1), lltv: 915_000_000_000_000_000n } }]);
  }
  const vault = pick([...Object.keys(SYNTHETIC_PROTOCOL.morphoVaults), SYNTHETIC_PROTOCOL.foreignVault]);
  if (number % 37 === 0) {
    out.push(['morphoVaultsV2', 'deposit', vault, ERC4626_EVENTS.deposit, { sender: address('5e', r % senderPool), owner: user, assets: amount, shares: amount }]);
  }
  if (number % 103 === 0) {
    out.push(['morphoVaultsV2', 'withdraw', vault, ERC4626_EVENTS.withdraw, { sender: user, receiver: user, owner: user, assets: amount, shares: amount }]);
  }
  return out;
}

// View answers for the synthetic protocol contracts; undefined means "not a protocol view" (falls through to reverts).
function protocolCall(target, data) {
  for (const [spoke, reserves] of Object.entries(SYNTHETIC_PROTOCOL.aaveReserves)) {
    if (target !== spoke) continue;
    const id = reserves.findIndex((_, index) => data === encodeCall('getReserve(uint256)', [['uint256', index]]));
    if (id < 0) return { error: { code: 3, message: 'execution reverted' } };
    const [underlying, decimals] = reserves[id];
    return { result: `0x${word(BigInt(underlying))}${word(BigInt(AAVE_V4_ARC.coreHub))}${word(id)}${word(decimals)}${word(0)}${word(1)}${word(0)}` };
  }
  if (target === MORPHO_ARC.blue && data.startsWith(encodeCall('idToMarketParams(bytes32)', [['bytes32', `0x${'0'.repeat(64)}`]]).slice(0, 10))) {
    const params = SYNTHETIC_PROTOCOL.morphoMarkets[`0x${data.slice(10)}`];
    return { result: params ? `0x${word(BigInt(params[0]))}${word(BigInt(params[1]))}${word(1)}${word(2)}${word(params[2])}` : `0x${word(0).repeat(5)}` };
  }
  if (target === MORPHO_ARC.vaultV2Factory && data.startsWith(encodeCall('isVaultV2(address)', [['address', ZERO]]).slice(0, 10))) {
    return { result: `0x${word(SYNTHETIC_PROTOCOL.morphoVaults[`0x${data.slice(-40)}`] ? 1 : 0)}` };
  }
  if (data === encodeCall('asset()') && (SYNTHETIC_PROTOCOL.morphoVaults[target] || target === SYNTHETIC_PROTOCOL.foreignVault)) {
    return { result: `0x${word(BigInt(SYNTHETIC_PROTOCOL.morphoVaults[target] ?? USDC_INTERFACE))}` };
  }
  return undefined;
}

// Block spacing in 1/10,000 s: by default 0.5074 s with integer-second timestamps, so neighbours often share a second,
// like Arc. The official V3 factory has code from factoryDeployedAt, the V4 PoolManager from poolManagerDeployedAt; the
// official pool (validV3Pool) emits nothing before its PoolCreated at poolCreatedAt and swaps in that same block right after
// it. foreignV3Emitters distinct contracts emit V3-signature swaps every foreignV3Every blocks without ever appearing in a
// PoolCreated.
export function createSyntheticChain({ originNumber = 23_000_000, originTimestamp = 1_790_000_000, blockSpacing = 5074, txPerBlock = 6,
  usdcPerBlock = 10, v4PerBlock = 5, senderPool = 4000, recipientPool = 2500, assetEvery = 40, v3Every = 300,
  factoryDeployedAt = originNumber, poolManagerDeployedAt = 0, poolCreatedAt = originNumber, foreignV3Emitters = 1, foreignV3Every = v3Every,
  head = originNumber + 20_000, protocols = true, limits = {}, faults = {}, seed = 0x6d61 } = {}) {
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
    if (protocols) for (const activity of protocolActivityOf(seed, number, senderPool, recipientPool)) specs.push(['protocol', activity]);
    return specs.map(([kind, index], logIndex) => {
      const transactionIndex = Math.floor((logIndex * transactions.length) / specs.length);
      const r = rand(seed, number, 3000 + logIndex);
      const base = { blockHash: blockHash(number), blockNumber: hex(number), blockTimestamp: hex(timestampOf(number)),
        transactionHash: transactions[transactionIndex].hash, transactionIndex: hex(transactionIndex), logIndex: hex(logIndex), removed: false };
      if (kind === 'protocol') {
        // `synthetic` (non-enumerable, so never serialized into an RPC response) lets the tests count without decoding.
        const [family, event, emitter, definition, values] = index;
        const log = { ...base, address: emitter, ...encodeEventLog(definition, values) };
        return Object.defineProperty(log, 'synthetic', { value: { family, event, values }, enumerable: false });
      }
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
        const key = syntheticV4PoolKey(number);
        return { ...base, address: UNISWAP_REGISTRY.v4PoolManager.address,
          topics: [UNISWAP_EVENT_TOPICS.v4Initialize, v4PoolIdOf(key), topicOf(key.currency0), topicOf(key.currency1)],
          data: `0x${word(key.fee)}${word(key.tickSpacing)}${word(BigInt(key.hooks))}${word(1n << 96n)}${word(0)}` };
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
    const topics = filter.topics?.[0] ? new Set(filter.topics[0]) : null; // no topics: every log of the addresses
    const out = [];
    for (let number = from; number <= to; number++) {
      for (const log of logsOf(number)) {
        if ((addresses && !addresses.has(log.address)) || (topics && !topics.has(log.topics[0]))) continue;
        out.push(log);
      }
    }
    if (out.length > maxResults) return { error: { code: -32602, message: `query exceeds max results ${maxResults}` } };
    return { result: faults.logs ? faults.logs(filter, out) : out };
  }

  // Contract code by block: the V4 PoolManager and the protocol contracts always, the V3 factory from its deployment block.
  function codeAt(target, blockTag) {
    const at = /^0x[0-9a-f]+$/i.test(blockTag ?? '') ? Number(BigInt(blockTag)) : head;
    const present = (target === UNISWAP_REGISTRY.v4PoolManager.address && at >= poolManagerDeployedAt) || PROTOCOL_CODE.has(target)
      || (target === UNISWAP_REGISTRY.v3Factory.address && at >= factoryDeployedAt);
    return (faults.code ? faults.code(target, present) : present) ? '0x6080604052348015600f57600080fd5b50' : '0x';
  }

  function answer(item) {
    const envelope = (payload) => ({ jsonrpc: '2.0', id: item.id, ...payload });
    switch (item.method) {
      case 'eth_chainId': return envelope({ result: hex(ARC_CHAIN_ID) });
      case 'eth_blockNumber': return envelope({ result: hex(head) });
      case 'eth_getBlockByNumber': return envelope({ result: rawBlock(Number(BigInt(item.params[0])), item.params[1] === true) });
      case 'eth_getLogs': return envelope(getLogs(item.params[0]));
      case 'eth_getCode': return envelope({ result: codeAt(item.params[0].toLowerCase(), item.params[1]) });
      case 'eth_getTransactionByHash': {
        // Synthetic transaction hashes embed their block and index (fakeHash tag '7a').
        const hash = String(item.params[0]).toLowerCase();
        const number = Number.parseInt(hash.slice(4, 18), 16);
        const index = Number.parseInt(hash.slice(18, 26), 16);
        const found = hash.startsWith('0x7a') && transactionsOf(number)[index]?.hash === hash;
        return envelope({ result: found ? { hash, blockNumber: hex(number), transactionIndex: hex(index) } : null });
      }
      case 'eth_call': return envelope(faults.call?.(item.params[0]) ?? protocolCall(item.params[0].to.toLowerCase(), item.params[0].data.toLowerCase())
        ?? { error: { code: 3, message: 'execution reverted' } });
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
