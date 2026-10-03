import { BorrowChain, BorrowKit, isKitError } from '@circle-fin/borrow-kit'
import {
  MAINNET_BORROW_ADAPTER_CONTRACT,
  MAINNET_BORROW_CHAIN,
  MAINNET_BORROW_CHAIN_ID,
  MAINNET_BORROW_READ_ONLY_ENABLED,
  MAINNET_BORROW_WRITES_ENABLED,
} from '../config/mainnetBorrow'

// Machina's only boundary to @circle-fin/borrow-kit. SDK responses are
// normalized here once; the UI sees the small types below. Missing or
// malformed service data becomes an explicit unavailable result, never zero.

type Hex = `0x${string}`

export type BorrowAmount = {
  token: string
  tokenAddress: Hex
  // Human-readable decimal string exactly as Borrow Service reports it.
  amount: string
  decimals: number
}

export type BorrowMarketAsset = {
  symbol: string
  address: Hex
  decimals: number
}

export type BorrowHealthBand = 'SAFE' | 'WARN' | 'URGENT' | 'IMMINENT' | 'LIQUIDATABLE'

export type BorrowMarket = {
  marketId: Hex
  protocol: 'morpho'
  loanAsset: BorrowMarketAsset
  collateralAsset: BorrowMarketAsset
  // Cached service projections. null means not backfilled yet, not zero.
  lltv: number | null
  borrowApy: number | null
  utilization: number | null
  borrowAssets: BorrowAmount | null
  liquidity: BorrowAmount | null
  refreshedAt: string | null
}

export type BorrowPosition = {
  loanId: string
  marketId: Hex
  owner: Hex
  // getLoans may omit the lifecycle; that is reported, not guessed.
  lifecycle: 'active' | 'closed' | 'unreported'
  // pending: the loan exists but its economics are not indexed yet.
  economics: 'ready' | 'pending'
  collateral: BorrowAmount | null
  borrowed: BorrowAmount | null
  principalBorrowed: BorrowAmount | null
  accruedInterest: BorrowAmount | null
  borrowApy: number | null
  ltv: number | null
  // null with ready economics means the loan carries no debt.
  healthFactor: number | null
  healthBand: BorrowHealthBand | null
  liquidationPrice: BorrowAmount | null
}

export type BorrowFeeLeg = {
  type: string
  amount: BorrowAmount
}

export type BorrowGasEstimate = {
  name: string
  gasUnits: string
  gasPriceWei: string
  feeWei: string
}

type BorrowQuoteOutcome = {
  resultingHealthFactor: number | null
  liquidationPrice: BorrowAmount | null
}

type BorrowQuoteCosts = {
  resultingLtv: number | null
  resultingBand: BorrowHealthBand
  fees: BorrowFeeLeg[]
  gasFees: BorrowGasEstimate[]
}

// maxRepayment is the SDK's bundledRepayment: the most the action may pull
// from the wallet. It is a ceiling, not the amount that will be paid.
export type BorrowQuote =
  | ({ kind: 'borrow'; collateral: BorrowAmount; loanAsset: BorrowAmount; borrowApy: number | null }
    & BorrowQuoteOutcome & BorrowQuoteCosts)
  | ({ kind: 'required-collateral'; requiredCollateral: BorrowAmount } & BorrowQuoteOutcome)
  | ({ kind: 'max-borrow'; maxBorrow: BorrowAmount } & BorrowQuoteOutcome)
  | ({ kind: 'repay'; repayAmount: BorrowAmount } & BorrowQuoteOutcome & BorrowQuoteCosts)
  | ({ kind: 'close-loan'; maxRepayment: BorrowAmount; collateral: BorrowAmount }
    & BorrowQuoteOutcome & BorrowQuoteCosts)
  | ({ kind: 'add-collateral'; collateral: BorrowAmount } & BorrowQuoteOutcome & BorrowQuoteCosts)
  | ({ kind: 'withdraw-collateral'; maxRepayment: BorrowAmount; collateral: BorrowAmount }
    & BorrowQuoteOutcome & BorrowQuoteCosts)

export type BorrowErrorCode =
  | 'reads_disabled'
  | 'invalid_input'
  | 'market_not_found'
  | 'loan_not_found'
  | 'unsupported_chain'
  | 'unexpected_chain'
  | 'unexpected_owner'
  | 'malformed_response'
  | 'service_unavailable'
  | 'service_rejected'
  | 'unexpected_error'

export type BorrowError = {
  code: BorrowErrorCode
  retryable: boolean
  // Field path, SDK error name or similar diagnostic detail.
  detail?: string
  sdkCode?: number
}

export type BorrowAvailability<T> =
  | { status: 'available'; data: T }
  | { status: 'unavailable'; error: BorrowError }

export type BorrowPage<T> = {
  items: T[]
  // Opaque Borrow Service cursor; null on the last page.
  nextPageAfter: string | null
}

const READ_METHODS = [
  'exploreMarkets',
  'getMarket',
  'getRequiredCollateral',
  'getMaxBorrow',
  'getBorrowQuote',
  'getLoans',
  'getPosition',
  'getRepayQuote',
  'getCloseLoanQuote',
  'getAddCollateralQuote',
  'getWithdrawCollateralRepayIfNeededQuote',
] as const

const WRITE_METHODS = [
  'borrow',
  'repay',
  'addCollateral',
  'withdrawCollateralRepayIfNeeded',
  'closeLoan',
] as const

export type BorrowReadClient = Pick<BorrowKit, (typeof READ_METHODS)[number]>
export type BorrowWriteClient = Pick<BorrowKit, (typeof WRITE_METHODS)[number]>

export const MAINNET_BORROW_READ_METHODS: readonly string[] = READ_METHODS
export const MAINNET_BORROW_WRITE_METHODS: readonly string[] = WRITE_METHODS

// Every SDK request names this chain itself; callers never supply one.
const ARC = BorrowChain.Arc

// Module-private on purpose: the raw kit carries the write methods, so it is
// reachable only through the read functions below and the gated
// executeBorrowWrite. Never export it or return it from a function.
let mainnetBorrowKit: BorrowKit | null = null

function getMainnetBorrowKit(): BorrowKit {
  // Machina does not forward Borrow activity or errors to Circle telemetry.
  mainnetBorrowKit ??= new BorrowKit({ disableAnalytics: true, disableErrorReporting: true })
  return mainnetBorrowKit
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const BYTES32 = /^0x[0-9a-fA-F]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DECIMAL = /^\d+(\.\d+)?$/
const POSITIVE_DECIMAL = /^(?=.*[1-9])\d+(\.\d+)?$/
const INTEGER = /^\d+$/
const HEALTH_BANDS: readonly BorrowHealthBand[] = ['SAFE', 'WARN', 'URGENT', 'IMMINENT', 'LIQUIDATABLE']

class BorrowResponseError extends Error {
  constructor(readonly code: BorrowErrorCode, readonly path: string) {
    super(`${code}: ${path}`)
  }
}

type Fields = Record<string, unknown>

function malformed(path: string): never {
  throw new BorrowResponseError('malformed_response', path)
}

function record(value: unknown, path: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) malformed(path)
  return value as Fields
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) malformed(path)
  return value
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) malformed(path)
  return value
}

function matching(value: unknown, pattern: RegExp, path: string): string {
  const result = text(value, path)
  if (!pattern.test(result)) malformed(path)
  return result
}

function decimals(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 36) malformed(path)
  return value
}

// Absent and null both mean the service has no value; neither becomes zero.
function ratioOrNull(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) malformed(path)
  return value
}

function band(value: unknown, path: string): BorrowHealthBand {
  if (!HEALTH_BANDS.includes(value as BorrowHealthBand)) malformed(path)
  return value as BorrowHealthBand
}

function bandOrNull(value: unknown, path: string): BorrowHealthBand | null {
  return value === null || value === undefined ? null : band(value, path)
}

function amount(value: unknown, path: string): BorrowAmount {
  const fields = record(value, path)
  return {
    token: text(fields.token, `${path}.token`),
    tokenAddress: matching(fields.tokenAddress, ADDRESS, `${path}.tokenAddress`) as Hex,
    amount: matching(fields.amount, DECIMAL, `${path}.amount`),
    decimals: decimals(fields.decimals, `${path}.decimals`),
  }
}

function amountOrNull(value: unknown, path: string): BorrowAmount | null {
  return value === null || value === undefined ? null : amount(value, path)
}

function asset(value: unknown, path: string): BorrowMarketAsset {
  const fields = record(value, path)
  return {
    symbol: text(fields.symbol, `${path}.symbol`),
    address: matching(fields.address, ADDRESS, `${path}.address`) as Hex,
    decimals: decimals(fields.decimals, `${path}.decimals`),
  }
}

function arcChain(value: unknown, path: string) {
  if (value !== ARC) throw new BorrowResponseError('unexpected_chain', path)
}

function cursor(value: unknown, path: string): string | null {
  const fields = record(value, path)
  if (fields.pageAfter === undefined || fields.pageAfter === null) return null
  return text(fields.pageAfter, `${path}.pageAfter`)
}

export function normalizeBorrowMarket(value: unknown, path = 'market'): BorrowMarket {
  const fields = record(value, path)
  arcChain(fields.chain, `${path}.chain`)
  if (fields.protocol !== 'morpho') malformed(`${path}.protocol`)
  const refreshedAt = fields.refreshedAt
  if (refreshedAt !== null && refreshedAt !== undefined
    && (typeof refreshedAt !== 'string' || Number.isNaN(Date.parse(refreshedAt)))) {
    malformed(`${path}.refreshedAt`)
  }
  return {
    marketId: matching(fields.marketId, BYTES32, `${path}.marketId`) as Hex,
    protocol: 'morpho',
    loanAsset: asset(fields.loanAsset, `${path}.loanAsset`),
    collateralAsset: asset(fields.collateralAsset, `${path}.collateralAsset`),
    lltv: ratioOrNull(fields.lltv, `${path}.lltv`),
    borrowApy: ratioOrNull(fields.borrowApy, `${path}.borrowApy`),
    utilization: ratioOrNull(fields.utilization, `${path}.utilization`),
    borrowAssets: amountOrNull(fields.borrowAssets, `${path}.borrowAssets`),
    liquidity: amountOrNull(fields.liquidity, `${path}.liquidity`),
    refreshedAt: (refreshedAt as string | null | undefined) ?? null,
  }
}

// getLoans names the owner walletAddress; getPosition names it wallet.
export function normalizeBorrowPosition(value: unknown, path = 'loan'): BorrowPosition {
  const fields = record(value, path)
  arcChain(fields.chain, `${path}.chain`)
  const owner = fields.walletAddress ?? fields.wallet
  if (fields.dataStatus !== 'READY' && fields.dataStatus !== 'PENDING') malformed(`${path}.dataStatus`)
  const status = fields.status
  if (status !== undefined && status !== 'active' && status !== 'closed') malformed(`${path}.status`)
  return {
    loanId: matching(fields.loanId, UUID, `${path}.loanId`),
    marketId: matching(fields.marketId, BYTES32, `${path}.marketId`) as Hex,
    owner: matching(owner, ADDRESS, `${path}.owner`) as Hex,
    lifecycle: status ?? 'unreported',
    economics: fields.dataStatus === 'READY' ? 'ready' : 'pending',
    collateral: amountOrNull(fields.collateral, `${path}.collateral`),
    borrowed: amountOrNull(fields.borrowed, `${path}.borrowed`),
    principalBorrowed: amountOrNull(fields.principalBorrowed, `${path}.principalBorrowed`),
    accruedInterest: amountOrNull(fields.accruedInterest, `${path}.accruedInterest`),
    borrowApy: ratioOrNull(fields.borrowApy, `${path}.borrowApy`),
    ltv: ratioOrNull(fields.ltv, `${path}.ltv`),
    healthFactor: ratioOrNull(fields.healthFactor, `${path}.healthFactor`),
    healthBand: bandOrNull(fields.healthFactorBand, `${path}.healthFactorBand`),
    liquidationPrice: amountOrNull(fields.liquidationPrice, `${path}.liquidationPrice`),
  }
}

function outcome(fields: Fields, path: string): BorrowQuoteOutcome {
  return {
    resultingHealthFactor: ratioOrNull(fields.resultingHealthFactor, `${path}.resultingHealthFactor`),
    liquidationPrice: amountOrNull(fields.liquidationPrice, `${path}.liquidationPrice`),
  }
}

function costs(fields: Fields, path: string): BorrowQuoteCosts {
  return {
    resultingLtv: ratioOrNull(fields.resultingLtv, `${path}.resultingLtv`),
    resultingBand: band(fields.resultingBand, `${path}.resultingBand`),
    fees: list(fields.fees, `${path}.fees`).map((fee, index) => {
      const leg = record(fee, `${path}.fees[${index}]`)
      return { type: text(leg.type, `${path}.fees[${index}].type`), amount: amount(leg.amount, `${path}.fees[${index}].amount`) }
    }),
    gasFees: list(fields.gasFees, `${path}.gasFees`).map((entry, index) => {
      const item = record(entry, `${path}.gasFees[${index}]`)
      const fees = record(item.fees, `${path}.gasFees[${index}].fees`)
      return {
        name: text(item.name, `${path}.gasFees[${index}].name`),
        gasUnits: matching(fees.gas, INTEGER, `${path}.gasFees[${index}].fees.gas`),
        gasPriceWei: matching(fees.gasPrice, INTEGER, `${path}.gasFees[${index}].fees.gasPrice`),
        feeWei: matching(fees.fee, INTEGER, `${path}.gasFees[${index}].fees.fee`),
      }
    }),
  }
}

export function normalizeBorrowQuote(kind: BorrowQuote['kind'], value: unknown, path = 'quote'): BorrowQuote {
  const fields = record(value, path)
  arcChain(fields.chain, `${path}.chain`)
  const base = outcome(fields, path)
  switch (kind) {
    case 'borrow':
      return {
        kind,
        collateral: amount(fields.collateralAmount, `${path}.collateralAmount`),
        loanAsset: amount(fields.loanAssetAmount, `${path}.loanAssetAmount`),
        borrowApy: ratioOrNull(fields.borrowApy, `${path}.borrowApy`),
        ...base,
        ...costs(fields, path),
      }
    case 'required-collateral':
      return { kind, requiredCollateral: amount(fields.requiredCollateral, `${path}.requiredCollateral`), ...base }
    case 'max-borrow':
      return { kind, maxBorrow: amount(fields.maxBorrowAmount, `${path}.maxBorrowAmount`), ...base }
    case 'repay':
      return { kind, repayAmount: amount(fields.repayAmount, `${path}.repayAmount`), ...base, ...costs(fields, path) }
    case 'close-loan':
    case 'withdraw-collateral':
      return {
        kind,
        maxRepayment: amount(fields.bundledRepayment, `${path}.bundledRepayment`),
        collateral: amount(fields.collateralAmount, `${path}.collateralAmount`),
        ...base,
        ...costs(fields, path),
      }
    case 'add-collateral':
      return { kind, collateral: amount(fields.collateralAmount, `${path}.collateralAmount`), ...base, ...costs(fields, path) }
  }
}

const SDK_ERROR_CODES: Partial<Record<number, BorrowErrorCode>> = {
  1200: 'loan_not_found',
  1204: 'invalid_input',
  1205: 'unsupported_chain',
  1207: 'market_not_found',
}

export function toBorrowError(error: unknown): BorrowError {
  if (error instanceof BorrowResponseError) {
    return { code: error.code, retryable: false, detail: error.path }
  }
  if (isKitError(error)) {
    const retryable = error.recoverability === 'RETRYABLE'
    return {
      code: SDK_ERROR_CODES[error.code] ?? (retryable ? 'service_unavailable' : 'service_rejected'),
      retryable,
      detail: error.name,
      sdkCode: error.code,
    }
  }
  return { code: 'unexpected_error', retryable: false }
}

function unavailable<T>(code: BorrowErrorCode, detail?: string): BorrowAvailability<T> {
  return { status: 'unavailable', error: { code, retryable: false, ...(detail ? { detail } : {}) } }
}

async function read<T>(
  invalidInput: string | null,
  load: () => Promise<unknown>,
  normalize: (value: unknown) => T,
): Promise<BorrowAvailability<T>> {
  if (MAINNET_BORROW_READ_ONLY_ENABLED !== true) return unavailable('reads_disabled')
  if (invalidInput) return unavailable('invalid_input', invalidInput)
  try {
    return { status: 'available', data: normalize(await load()) }
  } catch (error) {
    return { status: 'unavailable', error: toBorrowError(error) }
  }
}

function invalid(checks: Record<string, boolean>) {
  return Object.entries(checks).find(([, ok]) => !ok)?.[0] ?? null
}

const isAddress = (value: unknown) => typeof value === 'string' && ADDRESS.test(value)
const isMarketId = (value: unknown) => typeof value === 'string' && BYTES32.test(value)
const isLoanId = (value: unknown) => typeof value === 'string' && UUID.test(value)
const isAmount = (value: unknown) => typeof value === 'string' && POSITIVE_DECIMAL.test(value)
const isSlippage = (value: unknown) =>
  value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10_000)
const isPageSize = (value: unknown) =>
  value === undefined || (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 100)
const isCursor = (value: unknown) =>
  value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= 2048)

// SDK requests below are built field by field. Inputs are never spread into a
// request, so a caller cannot replace the chain or add SDK config, a base URL
// or a credential: unknown input fields are simply not read.

export function exploreBorrowMarkets(
  options: { sortBy?: 'lltv' | 'borrowApy'; pageSize?: number; pageAfter?: string } = {},
  client: BorrowReadClient = getMainnetBorrowKit(),
): Promise<BorrowAvailability<BorrowPage<BorrowMarket>>> {
  return read(
    invalid({
      sortBy: options.sortBy === undefined || options.sortBy === 'lltv' || options.sortBy === 'borrowApy',
      pageSize: isPageSize(options.pageSize),
      pageAfter: isCursor(options.pageAfter),
    }),
    () => client.exploreMarkets({
      chain: ARC,
      sortBy: options.sortBy,
      pageSize: options.pageSize,
      pageAfter: options.pageAfter,
    }),
    (value) => {
      const fields = record(value, 'exploreMarkets')
      return {
        items: list(fields.markets, 'exploreMarkets.markets').map((market, index) => normalizeBorrowMarket(market, `markets[${index}]`)),
        nextPageAfter: cursor(fields.pagination, 'exploreMarkets.pagination'),
      }
    },
  )
}

export function getBorrowMarket(
  marketId: string,
  client: BorrowReadClient = getMainnetBorrowKit(),
): Promise<BorrowAvailability<BorrowMarket>> {
  return read(
    invalid({ marketId: isMarketId(marketId) }),
    () => client.getMarket({ chain: ARC, marketId }),
    (value) => {
      const market = normalizeBorrowMarket(value)
      if (market.marketId.toLowerCase() !== marketId.toLowerCase()) malformed('market.marketId')
      return market
    },
  )
}

export function quoteRequiredCollateral(
  input: { marketId: string; borrowAmount: string; targetHealthFactor: number },
  client: BorrowReadClient = getMainnetBorrowKit(),
): Promise<BorrowAvailability<BorrowQuote>> {
  return read(
    invalid({
      marketId: isMarketId(input.marketId),
      borrowAmount: isAmount(input.borrowAmount),
      targetHealthFactor: Number.isFinite(input.targetHealthFactor) && input.targetHealthFactor > 1,
    }),
    () => client.getRequiredCollateral({
      chain: ARC,
      marketId: input.marketId,
      borrowAmount: input.borrowAmount,
      targetHealthFactor: input.targetHealthFactor,
    }),
    (value) => normalizeBorrowQuote('required-collateral', value),
  )
}

export function quoteMaxBorrow(
  input: { marketId: string; collateralAmount: string },
  client: BorrowReadClient = getMainnetBorrowKit(),
): Promise<BorrowAvailability<BorrowQuote>> {
  return read(
    invalid({ marketId: isMarketId(input.marketId), collateralAmount: isAmount(input.collateralAmount) }),
    () => client.getMaxBorrow({ chain: ARC, marketId: input.marketId, collateralAmount: input.collateralAmount }),
    (value) => normalizeBorrowQuote('max-borrow', value),
  )
}

// Open-loan preview (wallet + market) or borrow-more preview (loan). No API
// key is passed: integrator fees would need a server-only Circle key.
export function quoteBorrow(
  input:
    | { marketId: string; walletAddress: string; borrowAmount: string; slippageBps?: number }
    | { loanId: string; borrowAmount: string; slippageBps?: number },
  client: BorrowReadClient = getMainnetBorrowKit(),
): Promise<BorrowAvailability<BorrowQuote>> {
  const target: Record<string, boolean> = 'loanId' in input
    ? { loanId: isLoanId(input.loanId) }
    : { marketId: isMarketId(input.marketId), walletAddress: isAddress(input.walletAddress) }
  return read(
    invalid({ ...target, borrowAmount: isAmount(input.borrowAmount), slippageBps: isSlippage(input.slippageBps) }),
    // A borrow-more preview takes no chain: the service resolves it from the
    // loan, and the response chain is still checked to be Arc.
    () => client.getBorrowQuote('loanId' in input
      ? { loanId: input.loanId, borrowAmount: input.borrowAmount, slippageBps: input.slippageBps }
      : {
        chain: ARC,
        marketId: input.marketId,
        walletAddress: input.walletAddress,
        borrowAmount: input.borrowAmount,
        slippageBps: input.slippageBps,
      }),
    (value) => normalizeBorrowQuote('borrow', value),
  )
}

export function getBorrowLoans(
  input: { walletAddress: string; pageSize?: number; pageAfter?: string },
  client: BorrowReadClient = getMainnetBorrowKit(),
): Promise<BorrowAvailability<BorrowPage<BorrowPosition>>> {
  return read(
    invalid({
      walletAddress: isAddress(input.walletAddress),
      pageSize: isPageSize(input.pageSize),
      pageAfter: isCursor(input.pageAfter),
    }),
    () => client.getLoans({
      chain: ARC,
      walletAddress: input.walletAddress,
      pageSize: input.pageSize,
      pageAfter: input.pageAfter,
    }),
    (value) => {
      const fields = record(value, 'getLoans')
      const items = list(fields.loans, 'getLoans.loans').map((loan, index) => normalizeBorrowPosition(loan, `loans[${index}]`))
      if (items.some((loan) => loan.owner.toLowerCase() !== input.walletAddress.toLowerCase())) {
        throw new BorrowResponseError('unexpected_owner', 'loans[].walletAddress')
      }
      return { items, nextPageAfter: cursor(fields.pagination, 'getLoans.pagination') }
    },
  )
}

export function getBorrowPosition(
  input: { loanId: string; expectedOwner?: string },
  client: BorrowReadClient = getMainnetBorrowKit(),
): Promise<BorrowAvailability<BorrowPosition>> {
  return read(
    invalid({ loanId: isLoanId(input.loanId), expectedOwner: input.expectedOwner === undefined || isAddress(input.expectedOwner) }),
    () => client.getPosition({ loanId: input.loanId }),
    (value) => {
      const position = normalizeBorrowPosition(value)
      if (position.loanId.toLowerCase() !== input.loanId.toLowerCase()) malformed('loan.loanId')
      if (input.expectedOwner && position.owner.toLowerCase() !== input.expectedOwner.toLowerCase()) {
        throw new BorrowResponseError('unexpected_owner', 'loan.wallet')
      }
      return position
    },
  )
}

export function quoteRepay(
  input: { loanId: string; repayAmount: string },
  client: BorrowReadClient = getMainnetBorrowKit(),
): Promise<BorrowAvailability<BorrowQuote>> {
  return read(
    invalid({ loanId: isLoanId(input.loanId), repayAmount: isAmount(input.repayAmount) }),
    () => client.getRepayQuote({ chain: ARC, loanId: input.loanId, repayAmount: input.repayAmount }),
    (value) => normalizeBorrowQuote('repay', value),
  )
}

export function quoteCloseLoan(
  input: { loanId: string; slippageBps?: number },
  client: BorrowReadClient = getMainnetBorrowKit(),
): Promise<BorrowAvailability<BorrowQuote>> {
  return read(
    invalid({ loanId: isLoanId(input.loanId), slippageBps: isSlippage(input.slippageBps) }),
    () => client.getCloseLoanQuote({ chain: ARC, loanId: input.loanId, slippageBps: input.slippageBps }),
    (value) => normalizeBorrowQuote('close-loan', value),
  )
}

export function quoteAddCollateral(
  input: { loanId: string; collateralAmount: string },
  client: BorrowReadClient = getMainnetBorrowKit(),
): Promise<BorrowAvailability<BorrowQuote>> {
  return read(
    invalid({ loanId: isLoanId(input.loanId), collateralAmount: isAmount(input.collateralAmount) }),
    () => client.getAddCollateralQuote({ chain: ARC, loanId: input.loanId, collateralAmount: input.collateralAmount }),
    (value) => normalizeBorrowQuote('add-collateral', value),
  )
}

export function quoteWithdrawCollateral(
  input: { loanId: string; collateralAmount: string; slippageBps?: number },
  client: BorrowReadClient = getMainnetBorrowKit(),
): Promise<BorrowAvailability<BorrowQuote>> {
  return read(
    invalid({
      loanId: isLoanId(input.loanId),
      collateralAmount: isAmount(input.collateralAmount),
      slippageBps: isSlippage(input.slippageBps),
    }),
    () => client.getWithdrawCollateralRepayIfNeededQuote({
      chain: ARC,
      loanId: input.loanId,
      collateralAmount: input.collateralAmount,
      slippageBps: input.slippageBps,
    }),
    (value) => normalizeBorrowQuote('withdraw-collateral', value),
  )
}

// ---------------------------------------------------------------------------
// Guarded writes. Disabled by MAINNET_BORROW_WRITES_ENABLED; nothing below
// signs, approves or broadcasts while that constant is false.
// ---------------------------------------------------------------------------

export type BorrowWalletCapability = 'supported' | 'unsupported' | 'unknown'

type Eip1193Request = (args: { method: string; params?: unknown[] }) => Promise<unknown>

// EIP-5792 read: asks the wallet whether it can settle an atomic batch on Arc.
// No signature and no transaction. Any failure reports the wallet as unable.
export async function detectAtomicBatchCapability(
  request: Eip1193Request,
  address: string,
): Promise<BorrowWalletCapability> {
  if (!isAddress(address)) return 'unknown'
  const chainHex = `0x${MAINNET_BORROW_CHAIN_ID.toString(16)}`
  let response: unknown
  try {
    response = await request({ method: 'wallet_getCapabilities', params: [address, [chainHex]] })
  } catch {
    return 'unsupported'
  }
  if (typeof response !== 'object' || response === null) return 'unknown'
  const byChain = response as Record<string, unknown>
  const chainCapabilities = byChain[chainHex] ?? byChain[String(MAINNET_BORROW_CHAIN_ID)] ?? byChain['0x0']
  if (typeof chainCapabilities !== 'object' || chainCapabilities === null) return 'unsupported'
  const atomic = (chainCapabilities as Record<string, unknown>).atomic
  if (typeof atomic !== 'object' || atomic === null) return 'unsupported'
  const { status, supported } = atomic as { status?: unknown; supported?: unknown }
  // Same acceptance rule as @circle-fin/adapter-viem-v2 supportsAtomicBatch.
  if (status === 'supported' || status === 'ready' || supported === true) return 'supported'
  return status === 'unsupported' || supported === false ? 'unsupported' : 'unknown'
}

export type BorrowWriteAction =
  | { kind: 'borrow'; marketId: string; borrowAmount: string; slippageBps?: number }
  | { kind: 'borrow-more'; loanId: string; borrowAmount: string; slippageBps?: number }
  | { kind: 'repay'; loanId: string; repayAmount: string }
  | { kind: 'add-collateral'; loanId: string; collateralAmount: string }
  | { kind: 'withdraw-collateral'; loanId: string; collateralAmount: string; slippageBps?: number }
  | { kind: 'close-loan'; loanId: string; slippageBps?: number }

export type BorrowWalletState = {
  address?: string | null
  chainId?: number | null
  atomicBatch: BorrowWalletCapability
}

export type BorrowWriteBlocker =
  | 'writes_disabled'
  | 'wallet_missing'
  | 'wrong_chain'
  | 'wallet_capability_missing'
  | 'invalid_action'
  | 'quote_missing'
  | 'quote_mismatch'
  | 'not_confirmed'

// What the wallet would be asked to sign, in batch order. Every write is one
// atomic batch; approvals are exact and go to the Circle Borrow Adapter only.
export type BorrowWalletRequest =
  | 'allowance-reset-if-partial'
  | 'collateral-approval-if-short'
  | 'usdc-approval-if-short'
  | 'morpho-authorization-grant'
  | 'adapter-execution'
  | 'morpho-authorization-revoke'

export type BorrowWritePlan = {
  actionId: string
  action: BorrowWriteAction
  owner: Hex | null
  chain: typeof MAINNET_BORROW_CHAIN
  chainId: number
  approvalSpender: typeof MAINNET_BORROW_ADAPTER_CONTRACT
  walletRequests: BorrowWalletRequest[]
  blockers: BorrowWriteBlocker[]
  ready: boolean
}

const WALLET_REQUESTS: Record<BorrowWriteAction['kind'], BorrowWalletRequest[]> = {
  'borrow': ['collateral-approval-if-short', 'morpho-authorization-grant', 'adapter-execution', 'morpho-authorization-revoke'],
  'borrow-more': ['collateral-approval-if-short', 'morpho-authorization-grant', 'adapter-execution', 'morpho-authorization-revoke'],
  'repay': ['usdc-approval-if-short', 'adapter-execution'],
  'add-collateral': ['allowance-reset-if-partial', 'collateral-approval-if-short', 'adapter-execution'],
  'withdraw-collateral': ['usdc-approval-if-short', 'morpho-authorization-grant', 'adapter-execution', 'morpho-authorization-revoke'],
  'close-loan': ['usdc-approval-if-short', 'morpho-authorization-grant', 'adapter-execution', 'morpho-authorization-revoke'],
}

const QUOTE_KIND: Record<BorrowWriteAction['kind'], BorrowQuote['kind']> = {
  'borrow': 'borrow',
  'borrow-more': 'borrow',
  'repay': 'repay',
  'add-collateral': 'add-collateral',
  'withdraw-collateral': 'withdraw-collateral',
  'close-loan': 'close-loan',
}

function sameDecimal(left: string, right: string) {
  const normalize = (value: string) => {
    const [whole, fraction = ''] = value.split('.')
    return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.replace(/0+$/, '')}`
  }
  return DECIMAL.test(left) && DECIMAL.test(right) && normalize(left) === normalize(right)
}

function actionIsValid(action: BorrowWriteAction) {
  switch (action.kind) {
    case 'borrow':
      return isMarketId(action.marketId) && isAmount(action.borrowAmount) && isSlippage(action.slippageBps)
    case 'borrow-more':
      return isLoanId(action.loanId) && isAmount(action.borrowAmount) && isSlippage(action.slippageBps)
    case 'repay':
      return isLoanId(action.loanId) && isAmount(action.repayAmount)
    case 'add-collateral':
      return isLoanId(action.loanId) && isAmount(action.collateralAmount)
    case 'withdraw-collateral':
      return isLoanId(action.loanId) && isAmount(action.collateralAmount) && isSlippage(action.slippageBps)
    case 'close-loan':
      return isLoanId(action.loanId) && isSlippage(action.slippageBps)
    default:
      return false
  }
}

function quoteMatches(action: BorrowWriteAction, quote: BorrowQuote) {
  if (quote.kind !== QUOTE_KIND[action.kind]) return false
  switch (action.kind) {
    case 'borrow':
    case 'borrow-more':
      return quote.kind === 'borrow' && sameDecimal(quote.loanAsset.amount, action.borrowAmount)
    case 'repay':
      return quote.kind === 'repay' && sameDecimal(quote.repayAmount.amount, action.repayAmount)
    case 'add-collateral':
      return quote.kind === 'add-collateral' && sameDecimal(quote.collateral.amount, action.collateralAmount)
    case 'withdraw-collateral':
      return quote.kind === 'withdraw-collateral' && sameDecimal(quote.collateral.amount, action.collateralAmount)
    case 'close-loan':
      return true
  }
}

function actionIdOf(action: BorrowWriteAction, owner: string | null) {
  const target = action.kind === 'borrow' ? action.marketId : action.loanId
  const value = 'borrowAmount' in action ? action.borrowAmount
    : 'repayAmount' in action ? action.repayAmount
      : 'collateralAmount' in action ? action.collateralAmount : ''
  const slippage = 'slippageBps' in action && action.slippageBps !== undefined ? String(action.slippageBps) : 'default'
  return [action.kind, MAINNET_BORROW_CHAIN_ID, owner?.toLowerCase() ?? '', target.toLowerCase(), value, slippage].join('|')
}

// Pure: reports every reason a write could not run, without touching the SDK,
// the wallet or the network. The UI shows the plan and its blockers.
export function planBorrowWrite(
  action: BorrowWriteAction,
  wallet: BorrowWalletState | null,
  quote: BorrowQuote | null,
): BorrowWritePlan {
  const blockers: BorrowWriteBlocker[] = []
  if (MAINNET_BORROW_WRITES_ENABLED !== true) blockers.push('writes_disabled')
  const owner = wallet?.address && isAddress(wallet.address) ? wallet.address as Hex : null
  if (!owner) blockers.push('wallet_missing')
  if (wallet?.chainId !== MAINNET_BORROW_CHAIN_ID) blockers.push('wrong_chain')
  if (wallet?.atomicBatch !== 'supported') blockers.push('wallet_capability_missing')
  const valid = actionIsValid(action)
  if (!valid) blockers.push('invalid_action')
  if (!quote) blockers.push('quote_missing')
  else if (!valid || !quoteMatches(action, quote)) blockers.push('quote_mismatch')
  return {
    actionId: valid ? actionIdOf(action, owner) : '',
    action,
    owner,
    chain: MAINNET_BORROW_CHAIN,
    chainId: MAINNET_BORROW_CHAIN_ID,
    approvalSpender: MAINNET_BORROW_ADAPTER_CONTRACT,
    walletRequests: valid ? WALLET_REQUESTS[action.kind] : [],
    blockers,
    ready: blockers.length === 0,
  }
}

export type BorrowWriteRequest = {
  action: BorrowWriteAction
  wallet: BorrowWalletState | null
  quote: BorrowQuote | null
  // The actionId of the plan the user explicitly reviewed and executed.
  confirmedActionId: string
  // Builds the connected-wallet adapter; only called after every check passes.
  getAdapter: () => Promise<Parameters<BorrowKit['repay']>[0]['from']['adapter']>
  client?: BorrowWriteClient
}

export type BorrowWriteOutcome =
  | { status: 'refused'; blockers: BorrowWriteBlocker[] }
  | { status: 'submitted'; loanId: string; batchId: string }
  | { status: 'confirmed' | 'confirmed-details-unavailable'; loanId: string; batchId: string; txHash: string }
  | { status: 'failed'; error: BorrowError }

export async function executeBorrowWrite(request: BorrowWriteRequest): Promise<BorrowWriteOutcome> {
  // The gate is checked first: while it is false no adapter is created and no
  // SDK write method is reached, so no wallet prompt can appear.
  if (MAINNET_BORROW_WRITES_ENABLED !== true) return { status: 'refused', blockers: ['writes_disabled'] }
  const plan = planBorrowWrite(request.action, request.wallet, request.quote)
  if (!plan.ready) return { status: 'refused', blockers: plan.blockers }
  if (request.confirmedActionId !== plan.actionId) return { status: 'refused', blockers: ['not_confirmed'] }

  try {
    const client = request.client ?? getMainnetBorrowKit()
    const from = { adapter: await request.getAdapter(), chain: ARC }
    const action = request.action
    const result = await (() => {
      switch (action.kind) {
        case 'borrow':
          return client.borrow({ from, marketId: action.marketId, borrowAmount: action.borrowAmount, slippageBps: action.slippageBps })
        case 'borrow-more':
          return client.borrow({ from, loanId: action.loanId, borrowAmount: action.borrowAmount, slippageBps: action.slippageBps })
        case 'repay':
          return client.repay({ from, loanId: action.loanId, repayAmount: action.repayAmount })
        case 'add-collateral':
          return client.addCollateral({ from, loanId: action.loanId, collateralAmount: action.collateralAmount })
        case 'withdraw-collateral':
          return client.withdrawCollateralRepayIfNeeded({
            from,
            loanId: action.loanId,
            collateralAmount: action.collateralAmount,
            slippageBps: action.slippageBps,
          })
        case 'close-loan':
          return client.closeLoan({ from, loanId: action.loanId, slippageBps: action.slippageBps })
      }
    })()
    if (result.status === 'submitted') return { status: 'submitted', loanId: result.loanId, batchId: result.batchId }
    return { status: result.status, loanId: result.loanId, batchId: result.batchId, txHash: result.txHash }
  } catch (error) {
    return { status: 'failed', error: toBorrowError(error) }
  }
}
