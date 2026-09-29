import { parseAbiItem } from 'viem';
import { ARC_CHAIN_ID, ARC_RPC_URL, createArcRpcClient } from './rpc.js';
import { verifyErc20Metadata } from './tokens.js';
import { decodeOfficialEvent, eventIdentity, eventTopic, readCode, readView, snapshotContext } from './circle-common.js';

export const GATEWAY_DEFINITION_VERSION = 'arc-intelligence-gateway-v1';
export const GATEWAY_ARC = Object.freeze({
  wallet: '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE',
  minter: '0x2222222d7164433c4C09B0b0D809a9b52C04C205',
  usdcInterface: '0x3600000000000000000000000000000000000000',
});

export const GATEWAY_ABI = Object.freeze({
  deposited: parseAbiItem('event Deposited(address indexed token, address indexed depositor, address indexed sender, uint256 value)'),
  gatewayBurned: parseAbiItem('event GatewayBurned(address indexed token, address indexed depositor, bytes32 indexed transferSpecHash, uint32 destinationDomain, bytes32 destinationRecipient, address signer, uint256 value, uint256 fee, uint256 fromAvailable, uint256 fromWithdrawing)'),
  attestationUsed: parseAbiItem('event AttestationUsed(address indexed token, address indexed recipient, bytes32 indexed transferSpecHash, uint32 sourceDomain, bytes32 sourceDepositor, bytes32 sourceSigner, uint256 value)'),
  withdrawalInitiated: parseAbiItem('event WithdrawalInitiated(address indexed token, address indexed depositor, uint256 value, uint256 remainingAvailable, uint256 totalWithdrawing, uint256 withdrawalBlock)'),
  withdrawalCompleted: parseAbiItem('event WithdrawalCompleted(address indexed token, address indexed depositor, uint256 value)'),
});

export const GATEWAY_TOPICS = Object.freeze(Object.fromEntries(
  Object.entries(GATEWAY_ABI).map(([name, abi]) => [name, eventTopic(abi)]),
));
const WALLET = GATEWAY_ARC.wallet.toLowerCase();
const MINTER = GATEWAY_ARC.minter.toLowerCase();

export function decodeGatewayEvent(log, verifiedDomain = null) {
  const emitter = log?.address?.toLowerCase();
  const topic = log?.topics?.[0]?.toLowerCase();
  const name = Object.keys(GATEWAY_TOPICS).find((key) => GATEWAY_TOPICS[key] === topic);
  if (!name) return undefined;
  if ((name === 'attestationUsed' ? MINTER : WALLET) !== emitter) return undefined;
  const args = decodeOfficialEvent(log, GATEWAY_ABI[name]);
  if (args === null) return null;
  const base = eventIdentity(log, name);
  if (name === 'deposited') return {
    ...base, token: args.token.toLowerCase(), depositor: args.depositor.toLowerCase(),
    sender: args.sender.toLowerCase(), valueRaw: args.value.toString(10),
    category: 'gateway_balance_funding',
  };
  if (name === 'gatewayBurned') return {
    ...base,
    token: args.token.toLowerCase(),
    depositor: args.depositor.toLowerCase(),
    transferSpecHash: args.transferSpecHash.toLowerCase(),
    destinationDomain: Number(args.destinationDomain),
    destinationRecipient: args.destinationRecipient.toLowerCase(),
    signer: args.signer.toLowerCase(),
    valueRaw: args.value.toString(10),
    feeRaw: args.fee.toString(10),
    fromAvailableRaw: args.fromAvailable.toString(10),
    fromWithdrawingRaw: args.fromWithdrawing.toString(10),
    category: verifiedDomain === null ? 'domain_unverified_source_leg'
      : Number(args.destinationDomain) === verifiedDomain ? 'same_domain_source_leg' : 'cross_domain_source_leg',
  };
  if (name === 'attestationUsed') return {
    ...base,
    token: args.token.toLowerCase(),
    recipient: args.recipient.toLowerCase(),
    transferSpecHash: args.transferSpecHash.toLowerCase(),
    sourceDomain: Number(args.sourceDomain),
    sourceDepositor: args.sourceDepositor.toLowerCase(),
    sourceSigner: args.sourceSigner.toLowerCase(),
    valueRaw: args.value.toString(10),
    category: verifiedDomain === null ? 'domain_unverified_destination_leg'
      : Number(args.sourceDomain) === verifiedDomain ? 'same_domain_destination_leg' : 'cross_domain_destination_leg',
  };
  if (name === 'withdrawalInitiated') return {
    ...base,
    token: args.token.toLowerCase(), depositor: args.depositor.toLowerCase(),
    valueRaw: args.value.toString(10),
    remainingAvailableRaw: args.remainingAvailable.toString(10),
    totalWithdrawingRaw: args.totalWithdrawing.toString(10),
    withdrawalBlockRaw: args.withdrawalBlock.toString(10),
    category: 'local_withdrawal_lifecycle',
  };
  return {
    ...base, token: args.token.toLowerCase(), depositor: args.depositor.toLowerCase(),
    valueRaw: args.value.toString(10), category: 'local_withdrawal_lifecycle',
  };
}

async function verifyDeployment(rpc, address, blockTag) {
  const [codePresent, domainValue, usdcSupported] = await Promise.all([
    readCode(rpc, address, blockTag),
    readView(rpc, address, 'function domain() view returns (uint32)', 'domain', [], blockTag),
    readView(rpc, address, 'function isTokenSupported(address token) view returns (bool)', 'isTokenSupported', [GATEWAY_ARC.usdcInterface], blockTag),
  ]);
  const domain = domainValue === null ? null : Number(domainValue);
  return {
    address,
    codePresent,
    domain,
    usdcSupported,
    verified: codePresent === true && Number.isSafeInteger(domain) && domain > 0 && usdcSupported === true,
  };
}

function sumRawByToken(events) {
  const totals = new Map();
  for (const event of events) totals.set(event.token, (totals.get(event.token) ?? 0n) + BigInt(event.valueRaw));
  return Object.fromEntries([...totals].map(([token, amount]) => [token, amount.toString(10)]));
}

export async function buildGatewaySnapshot({ phase1aSnapshot, rpc = createArcRpcClient() } = {}) {
  const context = snapshotContext(phase1aSnapshot);
  const warnings = [];
  if (!context.complete) warnings.push('Complete Phase 1A Arc receipt/log snapshot unavailable.');
  const rpcAllowed = context.complete && rpc?.url === ARC_RPC_URL;
  const blockTag = context.blockRange?.blockTag;
  const [wallet, minter, tokenMetadata] = rpcAllowed
    ? await Promise.all([
      verifyDeployment(rpc, WALLET, blockTag),
      verifyDeployment(rpc, MINTER, blockTag),
      verifyErc20Metadata(rpc, GATEWAY_ARC.usdcInterface, { blockTag }),
    ])
    : [
      { address: WALLET, codePresent: null, domain: null, usdcSupported: null, verified: false },
      { address: MINTER, codePresent: null, domain: null, usdcSupported: null, verified: false },
      null,
    ];
  const verifiedDomain = wallet.verified && minter.verified && wallet.domain === minter.domain ? wallet.domain : null;
  if (!wallet.verified) warnings.push('GatewayWallet code, domain, or USDC support view unavailable.');
  if (!minter.verified) warnings.push('GatewayMinter code, domain, or USDC support view unavailable.');
  if (wallet.verified && minter.verified && wallet.domain !== minter.domain) warnings.push('Gateway wallet/minter domains disagree.');
  if (tokenMetadata?.status !== 'verified') warnings.push('Arc USDC ERC20 interface metadata unavailable at requestedEnd.');

  const deposits = [];
  const burns = [];
  const attestations = [];
  const withdrawalInitiated = [];
  const withdrawalCompleted = [];
  let malformedEventCount = 0;
  if (context.usable) for (const log of phase1aSnapshot.logs) {
    const decoded = decodeGatewayEvent(log, verifiedDomain);
    if (decoded === undefined) continue;
    if (decoded === null) {
      malformedEventCount += 1;
      continue;
    }
    if (decoded.type === 'deposited') deposits.push(decoded);
    else if (decoded.type === 'gatewayBurned') burns.push(decoded);
    else if (decoded.type === 'attestationUsed') attestations.push(decoded);
    else if (decoded.type === 'withdrawalInitiated') withdrawalInitiated.push(decoded);
    else withdrawalCompleted.push(decoded);
  }
  if (malformedEventCount) warnings.push(`${malformedEventCount} recognized official Gateway event(s) failed strict ABI validation.`);
  const burnHashes = new Set(burns.map((event) => event.transferSpecHash));
  const linkedTransferSpecHashes = [...new Set(attestations
    .map((event) => event.transferSpecHash)
    .filter((hash) => burnHashes.has(hash)))];
  const arcLegEventScanComplete = context.complete && malformedEventCount === 0;
  const complete = arcLegEventScanComplete && verifiedDomain !== null && tokenMetadata?.status === 'verified';
  return {
    protocol: 'circle.gateway',
    definitionVersion: GATEWAY_DEFINITION_VERSION,
    chainId: ARC_CHAIN_ID,
    source: rpc?.url ?? ARC_RPC_URL,
    blockRange: context.blockRange,
    wallet,
    minter,
    verifiedDomain,
    contractVerification: { walletVerified: wallet.verified, minterVerified: minter.verified, sharedDomainVerified: verifiedDomain !== null },
    deposits,
    burns,
    attestations,
    withdrawals: { initiated: withdrawalInitiated, completed: withdrawalCompleted },
    linkedTransferSpecHashes,
    eventCounts: {
      gatewayDepositCount: deposits.length,
      gatewayBurnCount: burns.length,
      gatewayAttestationCount: attestations.length,
      withdrawalInitiatedCount: withdrawalInitiated.length,
      withdrawalCompletedCount: withdrawalCompleted.length,
      malformedEventCount,
    },
    gatewayDepositRawByToken: sumRawByToken(deposits),
    tokenMetadata: tokenMetadata ?? { address: GATEWAY_ARC.usdcInterface, status: 'unknown/unverified' },
    arcLegEventScanComplete,
    crossChainCompletionCoverage: { status: 'unavailable', reason: 'Arc-only logs do not prove end-to-end cross-domain completion.' },
    warnings,
    complete,
  };
}
