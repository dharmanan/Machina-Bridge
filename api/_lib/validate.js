const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH_REGEX = /^0x([A-Fa-f0-9]{64})$/;

export function isValidEvmAddress(value) {
  return typeof value === 'string' && EVM_ADDRESS_REGEX.test(value);
}

export function isValidTxHash(value) {
  return typeof value === 'string' && TX_HASH_REGEX.test(value);
}

export function toPositiveNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}
