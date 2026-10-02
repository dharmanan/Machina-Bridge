// Compact engine, Stage 3: protocol families (Circle CCTP V2, Circle Gateway, Across, Aave V4, Morpho Blue, Morpho Vault V2)
// and multi-hour windows. Offline only: a deterministic synthetic chain, no network, no server. node:sqlite store and
// runner tests run when the runtime has it (Node 22.13+); COMPACT_REQUIRE_SQLITE=1 turns its absence into a failure.
// COMPACT_SQLITE_DIR (optional) is where the temporary database directory is created; it is deleted afterwards.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AAVE_V4_EVENT_TOPICS } from '../api/_lib/arc-intelligence/aave.js';
import { MORPHO_V2_EVENT_TOPICS } from '../api/_lib/arc-intelligence/morpho.js';
import { TRANSFER_TOPIC } from '../api/_lib/arc-intelligence/usdc.js';
import { decodeResult, defineEvent, selectorOf } from '../server/compact/abi.js';
import { FAMILY_FIELDS, FAMILY_WINDOWS } from '../server/compact/families.js';
import { processHour } from '../server/compact/hour.js';
import { keccak256 } from '../server/compact/keccak.js';
import { createSyntheticChain, encodeEventLog, SYNTHETIC_PROTOCOL } from '../server/compact/offline.js';
import { AAVE_V4_ARC, AAVE_V4_EVENTS } from '../server/compact/protocols/aave.js';
import { ACROSS_EVENTS } from '../server/compact/protocols/across.js';
import { CCTP_EVENTS, CIRCLE_ARC, GATEWAY_EVENTS } from '../server/compact/protocols/circle.js';
import { PROTOCOL_FAMILIES } from '../server/compact/protocols/index.js';
import { ERC4626_EVENTS, MORPHO_ARC, MORPHO_BLUE_EVENTS } from '../server/compact/protocols/morpho.js';
import { createProvider } from '../server/compact/provider.js';
import { bootstrapV3Registry, registrySnapshot } from '../server/compact/registry.js';
import { FAMILY_VERSIONS, LOG_STREAMS } from '../server/compact/sources.js';
import { createCompactStore } from '../server/compact/store.js';
import { sumWindow, WindowError } from '../server/compact/windows.js';
import { runCompactHour } from './run-compact-hour.mjs';
import { findRecentEvent, smokeArguments, smokeProtocols, smokeRange } from './smoke-compact-protocols.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let passed = 0;
async function test(name, run) { await run(); passed += 1; console.log(`PASS ${name}`); }
const offlineProvider = (fetchImpl) => createProvider({ fetchImpl, minIntervalMs: 0, cooldownMs: 0, sleep: async () => {} });

// Two consecutive synthetic UTC hours; the chain carries every protocol family's events, code and views.
const HOUR = 1_790_006_400;
const ORIGIN = { originNumber: 23_000_000, originTimestamp: HOUR - 1000 };
const SAFE_HEAD = ORIGIN.originNumber + 25_000;
const chainOf = (options = {}) => createSyntheticChain({ ...ORIGIN, poolCreatedAt: 23_002_500, ...options });
const V3 = registrySnapshot(await bootstrapV3Registry(offlineProvider(chainOf().fetchImpl), { fromBlock: ORIGIN.originNumber, toBlock: SAFE_HEAD }));
const run = (options = {}, hourStart = HOUR) => processHour({ provider: offlineProvider(chainOf(options).fetchImpl), hourStart, safeHead: SAFE_HEAD,
  v3Registry: V3 });
const clean = await run();
const next = await run({}, HOUR + 3600);
const chain = chainOf();
const NAMES = PROTOCOL_FAMILIES.map((family) => family.name);
assert(clean.complete && next.complete, 'every family is available on the clean synthetic chain');

// Independent reference: the generator's own event values (non-enumerable `synthetic` on each log), no decoder involved.
const toAddress = (bytes32) => `0x${bytes32.slice(-40)}`;
function finalize(value) {
  if (typeof value === 'bigint') return value.toString(10);
  if (value instanceof Set) return value.size;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, finalize(item)]));
  return value;
}
function protocolReference(first, last) {
  const cctp = { outboundTransferCount: 0, outboundAmountRaw: 0n, outboundByDestinationDomain: {}, uniqueOutboundSenders: new Set(), inboundMintCount: 0,
    inboundAmountRaw: 0n, inboundFeeCollectedRaw: 0n, uniqueInboundRecipients: new Set(), messageReceivedCount: 0, messagesBySourceDomain: {} };
  const gateway = { depositCount: 0, depositAmountRaw: 0n, uniqueDepositors: new Set(), outboundBurnCount: 0, outboundBurnAmountRaw: 0n,
    outboundBurnFeeRaw: 0n, outboundByDestinationDomain: {}, inboundMintCount: 0, inboundMintAmountRaw: 0n, inboundBySourceDomain: {},
    uniqueInboundRecipients: new Set(), withdrawalInitiatedCount: 0, withdrawalCompletedCount: 0, withdrawalAmountRaw: 0n };
  const across = { depositCount: 0, depositByToken: {}, depositByDestinationChain: {}, uniqueDepositors: new Set(), fillCount: 0, slowFillCount: 0,
    fillByToken: {}, fillByOriginChain: {}, uniqueFillRecipients: new Set() };
  const aaveV4 = { supplyCount: 0, withdrawCount: 0, borrowCount: 0, repayCount: 0, liquidationCount: 0, uniqueUsers: new Set(), reserves: {} };
  const morphoBlue = { supplyCount: 0, withdrawCount: 0, borrowCount: 0, repayCount: 0, supplyCollateralCount: 0, withdrawCollateralCount: 0,
    liquidationCount: 0, marketCreatedCount: 0, uniqueAccounts: new Set(), markets: {} };
  const emitters = new Map();
  const transfer = (map, key, amount) => { const entry = map[key] ??= { transferCount: 0, amountRaw: 0n }; entry.transferCount += 1; entry.amountRaw += BigInt(amount); };
  const reserve = (spoke, id) => aaveV4.reserves[`${spoke}:${id}`] ??= { spoke, reserveId: String(id), underlying: SYNTHETIC_PROTOCOL.aaveReserves[spoke][id][0],
    decimals: SYNTHETIC_PROTOCOL.aaveReserves[spoke][id][1], suppliedRaw: 0n, withdrawnRaw: 0n, borrowedRaw: 0n, repaidRaw: 0n, liquidatedDebtRaw: 0n,
    liquidatedCollateralRaw: 0n };
  const market = (id) => morphoBlue.markets[id] ??= { loanToken: SYNTHETIC_PROTOCOL.morphoMarkets[id][0], collateralToken: SYNTHETIC_PROTOCOL.morphoMarkets[id][1],
    lltv: SYNTHETIC_PROTOCOL.morphoMarkets[id][2].toString(10), suppliedRaw: 0n, withdrawnRaw: 0n, borrowedRaw: 0n, repaidRaw: 0n, collateralSuppliedRaw: 0n,
    collateralWithdrawnRaw: 0n, liquidationRepaidRaw: 0n, liquidationSeizedRaw: 0n, badDebtRaw: 0n };
  for (let number = first; number <= last; number++) {
    const transactions = chain.transactionsOf(number);
    for (const log of chain.logsOf(number)) {
      if (!log.synthetic) continue;
      const { family, event, values: v } = log.synthetic;
      const from = transactions[Number(log.transactionIndex)].from;
      switch (`${family}.${event}`) {
        case 'cctp.depositForBurn': cctp.outboundTransferCount += 1; cctp.outboundAmountRaw += BigInt(v.amount);
          transfer(cctp.outboundByDestinationDomain, String(v.destinationDomain), v.amount); cctp.uniqueOutboundSenders.add(from); break;
        case 'cctp.mintAndWithdraw': cctp.inboundMintCount += 1; cctp.inboundAmountRaw += BigInt(v.amount); cctp.inboundFeeCollectedRaw += BigInt(v.feeCollected);
          cctp.uniqueInboundRecipients.add(v.mintRecipient); break;
        case 'cctp.messageReceived': cctp.messageReceivedCount += 1;
          (cctp.messagesBySourceDomain[String(v.sourceDomain)] ??= { messageCount: 0 }).messageCount += 1; break;
        case 'gateway.deposited': gateway.depositCount += 1; gateway.depositAmountRaw += BigInt(v.value); gateway.uniqueDepositors.add(v.depositor); break;
        case 'gateway.gatewayBurned': gateway.outboundBurnCount += 1; gateway.outboundBurnAmountRaw += BigInt(v.value); gateway.outboundBurnFeeRaw += BigInt(v.fee);
          transfer(gateway.outboundByDestinationDomain, String(v.destinationDomain), v.value); break;
        case 'gateway.attestationUsed': gateway.inboundMintCount += 1; gateway.inboundMintAmountRaw += BigInt(v.value);
          transfer(gateway.inboundBySourceDomain, String(v.sourceDomain), v.value); gateway.uniqueInboundRecipients.add(v.recipient); break;
        case 'gateway.withdrawalInitiated': gateway.withdrawalInitiatedCount += 1; break;
        case 'gateway.withdrawalCompleted': gateway.withdrawalCompletedCount += 1; gateway.withdrawalAmountRaw += BigInt(v.value); break;
        case 'across.fundsDeposited': {
          across.depositCount += 1;
          const token = across.depositByToken[toAddress(v.inputToken)] ??= { depositCount: 0, inputAmountRaw: 0n };
          token.depositCount += 1; token.inputAmountRaw += BigInt(v.inputAmount);
          (across.depositByDestinationChain[String(v.destinationChainId)] ??= { depositCount: 0 }).depositCount += 1;
          across.uniqueDepositors.add(toAddress(v.depositor)); break;
        }
        case 'across.filledRelay': {
          across.fillCount += 1;
          if (v.relayExecutionInfo.fillType === 2) across.slowFillCount += 1;
          const token = across.fillByToken[toAddress(v.outputToken)] ??= { fillCount: 0, outputAmountRaw: 0n };
          token.fillCount += 1; token.outputAmountRaw += BigInt(v.relayExecutionInfo.updatedOutputAmount);
          (across.fillByOriginChain[String(v.originChainId)] ??= { fillCount: 0 }).fillCount += 1;
          across.uniqueFillRecipients.add(toAddress(v.relayExecutionInfo.updatedRecipient)); break;
        }
        case 'aaveV4.supply': aaveV4.supplyCount += 1; reserve(log.address, v.reserveId).suppliedRaw += BigInt(v.suppliedAmount); aaveV4.uniqueUsers.add(v.user); break;
        case 'aaveV4.withdraw': aaveV4.withdrawCount += 1; reserve(log.address, v.reserveId).withdrawnRaw += BigInt(v.withdrawnAmount); aaveV4.uniqueUsers.add(v.user); break;
        case 'aaveV4.borrow': aaveV4.borrowCount += 1; reserve(log.address, v.reserveId).borrowedRaw += BigInt(v.drawnAmount); aaveV4.uniqueUsers.add(v.user); break;
        case 'aaveV4.repay': aaveV4.repayCount += 1; reserve(log.address, v.reserveId).repaidRaw += BigInt(v.totalAmountRepaid); aaveV4.uniqueUsers.add(v.user); break;
        case 'aaveV4.liquidationCall': aaveV4.liquidationCount += 1; aaveV4.uniqueUsers.add(v.user);
          reserve(log.address, v.debtReserveId).liquidatedDebtRaw += BigInt(v.debtAmountRestored);
          reserve(log.address, v.collateralReserveId).liquidatedCollateralRaw += BigInt(v.collateralAmountRemoved); break;
        case 'morphoBlue.supply': morphoBlue.supplyCount += 1; market(v.id).suppliedRaw += BigInt(v.assets); morphoBlue.uniqueAccounts.add(v.onBehalf); break;
        case 'morphoBlue.withdraw': morphoBlue.withdrawCount += 1; market(v.id).withdrawnRaw += BigInt(v.assets); morphoBlue.uniqueAccounts.add(v.onBehalf); break;
        case 'morphoBlue.borrow': morphoBlue.borrowCount += 1; market(v.id).borrowedRaw += BigInt(v.assets); morphoBlue.uniqueAccounts.add(v.onBehalf); break;
        case 'morphoBlue.repay': morphoBlue.repayCount += 1; market(v.id).repaidRaw += BigInt(v.assets); morphoBlue.uniqueAccounts.add(v.onBehalf); break;
        case 'morphoBlue.supplyCollateral': morphoBlue.supplyCollateralCount += 1; market(v.id).collateralSuppliedRaw += BigInt(v.assets);
          morphoBlue.uniqueAccounts.add(v.onBehalf); break;
        case 'morphoBlue.withdrawCollateral': morphoBlue.withdrawCollateralCount += 1; market(v.id).collateralWithdrawnRaw += BigInt(v.assets);
          morphoBlue.uniqueAccounts.add(v.onBehalf); break;
        case 'morphoBlue.liquidate': {
          morphoBlue.liquidationCount += 1;
          const entry = market(v.id);
          entry.liquidationRepaidRaw += BigInt(v.repaidAssets); entry.liquidationSeizedRaw += BigInt(v.seizedAssets); entry.badDebtRaw += BigInt(v.badDebtAssets);
          morphoBlue.uniqueAccounts.add(v.borrower); break;
        }
        case 'morphoBlue.createMarket': morphoBlue.marketCreatedCount += 1; break;
        default: {
          const emitter = emitters.get(log.address) ?? { depositCount: 0, withdrawCount: 0, deposited: 0n, withdrawn: 0n, events: 0, owners: new Set() };
          emitters.set(log.address, emitter);
          emitter.events += 1;
          if (event === 'deposit') { emitter.depositCount += 1; emitter.deposited += BigInt(v.assets); } else { emitter.withdrawCount += 1; emitter.withdrawn += BigInt(v.assets); }
          emitter.owners.add(v.owner);
        }
      }
    }
  }
  const official = [...emitters].filter(([address]) => SYNTHETIC_PROTOCOL.morphoVaults[address]);
  const foreign = [...emitters].filter(([address]) => !SYNTHETIC_PROTOCOL.morphoVaults[address]);
  const morphoVaultsV2 = { depositCount: official.reduce((sum, [, e]) => sum + e.depositCount, 0), withdrawCount: official.reduce((sum, [, e]) => sum + e.withdrawCount, 0),
    uniqueOwners: new Set(official.flatMap(([, e]) => [...e.owners])), foreignEmitterCount: foreign.length,
    foreignEventCount: foreign.reduce((sum, [, e]) => sum + e.events, 0),
    vaults: Object.fromEntries(official.map(([address, e]) => [address, { asset: SYNTHETIC_PROTOCOL.morphoVaults[address], depositCount: e.depositCount,
      withdrawCount: e.withdrawCount, depositedAssetsRaw: e.deposited, withdrawnAssetsRaw: e.withdrawn }])) };
  return finalize({ cctp, gateway, across, aaveV4, morphoBlue, morphoVaultsV2 });
}

const blockOf = (target) => {
  let number = ORIGIN.originNumber + Math.floor(((target - ORIGIN.originTimestamp) * 10000) / 5074) - 5;
  while (chain.timestampOf(number) >= target) number -= 1;
  while (chain.timestampOf(number) < target) number += 1;
  return number;
};
const [first0, first1, first2] = [blockOf(HOUR), blockOf(HOUR + 3600), blockOf(HOUR + 7200)];
const metricsOf = (family, name) => Object.fromEntries(FAMILY_FIELDS[name].map((field) => [field, family[field]]));

// The named family unavailable with that reason and every field null; everything else exactly as in the clean hour.
function assertOnly(result, name, reason, baseline = clean) {
  assert.equal(result.families[name].status, 'unavailable', name);
  assert.equal(result.families[name].reason, reason, name);
  for (const field of FAMILY_FIELDS[name]) assert.equal(result.families[name][field], null, `${name}.${field} must be null, never zero`);
  for (const other of Object.keys(result.families).filter((key) => key !== name)) assert.deepEqual(result.families[other], baseline.families[other], other);
  assert.deepEqual(result.network, baseline.network);
  assert.equal(result.complete, false);
}

// Corrupts the first protocol log of `family` that `match` accepts, in whatever stream response carries it.
function corruptFirst(family, change, match = () => true) {
  let done = false;
  return { logs: (_filter, logs) => logs.map((log) => {
    if (done || log.synthetic?.family !== family || !match(log)) return log;
    done = true;
    return change(log);
  }) };
}
const streamOf = (family) => LOG_STREAMS.find((stream) => stream.key === PROTOCOL_FAMILIES.find((item) => item.name === family).streams[0].key);
const failStream = (family) => ({ request: (body) => {
  const stream = streamOf(family);
  const filter = !Array.isArray(body) && body.method === 'eth_getLogs' ? body.params[0] : null;
  return filter && (filter.address?.[0] ?? null) === (stream.address?.[0] ?? null) && filter.topics[0][0] === stream.topics[0]
    ? { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'header not found' } } : undefined;
} });

await test('abi: keccak and every protocol topic and selector match independent references', async () => {
  assert.equal(keccak256(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(defineEvent('event Transfer(address indexed from, address indexed to, uint256 value)').topic, TRANSFER_TOPIC);
  // A2 recorded these topics for Aave V4 and ERC-4626 (api/_lib/arc-intelligence/aave.js, morpho.js).
  for (const kind of ['supply', 'withdraw', 'borrow', 'repay', 'liquidationCall']) assert.equal(AAVE_V4_EVENTS[kind].topic, AAVE_V4_EVENT_TOPICS[kind], kind);
  assert.deepEqual([ERC4626_EVENTS.deposit.topic, ERC4626_EVENTS.withdraw.topic], [MORPHO_V2_EVENT_TOPICS.deposit, MORPHO_V2_EVENT_TOPICS.withdraw]);
  // viem-derived on 2026-10-02 from A2's parsed ABIs (cctp.js, gateway.js, p1b-registry.js depend on viem, so they are not imported).
  const viemTopics = {
    depositForBurn: '0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5', mintAndWithdraw: '0x50c55e915134d457debfa58eb6f4342956f8b0616d51a89a3659360178e1ab63',
    messageReceived: '0xff48c13eda96b1cceacc6b9edeedc9e9db9d6226afbc30146b720c19d3addb1c', deposited: '0x4174a9435a04d04d274c76779cad136a41fde6937c56241c09ab9d3c7064a1a9',
    gatewayBurned: '0x12ee2719e7e2dec9f2a0041286b66669153dff0d36719f692b8bbaa4dfe0aa87', attestationUsed: '0xbb312ce0cc311b2cb0746e09ccd2f91fdb9e2ac755d2f11c65300eb0d0fffd63',
    withdrawalInitiated: '0x5f9a559874d8abe05a98d167b78d2012697505ea3e7bcdba906e7b6084014c65', withdrawalCompleted: '0xb00382203b46c3b6ad0a2d7af0268e334bd9406256a7c7ba8f7fc8bc47f8cde9',
    fundsDeposited: '0x32ed1a409ef04c7b0227189c3a103dc5ac10e775a15b785dcc510201f7c25ad3', filledRelay: '0x44b559f101f8fbcc8a0ea43fa91a05a729a5ea6e14a7c75aa750374690137208',
  };
  for (const [kind, topic] of Object.entries(viemTopics)) assert.equal((CCTP_EVENTS[kind] ?? GATEWAY_EVENTS[kind] ?? ACROSS_EVENTS[kind]).topic, topic, kind);
  // Morpho Blue's published on-chain topics (EventsLib), independent of these signatures.
  const blue = { supply: '0xedf8870433c83823eb071d3df1caa8d008f12f6440918c20d75a3602cda30fe0', withdraw: '0xa56fc0ad5702ec05ce63666221f796fb62437c32db1aa1aa075fc6484cf58fbf',
    borrow: '0x570954540bed6b1304a87dfe815a5eda4a648f7097a16240dcd85c9b5fd42a43', repay: '0x52acb05cebbd3cd39715469f22afbf5a17496295ef3bc9bb5944056c63ccaa09',
    supplyCollateral: '0xa3b9472a1399e17e123f3c2e6586c23e504184d504de59cdaa2b375e880c6184', withdrawCollateral: '0xe80ebd7cc9223d7382aab2e0d1d6155c65651f83d53c8b9b06901d167e321142',
    liquidate: '0xa4946ede45d0c6f06a0f5ce92c9ad3b4751452d2fe0e25010783bcab57a67e41', createMarket: '0xac4b2400f169220b0c0afdde7a0b32e775ba727ea1cb30b35f935cdaab8683ac' };
  for (const [kind, topic] of Object.entries(blue)) assert.equal(MORPHO_BLUE_EVENTS[kind].topic, topic, kind);
  assert.deepEqual(['getReserve(uint256)', 'isVaultV2(address)', 'asset()', 'idToMarketParams(bytes32)'].map(selectorOf),
    ['0x77778db3', '0x5edec50d', '0x38d52e0f', '0x2c3c9157']);
});

await test('abi: decoding accepts canonical encodings only and never returns a partial value', async () => {
  const values = { burnToken: CIRCLE_ARC.usdc, amount: 5n, depositor: `0x${'11'.repeat(20)}`, mintRecipient: `0x${'22'.repeat(32)}`, destinationDomain: 6,
    destinationTokenMessenger: `0x${'33'.repeat(32)}`, destinationCaller: `0x${'0'.repeat(64)}`, maxFee: 1, minFinalityThreshold: 2000, hookData: '0xdeadbeef' };
  const log = encodeEventLog(CCTP_EVENTS.depositForBurn, values);
  const decoded = CCTP_EVENTS.depositForBurn.decode(log);
  assert.deepEqual([decoded.amount, decoded.destinationDomain, decoded.depositor, decoded.hookData], [5n, 6n, values.depositor, { byteLength: 4 }]);
  const words = log.data.slice(2).match(/.{64}/g);
  const data = (list) => `0x${list.join('')}`;
  for (const [label, broken] of [
    ['dirty address topic', { ...log, topics: [log.topics[0], `0x${'ff'.repeat(32)}`, ...log.topics.slice(2)] }],
    ['missing topic', { ...log, topics: log.topics.slice(0, 3) }],
    ['extra topic', { ...log, topics: [...log.topics, log.topics[1]] }],
    ['uint32 out of range', { ...log, data: data(words.map((word, index) => (index === 2 ? 'f'.repeat(64) : word))) }],
    // Data words: amount, mintRecipient, destinationDomain, destinationTokenMessenger, destinationCaller, maxFee, hookData offset | length, content.
    ['non-canonical bytes offset', { ...log, data: data(words.map((word, index) => (index === 6 ? (BigInt(`0x${word}`) + 32n).toString(16).padStart(64, '0') : word))) }],
    ['bytes length past the data', { ...log, data: data(words.map((word, index) => (index === 7 ? (BigInt(`0x${word}`) + 32n).toString(16).padStart(64, '0') : word))) }],
    ['trailing word', { ...log, data: `${log.data}${'0'.repeat(64)}` }],
    ['dirty padding', { ...log, data: `${log.data.slice(0, -2)}01` }],
    ['truncated', { ...log, data: log.data.slice(0, -64) }],
  ]) assert.equal(CCTP_EVENTS.depositForBurn.decode(broken), null, label);
  assert.equal(decodeResult(['address'], `0x${'ff'.repeat(32)}`), null, 'a dirty address word in a view result');
  assert.equal(decodeResult(['bool'], `0x${'0'.repeat(63)}2`), null, 'a bool that is neither 0 nor 1');
});

await test('protocol families equal an independent count of the synthetic chain, in two consecutive hours', async () => {
  for (const [result, first, last] of [[clean, first0, first1 - 1], [next, first1, first2 - 1]]) {
    const expected = protocolReference(first, last);
    for (const name of NAMES) assert.deepEqual(metricsOf(result.families[name], name), expected[name], name);
  }
  const reference = protocolReference(first0, first1 - 1);
  assert(NAMES.every((name) => Object.values(reference[name]).some((value) => value !== 0 && value !== '0')), 'every family has activity');
  assert(reference.across.slowFillCount > 0 && reference.morphoVaultsV2.foreignEventCount > 0 && reference.aaveV4.liquidationCount > 0
    && reference.morphoBlue.liquidationCount > 0 && reference.gateway.outboundByDestinationDomain['26'], 'the fixture exercises the edge cases');
});

await test('no double counting: lifecycle events of one flow are counted once and never summed across families', async () => {
  const events = (family, event) => Array.from({ length: first1 - first0 }, (_, index) => chain.logsOf(first0 + index)).flat()
    .filter((log) => log.synthetic?.family === family && log.synthetic.event === event).length;
  const { cctp, gateway, across, morphoBlue, morphoVaultsV2 } = clean.families;
  assert.deepEqual([cctp.outboundTransferCount, cctp.inboundMintCount, cctp.messageReceivedCount],
    [events('cctp', 'depositForBurn'), events('cctp', 'mintAndWithdraw'), events('cctp', 'messageReceived')],
    'a mint and its message envelope arrive together; transfers count mints, messages count envelopes');
  assert.equal(Object.values(cctp.outboundByDestinationDomain).reduce((sum, item) => sum + item.transferCount, 0), cctp.outboundTransferCount);
  assert.equal(gateway.withdrawalCompletedCount, events('gateway', 'withdrawalCompleted'));
  assert.equal(gateway.withdrawalInitiatedCount, events('gateway', 'withdrawalInitiated'), 'initiations are counted, never added to the amount');
  assert.equal(across.fillCount, events('across', 'filledRelay'), 'slow fills are fills, counted once');
  assert(across.slowFillCount < across.fillCount);
  assert.equal(morphoBlue.marketCreatedCount, events('morphoBlue', 'createMarket'));
  assert.equal(morphoVaultsV2.depositCount + morphoVaultsV2.withdrawCount + morphoVaultsV2.foreignEventCount,
    events('morphoVaultsV2', 'deposit') + events('morphoVaultsV2', 'withdraw'), 'every ERC-4626 event is either official or foreign, never both');
});

await test('official emitters only: a foreign address is refused, a cross-contract event is refused, a foreign vault is ignored', async () => {
  const foreign = `0x${'de'.repeat(20)}`;
  const injected = await run({ faults: { logs: (filter, logs) => (filter.address?.[0] === CIRCLE_ARC.tokenMessenger && logs.length
    ? [...logs, { ...logs[0], address: foreign }] : logs) } });
  assertOnly(injected, 'cctp', 'unexpected_log_address');
  const crossed = await run({ faults: corruptFirst('cctp', (log) => ({ ...log, address: CIRCLE_ARC.tokenMessenger }), (log) => log.synthetic.event === 'messageReceived') });
  assertOnly(crossed, 'cctp', 'unexpected_cctp_emitter');
  const crossedGateway = await run({ faults: corruptFirst('gateway', (log) => ({ ...log, address: CIRCLE_ARC.gatewayMinter }), (log) => log.synthetic.event === 'deposited') });
  assertOnly(crossedGateway, 'gateway', 'unexpected_gateway_emitter');
  const spoke = await run({ faults: { logs: (filter, logs) => (filter.address?.[0] === AAVE_V4_ARC.mainSpoke && logs.length
    ? [...logs, { ...logs[0], address: foreign }] : logs) } });
  assertOnly(spoke, 'aaveV4', 'unexpected_log_address');
  assert(clean.families.morphoVaultsV2.foreignEmitterCount === 1 && !(SYNTHETIC_PROTOCOL.foreignVault in clean.families.morphoVaultsV2.vaults));
  const brokenForeign = await run({ faults: corruptFirst('morphoVaultsV2', (log) => ({ ...log, data: `${log.data}00` }), (log) => log.address === SYNTHETIC_PROTOCOL.foreignVault) });
  assert.deepEqual(brokenForeign, clean, 'a malformed event from a foreign ERC-4626 emitter is ignored');
});

await test('malformed events make exactly that family unavailable, never zero', async () => {
  for (const [name, reason] of [['cctp', 'malformed_cctp_event'], ['gateway', 'malformed_gateway_event'], ['across', 'malformed_across_event'],
    ['aaveV4', 'malformed_aave_event'], ['morphoBlue', 'malformed_morpho_blue_event'], ['morphoVaultsV2', 'malformed_morpho_vault_event']]) {
    const official = name !== 'morphoVaultsV2' || ((log) => SYNTHETIC_PROTOCOL.morphoVaults[log.address]);
    assertOnly(await run({ faults: corruptFirst(name, (log) => ({ ...log, data: `${log.data}00` }), official === true ? undefined : official) }), name, reason);
  }
  const fillType = await run({ faults: corruptFirst('across', (log) => {
    const words = log.data.slice(2).match(/.{64}/g);
    words[words.length - 1] = '3'.padStart(64, '0'); // relayExecutionInfo.fillType 3 does not exist
    return { ...log, data: `0x${words.join('')}` };
  }, (log) => log.synthetic.event === 'filledRelay') });
  assertOnly(fillType, 'across', 'malformed_across_event');
});

await test('a provider failure on one protocol stream makes only that family unavailable', async () => {
  for (const name of NAMES) assertOnly(await run({ faults: failStream(name) }), name, 'rpc_error');
});

await test('official code and view reads fail closed: no code, a reverted or lagging view, a foreign hub', async () => {
  for (const { name, codeAddresses } of PROTOCOL_FAMILIES) {
    const reason = { cctp: 'cctp_code_unverified', gateway: 'gateway_code_unverified', across: 'across_code_unverified', aaveV4: 'aave_code_unverified',
      morphoBlue: 'morpho_blue_code_unverified', morphoVaultsV2: 'morpho_vault_factory_code_unverified' }[name];
    assertOnly(await run({ faults: { code: (target, present) => target !== codeAddresses.at(-1) && present } }), name, reason);
  }
  const revert = { error: { code: 3, message: 'execution reverted' } };
  const lagging = { error: { code: -32000, message: 'header not found' } };
  assertOnly(await run({ faults: { call: ({ to }) => (to === AAVE_V4_ARC.forexSpoke ? revert : undefined) } }), 'aaveV4', 'aave_reserve_unresolved');
  const word = (value) => value.slice(2).padStart(64, '0');
  const foreignHub = `0x${word(CIRCLE_ARC.usdc)}${word(`0x${'ab'.repeat(20)}`)}${'0'.repeat(64)}${word('0x6')}${'0'.repeat(192)}`;
  assertOnly(await run({ faults: { call: ({ to }) => (to === AAVE_V4_ARC.mainSpoke ? { result: foreignHub } : undefined) } }), 'aaveV4', 'aave_reserve_unresolved');
  assertOnly(await run({ faults: { call: ({ to }) => (to === MORPHO_ARC.blue ? lagging : undefined) } }), 'morphoBlue', 'morpho_market_unresolved');
  assertOnly(await run({ faults: { call: ({ to }) => (to === MORPHO_ARC.blue ? { result: `0x${'0'.repeat(320)}` } : undefined) } }), 'morphoBlue',
    'morpho_market_unresolved');
  assertOnly(await run({ faults: { call: ({ to }) => (to === MORPHO_ARC.vaultV2Factory ? lagging : undefined) } }), 'morphoVaultsV2',
    'morpho_vault_verification_unavailable');
  assertOnly(await run({ faults: { call: ({ data }) => (data === selectorOf('asset()') ? lagging : undefined) } }), 'morphoVaultsV2', 'morpho_vault_asset_unavailable');
});

await test('unexpected tokens and non-EVM addresses fail closed instead of mixing units', async () => {
  const eurcTopic = `0x${'0'.repeat(24)}${'bef5f6d51cb62b58e6a8f77868681825c6fe21c1'}`;
  assertOnly(await run({ faults: corruptFirst('cctp', (log) => ({ ...log, topics: [log.topics[0], eurcTopic, ...log.topics.slice(2)] }),
    (log) => log.synthetic.event === 'depositForBurn') }), 'cctp', 'cctp_unexpected_token');
  assertOnly(await run({ faults: corruptFirst('gateway', (log) => ({ ...log, topics: [log.topics[0], eurcTopic, ...log.topics.slice(2)] })) }), 'gateway',
    'gateway_unexpected_token');
  assertOnly(await run({ faults: corruptFirst('across', (log) => ({ ...log, data: `0x${'ff'.repeat(32)}${log.data.slice(66)}` }),
    (log) => log.synthetic.event === 'fundsDeposited') }), 'across', 'across_non_evm_address');
});

await test('determinism: any window size or per-response split gives byte-identical protocol families', async () => {
  for (const options of [{ windowBlocks: 50 }, { windowBlocks: 1000 }, { limits: { maxRange: 120 } }]) {
    const result = await processHour({ provider: offlineProvider(chainOf(options.limits ? { limits: options.limits } : {}).fetchImpl), hourStart: HOUR,
      safeHead: SAFE_HEAD, v3Registry: V3, ...(options.windowBlocks ? { windowBlocks: options.windowBlocks } : {}) });
    assert.equal(digest(result), digest(clean), JSON.stringify(options));
  }
});

await test('windows: counts, raw amounts and keyed tallies add up across hours; unique counts are never summed', async () => {
  const combined = protocolReference(first0, first2 - 1);
  const pick = (source, spec) => {
    const out = {};
    for (const field of [...(spec.counts ?? []), ...(spec.amounts ?? []), ...(spec.constants ?? [])]) out[field] = source[field];
    for (const [field, tally] of Object.entries(spec.tallies ?? {})) out[field] = Object.fromEntries(Object.entries(source[field]).map(([key, entry]) => [key, pick(entry, tally)]));
    return out;
  };
  for (const name of NAMES) {
    const summed = sumWindow(FAMILY_WINDOWS[name], [clean.families[name], next.families[name]]);
    assert.deepEqual(summed, pick(combined[name], FAMILY_WINDOWS[name]), name);
    for (const field of FAMILY_FIELDS[name].filter((key) => /^unique/.test(key))) assert.equal(field in summed, false, `${name}.${field} is not additive`);
  }
  // The Stage 1/2 families too, against plain arithmetic on the two hours.
  const usdc = sumWindow(FAMILY_WINDOWS.usdc, [clean.families.usdc, next.families.usdc]);
  assert.deepEqual(usdc, { transferCount: clean.families.usdc.transferCount + next.families.usdc.transferCount, mintCount: clean.families.usdc.mintCount
    + next.families.usdc.mintCount, burnCount: clean.families.usdc.burnCount + next.families.usdc.burnCount, rawDecimals: 18,
  amountRaw: (BigInt(clean.families.usdc.amountRaw) + BigInt(next.families.usdc.amountRaw)).toString(10) });
  const eurc = sumWindow(FAMILY_WINDOWS.assets, [clean.families.assets, next.families.assets]).items.find((item) => item.symbol === 'EURC');
  assert.equal(eurc.transferCount, clean.families.assets.items.find((item) => item.symbol === 'EURC').transferCount
    + next.families.assets.items.find((item) => item.symbol === 'EURC').transferCount);
  assert.equal(sumWindow(FAMILY_WINDOWS.uniswapV4, [clean.families.uniswapV4, next.families.uniswapV4]).swapCount,
    clean.families.uniswapV4.swapCount + next.families.uniswapV4.swapCount);
  const moved = structuredClone(next.families.aaveV4);
  Object.values(moved.reserves)[0].underlying = `0x${'ab'.repeat(20)}`;
  assert.throws(() => sumWindow(FAMILY_WINDOWS.aaveV4, [clean.families.aaveV4, moved]), (error) => error instanceof WindowError
    && error.code === 'window_constant_mismatch', 'a reserve whose token changed between hours is never summed');
});

// The live protocol smoke (scripts/smoke-compact-protocols.mjs), exercised offline on the same code path.
const quiet = () => {};
const smokeFrom = first0 + 100;
const smokeTo = first0 + 1599;

await test('live smoke, offline: real decoding is PASS, no activity is NO_ACTIVITY (never a pass), any failure is FAIL with its reason', async () => {
  const all = await smokeProtocols({ provider: offlineProvider(chainOf().fetchImpl), from: smokeFrom, to: smokeTo, print: quiet });
  assert.deepEqual([all.exitCode, all.verdicts.map((item) => item.verdict)], [0, NAMES.map(() => 'PASS')]);
  assert(Object.values(all.census).every((byTopic) => Object.keys(byTopic).length && Object.keys(byTopic).every((key) => key.startsWith('counted '))),
    'the official contracts emit only counted topics here');
  assert.deepEqual(Object.keys(all.overlaps), NAMES, 'same-transaction event kinds are reported per family');
  assert(Object.values(all.overlaps).every((combos) => Object.keys(combos).every((combo) => combo.split('+').length > 1)));
  const idle = await smokeProtocols({ provider: offlineProvider(chainOf({ protocols: false }).fetchImpl), from: smokeFrom, to: smokeTo, print: quiet });
  assert.deepEqual([idle.exitCode, idle.verdicts.map((item) => item.verdict)], [2, NAMES.map(() => 'NO_ACTIVITY')]);
  assert(idle.verdicts.every((item) => item.reason.includes('decoder not verified')));
  const lines = [];
  const failing = await smokeProtocols({ provider: offlineProvider(chainOf({ faults: failStream('aaveV4') }).fetchImpl), from: smokeFrom, to: smokeTo,
    print: (text) => lines.push(text) });
  assert.equal(failing.exitCode, 1);
  assert.deepEqual(failing.verdicts.find((item) => item.family === 'aaveV4'), { family: 'aaveV4', verdict: 'FAIL', reason: 'rpc_error', decoded: null });
  assert(failing.verdicts.filter((item) => item.family !== 'aaveV4').every((item) => item.verdict === 'PASS'), 'the other families are unaffected');
  assert(lines.at(-1).startsWith('RESULT FAIL aaveV4'));
  const malformed = await smokeProtocols({ provider: offlineProvider(chainOf({ faults: corruptFirst('morphoBlue', (log) => ({ ...log, data: `${log.data}00` })) }).fetchImpl),
    from: smokeFrom, to: smokeTo, print: quiet });
  assert.deepEqual(malformed.verdicts.find((item) => item.family === 'morphoBlue').reason, 'malformed_morpho_blue_event');
  const gap = await smokeProtocols({ provider: offlineProvider(chainOf({ faults: { block: (n, raw, full) => (full && n === smokeFrom + 10 ? null : raw) } }).fetchImpl),
    from: smokeFrom, to: smokeTo, print: quiet });
  assert(gap.exitCode === 1 && gap.verdicts.every((item) => item.verdict === 'FAIL' && item.reason === 'range_unavailable:missing_block'));
  const unknownTopic = `0x${'99'.repeat(32)}`;
  const renamed = await smokeProtocols({ provider: offlineProvider(chainOf({ faults: { logs: (filter, logs) => (!filter.topics && logs.length
    ? [...logs, { ...logs[0], topics: [unknownTopic] }] : logs) } }).fetchImpl), from: smokeFrom, to: smokeTo, print: quiet });
  assert(Object.values(renamed.census).some((byTopic) => byTopic[`unknown ${unknownTopic}`] === 1), 'an event the definitions do not know is listed');
});

await test('live smoke ranges: --tx and --find locate one event with a bounded number of requests; nothing past the safe head', async () => {
  const synthetic = chainOf();
  const safeHead = ORIGIN.originNumber + 20_000 - 200; // the synthetic head minus the smoke margin
  assert.deepEqual(await smokeRange(offlineProvider(synthetic.fetchImpl), smokeArguments([])), [safeHead - 1499, safeHead]);
  const transaction = synthetic.transactionsOf(first0 + 5)[0].hash;
  assert.deepEqual(await smokeRange(offlineProvider(synthetic.fetchImpl), smokeArguments([`--tx=${transaction}`])), [first0 + 3, first0 + 7]);
  await assert.rejects(smokeRange(offlineProvider(synthetic.fetchImpl), smokeArguments([`--tx=0x7a${'0'.repeat(62)}`])), /transaction_not_found/);
  await assert.rejects(smokeRange(offlineProvider(synthetic.fetchImpl), smokeArguments(['--from=1', `--to=${safeHead + 1}`])), /range_not_completed/);
  await assert.rejects(smokeRange(offlineProvider(synthetic.fetchImpl), smokeArguments(['--blocks=5001'])), /invalid_block_count/);
  for (const argv of [['--blocks=10', `--tx=${transaction}`], ['--nope=1'], ['--tx=0x12'], ['--find=uniswapV3']]) assert.throws(() => smokeArguments(argv), String(argv));
  let newest = safeHead;
  while (!synthetic.logsOf(newest).some((log) => log.synthetic?.family === 'aaveV4')) newest -= 1;
  const provider = offlineProvider(synthetic.fetchImpl);
  const found = await findRecentEvent(provider, 'aaveV4', safeHead, 6);
  assert.equal(found.blockNumber, newest);
  assert.equal(provider.stats.calls.eth_getLogs, 1, 'one filtered 10,000-block request found it');
  const lines = [];
  assert.deepEqual(await smokeRange(offlineProvider(synthetic.fetchImpl), smokeArguments(['--find=aaveV4']), (text) => lines.push(text)),
    [newest - 249, Math.min(safeHead, newest + 250)]);
  assert(lines[0].startsWith(`FOUND aaveV4 event at block ${newest}`));
  const none = offlineProvider(chainOf({ protocols: false }).fetchImpl);
  assert.equal(await findRecentEvent(none, 'cctp', safeHead, 3), null);
  assert.equal(none.stats.calls.eth_getLogs, 3, 'an empty search stops after max-windows requests, never a chain scan');
  await assert.rejects(findRecentEvent(none, 'cctp', safeHead, 25), /invalid_find_request/);
});

// Store and runner (node:sqlite, Node 22.13+). Temporary files only, deleted at the end.
const sqlite = await import('node:sqlite').catch(() => null);
if (!sqlite) {
  assert.notEqual(process.env.COMPACT_REQUIRE_SQLITE, '1', `node:sqlite is required but unavailable on Node ${process.version}`);
  console.log(`DEFERRED sqlite protocol store tests: node:sqlite is unavailable on Node ${process.version}; run them on Node 24`);
} else {
  const directory = await mkdtemp(join(process.env.COMPACT_SQLITE_DIR || tmpdir(), 'compact-protocols-'));
  const open = (name) => new sqlite.DatabaseSync(join(directory, name));
  const rowsOf = (store, hourStart) => Object.fromEntries(store.familyRows(hourStart).map((row) => [row.family, row]));
  const third = await run({}, HOUR + 7200);
  try {
    await test('sqlite: protocol families round-trip as stored rows; replay is unchanged; the checkpoint is untouched by replays', async () => {
      const db = open('roundtrip.sqlite');
      const store = createCompactStore(db);
      for (const hour of [clean, next, third]) assert.equal(store.commitHour(hour).outcome, 'inserted');
      for (const name of NAMES) assert.deepEqual(rowsOf(store, HOUR + 3600)[name].metrics, metricsOf(next.families[name], name), name);
      const checkpoint = store.checkpoint();
      for (const hour of [clean, next, third]) assert.equal(store.commitHour(hour).outcome, 'unchanged');
      assert.deepEqual(store.checkpoint(), checkpoint);
      db.close();
    });

    await test('sqlite: an unavailable protocol family is repaired to available; available families never change', async () => {
      const db = open('repair.sqlite');
      const store = createCompactStore(db);
      const morphoDown = await run({ faults: failStream('morphoBlue') });
      store.commitHour(morphoDown);
      store.commitHour(await run({}, HOUR + 3600));
      const before = rowsOf(store, HOUR);
      const checkpoint = store.checkpoint();
      assert.equal(before.morphoBlue.status, 'unavailable');
      assert.equal(store.commitHour(clean).outcome, 'upgraded');
      const after = rowsOf(store, HOUR);
      assert.deepEqual(after.morphoBlue.metrics, metricsOf(clean.families.morphoBlue, 'morphoBlue'));
      for (const name of Object.keys(FAMILY_FIELDS).filter((key) => key !== 'morphoBlue')) assert.deepEqual(after[name], before[name], name);
      assert.deepEqual(store.checkpoint(), checkpoint, 'a repair never moves the checkpoint');
      assert.equal(store.commitHour(morphoDown).outcome, 'unchanged', 'an available family is never downgraded');
      db.close();
    });

    await test('sqlite: an hour stored before the protocol families existed gains their rows on replay, and the runner repairs it', async () => {
      const db = open('older.sqlite');
      const store = createCompactStore(db);
      store.commitHour(clean);
      // A Stage 2b database: same schema, no rows for the families added in Stage 3.
      db.prepare(`DELETE FROM compact_family_hours WHERE family IN (${NAMES.map(() => '?').join(', ')})`).run(...NAMES);
      assert.deepEqual(Object.keys(rowsOf(store, HOUR)).sort(), ['assets', 'uniswapV3', 'uniswapV4', 'usdc']);
      assert.deepEqual(store.familyWindow('cctp', HOUR, 1), { family: 'cctp', fromHour: HOUR, toHour: HOUR, hours: 1, status: 'unavailable',
        reason: 'family_not_processed', hourStart: HOUR, metrics: null });
      db.close();
      const lines = [];
      const summary = await runCompactHour({ sqlitePath: join(directory, 'older.sqlite'), hourStart: HOUR, provider: offlineProvider(chainOf().fetchImpl),
        registryFromBlock: ORIGIN.originNumber, print: (text) => lines.push(text) });
      assert.deepEqual([summary.hourMode, summary.hourOutcome, summary.ok], ['repair', 'upgraded', true], lines.join('\n'));
      assert.deepEqual([...summary.repairFamilies].sort(), [...NAMES].sort());
      const reopened = open('older.sqlite');
      const repaired = createCompactStore(reopened);
      for (const name of NAMES) assert.deepEqual(rowsOf(repaired, HOUR)[name].metrics, metricsOf(clean.families[name], name), name);
      assert.equal(repaired.checkpoint().hourStart, HOUR);
      reopened.close();
    });

    await test('sqlite: every family definition version is recorded once; a database written under another definition is refused', async () => {
      const db = open('versions.sqlite');
      createCompactStore(db).commitHour(clean);
      const recorded = Object.fromEntries(db.prepare("SELECT key, value FROM compact_meta WHERE key GLOB 'family_version:*'").all()
        .map((row) => [row.key.slice('family_version:'.length), row.value]));
      assert.deepEqual(recorded, { ...FAMILY_VERSIONS });
      db.prepare("UPDATE compact_meta SET value = 'older-definition' WHERE key = 'family_version:aaveV4'").run();
      db.close();
      const again = open('versions.sqlite');
      assert.throws(() => createCompactStore(again), (error) => error.code === 'family_definition_mismatch');
      assert.equal(again.prepare("SELECT value FROM compact_meta WHERE key = 'family_version:aaveV4'").get().value, 'older-definition', 'nothing rewritten');
      again.close();
    });

    await test('sqlite: family windows are exact sums of stored hours, never partial, and only 1H, 6H and 24H exist', async () => {
      const db = open('windows.sqlite');
      const store = createCompactStore(db);
      store.commitHour(clean);
      store.commitHour(await run({ faults: failStream('across') }, HOUR + 3600));
      store.commitHour(third);
      const one = store.familyWindow('cctp', HOUR + 7200, 1);
      assert.deepEqual([one.status, one.metrics], ['available', sumWindow(FAMILY_WINDOWS.cctp, [third.families.cctp])]);
      assert.equal(store.familyWindow('cctp', HOUR + 7200, 6).reason, 'hour_missing');
      assert.deepEqual([store.familyWindow('across', HOUR + 3600, 1).status, store.familyWindow('across', HOUR + 3600, 1).reason],
        ['unavailable', 'family_unavailable']);
      assert.equal(store.familyWindow('usdc', HOUR, 1).metrics.transferCount, clean.families.usdc.transferCount);
      for (const [family, hours] of [['cctp', 2], ['cctp', 168], ['nope', 1]]) {
        assert.throws(() => store.familyWindow(family, HOUR, hours), (error) => error.code === 'unsupported_window', `${family}/${hours}`);
      }
      db.close();
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

console.log(`ARC_INTELLIGENCE_COMPACT_PROTOCOLS: PASS (${passed} deterministic scenarios on Node ${process.version}; offline only; node:sqlite ${sqlite ? 'tested' : 'deferred'})`);
