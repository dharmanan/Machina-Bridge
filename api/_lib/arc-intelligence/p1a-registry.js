import { ARC_CHAIN_ID } from './rpc.js';

const ARC_ECOSYSTEM = 'https://www.arc.io/blog/arc-economic-os-internet';
const PHASE_ZERO = 'docs/arc-intelligence-phase0.md';

export const P1A_DEX_CANDIDATES = Object.freeze([
  ['Aero', 'dex'], ['Curve', 'dex'], ['KyberSwap', 'aggregator'],
  ['1inch', 'aggregator'], ['0x', 'aggregator'], ['LI.FI', 'aggregator'],
  ['Swapper', 'aggregator'], ['Doppler', 'dex_or_launchpad'],
  ['Bankr', 'aggregator'], ['Alph', 'trading_app'],
  ['fomo', 'trading_app'], ['Pump.fun', 'trading_app'],
].map(([protocol, role]) => Object.freeze({
  chainId: ARC_CHAIN_ID, protocol, version: null, role, address: null,
  source: ARC_ECOSYSTEM, sourceEvidence: 'ecosystem_listing_only',
  verificationStatus: 'unavailable', effectiveFromBlock: null,
})));

function launchpad(protocol, version, address, source, sourceKey, effectiveFromBlock = null) {
  return Object.freeze({ chainId: ARC_CHAIN_ID, protocol, version,
    role: 'launch_factory', address: address?.toLowerCase() ?? null,
    source, sourceKey, verificationStatus: sourceKey ? 'source_verified_candidate' : 'unavailable',
    effectiveFromBlock });
}

export const P1A_LAUNCHPAD_CANDIDATES = Object.freeze([
  launchpad('Argus', 'Portal v7', '0xb021be536808f551b31789422fd28a6c9c6e97da',
    'https://github.com/arguspad/argus-world/blob/main/contracts/Portal.sol', 'Portal.TokenCreated'),
  launchpad('RadarDEX Classic', null, '0x4b638c1502a07a8e1a26112ee98f51a3f34bc93a', PHASE_ZERO, null),
  launchpad('RadarDEX Reflection', null, '0x2d933ce4bde6f3d99540b5d7886b383e59b2b2f8', PHASE_ZERO, null),
  launchpad('Tolly', 'TollyPad V3', '0xcad7ee36ac193bf2eddb7b3e2736c5bdb8269c8b',
    'https://github.com/TollyLabs/v3-contracts/blob/main/contracts/launchpad/TollyPad.sol', 'TollyPad.TokenCreated'),
  launchpad('Warp', null, '0x0dcad158e98bc24455f9e94f46709d8a5f6d1255', PHASE_ZERO, null),
  launchpad('Archemist V2', 'V2', '0x297cebc4de347347205cd08667b56ee951dd8810',
    'https://archemist.fun/docs', 'ArchemistV2USDCFactory.TokenCreated'),
  launchpad('PEGD V4', null, '0xd0aa679ec263e8f9bc929426eb9eab2e061d2c5f', PHASE_ZERO, null),
  launchpad('Minara', null, '0xb6c6f77ee74af874a183bfd77dd0176d1ac91de6', PHASE_ZERO, null),
  launchpad('Openlaunch', 'LaunchFactoryArc', '0x815542e8b392389a1389e22e588e4b62a67ade72',
    'https://github.com/Gitlawb/openlaunch/blob/main/contracts/src/LaunchFactoryArc.sol', 'LaunchFactoryArc.Launched', 21_165_817),
  launchpad('Pump.fun', null, null, ARC_ECOSYSTEM, null),
  launchpad('ArcPad', null, null, PHASE_ZERO, null),
  launchpad('Load.fun', null, null, PHASE_ZERO, null),
  launchpad('Parabola', null, null, PHASE_ZERO, null),
]);
