import { parseAbiItem } from 'viem';
import { ARC_CHAIN_ID, ARC_RPC_URL, createArcRpcClient } from './rpc.js';
import { readCode, snapshotContext } from './circle-common.js';
import { MORPHO_ARC_CANDIDATE_VAULTS, MORPHO_V2_ARC_FACTORY } from './morpho.js';

export const P1B_DEFINITION_VERSION = 'arc-intelligence-p1b-registry-v1';

const ACROSS_SOURCE = 'https://docs.across.to/chains-and-contracts';
const ACROSS_ABI_SOURCE = 'https://github.com/across-protocol/contracts/blob/master/contracts/interfaces/V3SpokePoolInterface.sol';

export const ACROSS_ARC_SPOKE_POOL = Object.freeze({
  address: '0x9b4A302A548c7e313c2b74C461db7b84d3074A84',
  chainId: ARC_CHAIN_ID,
  source: ACROSS_SOURCE,
  deploymentExplorerLink: 'https://explorer.arc.io/address/0x9b4A302A548c7e313c2b74C461db7b84d3074A84',
  abiSource: ACROSS_ABI_SOURCE,
  role: 'spoke_pool_arc_leg_only',
});

// These are protocol-defined event signatures from Across V3SpokePoolInterface.sol.
// Router, periphery, and multicall contracts are intentionally not economic emitters.
export const ACROSS_FUNDS_DEPOSITED_ABI = parseAbiItem(
  'event FundsDeposited(bytes32 inputToken,bytes32 outputToken,uint256 inputAmount,uint256 outputAmount,uint256 indexed destinationChainId,uint256 indexed depositId,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes32 indexed depositor,bytes32 recipient,bytes32 exclusiveRelayer,bytes message)',
);
export const ACROSS_FILLED_RELAY_ABI = parseAbiItem(
  'event FilledRelay(bytes32 inputToken,bytes32 outputToken,uint256 inputAmount,uint256 outputAmount,uint256 repaymentChainId,uint256 indexed originChainId,uint256 indexed depositId,uint32 fillDeadline,uint32 exclusivityDeadline,bytes32 exclusiveRelayer,bytes32 indexed relayer,bytes32 depositor,bytes32 recipient,bytes32 messageHash,(bytes32 updatedRecipient,bytes32 updatedMessageHash,uint256 updatedOutputAmount,uint8 fillType) relayExecutionInfo)',
);

export const P1B_BRIDGE_CANDIDATES = Object.freeze([
  { protocol: 'Across', category: 'bridge', version: 'v3-spoke-pool', role: 'settlement_spoke_pool', address: ACROSS_ARC_SPOKE_POOL.address, chainId: ARC_CHAIN_ID, authoritativeSource: ACROSS_SOURCE, deploymentExplorerLink: ACROSS_ARC_SPOKE_POOL.deploymentExplorerLink, abiSource: ACROSS_ABI_SOURCE, verificationStatus: 'source_verified_candidate' },
  ...[
    ['LI.FI', 'aggregator_or_routing_layer'], ['RhinoFi', 'bridge'], ['Socket / Bungee', 'aggregator_or_routing_layer'],
    ['Stargate', 'bridge'], ['LayerZero', 'messaging_layer'], ['Eco', 'intent_and_bridge'], ['Fast', 'bridge'],
    ['Relay', 'aggregator_or_routing_layer'], ['Aleo / xReserve', 'bridge'],
  ].map(([protocol, role]) => ({ protocol, category: 'bridge', version: null, role, address: null, chainId: ARC_CHAIN_ID,
    authoritativeSource: null, abiSource: null, verificationStatus: 'unavailable_no_official_arc_deployment_and_abi' })),
]);

export const STABLEFX_ARC_CANDIDATES = Object.freeze([{
  protocol: 'Circle StableFX', category: 'stablefx', version: 'unknown', role: 'candidate_fx_escrow',
  address: '0xe2E5F173576B513d994073CCbDaCBE027d43DFe6', chainId: ARC_CHAIN_ID,
  authoritativeSource: null, abiSource: null, verificationStatus: 'candidate_unverified',
  reason: 'No official Arc mainnet deployment identity, settlement ABI, or fee semantics established.',
}]);

export const RWA_ARC_CANDIDATES = Object.freeze([
  { protocol: 'USYC', category: 'rwa', version: 'erc20-share', role: 'verified_asset_transfer_mint_burn_only', address: '0x8a5D989Bbb96929F689B0200f435f53dA42bF490', chainId: ARC_CHAIN_ID,
    authoritativeSource: 'https://www.circle.com/usyc', verificationStatus: 'verified_asset_from_p0_registry', accountingMetrics: 'unavailable' },
  ...['BUIDL', 'JAAA', 'JTRSY'].map((protocol) => ({ protocol, category: 'rwa', version: null, role: 'candidate_asset', address: null,
    chainId: ARC_CHAIN_ID, authoritativeSource: null, verificationStatus: 'unavailable_no_official_arc_token_address', accountingMetrics: 'unavailable' })),
]);

// Candidate labels are retained from Phase 0 discovery. The vault address, factory
// registration, asset, curator address, and Vault V2 views are verified separately
// by morpho.js at the requested block. No organization name is inferred from curator.
export const P1B_MORPHO_VAULT_REGISTRY = Object.freeze(MORPHO_ARC_CANDIDATE_VAULTS.map((candidate) => ({
  category: 'vault', protocol: 'Morpho', version: 'VaultV2', role: 'candidate_vault',
  address: candidate.address, chainId: ARC_CHAIN_ID, effectiveBlock: null,
  label: candidate.candidateLabel, labelProvenance: 'phase0_discovery_candidate_label',
  authoritativeSource: MORPHO_V2_ARC_FACTORY.source,
  verificationStatus: 'requires_requested_end_factory_and_view_verification',
})).concat([
  { category: 'curator_candidate', protocol: 'Morpho', version: 'VaultV2', role: 'curator_without_verified_arc_vault_address',
    address: null, chainId: ARC_CHAIN_ID, effectiveBlock: null, label: 'Cumberland',
    labelProvenance: 'Arc mainnet launch announcement identifies Cumberland as supporting curated vault strategies; no specific Arc VaultV2 address verified.',
    authoritativeSource: 'https://www.arc.io/blog/arc-economic-os-internet',
    verificationStatus: 'unavailable_no_verified_arc_v2_vault_address' },
  { category: 'vault_registry', protocol: 'Morpho', version: 'VaultV2', role: 'factory',
  address: MORPHO_V2_ARC_FACTORY.address, chainId: ARC_CHAIN_ID, effectiveBlock: null,
  label: null, labelProvenance: null, authoritativeSource: MORPHO_V2_ARC_FACTORY.source,
  verificationStatus: 'requires_requested_end_code_verification' },
]));

export async function buildP1BRegistrySnapshot({ phase1aSnapshot, rpc = createArcRpcClient() } = {}) {
  const context = snapshotContext(phase1aSnapshot);
  const blockTag = context.blockRange?.blockTag ?? null;
  const stablefx = await Promise.all(STABLEFX_ARC_CANDIDATES.map(async (candidate) => ({
    ...candidate,
    address: candidate.address.toLowerCase(),
    codePresent: context.complete && rpc?.url === ARC_RPC_URL ? await readCode(rpc, candidate.address, blockTag) : null,
    codeVerifiedAt: context.complete && rpc?.url === ARC_RPC_URL ? blockTag : null,
    deploymentVerified: false,
    eventScanComplete: false,
    settlementEventCount: null,
    settlementAmounts: null,
    feeAmounts: null,
    metricsStatus: 'unavailable',
  })));
  return {
    protocol: 'arc.p1b.registry', definitionVersion: P1B_DEFINITION_VERSION,
    chainId: ARC_CHAIN_ID, source: ARC_RPC_URL, blockRange: context.blockRange,
    bridgeCandidates: P1B_BRIDGE_CANDIDATES,
    stablefxCandidates: stablefx,
    rwaCandidates: RWA_ARC_CANDIDATES,
    morphoVaultRegistry: P1B_MORPHO_VAULT_REGISTRY,
    deploymentVerified: false,
    eventScanComplete: false,
    registrySubsetComplete: false,
    protocolUniverseComplete: false,
    complete: false,
    warnings: [
      'Bridge, StableFX, and RWA candidates without official Arc deployment and event semantics remain unavailable.',
      'Morpho registry labels are discovery aliases; only onchain factory and views establish runtime identity.',
      'Protocol universe coverage is intentionally incomplete.',
    ],
  };
}
