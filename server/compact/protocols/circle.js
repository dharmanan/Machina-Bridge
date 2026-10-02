// Compact engine: Circle CCTP V2 and Circle Gateway, Arc leg only. Addresses come from the official Arc contract list
// (https://docs.arc.io/arc/references/contract-addresses); event signatures are Circle's (evm-cctp-contracts src/v2, Gateway
// wallet/minter), the same ones the A2 modules api/_lib/arc-intelligence/cctp.js and gateway.js decode with viem. Arc logs
// prove the Arc leg only: a burn here is an outbound leg, a mint here an inbound leg; the other chain's leg is never
// claimed. Amounts are in the Arc USDC ERC-20 interface units (6 decimals). Any other token makes the family unavailable
// rather than being mixed into USDC totals.
import { defineEvent } from '../abi.js';
import { FamilyError } from '../family-error.js';
import { createTally, requireCode, senderOf } from './common.js';

export const CIRCLE_ARC = Object.freeze({
  usdc: '0x3600000000000000000000000000000000000000',
  domain: 26,
  tokenMessenger: '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d',
  messageTransmitter: '0x81d40f21f12a8f0e3252bccb954d722d4c464b64',
  gatewayWallet: '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee',
  gatewayMinter: '0x2222222d7164433c4c09b0b0d809a9b52c04c205',
});
const DOMAIN_LIMIT = 64;

export const CCTP_EVENTS = Object.freeze({
  depositForBurn: defineEvent('event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)'),
  mintAndWithdraw: defineEvent('event MintAndWithdraw(address indexed mintRecipient, uint256 amount, address indexed mintToken, uint256 feeCollected)'),
  messageReceived: defineEvent('event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)'),
});

export const GATEWAY_EVENTS = Object.freeze({
  deposited: defineEvent('event Deposited(address indexed token, address indexed depositor, address indexed sender, uint256 value)'),
  gatewayBurned: defineEvent('event GatewayBurned(address indexed token, address indexed depositor, bytes32 indexed transferSpecHash, uint32 destinationDomain, bytes32 destinationRecipient, address signer, uint256 value, uint256 fee, uint256 fromAvailable, uint256 fromWithdrawing)'),
  attestationUsed: defineEvent('event AttestationUsed(address indexed token, address indexed recipient, bytes32 indexed transferSpecHash, uint32 sourceDomain, bytes32 sourceDepositor, bytes32 sourceSigner, uint256 value)'),
  withdrawalInitiated: defineEvent('event WithdrawalInitiated(address indexed token, address indexed depositor, uint256 value, uint256 remainingAvailable, uint256 totalWithdrawing, uint256 withdrawalBlock)'),
  withdrawalCompleted: defineEvent('event WithdrawalCompleted(address indexed token, address indexed depositor, uint256 value)'),
});

// Each family reads its two contracts in one stream (address list x topic list); every event must still come from the one
// contract that defines it, so a cross combination is refused instead of counted.
function decoded(event, log, family, emitter) {
  if (log.address !== emitter) throw new FamilyError(`unexpected_${family}_emitter`);
  const values = event.decode(log);
  if (!values) throw new FamilyError(`malformed_${family}_event`);
  return values;
}

// CCTP: one DepositForBurn is one outbound transfer (gross burned amount); one MintAndWithdraw is one inbound transfer
// (amount minted to the recipient, with the fee minted separately). MessageReceived is the message envelope of an
// inbound message, counted as messages only, never as additional transfers. MessageSent is not read at all.
function createCctpAccumulator() {
  let outboundTransferCount = 0, outboundAmount = 0n, inboundMintCount = 0, inboundAmount = 0n, inboundFee = 0n, messageReceivedCount = 0;
  const byDestination = createTally({ limit: DOMAIN_LIMIT, code: 'cctp_domain_limit', counts: ['transferCount'], amounts: ['amountRaw'] });
  const bySource = createTally({ limit: DOMAIN_LIMIT, code: 'cctp_domain_limit', counts: ['messageCount'] });
  const outboundSenders = new Set();
  const inboundRecipients = new Set();
  return {
    add(_stream, logs, window) {
      for (const log of logs) {
        if (log.topics[0] === CCTP_EVENTS.depositForBurn.topic) {
          const event = decoded(CCTP_EVENTS.depositForBurn, log, 'cctp', CIRCLE_ARC.tokenMessenger);
          if (event.burnToken !== CIRCLE_ARC.usdc) throw new FamilyError('cctp_unexpected_token');
          outboundTransferCount += 1;
          outboundAmount += event.amount;
          byDestination.add(String(event.destinationDomain), { transferCount: 1, amountRaw: event.amount });
          outboundSenders.add(senderOf(window, log));
        } else if (log.topics[0] === CCTP_EVENTS.mintAndWithdraw.topic) {
          const event = decoded(CCTP_EVENTS.mintAndWithdraw, log, 'cctp', CIRCLE_ARC.tokenMessenger);
          if (event.mintToken !== CIRCLE_ARC.usdc) throw new FamilyError('cctp_unexpected_token');
          inboundMintCount += 1;
          inboundAmount += event.amount;
          inboundFee += event.feeCollected;
          inboundRecipients.add(event.mintRecipient);
        } else {
          const event = decoded(CCTP_EVENTS.messageReceived, log, 'cctp', CIRCLE_ARC.messageTransmitter);
          messageReceivedCount += 1;
          bySource.add(String(event.sourceDomain), { messageCount: 1 });
        }
      }
    },
    async finish(context) {
      requireCode(context, [CIRCLE_ARC.tokenMessenger, CIRCLE_ARC.messageTransmitter], 'cctp_code_unverified');
      return { outboundTransferCount, outboundAmountRaw: outboundAmount.toString(10), outboundByDestinationDomain: byDestination.toObject(),
        uniqueOutboundSenders: outboundSenders.size, inboundMintCount, inboundAmountRaw: inboundAmount.toString(10),
        inboundFeeCollectedRaw: inboundFee.toString(10), uniqueInboundRecipients: inboundRecipients.size, messageReceivedCount,
        messagesBySourceDomain: bySource.toObject() };
    },
  };
}

// Gateway: Deposited funds a unified Gateway balance from Arc; GatewayBurned settles an outbound transfer whose source
// balance is on Arc (destination domain 26 means a same-chain transfer); AttestationUsed mints an inbound transfer on
// Arc. A withdrawal is two events of one lifecycle: only WithdrawalCompleted carries the amount that left; initiations
// are counted, never summed again. Unified balances themselves are off-chain state and are not claimed.
function createGatewayAccumulator() {
  let depositCount = 0, depositAmount = 0n, outboundBurnCount = 0, outboundBurnAmount = 0n, outboundBurnFee = 0n;
  let inboundMintCount = 0, inboundMintAmount = 0n, withdrawalInitiatedCount = 0, withdrawalCompletedCount = 0, withdrawalAmount = 0n;
  const byDestination = createTally({ limit: DOMAIN_LIMIT, code: 'gateway_domain_limit', counts: ['transferCount'], amounts: ['amountRaw'] });
  const bySource = createTally({ limit: DOMAIN_LIMIT, code: 'gateway_domain_limit', counts: ['transferCount'], amounts: ['amountRaw'] });
  const depositors = new Set();
  const inboundRecipients = new Set();
  const usdcOnly = (event) => { if (event.token !== CIRCLE_ARC.usdc) throw new FamilyError('gateway_unexpected_token'); return event; };
  return {
    add(_stream, logs) {
      for (const log of logs) {
        const topic = log.topics[0];
        if (topic === GATEWAY_EVENTS.deposited.topic) {
          const event = usdcOnly(decoded(GATEWAY_EVENTS.deposited, log, 'gateway', CIRCLE_ARC.gatewayWallet));
          depositCount += 1;
          depositAmount += event.value;
          depositors.add(event.depositor);
        } else if (topic === GATEWAY_EVENTS.gatewayBurned.topic) {
          const event = usdcOnly(decoded(GATEWAY_EVENTS.gatewayBurned, log, 'gateway', CIRCLE_ARC.gatewayWallet));
          outboundBurnCount += 1;
          outboundBurnAmount += event.value;
          outboundBurnFee += event.fee;
          byDestination.add(String(event.destinationDomain), { transferCount: 1, amountRaw: event.value });
        } else if (topic === GATEWAY_EVENTS.attestationUsed.topic) {
          const event = usdcOnly(decoded(GATEWAY_EVENTS.attestationUsed, log, 'gateway', CIRCLE_ARC.gatewayMinter));
          inboundMintCount += 1;
          inboundMintAmount += event.value;
          bySource.add(String(event.sourceDomain), { transferCount: 1, amountRaw: event.value });
          inboundRecipients.add(event.recipient);
        } else if (topic === GATEWAY_EVENTS.withdrawalInitiated.topic) {
          usdcOnly(decoded(GATEWAY_EVENTS.withdrawalInitiated, log, 'gateway', CIRCLE_ARC.gatewayWallet));
          withdrawalInitiatedCount += 1;
        } else {
          const event = usdcOnly(decoded(GATEWAY_EVENTS.withdrawalCompleted, log, 'gateway', CIRCLE_ARC.gatewayWallet));
          withdrawalCompletedCount += 1;
          withdrawalAmount += event.value;
        }
      }
    },
    async finish(context) {
      requireCode(context, [CIRCLE_ARC.gatewayWallet, CIRCLE_ARC.gatewayMinter], 'gateway_code_unverified');
      return { depositCount, depositAmountRaw: depositAmount.toString(10), uniqueDepositors: depositors.size, outboundBurnCount,
        outboundBurnAmountRaw: outboundBurnAmount.toString(10), outboundBurnFeeRaw: outboundBurnFee.toString(10),
        outboundByDestinationDomain: byDestination.toObject(), inboundMintCount, inboundMintAmountRaw: inboundMintAmount.toString(10),
        inboundBySourceDomain: bySource.toObject(), uniqueInboundRecipients: inboundRecipients.size, withdrawalInitiatedCount,
        withdrawalCompletedCount, withdrawalAmountRaw: withdrawalAmount.toString(10) };
    },
  };
}

const transferTally = { counts: ['transferCount'], amounts: ['amountRaw'] };

export const CCTP_FAMILY = Object.freeze({
  name: 'cctp',
  version: 'circle-cctp-v2-arc-leg-v1',
  streams: [{ key: 'cctp', address: [CIRCLE_ARC.tokenMessenger, CIRCLE_ARC.messageTransmitter],
    topics: [CCTP_EVENTS.depositForBurn.topic, CCTP_EVENTS.mintAndWithdraw.topic, CCTP_EVENTS.messageReceived.topic] }],
  codeAddresses: [CIRCLE_ARC.tokenMessenger, CIRCLE_ARC.messageTransmitter],
  fields: ['outboundTransferCount', 'outboundAmountRaw', 'outboundByDestinationDomain', 'uniqueOutboundSenders', 'inboundMintCount',
    'inboundAmountRaw', 'inboundFeeCollectedRaw', 'uniqueInboundRecipients', 'messageReceivedCount', 'messagesBySourceDomain'],
  window: {
    counts: ['outboundTransferCount', 'inboundMintCount', 'messageReceivedCount'],
    amounts: ['outboundAmountRaw', 'inboundAmountRaw', 'inboundFeeCollectedRaw'],
    tallies: { outboundByDestinationDomain: transferTally, messagesBySourceDomain: { counts: ['messageCount'] } },
  },
  create: createCctpAccumulator,
});

export const GATEWAY_FAMILY = Object.freeze({
  name: 'gateway',
  version: 'circle-gateway-arc-leg-v1',
  streams: [{ key: 'gateway', address: [CIRCLE_ARC.gatewayWallet, CIRCLE_ARC.gatewayMinter],
    topics: Object.values(GATEWAY_EVENTS).map((event) => event.topic) }],
  codeAddresses: [CIRCLE_ARC.gatewayWallet, CIRCLE_ARC.gatewayMinter],
  fields: ['depositCount', 'depositAmountRaw', 'uniqueDepositors', 'outboundBurnCount', 'outboundBurnAmountRaw', 'outboundBurnFeeRaw',
    'outboundByDestinationDomain', 'inboundMintCount', 'inboundMintAmountRaw', 'inboundBySourceDomain', 'uniqueInboundRecipients',
    'withdrawalInitiatedCount', 'withdrawalCompletedCount', 'withdrawalAmountRaw'],
  window: {
    counts: ['depositCount', 'outboundBurnCount', 'inboundMintCount', 'withdrawalInitiatedCount', 'withdrawalCompletedCount'],
    amounts: ['depositAmountRaw', 'outboundBurnAmountRaw', 'outboundBurnFeeRaw', 'inboundMintAmountRaw', 'withdrawalAmountRaw'],
    tallies: { outboundByDestinationDomain: transferTally, inboundBySourceDomain: transferTally },
  },
  create: createGatewayAccumulator,
});
