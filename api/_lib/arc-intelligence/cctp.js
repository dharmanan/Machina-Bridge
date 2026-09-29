import { keccak256, parseAbiItem } from 'viem';
import { ARC_CHAIN_ID, ARC_RPC_URL, createArcRpcClient } from './rpc.js';
import { verifyErc20Metadata } from './tokens.js';
import { decodeOfficialEvent, eventIdentity, eventTopic, readCode, readView, snapshotContext } from './circle-common.js';

export const CCTP_V2_DEFINITION_VERSION = 'arc-intelligence-cctp-v2-v1';
export const CCTP_V2_ARC = Object.freeze({
  domain: 26,
  usdcInterface: '0x3600000000000000000000000000000000000000',
  tokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  messageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
});

export const CCTP_V2_ABI = Object.freeze({
  depositForBurn: parseAbiItem('event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)'),
  mintAndWithdraw: parseAbiItem('event MintAndWithdraw(address indexed mintRecipient, uint256 amount, address indexed mintToken, uint256 feeCollected)'),
  messageReceived: parseAbiItem('event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)'),
});

export const CCTP_V2_TOPICS = Object.freeze(Object.fromEntries(
  Object.entries(CCTP_V2_ABI).map(([name, abi]) => [name, eventTopic(abi)]),
));

const TOKEN_MESSENGER = CCTP_V2_ARC.tokenMessenger.toLowerCase();
const MESSAGE_TRANSMITTER = CCTP_V2_ARC.messageTransmitter.toLowerCase();

export function decodeCctpV2Event(log) {
  const emitter = log?.address?.toLowerCase();
  const topic = log?.topics?.[0]?.toLowerCase();
  const name = Object.keys(CCTP_V2_TOPICS).find((key) => CCTP_V2_TOPICS[key] === topic);
  if (!name) return undefined;
  if ((name === 'messageReceived' ? MESSAGE_TRANSMITTER : TOKEN_MESSENGER) !== emitter) return undefined;
  const args = decodeOfficialEvent(log, CCTP_V2_ABI[name]);
  if (args === null) return null;
  if (name === 'depositForBurn') return {
    ...eventIdentity(log, 'arc_outbound_burn_leg'),
    burnToken: args.burnToken.toLowerCase(),
    amountRaw: args.amount.toString(10),
    amountUnits: args.burnToken.toLowerCase() === CCTP_V2_ARC.usdcInterface ? 'USDC ERC20 interface raw units' : 'burn token raw units',
    depositor: args.depositor.toLowerCase(),
    mintRecipient: args.mintRecipient.toLowerCase(),
    destinationDomain: Number(args.destinationDomain),
    destinationTokenMessenger: args.destinationTokenMessenger.toLowerCase(),
    destinationCaller: args.destinationCaller.toLowerCase(),
    maxFeeRaw: args.maxFee.toString(10),
    minFinalityThreshold: Number(args.minFinalityThreshold),
    hookDataLength: (args.hookData.length - 2) / 2,
    hookDataHash: keccak256(args.hookData),
  };
  if (name === 'mintAndWithdraw') return {
    ...eventIdentity(log, 'arc_inbound_mint_leg'),
    mintRecipient: args.mintRecipient.toLowerCase(),
    amountRaw: args.amount.toString(10),
    mintToken: args.mintToken.toLowerCase(),
    amountUnits: args.mintToken.toLowerCase() === CCTP_V2_ARC.usdcInterface ? 'USDC ERC20 interface raw units' : 'mint token raw units',
    feeCollectedRaw: args.feeCollected.toString(10),
  };
  return {
    ...eventIdentity(log, 'message_envelope_received'),
    caller: args.caller.toLowerCase(),
    sourceDomain: Number(args.sourceDomain),
    nonce: args.nonce.toLowerCase(),
    sender: args.sender.toLowerCase(),
    finalityThresholdExecuted: Number(args.finalityThresholdExecuted),
    messageBodyLength: (args.messageBody.length - 2) / 2,
    messageBodyHash: keccak256(args.messageBody),
  };
}

export async function buildCctpV2Snapshot({ phase1aSnapshot, rpc = createArcRpcClient() } = {}) {
  const context = snapshotContext(phase1aSnapshot);
  const warnings = [];
  if (!context.complete) warnings.push('Complete Phase 1A Arc receipt/log snapshot unavailable.');
  const rpcAllowed = context.complete && rpc?.url === ARC_RPC_URL;
  const blockTag = context.blockRange?.blockTag;
  const [messengerCode, transmitterCode, localDomainValue, linkedTransmitter, tokenMetadata] = rpcAllowed
    ? await Promise.all([
      readCode(rpc, TOKEN_MESSENGER, blockTag),
      readCode(rpc, MESSAGE_TRANSMITTER, blockTag),
      readView(rpc, MESSAGE_TRANSMITTER, 'function localDomain() view returns (uint32)', 'localDomain', [], blockTag),
      readView(rpc, TOKEN_MESSENGER, 'function localMessageTransmitter() view returns (address)', 'localMessageTransmitter', [], blockTag),
      verifyErc20Metadata(rpc, CCTP_V2_ARC.usdcInterface, { blockTag }),
    ])
    : [null, null, null, null, null];
  const localDomain = localDomainValue === null ? null : Number(localDomainValue);
  const messengerVerified = messengerCode === true && linkedTransmitter?.toLowerCase() === MESSAGE_TRANSMITTER;
  const transmitterVerified = transmitterCode === true && localDomain === CCTP_V2_ARC.domain;
  const contractsVerified = messengerVerified && transmitterVerified;
  if (!messengerVerified) warnings.push('CCTP V2 TokenMessenger code or local MessageTransmitter linkage unavailable.');
  if (!transmitterVerified) warnings.push('CCTP V2 MessageTransmitter code or localDomain verification unavailable.');
  if (tokenMetadata?.status !== 'verified') warnings.push('Arc USDC ERC20 interface metadata unavailable at requestedEnd.');

  const outboundBurns = [];
  const inboundMints = [];
  const messageReceipts = [];
  let malformedEventCount = 0;
  if (context.usable) for (const log of phase1aSnapshot.logs) {
    const decoded = decodeCctpV2Event(log);
    if (decoded === undefined) continue;
    if (decoded === null) {
      malformedEventCount += 1;
      continue;
    }
    if (decoded.type === 'arc_outbound_burn_leg') outboundBurns.push(decoded);
    else if (decoded.type === 'arc_inbound_mint_leg') inboundMints.push(decoded);
    else messageReceipts.push(decoded);
  }
  if (malformedEventCount) warnings.push(`${malformedEventCount} recognized official CCTP V2 event(s) failed strict ABI validation.`);
  // One mint and one envelope in the same transaction are unambiguous Arc-local evidence.
  // A transaction with multiple of either remains unlinked; neither case proves the remote leg.
  const messageToMintLinks = [];
  for (const receipt of messageReceipts) {
    const mints = inboundMints.filter((mint) => mint.transactionHash === receipt.transactionHash);
    const envelopes = messageReceipts.filter((message) => message.transactionHash === receipt.transactionHash);
    if (mints.length === 1 && envelopes.length === 1 && mints[0].logIndex < receipt.logIndex) messageToMintLinks.push({
      transactionHash: receipt.transactionHash,
      mintLogIndex: mints[0].logIndex,
      messageReceivedLogIndex: receipt.logIndex,
      basis: 'unique_official_mint_and_message_received_in_transaction',
    });
  }
  const arcLegEventScanComplete = context.complete && malformedEventCount === 0;
  const complete = arcLegEventScanComplete && contractsVerified && tokenMetadata?.status === 'verified';
  return {
    protocol: 'cctp.v2',
    definitionVersion: CCTP_V2_DEFINITION_VERSION,
    chainId: ARC_CHAIN_ID,
    source: rpc?.url ?? ARC_RPC_URL,
    blockRange: context.blockRange,
    deployments: {
      tokenMessenger: { address: TOKEN_MESSENGER, codePresent: messengerCode, linkedMessageTransmitter: linkedTransmitter?.toLowerCase() ?? null, verified: messengerVerified },
      messageTransmitter: { address: MESSAGE_TRANSMITTER, codePresent: transmitterCode, localDomain, verified: transmitterVerified },
    },
    contractVerification: { tokenMessengerVerified: messengerVerified, messageTransmitterVerified: transmitterVerified, contractsVerified },
    arcDomain: transmitterVerified ? localDomain : null,
    outboundBurns,
    inboundMints,
    messageReceipts,
    messageToMintLinks,
    eventCounts: {
      arcOutboundBurnLegCount: outboundBurns.length,
      arcInboundMintLegCount: inboundMints.length,
      messageReceivedCount: messageReceipts.length,
      malformedEventCount,
    },
    tokenMetadata: tokenMetadata ?? { address: CCTP_V2_ARC.usdcInterface, status: 'unknown/unverified' },
    arcLegEventScanComplete,
    crossChainCompletionCoverage: { status: 'unavailable', reason: 'Arc-only receipt logs do not establish counterpart-chain completion.' },
    warnings,
    complete,
  };
}
