const HEX_QUANTITY = /^0x[0-9a-f]+$/i;
const HEX_DATA = /^0x(?:[0-9a-f]{2})*$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;

export function quantityToBigInt(value, label = 'quantity') {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new RangeError(`${label} must be nonnegative`);
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && HEX_QUANTITY.test(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new TypeError(`Malformed ${label}`);
}

export function quantityToDecimalString(value, label = 'quantity') {
  return quantityToBigInt(value, label).toString(10);
}

export function quantityToSafeNumber(value, label = 'quantity') {
  const integer = quantityToBigInt(value, label);
  if (integer > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${label} exceeds safe integer range`);
  return Number(integer);
}

export function normalizeAddress(value, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || !ADDRESS.test(value)) throw new TypeError('Malformed address');
  return value.toLowerCase();
}

function normalizeHash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) throw new TypeError(`Malformed ${label}`);
  return value.toLowerCase();
}

function normalizeData(value, label = 'data') {
  if (typeof value !== 'string' || !HEX_DATA.test(value)) throw new TypeError(`Malformed ${label}`);
  return value.toLowerCase();
}

export function normalizeBlock(raw, chainId) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.transactions)) {
    throw new TypeError('Malformed block');
  }
  const number = quantityToSafeNumber(raw.number, 'block number');
  const timestamp = quantityToSafeNumber(raw.timestamp, 'block timestamp');
  const transactions = raw.transactions.map((transaction, index) =>
    normalizeTransaction(transaction, { blockNumber: number, transactionIndex: index }),
  ).sort((left, right) => left.blockNumber - right.blockNumber || left.transactionIndex - right.transactionIndex);

  return {
    chainId,
    number,
    hash: normalizeHash(raw.hash, 'block hash'),
    parentHash: normalizeHash(raw.parentHash, 'parent hash'),
    timestamp,
    transactionCount: transactions.length,
    transactions,
  };
}

export function normalizeTransaction(raw, { blockNumber, transactionIndex } = {}) {
  if (!raw || typeof raw !== 'object') throw new TypeError('Malformed transaction');
  const rawBlockNumber = raw.blockNumber ?? blockNumber;
  const rawTransactionIndex = raw.transactionIndex ?? transactionIndex;
  if (rawBlockNumber === undefined || rawTransactionIndex === undefined) {
    throw new TypeError('Transaction is missing block position');
  }
  const input = normalizeData(raw.input ?? raw.data ?? '0x', 'transaction input');
  const hash = normalizeHash(raw.hash, 'transaction hash');

  return {
    hash,
    blockNumber: quantityToSafeNumber(rawBlockNumber, 'transaction block number'),
    transactionIndex: quantityToSafeNumber(rawTransactionIndex, 'transaction index'),
    from: normalizeAddress(raw.from),
    to: normalizeAddress(raw.to, { nullable: true }),
    valueRaw: quantityToDecimalString(raw.value ?? '0x0', 'transaction value'),
    inputSelector: input.length >= 10 ? input.slice(0, 10) : null,
  };
}

export function normalizeLog(raw, defaults = {}) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.topics)) throw new TypeError('Malformed log');
  const blockNumber = raw.blockNumber ?? defaults.blockNumber;
  const transactionIndex = raw.transactionIndex ?? defaults.transactionIndex;
  const logIndex = raw.logIndex ?? defaults.logIndex;
  const transactionHash = raw.transactionHash ?? defaults.transactionHash;
  if (blockNumber === undefined || logIndex === undefined) throw new TypeError('Log is missing block position');

  return {
    address: normalizeAddress(raw.address),
    topics: raw.topics.map((topic) => normalizeHash(topic, 'log topic')),
    data: normalizeData(raw.data),
    blockNumber: quantityToSafeNumber(blockNumber, 'log block number'),
    transactionIndex: transactionIndex === undefined ? null : quantityToSafeNumber(transactionIndex, 'log transaction index'),
    logIndex: quantityToSafeNumber(logIndex, 'log index'),
    transactionHash: transactionHash ? normalizeHash(transactionHash, 'log transaction hash') : null,
    blockHash: raw.blockHash ? normalizeHash(raw.blockHash, 'log block hash') : null,
    removed: raw.removed === true,
  };
}

export function normalizeReceipt(raw, defaults = {}) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.logs)) throw new TypeError('Malformed receipt');
  const hash = normalizeHash(raw.transactionHash ?? defaults.hash, 'receipt transaction hash');
  const blockNumber = raw.blockNumber ?? defaults.blockNumber;
  const transactionIndex = raw.transactionIndex ?? defaults.transactionIndex;
  if (blockNumber === undefined || transactionIndex === undefined) throw new TypeError('Receipt is missing block position');

  let status = 'unknown';
  if (raw.status === '0x1' || raw.status === '0x01') status = 'success';
  if (raw.status === '0x0' || raw.status === '0x00') status = 'failed';

  return {
    hash,
    blockNumber: quantityToSafeNumber(blockNumber, 'receipt block number'),
    transactionIndex: quantityToSafeNumber(transactionIndex, 'receipt transaction index'),
    status,
    gasUsedRaw: quantityToDecimalString(raw.gasUsed, 'receipt gas used'),
    effectiveGasPriceRaw: raw.effectiveGasPrice == null
      ? null
      : quantityToDecimalString(raw.effectiveGasPrice, 'effective gas price'),
    contractAddress: normalizeAddress(raw.contractAddress, { nullable: true }),
    logs: raw.logs.map((log) => normalizeLog(log, {
      blockNumber,
      transactionIndex,
      transactionHash: hash,
    })).sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex),
  };
}
