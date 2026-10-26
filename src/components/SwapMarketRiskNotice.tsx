// Prices shown are provider quotes, not a verified independent price-oracle bound.
// Keep this limitation visible without pretending a second venue is an oracle.
export function SwapMarketRiskNotice() {
  return <p role="note" className="text-xs leading-5 text-amber-900">
    Price is a provider quote, not independently oracle-verified. Review the rate and minimum output.
  </p>
}
