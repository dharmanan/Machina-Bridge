import { eventAbi } from './common.js';

// Official Portal.sol, Portal v7 on Arc: https://github.com/arguspad/argus-world/blob/main/contracts/Portal.sol
export const ARGUS_ADAPTER = Object.freeze({
  protocol: 'Argus',
  abi: eventAbi('event TokenCreated(address indexed token, address indexed creator, string name, string symbol, bytes32 poolId, string imageURI, string website, string twitter, string telegram)'),
  creatorField: 'creator',
  view: Object.freeze({ signature: 'function LAUNCH_STRUCT_WORDS() view returns (uint256)',
    functionName: 'LAUNCH_STRUCT_WORDS', verify: (value) => value === 11n }),
  project: (args) => ({ poolId: args.poolId.toLowerCase() }),
});
