// Present Circle Earn Kit's fee quote without inventing zero fees or subtracting
// charges from a deposit/withdrawal amount whose accounting is not specified.
export type EarnFeeLine = { label: string; amount: string; symbol: string; isCircle: boolean }
export type EarnFeeSummary = {
  state: 'reported' | 'missing' | 'invalid'
  circleFees: EarnFeeLine[]
  otherFees: EarnFeeLine[]
  expectedShares: string | null
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

const decimal = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)

function feeLine(value: unknown): EarnFeeLine | null {
  const entry = record(value)
  if (!entry || typeof entry.type !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(entry.type)
    || !decimal(entry.amount) || typeof entry.symbol !== 'string'
    || !/^[a-zA-Z][a-zA-Z0-9._-]{0,20}$/.test(entry.symbol)) return null
  const isCircle = entry.type.toLowerCase() === 'circle'
  return { label: isCircle ? 'Circle service fee' : entry.type + ' fee',
    amount: entry.amount, symbol: entry.symbol, isCircle }
}

export function summarizeEarnQuoteFees(quote: unknown): EarnFeeSummary {
  const data = record(quote)
  const shares = record(data?.expectedShares)
  const expectedShares = shares && decimal(shares.amount) ? shares.amount : null
  if (!data || !Array.isArray(data.fees)) {
    return { state: 'missing', circleFees: [], otherFees: [], expectedShares }
  }
  const lines = data.fees.map(feeLine)
  if (lines.some((line) => line === null)) {
    return { state: 'invalid', circleFees: [], otherFees: [], expectedShares }
  }
  const items = lines as EarnFeeLine[]
  return { state: 'reported', circleFees: items.filter((f) => f.isCircle),
    otherFees: items.filter((f) => !f.isCircle), expectedShares }
}
