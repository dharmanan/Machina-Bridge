import { eventAbi } from './common.js';

// Official Arc deployment: https://github.com/Gitlawb/openlaunch/blob/main/contracts/deployments/launchpad-arc.json
// Official ABI: https://github.com/Gitlawb/openlaunch/blob/main/contracts/src/LaunchFactoryArc.sol
export const OPENLAUNCH_ADAPTER = Object.freeze({
  protocol: 'Openlaunch',
  abi: eventAbi('event Launched(address indexed token, uint256 indexed tokenId, address indexed launcher, address quote, bytes32 poolId, int24 startTick, uint24 lpFee, uint256 supply, string metadataURI)'),
  creatorField: null, // The official event names this field launcher, not creator.
  view: Object.freeze({ signature: 'function launchCount() view returns (uint256)', functionName: 'launchCount',
    verify: (value) => typeof value === 'bigint' && value >= 0n }),
  project: (args) => ({ launcher: args.launcher.toLowerCase(), quote: args.quote.toLowerCase(),
    poolId: args.poolId.toLowerCase(), tokenIdRaw: args.tokenId.toString(10),
    supplyRaw: args.supply.toString(10) }),
});
