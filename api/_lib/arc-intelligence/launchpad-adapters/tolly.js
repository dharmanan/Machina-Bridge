import { parseAbiItem } from 'viem';

// Official TollyPad.sol: https://github.com/TollyLabs/v3-contracts/blob/main/contracts/launchpad/TollyPad.sol
export const TOLLY_ADAPTER = Object.freeze({
  protocol: 'Tolly',
  abi: parseAbiItem('event TokenCreated(address indexed token, address indexed creator, string name, string symbol, address pool, string imageURI, string website, string twitter, string telegram)'),
  creatorField: 'creator',
  view: Object.freeze({ signature: 'function quote() view returns (address)', functionName: 'quote',
    verify: (value) => value?.toLowerCase() === '0x3600000000000000000000000000000000000000' }),
  project: (args) => ({ pool: args.pool.toLowerCase() }),
});
