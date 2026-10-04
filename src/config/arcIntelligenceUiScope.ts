// Arc Intelligence UI scope contract. Every permanent capability of the dashboard is listed here with a stable id, and
// the dashboard renders a `data-intel-section` / `data-intel-item` target for each of them in every data state.
// A capability without verified data yet still keeps its place: it shows a calm status, never a fake value.
// scripts/verify-arc-intelligence-dashboard.mjs fails if a section or item disappears from this list or the screen.

export type ArcIntelligenceWindow = '24h' | '7d' | '30d'

export const ARC_INTELLIGENCE_WINDOWS: readonly { id: ArcIntelligenceWindow; label: string }[] = [
  { id: '24h', label: '24H' },
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
]

// Windows the current Intelligence API can answer. Others are rendered with a collecting state and never requested.
export const ARC_INTELLIGENCE_BACKEND_WINDOWS: Readonly<Record<ArcIntelligenceWindow, boolean>> = {
  '24h': true,
  '7d': false,
  '30d': false,
}

export type ArcIntelligenceSectionId =
  | 'network'
  | 'volume-chart'
  | 'active-addresses-chart'
  | 'top-protocols'
  | 'top-pools-v3'
  | 'top-pools-v4'
  | 'recent-activity'
  | 'assets'
  | 'launches'
  | 'borrow'
  | 'lending'
  | 'cross-chain'
  | 'rwa-other'

// live: backed by the current Intelligence API today. pending: permanent slot whose verified source is still being built.
export type ArcIntelligenceScopeItem = { id: string; label: string; backend: 'live' | 'pending' }

export type ArcIntelligenceScopeSection = {
  id: ArcIntelligenceSectionId
  title: string
  group: 'Network Activity' | 'Markets' | 'Recent Activity' | 'Assets' | 'New Token Launches' | 'Borrow' | 'Lending' | 'Cross-chain'
    | 'Ecosystem'
  items: readonly ArcIntelligenceScopeItem[]
}

const live = (id: string, label: string): ArcIntelligenceScopeItem => ({ id, label, backend: 'live' })
const pending = (id: string, label: string): ArcIntelligenceScopeItem => ({ id, label, backend: 'pending' })

export const ARC_INTELLIGENCE_UI_SCOPE: readonly ArcIntelligenceScopeSection[] = [
  {
    id: 'network',
    title: 'Network Activity',
    group: 'Network Activity',
    items: [
      live('window.24h', '24H window'),
      pending('window.7d', '7D window'),
      pending('window.30d', '30D window'),
      live('network.active-addresses', 'Active Addresses'),
      live('network.transactions', 'Transactions'),
      pending('network.total-volume', 'Total Volume'),
      pending('network.average-fee', 'Average Fee'),
      live('network.blocks', 'Blocks'),
      live('network.tps', 'Transactions per second'),
      live('network.gas-used', 'Gas used'),
    ],
  },
  {
    id: 'volume-chart',
    title: 'DEX Activity',
    group: 'Network Activity',
    items: [
      pending('volume-chart.volume', 'Volume tab: USD volume across all verified pairs'),
      live('volume-chart.swaps', 'Swaps tab: swap events per hour across all verified pairs'),
      live('volume-chart.uniswap-v3', 'Uniswap V3'),
      live('volume-chart.uniswap-v4', 'Uniswap V4'),
      pending('volume-chart.other', 'Other verified DEX protocols'),
      live('volume-chart.latest', 'Latest complete hour and peak hour'),
    ],
  },
  {
    id: 'active-addresses-chart',
    title: 'Active Addresses',
    group: 'Network Activity',
    items: [
      live('active-addresses-chart.series', 'Active addresses over the selected window (hourly for 24H, daily for 7D and 30D)'),
      live('active-addresses-chart.latest', 'Latest complete hour and peak hour'),
    ],
  },
  {
    id: 'top-protocols',
    title: 'Top Protocols',
    group: 'Markets',
    items: [
      pending('top-protocols.volume-ranking', 'Ranking by verified volume'),
      live('top-protocols.uniswap-v3', 'Uniswap V3'),
      live('top-protocols.uniswap-v4', 'Uniswap V4'),
      live('top-protocols.aave', 'Aave'),
      live('top-protocols.morpho-blue', 'Morpho Blue'),
      live('top-protocols.morpho-vaults', 'Morpho Vaults'),
      pending('top-protocols.other', 'Other verified Arc protocols'),
    ],
  },
  {
    id: 'top-pools-v3',
    title: 'Top Pools (Uniswap V3)',
    group: 'Markets',
    items: [
      live('top-pools-v3.all-pairs', 'All verified V3 pairs, not only USDC pairs'),
      pending('top-pools-v3.volume', 'Pool volume in USD, the primary ranking once verified USD pricing exists'),
      live('top-pools-v3.swaps', 'Pool swap count, labelled as a count: the interim ranking until USD volume is verified'),
      pending('top-pools-v3.liquidity', 'Pool liquidity: value held in the pool (TVL style)'),
      live('top-pools-v3.new-pools', 'New V3 pools in the window'),
      live('top-pools-v3.pool-count', 'Verified V3 pools tracked'),
    ],
  },
  {
    id: 'top-pools-v4',
    title: 'Top Pools (Uniswap V4)',
    group: 'Markets',
    items: [
      live('top-pools-v4.all-pairs', 'All verified V4 pairs, not only USDC pairs'),
      pending('top-pools-v4.volume', 'Pool volume in USD, the primary ranking once verified USD pricing exists'),
      live('top-pools-v4.swaps', 'Pool swap count, labelled as a count: the interim ranking until USD volume is verified'),
      pending('top-pools-v4.liquidity', 'Pool liquidity: value held in the pool (TVL style)'),
      live('top-pools-v4.new-pools', 'New V4 pools in the window'),
    ],
  },
  {
    id: 'recent-activity',
    title: 'Recent Activity',
    group: 'Recent Activity',
    items: [
      live('recent-activity.all', 'All'),
      live('recent-activity.swaps', 'Swaps'),
      live('recent-activity.adds', 'Adds'),
      live('recent-activity.removes', 'Removes'),
      live('recent-activity.time', 'Time'),
      live('recent-activity.type', 'Activity type'),
      live('recent-activity.protocol', 'Protocol'),
      live('recent-activity.pair', 'Pair, all verified pairs'),
      live('recent-activity.amounts', 'Token amounts'),
      live('recent-activity.from', 'From: transaction sender'),
      live('recent-activity.to', 'To: recipient or owner recorded by the event'),
      live('recent-activity.transaction-links', 'Transaction links'),
    ],
  },
  {
    id: 'assets',
    title: 'Assets',
    group: 'Assets',
    items: [
      live('assets.usdc', 'USDC'),
      live('assets.eurc', 'EURC'),
      live('assets.cirbtc', 'cirBTC'),
      live('assets.weth', 'WETH'),
      live('assets.usyc', 'USYC'),
      pending('assets.other-verified', 'Other verified Arc assets'),
      pending('assets.new-tokens', 'Newly discovered tokens'),
    ],
  },
  {
    id: 'launches',
    title: 'New Token Launches',
    group: 'New Token Launches',
    items: [
      pending('launches.token', 'Token'),
      pending('launches.symbol-address', 'Symbol and address'),
      pending('launches.source', 'Launch source'),
      pending('launches.time', 'Launch time'),
      pending('launches.transaction', 'Launch transaction'),
      pending('launches.initial-pool', 'Initial pair or pool'),
      pending('launches.dex-activity', 'DEX activity'),
      pending('launches.status', 'Status'),
    ],
  },
  {
    // The Borrow product (Circle Borrow Kit), not Lending Intelligence: what a user can do, not what the chain did.
    id: 'borrow',
    title: 'Borrow on Arc',
    group: 'Borrow',
    items: [
      live('borrow.route', 'cirBTC collateral to USDC borrow, on Morpho on Arc, through Circle Borrow Kit'),
      live('borrow.market-list', 'Every validated Arc cirBTC/USDC Morpho market, listed by market ID for display only (not a ranking)'),
      live('borrow.market-id', 'Shortened market ID of each listed market'),
      live('borrow.market-terms', 'Borrow APY, liquidation LTV, utilization and available liquidity of each market, read only from Circle Borrow Kit'),
      pending('borrow.action', 'Borrow action with explicit market selection, rendered only when Machina borrowing writes are enabled'),
    ],
  },
  {
    id: 'lending',
    title: 'Lending',
    group: 'Lending',
    items: [
      live('lending.aave', 'Aave'),
      live('lending.morpho-blue', 'Morpho Blue'),
      live('lending.morpho-vaults', 'Morpho Vaults'),
    ],
  },
  {
    id: 'cross-chain',
    title: 'Cross-chain',
    group: 'Cross-chain',
    items: [
      live('cross-chain.cctp', 'CCTP'),
      live('cross-chain.gateway', 'Gateway'),
      live('cross-chain.across', 'Across'),
    ],
  },
  {
    id: 'rwa-other',
    title: 'RWA and Other Verified Protocols',
    group: 'Ecosystem',
    items: [
      live('rwa-other.rwa', 'RWA'),
      pending('rwa-other.other-protocols', 'Verified Arc protocol activity'),
      pending('rwa-other.exchange-flows', 'Verified exchange flows'),
      pending('rwa-other.more-protocols', 'Other verified Arc protocols'),
    ],
  },
]

// Locked meaning of fields whose value is easy to substitute with something that only looks similar. A backend or UI
// change may fill these fields only from the stated source; every listed substitute is forbidden, and a field without
// its exact source stays source_pending (or unavailable for that row) rather than borrowing another number.
export type ArcIntelligenceFieldSemantics = {
  meaning: string
  source: string
  forbidden: readonly string[]
  unavailableWhen?: readonly string[]
}

export const ARC_INTELLIGENCE_FIELD_SEMANTICS: Readonly<Record<string, ArcIntelligenceFieldSemantics>> = Object.freeze({
  'recent-activity.protocol': Object.freeze({ meaning: 'exact protocol identity of the event', source: 'verified emitter (Uniswap V3 pool or V4 PoolManager)',
    forbidden: Object.freeze(['guessed protocol', 'router or aggregator name']) }),
  'recent-activity.from': Object.freeze({ meaning: 'exact transaction sender', source: 'verified block spine (top-level transaction from)',
    forbidden: Object.freeze(['event sender field', 'router', 'guessed wallet']) }),
  'recent-activity.to': Object.freeze({ meaning: 'exact event-level recipient, owner or counterparty with known semantics',
    source: 'decoded event field (for example the V3 Swap recipient)',
    forbidden: Object.freeze(['tx.to', 'router', 'top-level transaction recipient', 'called contract']),
    unavailableWhen: Object.freeze(['uniswap_v4_swap']) }),
  'top-pools.volume': Object.freeze({ meaning: 'valued swap volume of the pool, the primary ranking once verified USD pricing exists',
    source: 'raw swap flows valued in USD', forbidden: Object.freeze(['swap count', 'event count', 'raw token sum', 'usdc-only flow']) }),
  // Until volume is verified, pools are ranked by swap count, always shown and named as a count of swaps.
  'top-pools.swaps': Object.freeze({ meaning: 'swap event count of the pool, labelled as a count: the interim ranking until USD volume is verified',
    source: 'decoded swap events', forbidden: Object.freeze(['labelled or shown as volume', 'shown in USD', 'converted to a token amount']) }),
  'top-pools.liquidity': Object.freeze({ meaning: 'actual pool liquidity: value held in the pool (TVL style)',
    source: 'exact, defensible pool state; source_pending until one exists',
    forbidden: Object.freeze(['add or remove event count', 'mint, burn or modifyLiquidity activity', 'liquidity activity', 'in-range liquidity units']) }),
})

// The only capabilities intentionally removed from the product: they need per-transaction receipts.
export const ARC_INTELLIGENCE_REMOVED_SCOPE: readonly string[] = [
  'successful transaction count',
  'failed transaction count',
  'success rate',
  'receipt-dependent transaction outcome analytics',
]
