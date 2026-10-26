import type { WriteCheck } from './borrowWriteSafety'

// What the Borrow screen tells a person, in order of importance. Pure presentation: it only reads the checks the shared safety
// layer already produced (borrowWriteSafety) and picks the one reason that matters most. It never changes, hides or overrides a
// check: every check stays in the technical details and still blocks a transaction exactly as before.

export type StatusTone = 'ready' | 'blocked' | 'waiting' | 'info'

export type BorrowStatusId =
  | 'choose-market'
  | 'connect-wallet'
  | 'enter-amount'
  | 'switch-network'
  | 'wallet-checking'
  | 'wallet-not-supported'
  | 'wallet-not-verified'
  | 'earlier-transaction'
  | 'history-unavailable'
  | 'checking'
  | 'quote-expired'
  | 'quote-unavailable'
  | 'market-unavailable'
  | 'insufficient-liquidity'
  | 'target-not-met'
  | 'ltv-too-high'
  | 'terms-unavailable'
  | 'insufficient-collateral'
  | 'balance-unavailable'
  | 'insufficient-gas'
  | 'loan-check'
  | 'cannot-continue'
  | 'checks-passed'

export type BorrowStatus = {
  id: BorrowStatusId
  tone: StatusTone
  title: string
  detail: string
  // Reading the quote and the data it depends on again (read only) could change this.
  canRefresh: boolean
}

export type StatusInput = {
  marketChosen: boolean
  amountEntered: boolean
  walletConnected: boolean
  // The wallet's answer about atomic transactions on Arc, once connected.
  wallet: 'wrong-network' | 'checking' | 'supported' | 'unsupported' | 'unknown'
  // An earlier write on this market or loan that is not settled, and a history that cannot be trusted, each as a plain sentence. They
  // stop everything, so they are said before an amount is even asked for.
  history: { unresolved: string | null; unreliable: string | null }
  // Reads for this borrow are still on their way.
  checking: boolean
  // The shared safety checks for this borrow, or null while there is nothing to check yet.
  checks: readonly WriteCheck[] | null
  // A plain sentence when the quote itself could not be read.
  quoteFailure: string | null
  // Already formatted for the person: nothing here is computed again.
  facts: {
    collateralSymbol: string
    loanSymbol: string
    collateralBalance: string | null
    collateralNeeded: string | null
    borrowAmount: string | null
    liquidityAvailable: string | null
    estimatedHealthFactor: string | null
    targetHealthFactor: string
    maxLtv: string
  }
}

const status = (id: BorrowStatusId, tone: StatusTone, title: string, detail: string, canRefresh = false): BorrowStatus => ({ id, tone, title, detail, canRefresh })

export function chooseBorrowStatus(input: StatusInput): BorrowStatus {
  const { facts } = input
  if (!input.marketChosen) return status('choose-market', 'info', 'Choose a market', 'Pick a market above to start.')
  if (!input.walletConnected) return status('connect-wallet', 'waiting', 'Connect your wallet', 'Connect a wallet to get a quote for your borrow. Nothing is sent.')
  if (input.history.unresolved) return status('earlier-transaction', 'blocked', 'Earlier transaction not settled', input.history.unresolved)
  if (input.history.unreliable) return status('history-unavailable', 'blocked', 'Transaction history unavailable', input.history.unreliable)
  if (!input.amountEntered) return status('enter-amount', 'info', 'Enter a borrow amount', `Type how much ${facts.loanSymbol} you want to borrow.`)

  // The wallet comes first: no quote or balance matters if it cannot run the transaction.
  switch (input.wallet) {
    case 'wrong-network':
      return status('switch-network', 'blocked', 'Switch to Arc Mainnet', 'Your wallet is on another network. Borrow works on Arc Mainnet (chain 5042).')
    case 'unsupported':
      return status('wallet-not-supported', 'blocked', 'Borrow transport unavailable', 'A fee-bound atomic Borrow transaction is not supported by this wallet connection. An atomic-batch capability alone does not guarantee the maximum network fee. No wallet signature is requested.')
    case 'unknown':
      return status('wallet-not-verified', 'blocked', 'Borrow transport unverified', 'Machina could not verify both atomic execution and enforceable maximum network fees. Borrow stays disabled; no wallet signature is requested.')
    case 'checking':
      return status('wallet-checking', 'waiting', 'Checking your wallet', 'Checking atomic execution and a fee-bound wallet transport on Arc. No signature is requested.')
    default:
      break
  }

  // Nothing has been checked yet: that is never "passed".
  if (input.checks === null || input.checks.length === 0) return status('checking', 'waiting', 'Checking your borrow', 'Reading the quote, the market and your wallet.')

  const bad = input.checks.filter((check) => check.status === 'fail' || check.status === 'unknown')
  const by = (...codes: string[]) => bad.find((check) => check.blocker !== null && codes.includes(check.blocker))
  const failed = (check: WriteCheck | undefined) => check !== undefined && check.status === 'fail'

  // An earlier write that is not settled stops everything on this market or loan, whatever the quote says.
  const earlier = by('attempt_unresolved')
  if (earlier) return status('earlier-transaction', 'blocked', 'Earlier transaction not settled', earlier.text)
  const history = by('attempt_store_unreliable')
  if (history) return status('history-unavailable', 'blocked', 'Transaction history unavailable', history.text)

  if (input.checking) return status('checking', 'waiting', 'Checking your borrow', 'Reading the quote, the market and your wallet.')

  // Old data decides nothing: if any of it has aged out, the terms must be read again before anything else is said.
  if (by('quote_stale', 'evidence_stale')) return status('quote-expired', 'waiting', 'Quote expired', 'Refresh to get current terms.', true)
  if (input.quoteFailure) return status('quote-unavailable', 'blocked', 'Quote unavailable', input.quoteFailure, true)

  const market = by('market_unverified', 'oracle_unavailable', 'market_data_missing', 'position_market_mismatch')
  if (market) {
    return status('market-unavailable', 'blocked', 'Market unavailable',
      failed(market) ? 'This market did not pass Machina\'s on-chain checks. Choose another market.' : 'This market could not be checked against Morpho right now. Refresh, or choose another market.', !failed(market))
  }
  const liquidity = by('insufficient_liquidity', 'liquidity_unknown')
  if (liquidity) {
    return liquidity.blocker === 'insufficient_liquidity'
      ? status('insufficient-liquidity', 'blocked', 'Insufficient liquidity',
        facts.liquidityAvailable !== null && facts.borrowAmount !== null
          ? `This market has ${facts.liquidityAvailable} available and you asked for ${facts.borrowAmount}. Try a smaller amount or another market.`
          : 'This market does not have enough USDC available for this amount. Try a smaller amount or another market.')
      : status('market-unavailable', 'blocked', 'Market unavailable', 'This market\'s available liquidity is not reported, so the amount cannot be checked.', true)
  }
  if (by('health_target_not_met')) {
    return status('target-not-met', 'blocked', 'Target Health Factor not met',
      `Circle's quote gives ${facts.estimatedHealthFactor ?? 'a lower value'} against your ${facts.targetHealthFactor} target. Machina does not lower your target for you.`)
  }
  if (by('ltv_above_limit')) return status('ltv-too-high', 'blocked', 'Borrow too large for its collateral', `This borrow would be above the ${facts.maxLtv} loan-to-value starting limit.`)
  if (by('health_unknown', 'ltv_unknown')) return status('terms-unavailable', 'blocked', 'Terms unavailable', 'The quote does not give enough information to check your Health Factor target.', true)

  if (by('insufficient_balance')) {
    return status('insufficient-collateral', 'blocked', 'Insufficient collateral',
      facts.collateralBalance !== null && facts.collateralNeeded !== null
        ? `Your wallet has ${facts.collateralBalance}. You need ${facts.collateralNeeded} for this borrow.`
        : `Your wallet does not hold enough ${facts.collateralSymbol} for this borrow.`)
  }
  if (by('balance_unknown')) return status('balance-unavailable', 'blocked', 'Wallet balance unavailable', 'Your wallet balance could not be read, so Machina cannot tell whether you have enough collateral.', true)
  if (by('insufficient_gas_balance')) return status('insufficient-gas', 'blocked', 'Not enough for gas', 'Your wallet does not hold enough of the network\'s gas currency (USDC) for this transaction.')

  const loan = by('loan_exists', 'loans_unknown', 'position_missing', 'position_not_owned', 'position_not_active')
  if (loan) return status('loan-check', 'blocked', 'Loan check failed', loan.text, loan.status === 'unknown')

  const other = bad[0]
  if (other) return status('cannot-continue', other.status === 'fail' ? 'blocked' : 'waiting', 'Cannot continue', other.text, other.status === 'unknown')

  return status('checks-passed', 'ready', 'Transaction checks passed', 'Every check for this borrow passes.')
}

// ---------------------------------------------------------------------------------------------------------------------
// Grouping for the technical details

export type CheckGroup = { id: string; title: string; checks: WriteCheck[]; blocked: number; unavailable: number; warnings: number; passed: number }

const GROUPS: { id: string; title: string; ids: readonly string[] }[] = [
  { id: 'wallet', title: 'Wallet and network', ids: ['wallet', 'network', 'wallet-capability', 'wallet-session', 'chain-addresses'] },
  { id: 'market', title: 'Market', ids: ['market', 'market-verified', 'oracle', 'liquidity', 'utilization'] },
  { id: 'quote', title: 'Quote and limits', ids: ['action', 'quote', 'quote-fresh', 'quote-request', 'quote-amounts', 'quote-tokens', 'gas', 'slippage', 'ltv', 'health-target', 'evidence'] },
  { id: 'balances', title: 'Balances', ids: ['balance', 'gas-balance'] },
  { id: 'loan', title: 'Loan', ids: ['position', 'position-owner', 'position-state', 'position-market', 'loan-exists', 'repay-debt', 'close-debt', 'close-collateral', 'withdraw-collateral', 'withdraw-health'] },
  { id: 'history', title: 'Transaction history', ids: ['attempt', 'attempt-log'] },
]

const RANK = { fail: 0, unknown: 1, warn: 2, pass: 3, 'not-applicable': 4 } as const

// Every check lands in exactly one group, with blocked ones first. A check this list does not know goes to "Other", never away.
export function groupWriteChecks(checks: readonly WriteCheck[]): CheckGroup[] {
  const known = new Set(GROUPS.flatMap((group) => group.ids))
  const groups = [...GROUPS.map((group) => ({ id: group.id, title: group.title, members: checks.filter((check) => group.ids.includes(check.id)) })),
    { id: 'other', title: 'Other', members: checks.filter((check) => !known.has(check.id)) }]
  return groups.filter((group) => group.members.length > 0).map((group) => ({
    id: group.id,
    title: group.title,
    checks: group.members.map((check, index) => ({ check, index })).sort((a, b) => RANK[a.check.status] - RANK[b.check.status] || a.index - b.index).map(({ check }) => check),
    blocked: group.members.filter((check) => check.status === 'fail').length,
    unavailable: group.members.filter((check) => check.status === 'unknown').length,
    warnings: group.members.filter((check) => check.status === 'warn').length,
    passed: group.members.filter((check) => check.status === 'pass').length,
  }))
}
