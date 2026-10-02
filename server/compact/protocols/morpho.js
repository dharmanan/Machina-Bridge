// Compact engine: Morpho on Arc. Addresses from the official Morpho address list
// (https://docs.morpho.org/developers/contracts/addresses/, Arc rows): Morpho Blue singleton and VaultV2Factory (the latter
// also in api/_lib/arc-intelligence/morpho.js). Two families, so one can fail without the other:
//  - morphoBlue: every Morpho market on Arc lives in the one Blue contract, so its events are complete market activity
//    (Borrow Kit loans included). Per market: raw amounts in the market's loan or collateral token units, resolved with
//    idToMarketParams at the hour's last block.
//  - morphoVaultsV2: ERC-4626 Deposit/Withdraw from any emitter, counted only when the official factory's isVaultV2 says the
//    emitter is a Vault V2; others are foreign (counted, never decoded, never fatal), like foreign Uniswap V3 emitters.
// Vault deposits are then allocated into Blue markets, so vault and market amounts describe the same capital at different
// layers and must never be added together. Rates, APY, utilization and TVL need state reads and are not derived.
import { decodeResult, defineEvent, encodeCall } from '../abi.js';
import { FamilyError } from '../family-error.js';
import { createTally, readViews, requireCode } from './common.js';

export const MORPHO_ARC = Object.freeze({
  blue: '0x34cd04070dd72b14e241112f6d83812df5af7fcd',
  vaultV2Factory: '0x3b0eefabfa22ec7cf2c73877ac16e78d76749f12',
});
const MARKET_LIMIT = 64;
const EMITTER_LIMIT = 100;
const ZERO = '0x0000000000000000000000000000000000000000';

export const MORPHO_BLUE_EVENTS = Object.freeze({
  supply: defineEvent('event Supply(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)'),
  withdraw: defineEvent('event Withdraw(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)'),
  borrow: defineEvent('event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)'),
  repay: defineEvent('event Repay(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)'),
  supplyCollateral: defineEvent('event SupplyCollateral(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets)'),
  withdrawCollateral: defineEvent('event WithdrawCollateral(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets)'),
  liquidate: defineEvent('event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)'),
  createMarket: defineEvent('event CreateMarket(bytes32 indexed id, (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams)'),
});
const BLUE_BY_TOPIC = new Map(Object.entries(MORPHO_BLUE_EVENTS).map(([kind, event]) => [event.topic, [kind, event]]));
// Which raw amount each position event adds to its market, and the counter it increments.
const BLUE_FLOWS = Object.freeze({
  supply: ['supplyCount', (event) => ({ suppliedRaw: event.assets })],
  withdraw: ['withdrawCount', (event) => ({ withdrawnRaw: event.assets })],
  borrow: ['borrowCount', (event) => ({ borrowedRaw: event.assets })],
  repay: ['repayCount', (event) => ({ repaidRaw: event.assets })],
  supplyCollateral: ['supplyCollateralCount', (event) => ({ collateralSuppliedRaw: event.assets })],
  withdrawCollateral: ['withdrawCollateralCount', (event) => ({ collateralWithdrawnRaw: event.assets })],
  liquidate: ['liquidationCount', (event) => ({ liquidationRepaidRaw: event.repaidAssets, liquidationSeizedRaw: event.seizedAssets,
    badDebtRaw: event.badDebtAssets })],
});
const MARKET_AMOUNTS = ['suppliedRaw', 'withdrawnRaw', 'borrowedRaw', 'repaidRaw', 'collateralSuppliedRaw', 'collateralWithdrawnRaw',
  'liquidationRepaidRaw', 'liquidationSeizedRaw', 'badDebtRaw'];
const BLUE_COUNTS = ['supplyCount', 'withdrawCount', 'borrowCount', 'repayCount', 'supplyCollateralCount', 'withdrawCollateralCount',
  'liquidationCount', 'marketCreatedCount'];

function createMorphoBlueAccumulator() {
  const counts = Object.fromEntries(BLUE_COUNTS.map((field) => [field, 0]));
  const markets = createTally({ limit: MARKET_LIMIT, code: 'morpho_market_limit', amounts: MARKET_AMOUNTS });
  const accounts = new Set();
  return {
    add(_stream, logs) {
      for (const log of logs) {
        const [kind, definition] = BLUE_BY_TOPIC.get(log.topics[0]);
        const event = definition.decode(log);
        if (!event) throw new FamilyError('malformed_morpho_blue_event');
        if (kind === 'createMarket') {
          counts.marketCreatedCount += 1;
          continue;
        }
        const [counter, amounts] = BLUE_FLOWS[kind];
        counts[counter] += 1;
        markets.add(event.id, amounts(event));
        accounts.add(kind === 'liquidate' ? event.borrower : event.onBehalf);
      }
    },
    async finish(context) {
      requireCode(context, [MORPHO_ARC.blue], 'morpho_blue_code_unverified');
      const ids = markets.keys();
      const results = await readViews(context.provider, ids.map((id) => ({ to: MORPHO_ARC.blue,
        data: encodeCall('idToMarketParams(bytes32)', [['bytes32', id]]) })), context.blockTag, 'morpho_market_unresolved');
      ids.forEach((id, index) => {
        const params = decodeResult(['address', 'address', 'address', 'address', 'uint256'], results[index]);
        if (!params || params[0] === ZERO) throw new FamilyError('morpho_market_unresolved');
        markets.setMeta(id, { loanToken: params[0], collateralToken: params[1], lltv: params[4].toString(10) });
      });
      return { ...counts, uniqueAccounts: accounts.size, markets: markets.toObject() };
    },
  };
}

export const ERC4626_EVENTS = Object.freeze({
  deposit: defineEvent('event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)'),
  withdraw: defineEvent('event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)'),
});

// Per emitter: counters, raw asset amounts and owners, kept until finish proves (or rejects) the emitter as a Vault V2.
// A malformed event only matters if its emitter turns out to be official.
function createMorphoVaultAccumulator() {
  const emitters = new Map();
  return {
    add(_stream, logs) {
      for (const log of logs) {
        let emitter = emitters.get(log.address);
        if (!emitter) {
          if (emitters.size >= EMITTER_LIMIT) throw new FamilyError('morpho_vault_emitter_limit');
          emitter = { depositCount: 0, withdrawCount: 0, deposited: 0n, withdrawn: 0n, events: 0, malformed: 0, owners: new Set() };
          emitters.set(log.address, emitter);
        }
        emitter.events += 1;
        const deposit = log.topics[0] === ERC4626_EVENTS.deposit.topic;
        const event = (deposit ? ERC4626_EVENTS.deposit : ERC4626_EVENTS.withdraw).decode(log);
        if (!event) { emitter.malformed += 1; continue; }
        if (deposit) { emitter.depositCount += 1; emitter.deposited += event.assets; } else { emitter.withdrawCount += 1; emitter.withdrawn += event.assets; }
        emitter.owners.add(event.owner);
      }
    },
    async finish(context) {
      requireCode(context, [MORPHO_ARC.vaultV2Factory], 'morpho_vault_factory_code_unverified');
      const addresses = [...emitters.keys()].sort();
      const flags = await readViews(context.provider, addresses.map((address) => ({ to: MORPHO_ARC.vaultV2Factory,
        data: encodeCall('isVaultV2(address)', [['address', address]]) })), context.blockTag, 'morpho_vault_verification_unavailable');
      const official = addresses.filter((address, index) => {
        const flag = decodeResult(['bool'], flags[index]);
        if (!flag) throw new FamilyError('morpho_vault_verification_unavailable');
        return flag[0];
      });
      const assets = await readViews(context.provider, official.map((address) => ({ to: address, data: encodeCall('asset()') })),
        context.blockTag, 'morpho_vault_asset_unavailable');
      const vaults = {};
      let depositCount = 0, withdrawCount = 0;
      const owners = new Set();
      official.forEach((address, index) => {
        const emitter = emitters.get(address);
        const asset = decodeResult(['address'], assets[index]);
        if (emitter.malformed) throw new FamilyError('malformed_morpho_vault_event');
        if (!asset || asset[0] === ZERO) throw new FamilyError('morpho_vault_asset_unavailable');
        depositCount += emitter.depositCount;
        withdrawCount += emitter.withdrawCount;
        for (const owner of emitter.owners) owners.add(owner);
        vaults[address] = { asset: asset[0], depositCount: emitter.depositCount, withdrawCount: emitter.withdrawCount,
          depositedAssetsRaw: emitter.deposited.toString(10), withdrawnAssetsRaw: emitter.withdrawn.toString(10) };
      });
      const foreign = addresses.filter((address) => !official.includes(address));
      return { depositCount, withdrawCount, uniqueOwners: owners.size, vaults,
        foreignEmitterCount: foreign.length, foreignEventCount: foreign.reduce((sum, address) => sum + emitters.get(address).events, 0) };
    },
  };
}

export const MORPHO_BLUE_FAMILY = Object.freeze({
  name: 'morphoBlue',
  version: 'morpho-blue-market-flows-v1',
  streams: [{ key: 'morphoBlue', address: [MORPHO_ARC.blue], topics: Object.values(MORPHO_BLUE_EVENTS).map((event) => event.topic) }],
  codeAddresses: [MORPHO_ARC.blue],
  fields: [...BLUE_COUNTS, 'uniqueAccounts', 'markets'],
  window: { counts: BLUE_COUNTS, tallies: { markets: { amounts: MARKET_AMOUNTS, constants: ['loanToken', 'collateralToken', 'lltv'] } } },
  create: createMorphoBlueAccumulator,
});

export const MORPHO_VAULTS_V2_FAMILY = Object.freeze({
  name: 'morphoVaultsV2',
  version: 'morpho-vault-v2-erc4626-flows-v1',
  // Topic-only, like Uniswap V3 pools: vaults are proven per emitter by the factory, not listed in advance.
  streams: [{ key: 'erc4626Vaults', address: null, topics: [ERC4626_EVENTS.deposit.topic, ERC4626_EVENTS.withdraw.topic], dense: true }],
  codeAddresses: [MORPHO_ARC.vaultV2Factory],
  fields: ['depositCount', 'withdrawCount', 'uniqueOwners', 'vaults', 'foreignEmitterCount', 'foreignEventCount'],
  window: { counts: ['depositCount', 'withdrawCount', 'foreignEventCount'],
    tallies: { vaults: { counts: ['depositCount', 'withdrawCount'], amounts: ['depositedAssetsRaw', 'withdrawnAssetsRaw'], constants: ['asset'] } } },
  create: createMorphoVaultAccumulator,
});
