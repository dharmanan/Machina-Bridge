// The Swap screen speaks in plain words. The controllers and checks produce precise messages (nonce readings, contract identity, the
// simulation, the provider's instructions); a person needs to know what happened and what to do, not those terms. Each technical message is
// mapped to a plain one here; messages that are already plain pass through unchanged, and the original text is kept for the closed
// "Technical details" disclosure. A new message that matches no rule is shown as-is rather than hidden.
// Order matters: the first rule that matches wins, so the specific messages come before the general ones (a replaced swap mentions a
// nonce too, but it was sent; a binding mismatch names the nonce among other fields).
const RULES: [RegExp, string][] = [
  [/^Review nonce check:.*method unsupported/i, 'Swap review is blocked because your wallet does not support a required read. No swap transaction was requested. Any confirmed token approval is unchanged.'],
  [/^Review nonce check:.*timed out/i, 'The wallet read timed out while preparing this swap review. No swap transaction was requested. Any confirmed token approval is unchanged. Try Review Swap again in a moment.'],
  [/^Review nonce check:.*invalid EIP-1193 response/i, 'Your wallet returned an invalid response while preparing this swap review. No swap transaction was requested. Any confirmed token approval is unchanged.'],
  [/^Review nonce check:.*another pending transaction/i, 'Swap review is blocked by a pending wallet transaction. Wait for it to finish. No swap transaction was requested; any confirmed token approval is unchanged.'],
  [/^Review nonce check:.*disagree|^Review nonce check:.*inconsistent eth_getTransactionCount/i, 'Your wallet and Arc do not report a consistent transaction state for this swap review. No swap transaction was requested. Any confirmed token approval is unchanged. Try Review Swap again in a moment.'],
  [/^Review nonce check:/i, 'The wallet checks for this swap review could not be verified. No swap transaction was requested. Any confirmed token approval is unchanged. Try Review Swap again in a moment.'],
  [/^Confirm nonce check:/i, 'The final wallet checks for this swap could not be verified. No swap transaction was requested. Any confirmed token approval is unchanged. Review a fresh swap before continuing.'],
  [/^Approval nonce check:/i, 'The wallet checks for this token approval could not be verified. No new approval transaction was requested. Previously confirmed approvals are unchanged.'],
  [/nonce was used by another transaction/i, 'This swap was replaced in your wallet (for example by a speed-up or cancel). Paste the hash your wallet shows for the replacement. It is only accepted if it is the swap you reviewed.'],
  [/does not know that hash/i, 'Arc doesn’t know that transaction hash (yet), so it was not saved. Check the hash in your wallet or on Arc Explorer and paste it again.'],
  [/does not identify the reviewed|hash differ/i, 'This transaction doesn’t match the swap you reviewed, so it isn’t counted as this swap. You can look at it on Arc Explorer. Please don’t send another swap until the earlier one is settled.'],
  [/Another swap from this wallet \(the other provider\)/i, 'Another swap from this wallet is still being verified. Wait for it to finish before starting a new one.'],
  [/unresolved|earlier wallet request/i, 'An earlier swap is still being verified. Wait for its result before starting a new one.'],
  [/Automatic checks stopped/i, 'We stopped checking automatically after repeated network trouble. This doesn’t mean the swap failed. Use Check status to try again; please don’t send it again.'],
  [/could not be read just now|network or RPC trouble|read problem/i, 'We couldn’t reach the network just now. This doesn’t mean the swap failed. We’ll keep checking; please don’t send it again.'],
  [/account nonce changed since Review/i, 'Your wallet sent another transaction since this review, so nothing was requested. Please review the swap again.'],
  [/another pending transaction for this account/i, 'Your wallet has another transaction that is still pending. Wait for it to finish, then try again. Nothing was sent.'],
  [/nonce|transaction count|latest\/pending|wallet RPC|Public Arc RPC|wallet network or account/i, 'We couldn’t confirm your wallet’s state just now, so nothing was sent. Please try again in a moment.'],
  [/pinned|adapter contract|implementation behind it/i, 'The swap contract on Arc isn’t the one this app has checked, so the swap was not started. Nothing was sent.'],
  [/simulation reverted|would fail on chain|simulated swap|test run of this exact swap/i, 'Arc says this swap wouldn’t work right now, so it was not sent to your wallet. Nothing was sent. Please review a fresh swap.'],
  [/swap instructions that differ/i, 'The provider returned a swap that doesn’t match what you reviewed, so it was not sent to your wallet. Nothing was sent.'],
  [/Universal Router on Arc no longer matches/i, 'Uniswap swaps are paused because its contract on Arc changed. Quotes are switched off.'],
  [/no pool route with liquidity/i, 'Uniswap has no available route for this pair and amount.'],
  [/contract, balance|balance, fees, contract identity/i, 'We couldn’t verify the balance and fees for this swap just now. Nothing was sent. Please try again.'],
  [/delegated wallets|EOAs only|externally owned wallets only/i, 'Smart-contract wallets aren’t supported for swaps yet. Please use a regular wallet account.'],
  [/Execution is restricted|restricted to the configured pilot/i, 'Swaps are limited to the approved wallet and USDC → EURC (up to 0.1 USDC) in this build. Quotes are still shown.'],
  [/Submission or confirmation is not yet verified/i, 'We haven’t confirmed the result yet. This doesn’t mean it failed. Please check your wallet and don’t send it again.'],
]
export function plainMessage(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined
  for (const [pattern, plain] of RULES) if (pattern.test(raw)) return plain
  return raw
}
