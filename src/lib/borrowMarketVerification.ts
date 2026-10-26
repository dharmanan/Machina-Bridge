import { createPublicClient, encodeAbiParameters, http, keccak256, parseAbi, type Hex } from 'viem'
import { MAINNET_BORROW_CHAIN_ID, MAINNET_BORROW_MAX_EVIDENCE_AGE_MS, MAINNET_BORROW_MORPHO_BLUE } from '../config/mainnetBorrow'
import type { BorrowMarket } from './mainnetBorrow'

// On-chain check of a Borrow Kit market against Morpho Blue on Arc. Circle's market list is a cache; this reads the market
// itself. A Morpho market ID is keccak256(abi.encode(loanToken, collateralToken, oracle, irm, lltv)), so once the
// parameters read from the chain hash back to the ID Circle reported, the oracle and IRM shown are exactly the ones that ID
// commits to, and no RPC can substitute others unnoticed. Read only: view calls through the public Arc RPC, no wallet.

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const WAD = 10 ** 18
// Circle reports ratios with six decimals, the chain with eighteen.
const LLTV_TOLERANCE = 1e-6

export type MorphoMarketParams = {
  loanToken: string
  collateralToken: string
  oracle: string
  irm: string
  lltv: bigint
}

export type OnchainMarketState = {
  totalSupplyAssets: bigint
  totalBorrowAssets: bigint
}

// The reads verification needs. Injectable so the logic is testable without a network.
export type MarketChainReader = {
  chainId(): Promise<number>
  marketParams(id: string, blockNumber?: bigint): Promise<MorphoMarketParams>
  marketState(id: string, blockNumber?: bigint): Promise<OnchainMarketState>
  // Morpho oracle price(): collateral priced in loan token, scaled by 10^(36 + loan decimals - collateral decimals).
  oraclePrice(oracle: string, blockNumber?: bigint): Promise<bigint>
  snapshot?(): Promise<{ number: bigint; hash: Hex; timestamp: bigint }>
  canonical?(block: { number: bigint; hash: Hex }): Promise<boolean>
}

export type MarketVerificationReason =
  | 'wrong_chain'
  | 'market_missing'
  | 'id_mismatch'
  | 'loan_token_mismatch'
  | 'collateral_token_mismatch'
  | 'lltv_mismatch'
  | 'oracle_missing'
  | 'oracle_price_unavailable'
  | 'irm_missing'
  | 'block_context_changed'

export type MarketVerificationDetails = {
  params: MorphoMarketParams
  // null when the oracle address is empty or price() could not be read or returned zero.
  oraclePrice: bigint | null
  // totalSupplyAssets - totalBorrowAssets, the amount Morpho can lend out right now.
  liquidity: bigint
  block?: { number: bigint; hash: Hex; timestamp: bigint }
}

export type MarketVerification =
  | { status: 'checking' }
  | { status: 'verified'; details: MarketVerificationDetails }
  | { status: 'unverified'; reasons: MarketVerificationReason[]; details: MarketVerificationDetails | null }
  // The chain could not be read, so nothing was checked. Never shown as verified.
  | { status: 'unavailable' }

export type VerifiableMarket = Pick<BorrowMarket, 'marketId' | 'loanAsset' | 'collateralAsset' | 'lltv'>

export type OnchainMarket = OnchainMarketState & {
  chainId: number
  params: MorphoMarketParams
  oraclePrice: bigint | null
}

export function computeMarketId(params: MorphoMarketParams): string {
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [params.loanToken as Hex, params.collateralToken as Hex, params.oracle as Hex, params.irm as Hex, params.lltv],
  ))
}

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()

// Pure: compares what Circle reported with what the chain holds. Any mismatch or missing piece is "unverified".
export function evaluateMarketVerification(market: VerifiableMarket, onchain: OnchainMarket): MarketVerification {
  if (onchain.chainId !== MAINNET_BORROW_CHAIN_ID) return { status: 'unverified', reasons: ['wrong_chain'], details: null }
  const { params } = onchain
  if (same(params.loanToken, ZERO_ADDRESS)) return { status: 'unverified', reasons: ['market_missing'], details: null }

  const reasons: MarketVerificationReason[] = []
  if (!same(computeMarketId(params), market.marketId)) reasons.push('id_mismatch')
  if (!same(params.loanToken, market.loanAsset.address)) reasons.push('loan_token_mismatch')
  if (!same(params.collateralToken, market.collateralAsset.address)) reasons.push('collateral_token_mismatch')
  // A ratio Circle has not reported cannot disagree with the chain; the chain value is still shown in the details.
  if (market.lltv !== null && Math.abs(Number(params.lltv) / WAD - market.lltv) > LLTV_TOLERANCE) reasons.push('lltv_mismatch')
  if (same(params.oracle, ZERO_ADDRESS)) reasons.push('oracle_missing')
  else if (onchain.oraclePrice === null || onchain.oraclePrice === 0n) reasons.push('oracle_price_unavailable')
  if (same(params.irm, ZERO_ADDRESS)) reasons.push('irm_missing')

  const details: MarketVerificationDetails = {
    params,
    oraclePrice: onchain.oraclePrice === 0n ? null : onchain.oraclePrice,
    liquidity: onchain.totalSupplyAssets > onchain.totalBorrowAssets ? onchain.totalSupplyAssets - onchain.totalBorrowAssets : 0n,
  }
  return reasons.length === 0 ? { status: 'verified', details } : { status: 'unverified', reasons, details }
}

export async function verifyBorrowMarket(market: VerifiableMarket, reader: MarketChainReader): Promise<MarketVerification> {
  try {
    const chainId = await reader.chainId()
    if (chainId !== MAINNET_BORROW_CHAIN_ID) return { status: 'unverified', reasons: ['wrong_chain'], details: null }
    const block = reader.snapshot ? await reader.snapshot() : undefined
    if (block && (block.number < 0n || !/^0x[0-9a-fA-F]{64}$/.test(block.hash) || Math.abs(Date.now() - Number(block.timestamp) * 1000) > MAINNET_BORROW_MAX_EVIDENCE_AGE_MS)) return { status: 'unavailable' }
    if (block && !reader.canonical) return { status: 'unavailable' }
    const [params, state] = await Promise.all([reader.marketParams(market.marketId, block?.number), reader.marketState(market.marketId, block?.number)])
    let oraclePrice: bigint | null = null
    if (!same(params.oracle, ZERO_ADDRESS)) {
      try {
        oraclePrice = await reader.oraclePrice(params.oracle, block?.number)
      } catch {
        oraclePrice = null
      }
    }
    if (block && !await reader.canonical!(block)) return { status: 'unverified', reasons: ['block_context_changed'], details: null }
    const result = evaluateMarketVerification(market, { chainId, params, oraclePrice, ...state })
    if (result.status !== 'unavailable' && result.status !== 'checking' && result.details && block) result.details.block = block
    return result
  } catch {
    return { status: 'unavailable' }
  }
}

const BLUE_ABI = parseAbi([
  'function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
])
const ORACLE_ABI = parseAbi(['function price() view returns (uint256)'])

// Public Arc RPC reads only. The chain ID is read once and checked before any answer is trusted.
export function createViemMarketReader(rpcUrl: string): MarketChainReader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 10_000, retryCount: 1 }) })
  let chain: Promise<number> | null = null
  return {
    // A failed read is not cached, so the next check asks again.
    chainId: () => (chain ??= client.getChainId().catch((error) => { chain = null; throw error })),
    async snapshot() {
      const block = await client.getBlock()
      if (!block.hash) throw new Error('missing_block_hash')
      return { number: block.number, hash: block.hash, timestamp: block.timestamp }
    },
    async canonical(block) { return (await client.getBlock({ blockNumber: block.number })).hash === block.hash },
    async marketParams(id, blockNumber) {
      const [loanToken, collateralToken, oracle, irm, lltv] = await client.readContract({
        address: MAINNET_BORROW_MORPHO_BLUE, abi: BLUE_ABI, functionName: 'idToMarketParams', args: [id as Hex], blockNumber,
      })
      return { loanToken, collateralToken, oracle, irm, lltv }
    },
    async marketState(id, blockNumber) {
      const state = await client.readContract({ address: MAINNET_BORROW_MORPHO_BLUE, abi: BLUE_ABI, functionName: 'market', args: [id as Hex], blockNumber })
      return { totalSupplyAssets: state[0], totalBorrowAssets: state[2] }
    },
    oraclePrice: (oracle, blockNumber) => client.readContract({ address: oracle as Hex, abi: ORACLE_ABI, functionName: 'price', blockNumber }),
  }
}
