// Archery CL on Arc mainnet: the official Slipstream-derived concentrated-liquidity factory and its pools, as published at
// https://archery.wtf/docs/security (Arc Mainnet: V3 contracts and markets). Each value was verified on chain, read only:
// the factory has no code at block 22447743 and was created at 22447744 by the documented deployer's transaction;
// allPoolsLength() returns these four pools in this order; every pool's factory() and the factory's getPool(token0,
// token1, tickSpacing) agree; the pools are EIP-1167 clones of the documented v3PoolImplementation, whose bytecode
// carries the Uniswap V3 Swap, Mint and Burn event topics. Counts only: never a fee, price, USD volume, TVL or APY.
export const ARCHERY_CL_DEFINITION_VERSION = 'archery-cl-hour-v1';

export const ARCHERY_CL = Object.freeze({
  id: 'archery_cl',
  name: 'Archery CL',
  chainId: 5042,
  source: 'https://archery.wtf/docs/security',
  factory: '0xc481038c013fe96f38ce7a2dc417b2b1b78b16a4',
  factoryCreationBlock: 22447744,
  factoryCreationTx: '0xdc8c3afb16ba528119a53fe7149cf988754e7ae6762f88dc213ee7d5071a9bbb',
  deployer: '0x5a378ff5e4450f8841ded68fcc110cd433f52e97',
  poolImplementation: '0x80d055bb22a7cd41843c7de0345e345bb9bcc6dd',
  // In the factory's allPools(i) order.
  pools: Object.freeze([
    Object.freeze({ address: '0x072ca55acb3cc90f96b7f7807cf8de2250af4dc7', market: 'WETH / USDC', tickSpacing: 50,
      token0: '0x128cc466b61f542da60c70e3aa11c10e19b84edb', token1: '0x3600000000000000000000000000000000000000' }),
    Object.freeze({ address: '0x948523143f6610a64ee8f17667818fe1d8c9f562', market: 'cirBTC / USDC', tickSpacing: 50,
      token0: '0x171a4217b86a807a64eb94757db6849fb4bdbaa0', token1: '0x3600000000000000000000000000000000000000' }),
    Object.freeze({ address: '0x3572897908f2d8d171bf701758f6ddafec5e3637', market: 'WETH / cirBTC', tickSpacing: 10,
      token0: '0x128cc466b61f542da60c70e3aa11c10e19b84edb', token1: '0x171a4217b86a807a64eb94757db6849fb4bdbaa0' }),
    Object.freeze({ address: '0xb88c08e31c1bc7d41f2cfc4fbafad5b3b0a5eae9', market: 'USDC / EURC', tickSpacing: 1,
      token0: '0x3600000000000000000000000000000000000000', token1: '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1' }),
  ]),
});
