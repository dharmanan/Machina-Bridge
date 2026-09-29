import { ARC_CHAIN_ID } from './rpc.js';

const REGISTRY_SOURCE = 'https://docs.arc.io/arc/references/contract-addresses';

export const ARC_VERIFIED_ASSETS = Object.freeze([
  {
    chainId: ARC_CHAIN_ID,
    address: '0x3600000000000000000000000000000000000000',
    symbol: 'USDC',
    decimals: 6,
    category: 'stablecoin',
    verification: { type: 'official_arc_contract_registry', source: REGISTRY_SOURCE },
    interfaces: {
      erc20Decimals: 6,
      nativeDecimals: 18,
      canonicalTransferEmitter: '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE',
    },
  },
  {
    chainId: ARC_CHAIN_ID,
    address: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
    symbol: 'EURC',
    decimals: 6,
    category: 'stablecoin',
    verification: { type: 'official_arc_contract_registry', source: REGISTRY_SOURCE },
  },
  {
    chainId: ARC_CHAIN_ID,
    address: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0',
    symbol: 'cirBTC',
    decimals: 8,
    category: 'tokenized_bitcoin',
    verification: { type: 'official_arc_contract_registry', source: REGISTRY_SOURCE },
  },
  {
    chainId: ARC_CHAIN_ID,
    address: '0x128cC466B61f542da60c70e3aA11c10e19B84EDB',
    symbol: 'WETH',
    decimals: 18,
    category: 'wrapped_asset',
    verification: { type: 'official_arc_contract_registry', source: REGISTRY_SOURCE },
  },
  {
    chainId: ARC_CHAIN_ID,
    address: '0x8a5D989Bbb96929F689B0200f435f53dA42bF490',
    symbol: 'USYC',
    decimals: 6,
    category: 'tokenized_fund',
    verification: { type: 'official_arc_contract_registry', source: REGISTRY_SOURCE },
  },
].map((asset) => Object.freeze({
  ...asset,
  address: asset.address.toLowerCase(),
  interfaces: asset.interfaces ? Object.freeze({
    ...asset.interfaces,
    canonicalTransferEmitter: asset.interfaces.canonicalTransferEmitter.toLowerCase(),
  }) : undefined,
  verification: Object.freeze(asset.verification),
})));

export const ARC_ASSETS_BY_ADDRESS = new Map(ARC_VERIFIED_ASSETS.map((asset) => [asset.address, asset]));

export function validateVerifiedAssetRegistry(assets = ARC_VERIFIED_ASSETS) {
  const seen = new Set();
  for (const asset of assets) {
    if (asset.chainId !== ARC_CHAIN_ID) throw new Error(`Unexpected asset chain id: ${asset.symbol}`);
    if (!/^0x[0-9a-f]{40}$/i.test(asset.address)) throw new Error(`Invalid registry address: ${asset.symbol}`);
    const address = asset.address.toLowerCase();
    if (seen.has(address)) throw new Error(`Duplicate registry address: ${asset.symbol}`);
    seen.add(address);
    if (!Number.isSafeInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 255) {
      throw new Error(`Invalid registry decimals: ${asset.symbol}`);
    }
    if (typeof asset.verification?.source !== 'string' || !asset.verification.source) {
      throw new Error(`Missing verification provenance: ${asset.symbol}`);
    }
  }
  return true;
}
