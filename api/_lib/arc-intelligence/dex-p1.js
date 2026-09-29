import { ARC_CHAIN_ID, ARC_RPC_URL } from './rpc.js';
import { P1A_DEX_CANDIDATES } from './p1a-registry.js';
import { snapshotContext } from './circle-common.js';

export const DEX_P1_DEFINITION_VERSION = 'arc-intelligence-dex-p1-v1';

// An ecosystem listing supplies no canonical emitter or economic swap ABI.
// Underlying Uniswap swaps remain exclusively in the P0 Uniswap decoder.
export async function buildDexP1Snapshot({ phase1aSnapshot, rpc } = {}) {
  const context = snapshotContext(phase1aSnapshot);
  return {
    protocol: 'dex.p1', definitionVersion: DEX_P1_DEFINITION_VERSION,
    chainId: ARC_CHAIN_ID, source: rpc?.url ?? ARC_RPC_URL,
    blockRange: context.blockRange,
    candidates: P1A_DEX_CANDIDATES.map((candidate) => ({ ...candidate,
      status: 'unavailable', codePresent: null, eventScanComplete: false,
      reason: 'Arc deployment emitter and official economic event ABI are not both verified.' })),
    observedSwaps: [], routeExecutions: [],
    protocolUniverseComplete: false, eventScanComplete: false, complete: false,
    warnings: ['P1 DEX and aggregator candidates have no verified Arc emitter/event pair; no economic activity is attributed.'],
  };
}
