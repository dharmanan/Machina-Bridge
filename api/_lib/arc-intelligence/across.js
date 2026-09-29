import { decodeOfficialEvent, eventIdentity, eventTopic, readCode, snapshotContext } from './circle-common.js';
import { ARC_CHAIN_ID, ARC_RPC_URL, createArcRpcClient } from './rpc.js';
import { ACROSS_ARC_SPOKE_POOL, ACROSS_FILLED_RELAY_ABI, ACROSS_FUNDS_DEPOSITED_ABI } from './p1b-registry.js';

export const ACROSS_DEFINITION_VERSION = 'arc-intelligence-across-v3-spoke-v1';
const UINT256_MAX = (1n << 256n) - 1n;

function eventBase(log, type) {
  return { ...eventIdentity(log, type), source: ARC_RPC_URL, unit: 'raw_event_token_units' };
}

function nonnegativeBigInt(value) {
  return typeof value === 'bigint' && value >= 0n && value <= UINT256_MAX ? value.toString(10) : null;
}

export function decodeAcrossArcLeg(log) {
  const topic = log?.topics?.[0]?.toLowerCase();
  if (topic === eventTopic(ACROSS_FUNDS_DEPOSITED_ABI)) {
    const args = decodeOfficialEvent(log, ACROSS_FUNDS_DEPOSITED_ABI);
    if (!args) return null;
    const inputAmountRaw = nonnegativeBigInt(args.inputAmount);
    const outputAmountRaw = nonnegativeBigInt(args.outputAmount);
    const destinationChainId = nonnegativeBigInt(args.destinationChainId);
    const depositId = nonnegativeBigInt(args.depositId);
    if ([inputAmountRaw, outputAmountRaw, destinationChainId, depositId].some((value) => value === null)) return null;
    return { ...eventBase(log, 'source_deposit_leg'), inputToken: args.inputToken.toLowerCase(), outputToken: args.outputToken.toLowerCase(),
      inputAmountRaw, quotedOutputAmountRaw: outputAmountRaw, destinationChainId, depositId,
      depositor: args.depositor.toLowerCase(), recipient: args.recipient.toLowerCase(), feeRaw: null };
  }
  if (topic === eventTopic(ACROSS_FILLED_RELAY_ABI)) {
    const args = decodeOfficialEvent(log, ACROSS_FILLED_RELAY_ABI);
    if (!args) return null;
    const inputAmountRaw = nonnegativeBigInt(args.inputAmount);
    const quotedOutputAmountRaw = nonnegativeBigInt(args.outputAmount);
    const outputAmountRaw = nonnegativeBigInt(args.relayExecutionInfo?.updatedOutputAmount);
    const originChainId = nonnegativeBigInt(args.originChainId);
    const depositId = nonnegativeBigInt(args.depositId);
    if ([inputAmountRaw, quotedOutputAmountRaw, outputAmountRaw, originChainId, depositId].some((value) => value === null)) return null;
    return { ...eventBase(log, 'destination_fill_leg'), inputToken: args.inputToken.toLowerCase(), outputToken: args.outputToken.toLowerCase(),
      inputAmountRaw, quotedOutputAmountRaw, outputAmountRaw, originChainId, depositId,
      recipient: (args.relayExecutionInfo?.updatedRecipient ?? args.recipient).toLowerCase(),
      relayer: args.relayer.toLowerCase(), fillType: Number(args.relayExecutionInfo.fillType), feeRaw: null };
  }
  return undefined;
}

export async function buildAcrossSnapshot({ phase1aSnapshot, rpc = createArcRpcClient() } = {}) {
  const context = snapshotContext(phase1aSnapshot);
  const warnings = [];
  const deploymentVerified = context.complete && rpc?.url === ARC_RPC_URL
    ? await readCode(rpc, ACROSS_ARC_SPOKE_POOL.address, context.blockRange.blockTag) === true
    : false;
  if (!deploymentVerified) warnings.push('Official Across Arc SpokePool code was not verified at requestedEnd.');
  if (!context.complete) warnings.push('Phase 1A snapshot is incomplete; Across event scan cannot be complete.');

  const events = [];
  let malformedEventCount = 0;
  const emitter = ACROSS_ARC_SPOKE_POOL.address.toLowerCase();
  for (const log of phase1aSnapshot?.logs ?? []) {
    if (log.address?.toLowerCase() !== emitter) continue;
    const decoded = decodeAcrossArcLeg(log);
    if (decoded === null) malformedEventCount += 1;
    else if (decoded !== undefined) events.push(decoded);
  }
  if (malformedEventCount) warnings.push(`${malformedEventCount} recognized Across Arc SpokePool event(s) failed strict ABI decoding.`);
  const eventScanComplete = context.complete && deploymentVerified && malformedEventCount === 0;
  const sourceLegs = events.filter((event) => event.type === 'source_deposit_leg');
  const destinationLegs = events.filter((event) => event.type === 'destination_fill_leg');
  return {
    protocol: 'across.v3', definitionVersion: ACROSS_DEFINITION_VERSION,
    chainId: ARC_CHAIN_ID, source: ARC_RPC_URL, blockRange: context.blockRange,
    deployment: { ...ACROSS_ARC_SPOKE_POOL, address: emitter, status: deploymentVerified ? 'verified' : 'unavailable', codeVerifiedAt: context.complete ? context.blockRange?.blockTag : null },
    sourceLegs, destinationLegs, events,
    sourceLegCount: sourceLegs.length, destinationLegCount: destinationLegs.length,
    malformedEventCount, routerEventsExcluded: true, peripheryEventsExcluded: true,
    crossChainCompletionCoverage: { status: 'unavailable', reason: 'Counterpart chain range is not indexed by this Arc-only snapshot.' },
    completeness: { phase1aSnapshotComplete: context.complete, deploymentVerified,
      eventScanComplete, registrySubsetComplete: eventScanComplete, protocolUniverseComplete: false, complete: false },
    complete: false,
    warnings: [...new Set(warnings)],
  };
}
