// Compact engine: Aave V4 on Arc (Hub/Spoke; Arc runs V4, not V3 Pool/aTokens). Addresses: Aave V4 changelog and the
// public Aave V4 API (Core Hub, Main Spoke, Forex Spoke), recorded in docs/arc-intelligence-phase0.md and
// api/_lib/arc-intelligence/aave.js. Event signatures are the ones whose topics A2 recorded there; the topics derived here
// from them are checked against A2's constants in the tests. Position flows only: supply, withdraw, borrow, repay and
// liquidation counts plus raw amounts per reserve in that reserve's underlying units. Each observed reserve is resolved
// with the Spoke's getReserve view at the hour's last block and must belong to the Core Hub; an unresolvable reserve
// makes the family unavailable. TVL, utilization, rates and APY need accounting state and are not derived here.
import { decodeResult, defineEvent, encodeCall } from '../abi.js';
import { FamilyError } from '../family-error.js';
import { createTally, readViews, requireCode } from './common.js';

export const AAVE_V4_ARC = Object.freeze({
  coreHub: '0x17288dfc86205301064577b98b02b81017e6f79c',
  mainSpoke: '0xb843bdc3a87a05e77e07df9fe48928b3a34b134d',
  forexSpoke: '0x4164ebcaf74670aa74c8d4f59de6157c0780f1bb',
});
const SPOKES = [AAVE_V4_ARC.mainSpoke, AAVE_V4_ARC.forexSpoke];
const RESERVE_LIMIT = 64;
const PREMIUM_DELTA = '(int256 sharesDelta, int256 offsetRayDelta, uint256 restoredPremiumRay) premiumDelta';
// Spoke.getReserve(reserveId) -> Reserve { underlying, hub, assetId, decimals, collateralRisk, flags, dynamicConfigKey }.
const RESERVE_WORDS = ['address', 'address', 'uint16', 'uint8', 'uint24', 'uint8', 'uint32'];

export const AAVE_V4_EVENTS = Object.freeze({
  supply: defineEvent('event Supply(uint256 indexed reserveId, address indexed caller, address indexed user, uint256 suppliedShares, uint256 suppliedAmount)'),
  withdraw: defineEvent('event Withdraw(uint256 indexed reserveId, address indexed caller, address indexed user, uint256 withdrawnShares, uint256 withdrawnAmount)'),
  borrow: defineEvent('event Borrow(uint256 indexed reserveId, address indexed caller, address indexed user, uint256 drawnShares, uint256 drawnAmount)'),
  repay: defineEvent(`event Repay(uint256 indexed reserveId, address indexed caller, address indexed user, uint256 drawnShares, uint256 totalAmountRepaid, ${PREMIUM_DELTA})`),
  liquidationCall: defineEvent(`event LiquidationCall(uint256 indexed collateralReserveId, uint256 indexed debtReserveId, address indexed user, address liquidator, bool receiveShares, uint256 debtAmountRestored, uint256 drawnSharesLiquidated, ${PREMIUM_DELTA}, uint256 collateralAmountRemoved, uint256 collateralSharesLiquidated, uint256 collateralSharesToLiquidator)`),
});
const BY_TOPIC = new Map(Object.entries(AAVE_V4_EVENTS).map(([kind, event]) => [event.topic, [kind, event]]));

function createAaveAccumulator() {
  const counts = { supplyCount: 0, withdrawCount: 0, borrowCount: 0, repayCount: 0, liquidationCount: 0 };
  const reserves = createTally({ limit: RESERVE_LIMIT, code: 'aave_reserve_limit',
    amounts: ['suppliedRaw', 'withdrawnRaw', 'borrowedRaw', 'repaidRaw', 'liquidatedDebtRaw', 'liquidatedCollateralRaw'] });
  const users = new Set();
  const reserve = (spoke, id, increments) => reserves.add(`${spoke}:${id}`, increments, { spoke, reserveId: id.toString(10) });
  return {
    add(_stream, logs) {
      for (const log of logs) {
        const [kind, definition] = BY_TOPIC.get(log.topics[0]);
        const event = definition.decode(log);
        if (!event) throw new FamilyError('malformed_aave_event');
        counts[`${kind === 'liquidationCall' ? 'liquidation' : kind}Count`] += 1;
        users.add(event.user);
        if (kind === 'supply') reserve(log.address, event.reserveId, { suppliedRaw: event.suppliedAmount });
        else if (kind === 'withdraw') reserve(log.address, event.reserveId, { withdrawnRaw: event.withdrawnAmount });
        else if (kind === 'borrow') reserve(log.address, event.reserveId, { borrowedRaw: event.drawnAmount });
        else if (kind === 'repay') reserve(log.address, event.reserveId, { repaidRaw: event.totalAmountRepaid });
        else {
          reserve(log.address, event.debtReserveId, { liquidatedDebtRaw: event.debtAmountRestored });
          reserve(log.address, event.collateralReserveId, { liquidatedCollateralRaw: event.collateralAmountRemoved });
        }
      }
    },
    async finish(context) {
      requireCode(context, [AAVE_V4_ARC.coreHub, ...SPOKES], 'aave_code_unverified');
      const keys = reserves.keys();
      const results = await readViews(context.provider, keys.map((key) => {
        const [spoke, id] = key.split(':');
        return { to: spoke, data: encodeCall('getReserve(uint256)', [['uint256', id]]) };
      }), context.blockTag, 'aave_reserve_unresolved');
      keys.forEach((key, index) => {
        const values = decodeResult(RESERVE_WORDS, results[index]);
        if (!values || values[1] !== AAVE_V4_ARC.coreHub || values[0] === '0x0000000000000000000000000000000000000000') {
          throw new FamilyError('aave_reserve_unresolved');
        }
        reserves.setMeta(key, { underlying: values[0], decimals: Number(values[3]) });
      });
      return { ...counts, uniqueUsers: users.size, reserves: reserves.toObject() };
    },
  };
}

export const AAVE_V4_FAMILY = Object.freeze({
  name: 'aaveV4',
  version: 'aave-v4-spoke-position-flows-v1',
  streams: [{ key: 'aaveV4Spokes', address: SPOKES, topics: Object.values(AAVE_V4_EVENTS).map((event) => event.topic) }],
  codeAddresses: [AAVE_V4_ARC.coreHub, ...SPOKES],
  fields: ['supplyCount', 'withdrawCount', 'borrowCount', 'repayCount', 'liquidationCount', 'uniqueUsers', 'reserves'],
  window: {
    counts: ['supplyCount', 'withdrawCount', 'borrowCount', 'repayCount', 'liquidationCount'],
    tallies: { reserves: { amounts: ['suppliedRaw', 'withdrawnRaw', 'borrowedRaw', 'repaidRaw', 'liquidatedDebtRaw', 'liquidatedCollateralRaw'],
      constants: ['spoke', 'reserveId', 'underlying', 'decimals'] } },
  },
  create: createAaveAccumulator,
});
