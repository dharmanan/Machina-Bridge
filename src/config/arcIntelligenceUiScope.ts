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
// 7D and 30D are answered from stored hours only: until a window holds every one of its hours its totals stay collecting.
export const ARC_INTELLIGENCE_BACKEND_WINDOWS: Readonly<Record<ArcIntelligenceWindow, boolean>> = {
  '24h': true,
  '7d': true,
  '30d': true,
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
      live('window.7d', '7D window: daily buckets, totals once all 168 hours are stored'),
      live('window.30d', '30D window: daily buckets, totals once all 720 hours are stored'),
      live('network.active-addresses', 'Active Addresses: unique within 24H; not counted over 7D or 30D (identities are kept for one day)'),
      live('network.transactions', 'Transactions'),
      live('network.total-volume', 'DEX Volume: USD-valued Uniswap V3 and V4 swaps on Arc, each swap counted once'),
      live('network.average-fee', 'Avg DEX Pool Fee: estimated Uniswap pool fees / fee-valued swaps; not Arc gas or network fee; excludes per step rounding and hook fees'),
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
      live('volume-chart.volume', 'Volume tab: USD volume per hour (24H) or per day (7D, 30D) across all verified pairs, each swap counted once'),
      live('volume-chart.swaps', 'Swaps tab: swap events per hour (24H) or per day (7D, 30D) across all verified pairs'),
      live('volume-chart.uniswap-v3', 'Uniswap V3'),
      live('volume-chart.uniswap-v4', 'Uniswap V4'),
      pending('volume-chart.other', 'Other verified DEX protocols'),
      live('volume-chart.latest', 'Latest complete period and peak period'),
    ],
  },
  {
    id: 'active-addresses-chart',
    title: 'Active Addresses',
    group: 'Network Activity',
    items: [
      live('active-addresses-chart.series', 'Active addresses per hour (24H); per day is not available because identities are kept for one day only'),
      live('active-addresses-chart.latest', 'Latest complete hour and peak hour'),
    ],
  },
  {
    id: 'top-protocols',
    title: 'Top Protocols',
    group: 'Markets',
    items: [
      pending('top-protocols.volume-ranking', 'Ranking by verified volume: blocked, lending and bridge USD values are per action and never one comparable volume'),
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
      live('top-pools-v3.volume', 'Pool volume in USD over the window, shown beside the swap count'),
      live('top-pools-v3.swaps', 'Pool swap count, labelled as a count: the ranking of the table'),
      live('top-pools-v3.liquidity', 'Pool liquidity: value held in the pool (TVL style), read from pool state for the top pools'),
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
      live('top-pools-v4.volume', 'Pool volume in USD over the window, shown beside the swap count'),
      live('top-pools-v4.swaps', 'Pool swap count, labelled as a count: the ranking of the table'),
      live('top-pools-v4.liquidity', 'Estimated principal reserves from pool state for the top pools; excludes uncollected fees and position rounding'),
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
      live('recent-activity.to', 'To: recipient or owner recorded by the event; V4 swaps state why none exists'),
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
      live('lending.aave-usd', 'Aave USD value per action (supplied, withdrawn, borrowed, repaid), never added across actions'),
      live('lending.morpho-blue-usd', 'Morpho Blue USD value per action, never added across actions'),
      live('lending.morpho-vaults-usd', 'Morpho Vaults USD value of deposits and withdrawals, kept separate'),
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
      live('cross-chain.cctp-usd', 'CCTP USD value per direction, never added across directions'),
      live('cross-chain.gateway-usd', 'Gateway USD value per action, never added across actions'),
      live('cross-chain.across-usd', 'Across USD value of deposits and fills, kept separate'),
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
  'top-pools.volume': Object.freeze({ meaning: 'valued swap volume of the pool over the window: every swap valued once, by its USDC side or by a verified hourly price of its other side',
    source: 'raw swap flows valued in USD by the compact valuation (USDC = 1 USD; other verified assets priced from verified Arc USDC pools)',
    forbidden: Object.freeze(['swap count', 'event count', 'raw token sum', 'usdc-only flow', 'both sides of one swap added together',
      'external or guessed price', 'unpriced swaps counted as zero']),
    unavailableWhen: Object.freeze(['any swap hour of the pool without a verified value']) }),
  // Pools are ranked by swap count, always shown and named as a count of swaps; USD volume is shown beside it.
  'top-pools.swaps': Object.freeze({ meaning: 'swap event count of the pool, labelled as a count: the ranking of the table',
    source: 'decoded swap events', forbidden: Object.freeze(['labelled or shown as volume', 'shown in USD', 'converted to a token amount']) }),
  'top-pools.liquidity': Object.freeze({ meaning: 'V3 token balances; V4 estimated principal reserves, excluding uncollected fees and per-position rounding',
    source: 'pool state at the last block of the latest verified hour (V3: token balances of the pool; V4: tick-sweep reserve estimate), valued with that hour\'s verified prices',
    forbidden: Object.freeze(['add or remove event count', 'mint, burn or modifyLiquidity activity', 'liquidity activity', 'in-range liquidity units',
      'external or guessed price', 'unpriced tokens counted as zero']),
    unavailableWhen: Object.freeze(['pool state not read for the pool', 'a held token without a verified price', 'a V4 hook that may hold pool value']) }),
  'network.average-fee': Object.freeze({ meaning: 'estimated average USD Uniswap pool fee per fee-valued V3 and V4 swap over the window; this is not Arc gas or network transaction fee',
    source: 'swap input amount times the pool fee (V3 fee tier; V4 fee recorded by each Swap event), valued like DEX volume; total pool fees / fee-valued swaps; excludes per step rounding and hook fees',
    forbidden: Object.freeze(['gas fee', 'transaction fee', 'fee tier shown as an amount', 'hook-taken fees', 'unvalued swaps counted as zero']),
    unavailableWhen: Object.freeze(['any hour of the window without valued fees']) }),
})

// The only capabilities intentionally removed from the product: they need per-transaction receipts.
export const ARC_INTELLIGENCE_REMOVED_SCOPE: readonly string[] = [
  'successful transaction count',
  'failed transaction count',
  'success rate',
  'receipt-dependent transaction outcome analytics',
]
