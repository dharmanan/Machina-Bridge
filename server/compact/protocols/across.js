// Compact engine: Across V3 SpokePool on Arc, Arc leg only. Address from the official Across contract list
// (https://docs.across.to/chains-and-contracts, ARC#5042); event signatures from Across V3SpokePoolInterface.sol, the same
// ones api/_lib/arc-intelligence/p1b-registry.js decodes with viem. A user flow is one FundsDeposited on its origin chain
// and one FilledRelay on its destination chain, so on Arc: a deposit is an outbound flow (Arc is the origin), a fill an
// inbound one (Arc is the destination); each is counted once. Relayer refunds and pool settlement (ExecutedRelayerRefundRoot,
// TokensBridged) are not user flows and are not read; slow fills are fills and are counted once, then broken out.
// Amounts are raw units of the token named in the event; tokens are never mixed.
import { defineEvent } from '../abi.js';
import { FamilyError } from '../family-error.js';
import { bytes32Address, createTally, requireCode } from './common.js';

export const ACROSS_ARC = Object.freeze({ spokePool: '0x9b4a302a548c7e313c2b74c461db7b84d3074a84' });
const KEY_LIMIT = 64;
const SLOW_FILL = 2n; // FillType.SlowFill; 0 FastFill and 1 ReplacedSlowFill are relayer fills

export const ACROSS_EVENTS = Object.freeze({
  fundsDeposited: defineEvent('event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)'),
  filledRelay: defineEvent('event FilledRelay(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 repaymentChainId, uint256 indexed originChainId, uint256 indexed depositId, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 exclusiveRelayer, bytes32 indexed relayer, bytes32 depositor, bytes32 recipient, bytes32 messageHash, (bytes32 updatedRecipient, bytes32 updatedMessageHash, uint256 updatedOutputAmount, uint8 fillType) relayExecutionInfo)'),
});

// On Arc every token and account in these events is an EVM address; anything else is not an Arc leg we can attribute.
function arcAddress(value) {
  const address = bytes32Address(value);
  if (!address) throw new FamilyError('across_non_evm_address');
  return address;
}

function createAcrossAccumulator() {
  let depositCount = 0, fillCount = 0, slowFillCount = 0;
  const depositByToken = createTally({ limit: KEY_LIMIT, code: 'across_key_limit', counts: ['depositCount'], amounts: ['inputAmountRaw'] });
  const depositByDestination = createTally({ limit: KEY_LIMIT, code: 'across_key_limit', counts: ['depositCount'] });
  const fillByToken = createTally({ limit: KEY_LIMIT, code: 'across_key_limit', counts: ['fillCount'], amounts: ['outputAmountRaw'] });
  const fillByOrigin = createTally({ limit: KEY_LIMIT, code: 'across_key_limit', counts: ['fillCount'] });
  const depositors = new Set();
  const recipients = new Set();
  return {
    add(_stream, logs) {
      for (const log of logs) {
        if (log.topics[0] === ACROSS_EVENTS.fundsDeposited.topic) {
          const event = ACROSS_EVENTS.fundsDeposited.decode(log);
          if (!event) throw new FamilyError('malformed_across_event');
          depositCount += 1;
          depositByToken.add(arcAddress(event.inputToken), { depositCount: 1, inputAmountRaw: event.inputAmount });
          depositByDestination.add(event.destinationChainId.toString(10), { depositCount: 1 });
          depositors.add(arcAddress(event.depositor));
        } else {
          const event = ACROSS_EVENTS.filledRelay.decode(log);
          if (!event || event.relayExecutionInfo.fillType > SLOW_FILL) throw new FamilyError('malformed_across_event');
          fillCount += 1;
          if (event.relayExecutionInfo.fillType === SLOW_FILL) slowFillCount += 1;
          // The executed fill pays updatedOutputAmount to updatedRecipient (equal to the originals unless the depositor sped it up).
          fillByToken.add(arcAddress(event.outputToken), { fillCount: 1, outputAmountRaw: event.relayExecutionInfo.updatedOutputAmount });
          fillByOrigin.add(event.originChainId.toString(10), { fillCount: 1 });
          recipients.add(arcAddress(event.relayExecutionInfo.updatedRecipient));
        }
      }
    },
    async finish(context) {
      requireCode(context, [ACROSS_ARC.spokePool], 'across_code_unverified');
      return { depositCount, depositByToken: depositByToken.toObject(), depositByDestinationChain: depositByDestination.toObject(),
        uniqueDepositors: depositors.size, fillCount, slowFillCount, fillByToken: fillByToken.toObject(),
        fillByOriginChain: fillByOrigin.toObject(), uniqueFillRecipients: recipients.size };
    },
  };
}

export const ACROSS_FAMILY = Object.freeze({
  name: 'across',
  version: 'across-v3-spoke-pool-arc-leg-v1',
  streams: [{ key: 'acrossSpokePool', address: [ACROSS_ARC.spokePool],
    topics: [ACROSS_EVENTS.fundsDeposited.topic, ACROSS_EVENTS.filledRelay.topic] }],
  codeAddresses: [ACROSS_ARC.spokePool],
  fields: ['depositCount', 'depositByToken', 'depositByDestinationChain', 'uniqueDepositors', 'fillCount', 'slowFillCount', 'fillByToken',
    'fillByOriginChain', 'uniqueFillRecipients'],
  window: {
    counts: ['depositCount', 'fillCount', 'slowFillCount'],
    tallies: { depositByToken: { counts: ['depositCount'], amounts: ['inputAmountRaw'] }, depositByDestinationChain: { counts: ['depositCount'] },
      fillByToken: { counts: ['fillCount'], amounts: ['outputAmountRaw'] }, fillByOriginChain: { counts: ['fillCount'] } },
  },
  create: createAcrossAccumulator,
});
