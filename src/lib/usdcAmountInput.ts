import { formatUnits, parseUnits } from 'viem'

export type UsdcAmountInput = { value: string; raw: bigint } | { error: string }

// A typed USDC amount, accepting either decimal separator (iPhone keyboards in many
// locales type "0,1"). The result is one canonical decimal string used for the fee
// quote, the Review and the signed transfer alike.
// Rejected: thousand separators, both or repeated separators, spaces, more than 6
// decimals, zero, and the ambiguous "1.500" / "1,500" (a decimal in one locale, a
// thousands group in another).
export function parseUsdcAmountInput(input: string): UsdcAmountInput {
  const text = input.trim()
  if (!text) return { error: 'Enter an amount.' }
  const match = /^(\d*)([.,])?(\d*)$/.exec(text)
  if (!match) return { error: 'Use digits with one decimal separator, e.g. 0.1 or 0,1. Thousand separators are not accepted.' }
  const [, whole, separator, fraction] = match
  if (!whole && !fraction) return { error: 'Enter an amount.' }
  if (separator && !fraction) return { error: 'Add the decimals after the separator, e.g. 0.1 or 0,1.' }
  if (fraction.length > 6) return { error: 'USDC has at most 6 decimals.' }
  if (separator && fraction.length === 3 && /[1-9]/.test(whole)) {
    const trimmed = fraction.replace(/0+$/, ''), example = trimmed ? `${whole}${separator}${trimmed}` : whole
    return { error: `“${text}” is ambiguous (a decimal or a thousands group). Write ${example}; thousand separators are not accepted.` }
  }
  const raw = parseUnits(`${whole || '0'}.${fraction || '0'}`, 6)
  if (raw <= 0n) return { error: 'Enter an amount greater than 0.' }
  return { value: formatUnits(raw, 6), raw }
}
