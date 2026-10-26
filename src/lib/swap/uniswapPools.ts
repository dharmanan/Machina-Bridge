import { getAddress, getCreate2Address, keccak256, encodeAbiParameters, parseAbiParameters, type Hex } from 'viem'
import { SWAP_SYMBOLS, swapToken, type SwapSymbol } from './tokens'

// Uniswap V3 pools on Arc Mainnet (factory 0xf0db…3918, pinned in uniswapArcPolicy) that hold real liquidity, found with the factory's
// getPool for the four Swap tokens (see scripts/discover-uniswap-arc-pools.mjs; evidence in scripts/fixtures/swap/provider-evidence.json).
// A route may only use pools listed here: the calldata decoder rejects any other hop, and each address is re-derived from the pinned
// factory and init-code hash, so a listed pool cannot be swapped for a look-alike.
export const V3_FACTORY = '0xf0db7b58379503491d857db50ac9ece64c653918'
export const V3_POOL_INIT_HASH = '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54'
export interface V3PoolEntry { a: SwapSymbol; b: SwapSymbol; fee: number; address: Hex; liquidity: string; evidenceBlock: number }
const POOL_KEY = parseAbiParameters('address token0,address token1,uint24 fee')
export function v3PoolAddress(a: SwapSymbol, b: SwapSymbol, fee: number): Hex {
  const [token0, token1] = [getAddress(swapToken(a).address), getAddress(swapToken(b).address)].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1))
  return getCreate2Address({ from: V3_FACTORY, salt: keccak256(encodeAbiParameters(POOL_KEY, [token0, token1, fee])), bytecodeHash: V3_POOL_INIT_HASH })
}
// Liquidity is a snapshot at the evidence block, used only to rank candidates; the simulation decides the real output.
const RAW: [SwapSymbol, SwapSymbol, number, string][] = [
  ['USDC', 'EURC', 500, '22525507362357'],
  ['USDC', 'EURC', 3000, '579405305'],
  ['USDC', 'cirBTC', 100, '413301847549'],
  ['USDC', 'WETH', 3000, '158840469360331'],
  ['USDC', 'WETH', 10000, '56090516186210'],
  ['cirBTC', 'WETH', 3000, '954045230356'],
]
export const EVIDENCE_BLOCK = 27291900
export const V3_POOLS: readonly V3PoolEntry[] = RAW.map(([a, b, fee, liquidity]) => ({ a, b, fee, liquidity, address: v3PoolAddress(a, b, fee), evidenceBlock: EVIDENCE_BLOCK }))

export interface V3Hop { tokenIn: SwapSymbol; tokenOut: SwapSymbol; fee: number }
export interface UniswapRoute { id: string; kind: 'v3'; hops: V3Hop[] }
const edges = (a: SwapSymbol, b: SwapSymbol) => V3_POOLS.filter(pool => (pool.a === a && pool.b === b) || (pool.a === b && pool.b === a)).sort((x, y) => (BigInt(y.liquidity) > BigInt(x.liquidity) ? 1 : -1))
export const routeId = (hops: readonly V3Hop[]) => hops.map(hop => `${hop.tokenIn}>${hop.fee}>${hop.tokenOut}`).join('|')
export function poolForHop(hop: V3Hop): V3PoolEntry | undefined { return edges(hop.tokenIn, hop.tokenOut).find(pool => pool.fee === hop.fee) }
export function routeIsRegistered(route: { hops: readonly V3Hop[] }): boolean {
  return route.hops.length >= 1 && route.hops.length <= 2 && route.hops.every((hop, i) => poolForHop(hop) !== undefined && (i === 0 || route.hops[i - 1].tokenOut === hop.tokenIn))
}
// Candidate routes for an exact-input swap, best pool first: every direct pool, plus two-hop routes through one other token (the best
// pool of each hop). The caller simulates them and keeps the best real output. Never more than MAX candidates.
export const MAX_ROUTE_CANDIDATES = 4
export function candidateRoutes(tokenIn: SwapSymbol, tokenOut: SwapSymbol): UniswapRoute[] {
  if (tokenIn === tokenOut) return []
  const out: UniswapRoute[] = []
  for (const pool of edges(tokenIn, tokenOut)) out.push({ id: '', kind: 'v3', hops: [{ tokenIn, tokenOut, fee: pool.fee }] })
  for (const mid of SWAP_SYMBOLS) {
    if (mid === tokenIn || mid === tokenOut) continue
    const first = edges(tokenIn, mid)[0], second = edges(mid, tokenOut)[0]
    if (first && second) out.push({ id: '', kind: 'v3', hops: [{ tokenIn, tokenOut: mid, fee: first.fee }, { tokenIn: mid, tokenOut, fee: second.fee }] })
  }
  const weight = (route: UniswapRoute) => route.hops.map(hop => BigInt(poolForHop(hop)!.liquidity)).reduce((m, x) => (x < m ? x : m))
  // Fewer hops first (cheaper, fewer fees), then the shallowest hop's depth.
  out.sort((x, y) => x.hops.length - y.hops.length || (weight(y) > weight(x) ? 1 : -1))
  return out.slice(0, MAX_ROUTE_CANDIDATES).map(route => ({ ...route, id: routeId(route.hops) }))
}
export const feeText = (fee: number) => `${(fee / 10000).toFixed(fee % 100 === 0 ? 2 : 3).replace(/0+$/, '').replace(/\.$/, '')}%`
export function describeRoute(route: { hops: readonly V3Hop[] }): string {
  return `${route.hops[0].tokenIn} → ${route.hops.map(hop => `${hop.tokenOut} (${feeText(hop.fee)})`).join(' → ')}`
}
