// Additive, optional extension to the v1 Gateway JSON. The v1 fields ALWAYS remain USDC ERC-20 units.
// No SQL/schema/family-version migration is needed; legacy readers ignore the extension.
import { ARC_VERIFIED_ASSETS } from '../../api/_lib/arc-intelligence/assets.js';
import { FamilyError } from './family-error.js';

export const GATEWAY_ASSETS = Object.freeze(ARC_VERIFIED_ASSETS.filter((asset) => ['USDC', 'EURC', 'cirBTC'].includes(asset.symbol)));
export const GATEWAY_USDC = GATEWAY_ASSETS.find((asset) => asset.symbol === 'USDC').address;
export const GATEWAY_TOKEN_FORMAT = 'circle-gateway-token-metrics-v1';
export const GATEWAY_COUNTS = Object.freeze(['depositCount', 'outboundBurnCount', 'inboundMintCount', 'withdrawalInitiatedCount', 'withdrawalCompletedCount']);
export const GATEWAY_AMOUNTS = Object.freeze(['depositAmountRaw', 'outboundBurnAmountRaw', 'outboundBurnFeeRaw', 'inboundMintAmountRaw', 'withdrawalAmountRaw']);
export const GATEWAY_TALLIES = Object.freeze(['outboundByDestinationDomain', 'inboundBySourceDomain']);
export const GATEWAY_FIELDS = Object.freeze([...GATEWAY_COUNTS, ...GATEWAY_AMOUNTS, ...GATEWAY_TALLIES, 'uniqueDepositors', 'uniqueInboundRecipients']);
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = () => { throw new FamilyError('gateway_token_metrics_invalid'); };
const canonical = (v) => JSON.stringify(v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, JSON.parse(canonical(v[key]))])) : v);

function validate(metrics) {
  if (!plain(metrics)) fail();
  for (const field of [...GATEWAY_COUNTS, 'uniqueDepositors', 'uniqueInboundRecipients']) {
    if (!Number.isSafeInteger(metrics[field]) || metrics[field] < 0) fail();
  }
  for (const field of GATEWAY_AMOUNTS) if (typeof metrics[field] !== 'string' || !/^(0|[1-9]\d*)$/.test(metrics[field])) fail();
  for (const field of GATEWAY_TALLIES) {
    if (!plain(metrics[field]) || Object.keys(metrics[field]).length > 64) fail();
    for (const [domain, entry] of Object.entries(metrics[field])) {
      if (!/^(0|[1-9]\d*)$/.test(domain) || BigInt(domain) > 0xffffffffn || !plain(entry)
        || !Number.isSafeInteger(entry.transferCount) || entry.transferCount < 0
        || typeof entry.amountRaw !== 'string' || !/^(0|[1-9]\d*)$/.test(entry.amountRaw)) fail();
    }
  }
  return Object.fromEntries(GATEWAY_FIELDS.map((field) => [field, metrics[field]]));
}

// A legacy successful hour verified USDC only. It is never reinterpreted as a measured multi-token hour.
export function gatewayTokenMetrics(metrics) {
  const usdc = validate(metrics);
  if (!Object.hasOwn(metrics, 'tokenMetrics')) return { legacy: true, byToken: { [GATEWAY_USDC]: usdc } };
  const extension = metrics.tokenMetrics;
  if (!plain(extension) || extension.version !== GATEWAY_TOKEN_FORMAT || !plain(extension.byToken)
    || Object.keys(extension).some((key) => !['version', 'byToken'].includes(key))) fail();
  const byToken = {};
  for (const [token, value] of Object.entries(extension.byToken)) {
    if (!GATEWAY_ASSETS.some((asset) => asset.address === token)) fail();
    byToken[token] = validate(value);
    // Do not silently discard a non-zero token amount as an "inactive" extension when preserving legacy JSON.
    for (const [amount, count] of [['depositAmountRaw', 'depositCount'], ['outboundBurnAmountRaw', 'outboundBurnCount'],
      ['outboundBurnFeeRaw', 'outboundBurnCount'], ['inboundMintAmountRaw', 'inboundMintCount'], ['withdrawalAmountRaw', 'withdrawalCompletedCount']]) {
      if (BigInt(value[amount]) !== 0n && value[count] === 0) fail();
    }
  }
  if (Object.keys(byToken).length !== GATEWAY_ASSETS.length || canonical(byToken[GATEWAY_USDC]) !== canonical(usdc)) fail();
  return { legacy: false, byToken };
}

// USDC-only results keep the EXACT legacy JSON/hash, including on replay of an already committed hour.
// Multi-token results persist the extension in the existing metrics_json column.
export function gatewayStoredMetrics(metrics) {
  const { byToken } = gatewayTokenMetrics(metrics);
  const legacy = validate(metrics);
  return GATEWAY_ASSETS.some((asset) => asset.address !== GATEWAY_USDC
    && GATEWAY_COUNTS.some((field) => byToken[asset.address]?.[field] > 0))
    ? { ...legacy, tokenMetrics: { version: GATEWAY_TOKEN_FORMAT, byToken } } : legacy;
}
