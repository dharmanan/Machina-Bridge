import {
  decodeEventLog,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbiItem,
  toEventSelector,
} from 'viem';

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const WORD = /^0x[0-9a-f]{64}$/i;

export function eventTopic(abi) {
  return toEventSelector(abi).toLowerCase();
}

export function decodeOfficialEvent(log, abi) {
  if (log?.topics?.[0]?.toLowerCase() !== eventTopic(abi)) return undefined;
  if (!ADDRESS.test(log.address ?? '')
    || !Array.isArray(log.topics)
    || log.topics.length !== 1 + abi.inputs.filter((input) => input.indexed).length
    || !log.topics.every((topic) => HASH.test(topic))
    || !/^0x(?:[0-9a-f]{2})*$/i.test(log.data ?? '')
    || !Number.isSafeInteger(log.blockNumber)
    || !Number.isSafeInteger(log.logIndex)
    || !HASH.test(log.transactionHash ?? '')) return null;
  try {
    const { args } = decodeEventLog({ abi: [abi], data: log.data, topics: log.topics, strict: true });
    const unindexed = abi.inputs.filter((input) => !input.indexed);
    if (encodeAbiParameters(unindexed, unindexed.map((input) => args[input.name])).toLowerCase() !== log.data.toLowerCase()) return null;
    let topicIndex = 1;
    for (const input of abi.inputs.filter((field) => field.indexed)) {
      const topic = log.topics[topicIndex++].toLowerCase();
      if (input.type === 'address' && !/^0x0{24}[0-9a-f]{40}$/.test(topic)) return null;
      if (input.type === 'uint32' && BigInt(topic) > 0xffffffffn) return null;
    }
    return args;
  } catch {
    return null;
  }
}

export function eventIdentity(log, type) {
  return {
    type,
    blockNumber: log.blockNumber,
    transactionIndex: Number.isSafeInteger(log.transactionIndex) ? log.transactionIndex : null,
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex: log.logIndex,
    emitter: log.address.toLowerCase(),
  };
}

export async function readCode(rpc, address, blockTag) {
  try {
    const code = await rpc.request('eth_getCode', [address, blockTag]);
    if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(code)) return null;
    return code.length > 2 && !/^0x0+$/.test(code.toLowerCase());
  } catch {
    return null;
  }
}

export async function readView(rpc, address, signature, functionName, args, blockTag) {
  const abi = [parseAbiItem(signature)];
  try {
    const data = encodeFunctionData({ abi, functionName, args });
    const result = await rpc.request('eth_call', [{ to: address, data }, blockTag]);
    if (!WORD.test(result ?? '')) return null;
    return decodeFunctionResult({ abi, functionName, data: result });
  } catch {
    return null;
  }
}

export function snapshotContext(snapshot) {
  const usable = snapshot?.chainId === 5042
    && Number.isSafeInteger(snapshot?.startBlock)
    && Number.isSafeInteger(snapshot?.endBlock)
    && Array.isArray(snapshot?.logs);
  return {
    usable,
    complete: usable && snapshot.complete === true,
    blockRange: usable ? {
      startBlock: snapshot.startBlock,
      endBlock: snapshot.endBlock,
      blockTag: `0x${snapshot.endBlock.toString(16)}`,
    } : null,
  };
}
