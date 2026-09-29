import { ARC_ASSETS_BY_ADDRESS, ARC_VERIFIED_ASSETS } from './assets.js';
import { normalizeAddress } from './normalize.js';
import { summarizeUsdcTransfers, TRANSFER_TOPIC, USDC_SYSTEM_EMITTER, ZERO_ADDRESS } from './usdc.js';

const ERC20_SELECTORS = Object.freeze({
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  totalSupply: '0x18160ddd',
});

function stripHex(value) {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) return null;
  return value.slice(2).toLowerCase();
}

function decodeAbiString(value) {
  const hex = stripHex(value);
  if (hex === null) return null;

  try {
    if (hex.length >= 128) {
      const offset = BigInt(`0x${hex.slice(0, 64)}`);
      if (offset < 32n || offset % 32n !== 0n || offset > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      const offsetChars = Number(offset) * 2;
      if (offsetChars + 64 > hex.length) return null;
      const length = BigInt(`0x${hex.slice(offsetChars, offsetChars + 64)}`);
      if (length > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      const byteLength = Number(length);
      const start = offsetChars + 64;
      const end = start + (byteLength * 2);
      if (end > hex.length) return null;
      const bytes = Uint8Array.from(hex.slice(start, end).match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\0+$/g, '');
      return decoded.length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(decoded) ? decoded : null;
    }

    if (hex.length === 64) {
      const bytes = Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\0+$/g, '');
      return decoded.length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(decoded) ? decoded : null;
    }
  } catch {
    return null;
  }

  return null;
}

function decodeUint(value) {
  const hex = stripHex(value);
  if (hex === null || hex.length !== 64) return null;
  try {
    return BigInt(`0x${hex.slice(0, 64)}`).toString(10);
  } catch {
    return null;
  }
}

function metadataCall(to, data) {
  return { to, data };
}

async function readField(rpc, address, method) {
  try {
    const result = await rpc.request('eth_call', [metadataCall(address, ERC20_SELECTORS[method]), 'latest']);
    if (method === 'name' || method === 'symbol') return decodeAbiString(result);
    const uint = decodeUint(result);
    if (uint === null) return null;
    if (method === 'decimals') {
      const decimals = BigInt(uint);
      return decimals <= 255n ? Number(decimals) : null;
    }
    return uint;
  } catch {
    return null;
  }
}

export async function verifyErc20Metadata(rpc, inputAddress) {
  let address;
  try {
    address = normalizeAddress(inputAddress);
  } catch {
    return { address: null, status: 'unknown/unverified', codePresent: false, name: null, symbol: null, decimals: null, totalSupplyRaw: null };
  }

  const codePromise = rpc.request('eth_getCode', [address, 'latest'])
    .then((code) => typeof code === 'string' && /^0x(?!0*$)[0-9a-f]+$/i.test(code))
    .catch(() => false);
  const [codePresent, name, symbol, decimals, totalSupplyRaw] = await Promise.all([
    codePromise,
    readField(rpc, address, 'name'),
    readField(rpc, address, 'symbol'),
    readField(rpc, address, 'decimals'),
    readField(rpc, address, 'totalSupply'),
  ]);

  const valid = codePresent
    && typeof name === 'string'
    && typeof symbol === 'string'
    && Number.isSafeInteger(decimals)
    && decimals >= 0
    && decimals <= 255
    && typeof totalSupplyRaw === 'string';

  return {
    address,
    status: valid ? 'verified' : 'unknown/unverified',
    codePresent,
    name: valid ? name : null,
    symbol: valid ? symbol : null,
    decimals: valid ? decimals : null,
    totalSupplyRaw: valid ? totalSupplyRaw : null,
  };
}

export async function mapConcurrent(items, concurrency, worker) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError('Invalid concurrency');
  const results = new Array(items.length);
  let next = 0;
  async function runWorker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()));
  return results;
}

function transferLogs(logs) {
  return logs.filter((log) => log.topics?.[0] === TRANSFER_TOPIC);
}

export async function discoverTransferEmitters(rpc, logs, { maxCandidates = 50, concurrency = 3 } = {}) {
  const emitters = [...new Set(transferLogs(logs)
    .map((log) => log.address.toLowerCase())
    .filter((address) => address !== USDC_SYSTEM_EMITTER))]
    .sort();
  const selected = emitters.slice(0, maxCandidates);
  const records = await mapConcurrent(selected, concurrency, (address) => verifyErc20Metadata(rpc, address));
  const byAddress = new Map(records.map((record) => [record.address, record]));

  return {
    emitters,
    records,
    byAddress,
    verifiedCount: records.filter((record) => record.status === 'verified').length,
    unverifiedCount: emitters.length - records.filter((record) => record.status === 'verified').length,
    truncatedCount: Math.max(0, emitters.length - selected.length),
  };
}

function transferAmount(log) {
  if (!/^0x[0-9a-f]{64}$/i.test(log.data)) return null;
  try {
    return BigInt(log.data);
  } catch {
    return null;
  }
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

function blankTotals() {
  return { transferCount: 0, amountRaw: 0n, mintCount: 0, burnCount: 0, malformedCount: 0 };
}

export function summarizeVerifiedAssetTransfers(logs, { complete = true } = {}) {
  const totals = new Map(ARC_VERIFIED_ASSETS.map((asset) => [asset.address, blankTotals()]));
  const tokenAddress = new Map(ARC_VERIFIED_ASSETS.map((asset) => [asset.address, asset]));

  for (const log of transferLogs(logs)) {
    const address = log.address.toLowerCase();
    const asset = tokenAddress.get(address);
    if (!asset || asset.symbol === 'USDC') continue;
    const amount = isTransferShape(log) ? transferAmount(log) : null;
    const total = totals.get(address);
    if (amount === null) {
      total.malformedCount += 1;
      continue;
    }
    total.transferCount += 1;
    total.amountRaw += amount;
    if (topicAddress(log.topics[1]) === ZERO_ADDRESS) total.mintCount += 1;
    if (topicAddress(log.topics[2]) === ZERO_ADDRESS) total.burnCount += 1;
  }

  return ARC_VERIFIED_ASSETS.map((asset) => {
    if (asset.symbol === 'USDC') {
      const canonical = summarizeUsdcTransfers(logs, { complete });
      return {
        chainId: asset.chainId,
        address: asset.address,
        symbol: asset.symbol,
        decimals: asset.decimals,
        rawDecimals: asset.interfaces.nativeDecimals,
        transferCount: canonical.transferCount,
        amountRaw: canonical.amountRaw,
        mintCount: canonical.mintCount,
        burnCount: canonical.burnCount,
        complete: canonical.complete,
        source: canonical.emitter,
      };
    }
    const total = totals.get(asset.address);
    const isComplete = complete && total.malformedCount === 0;
    return {
      chainId: asset.chainId,
      address: asset.address,
      symbol: asset.symbol,
      decimals: asset.decimals,
      rawDecimals: asset.decimals,
      transferCount: isComplete ? total.transferCount : null,
      amountRaw: isComplete ? total.amountRaw.toString(10) : null,
      mintCount: isComplete ? total.mintCount : null,
      burnCount: isComplete ? total.burnCount : null,
      complete: isComplete,
      source: asset.address,
    };
  });
}

export async function inspectMajorAssets(rpc, { concurrency = 3 } = {}) {
  return mapConcurrent(ARC_VERIFIED_ASSETS, concurrency, async (asset) => {
    const observed = await verifyErc20Metadata(rpc, asset.address);
    const matchesRegistry = observed.status === 'verified'
      && observed.symbol.toUpperCase() === asset.symbol.toUpperCase()
      && observed.decimals === asset.decimals;
    return {
      address: asset.address,
      symbol: asset.symbol,
      decimals: asset.decimals,
      category: asset.category,
      registryVerification: asset.verification,
      liveCodePresent: observed.codePresent,
      liveMetadataStatus: observed.status,
      liveMetadataMatchesRegistry: matchesRegistry,
      observedSymbol: observed.symbol,
      observedDecimals: observed.decimals,
      totalSupplyRaw: observed.totalSupplyRaw,
    };
  });
}

export function formatEmitterMetadataSummary(records) {
  return records.map((record) => ({
    address: record.address,
    status: record.status,
    name: record.name,
    symbol: record.symbol,
    decimals: record.decimals,
    totalSupplyRaw: record.totalSupplyRaw,
    registryAsset: ARC_ASSETS_BY_ADDRESS.get(record.address)?.symbol ?? null,
  }));
}
