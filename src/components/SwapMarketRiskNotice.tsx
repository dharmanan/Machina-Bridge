// This canary has transaction/minimum checks, but no verified Arc market-oracle coverage.
// A second venue or a successful simulation must not be labelled a fair-market-price guarantee.
export function SwapMarketRiskNotice() {
  return <div role="note" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950">
    <p className="font-medium">Controlled canary · market price not independently verified</p>
    <p>Check the quoted rate before confirming. Slippage protects the minimum shown; it cannot protect against a poor starting price or a wrapped token losing its backing.</p>
  </div>
}
