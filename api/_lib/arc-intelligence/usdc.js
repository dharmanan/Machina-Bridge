import { ARC_VERIFIED_ASSETS } from './assets.js';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const USDC_ASSET = ARC_VERIFIED_ASSETS.find((asset) => asset.symbol === 'USDC');
export const USDC_ERC20_ADDRESS = USDC_ASSET.address;
export const USDC_SYSTEM_EMITTER = USDC_ASSET.interfaces.canonicalTransferEmitter;

function transferAmountRaw(log) {
  if (!/^0x[0-9a-f]{64}$/i.test(log.data)) return null;
  return BigInt(log.data).toString(10);
}

function topicAddress(topic) {
  if (typeof topic !== 'string' || !/^0x0{24}[0-9a-f]{40}$/i.test(topic)) return null;
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function isTransferShape(log) {
  return log?.topics?.length === 3
    && topicAddress(log.topics[1]) !== null
    && topicAddress(log.topics[2]) !== null;
}

export function isCanonicalUsdcLog(log) {
  return log?.address?.toLowerCase() === USDC_SYSTEM_EMITTER
    && log?.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC;
}

export function summarizeUsdcTransfers(logs, { complete = true } = {}) {
  let count = 0;
  let amount = 0n;
  let mintCount = 0;
  let burnCount = 0;
  let malformedCanonicalCount = 0;
  let malformedInterfaceCount = 0;
  let erc20InterfaceCount = 0;
  let erc20InterfaceAmount = 0n;

  for (const log of logs) {
    if (log?.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (log.address?.toLowerCase() === USDC_ERC20_ADDRESS) {
      const interfaceAmount = isTransferShape(log) ? transferAmountRaw(log) : null;
      if (interfaceAmount === null) malformedInterfaceCount += 1;
      else {
        erc20InterfaceCount += 1;
        erc20InterfaceAmount += BigInt(interfaceAmount);
      }
    }
    if (!isCanonicalUsdcLog(log)) continue;

    const raw = isTransferShape(log) ? transferAmountRaw(log) : null;
    if (raw === null) {
      malformedCanonicalCount += 1;
      continue;
    }
    count += 1;
    amount += BigInt(raw);
    if (topicAddress(log.topics[1]) === ZERO_ADDRESS) mintCount += 1;
    if (topicAddress(log.topics[2]) === ZERO_ADDRESS) burnCount += 1;
  }

  const canonicalComplete = complete && malformedCanonicalCount === 0;
  const interfaceComplete = complete && malformedInterfaceCount === 0;
  return {
    emitter: USDC_SYSTEM_EMITTER,
    rawDecimals: 18,
    transferCount: canonicalComplete ? count : null,
    amountRaw: canonicalComplete ? amount.toString(10) : null,
    mintCount: canonicalComplete ? mintCount : null,
    burnCount: canonicalComplete ? burnCount : null,
    erc20InterfaceActivity: {
      emitter: USDC_ERC20_ADDRESS,
      rawDecimals: 6,
      transferCount: interfaceComplete ? erc20InterfaceCount : null,
      amountRaw: interfaceComplete ? erc20InterfaceAmount.toString(10) : null,
      complete: interfaceComplete,
      includedInCanonicalAmount: false,
    },
    complete: canonicalComplete,
    legacyUsdcBackfill: {
      status: 'unavailable',
      reason: 'Legacy NativeCoin event signature/topic has not been verified in the approved source set.',
    },
    warnings: [
      ...(malformedCanonicalCount > 0 ? [`${malformedCanonicalCount} malformed canonical USDC transfer log(s) were excluded.`] : []),
      ...(malformedInterfaceCount > 0 ? [`${malformedInterfaceCount} malformed USDC ERC-20 interface log(s) were excluded.`] : []),
    ],
  };
}
