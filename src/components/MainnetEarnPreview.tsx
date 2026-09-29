import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, RefreshCw, ShieldCheck, TrendingUp } from 'lucide-react'
import { EarnKit } from '@circle-fin/earn-kit'
import {
  MAINNET_EARN_ASSET,
  MAINNET_EARN_CHAIN,
  MAINNET_EARN_READ_ONLY_ENABLED,
  MAINNET_EARN_SELECTED_VAULT_ADDRESSES,
  MAINNET_EARN_VERIFIED_GUARDED_VAULT_ADDRESSES,
  MAINNET_EARN_WRITES_ENABLED,
} from '../config/mainnetEarn'
import MainnetEarnActions from './MainnetEarnActions'

type EarnVault = {
  vaultAddress?: string
  address?: string
  chain?: string
  name?: string
  protocol?: string
  asset?: string
  currentApy?: number | null
  vaultFee?: number | null
  status?: string
  circleGuarded?: boolean
  manager?: string | null
  totalDeposits?: string | null
  liquidity?: string | null
  apyProfile?: {
    current?: number | null
    native?: number | null
    source?: string | null
  } | null
  fee?: {
    performance?: number | null
    management?: number | null
  } | null
  riskSignals?: {
    circleSentinel?: boolean | null
    warnings?: unknown[]
    earnKitWarnings?: unknown[]
  } | null
  liquidityProfile?: {
    totalDeposits?: string | null
    available?: string | null
    totalSupply?: string | null
    status?: string | null
  } | null
}

type SupportedChain = {
  name?: string
  isTestnet?: boolean
}

const earnKit = new EarnKit()
const ARC_MAINNET_CHAIN_ID = 5042
const MORPHO_GRAPHQL_ENDPOINT = 'https://api.morpho.org/graphql'

const GALAXY_USDC_ADDRESS =
  '0x8E357432CC12ff425c36432F312968aEb16112AF'

const GALAXY_USDC_FALLBACK: EarnVault = {
  vaultAddress: GALAXY_USDC_ADDRESS,
  name: 'Galaxy USDC',
  protocol: 'MORPHO',
  asset: 'USDC',
  circleGuarded: true,
}

const selectedVaultAddresses = new Set(
  MAINNET_EARN_SELECTED_VAULT_ADDRESSES.map((address) => address.toLowerCase()),
)

const selectedVaultOrder = new Map(
  MAINNET_EARN_SELECTED_VAULT_ADDRESSES.map((address, index) => [
    address.toLowerCase(),
    index,
  ]),
)

const verifiedGuardedVaultAddresses = new Set(
  MAINNET_EARN_VERIFIED_GUARDED_VAULT_ADDRESSES.map((address) => address.toLowerCase()),
)

function formatApy(vault: EarnVault) {
  const apy = vault.currentApy ?? vault.apyProfile?.current
  if (apy == null || !Number.isFinite(apy)) return 'Unavailable'

  const percent = apy * 100
  if (percent > 0 && percent < 0.01) return '<0.01%'
  return `${percent.toFixed(2)}%`
}

function formatUsdc(value?: string | null) {
  if (!value) return 'Unavailable'
  const amount = Number(value)
  if (!Number.isFinite(amount)) return `${value} USDC`
  return `${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC`
}

function vaultAddress(vault: EarnVault) {
  return vault.vaultAddress ?? vault.address ?? ''
}

function isCircleGuardedVault(vault: EarnVault) {
  const address = vaultAddress(vault).toLowerCase()
  return vault.circleGuarded === true || verifiedGuardedVaultAddresses.has(address)
}

function shortAddress(address: string) {
  if (!address) return ''
  if (address.length <= 12) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function isSelectedVault(vault: EarnVault) {
  return selectedVaultAddresses.has(vaultAddress(vault).toLowerCase())
}

function isUsdcVault(vault: EarnVault) {
  const asset = (vault.asset ?? '').toUpperCase()
  return !asset || asset === MAINNET_EARN_ASSET
}

function isActiveVault(vault: EarnVault) {
  const status = vault.status ?? vault.liquidityProfile?.status
  return !status || status === 'active'
}

function collectSelectedVaults(vaults: readonly EarnVault[]) {
  const selected = new Map<string, EarnVault>()

  for (const vault of vaults) {
    const address = vaultAddress(vault).toLowerCase()
    if (!address) continue
    if (!isSelectedVault(vault)) continue
    if (!isUsdcVault(vault)) continue
    if (!isActiveVault(vault)) continue
    if (!isCircleGuardedVault(vault)) continue
    selected.set(address, vault)
  }

  return selected
}

type MorphoVaultResponse = {
  data?: {
    vaultByAddress?: {
      address?: string
      name?: string | null
      asset?: {
        symbol?: string | null
        decimals?: number | null
      } | null
      state?: {
        totalAssets?: string | null
        apy?: string | number | null
        netApy?: string | number | null
        allocation?: Array<{
          supplyAssets?: string | null
          market?: {
            collateralAsset?: { symbol?: string | null } | null
            loanAsset?: { decimals?: number | null } | null
            state?: {
              supplyAssets?: string | null
              borrowAssets?: string | null
            } | null
          } | null
        }> | null
      } | null
    } | null
  }
  errors?: Array<{ message?: string }>
}

function decimalFromBaseUnits(value: bigint, decimals: number) {
  const divisor = 10 ** decimals
  return Number(value) / divisor
}

function morphoAvailableLiquidity(
  allocations: NonNullable<NonNullable<NonNullable<MorphoVaultResponse['data']>['vaultByAddress']>['state']>['allocation'],
  assetDecimals: number,
) {
  if (!allocations) return null

  let available = 0

  for (const allocation of allocations) {
    const market = allocation.market

    if (allocation.supplyAssets == null || !market) return null

    const suppliedToMarket = BigInt(allocation.supplyAssets)

    if (!market.collateralAsset) {
      available += decimalFromBaseUnits(suppliedToMarket, assetDecimals)
      continue
    }

    if (market.state?.supplyAssets == null || market.state.borrowAssets == null) return null

    const marketSupply = BigInt(market.state.supplyAssets)
    const marketBorrow = BigInt(market.state.borrowAssets)
    const marketAvailable = marketSupply > marketBorrow ? marketSupply - marketBorrow : 0n
    const withdrawable = suppliedToMarket < marketAvailable ? suppliedToMarket : marketAvailable
    const decimals = market.loanAsset?.decimals ?? assetDecimals

    available += decimalFromBaseUnits(withdrawable, decimals)
  }

  return available.toString()
}

async function fetchMorphoVaultFallback(address: string): Promise<EarnVault | null> {
  const response = await fetch(MORPHO_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `
        query VaultByAddress($address: String!, $chainId: Int!) {
          vaultByAddress(address: $address, chainId: $chainId) {
            address
            name
            asset {
              symbol
              decimals
            }
            state {
              totalAssets
              apy
              netApy
              allocation {
                supplyAssets
                market {
                  collateralAsset { symbol }
                  loanAsset { decimals }
                  state {
                    supplyAssets
                    borrowAssets
                  }
                }
              }
            }
          }
        }
      `,
      variables: {
        address,
        chainId: ARC_MAINNET_CHAIN_ID,
      },
    }),
  })

  if (!response.ok) return null

  const body = await response.json() as MorphoVaultResponse
  const vault = body.data?.vaultByAddress
  if (!vault?.address) return null

  const decimals = vault.asset?.decimals ?? 6
  const totalAssetsRaw = vault.state?.totalAssets
  const currentApy = Number(vault.state?.netApy ?? vault.state?.apy)
  const available = morphoAvailableLiquidity(vault.state?.allocation ?? null, decimals)

  return {
    vaultAddress: vault.address,
    name: vault.name ?? undefined,
    protocol: 'MORPHO',
    asset: vault.asset?.symbol ?? MAINNET_EARN_ASSET,
    currentApy: Number.isFinite(currentApy) ? currentApy : null,
    totalDeposits: totalAssetsRaw == null
      ? null
      : decimalFromBaseUnits(BigInt(totalAssetsRaw), decimals).toString(),
    liquidity: available,
  }
}

function warningText(value: unknown) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return null

  const warning = value as {
    message?: unknown
    description?: unknown
    title?: unknown
    code?: unknown
  }

  for (const candidate of [
    warning.message,
    warning.description,
    warning.title,
    warning.code,
  ]) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim()
    }
  }

  return null
}

export default function MainnetEarnPreview() {
  const [vaults, setVaults] = useState<EarnVault[]>([])
  const [supportedChains, setSupportedChains] = useState<SupportedChain[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadVaults = useCallback(async () => {
    if (!MAINNET_EARN_READ_ONLY_ENABLED) return

    setLoading(true)
    setError(null)

    try {
      const chains = earnKit.getSupportedChains() as SupportedChain[]
      setSupportedChains(chains)

      const discoveryResult = await earnKit.exploreVaults({
        chain: MAINNET_EARN_CHAIN,
        sortBy: 'apy',
      } as never) as unknown as { vaults?: readonly EarnVault[] }

      const selectedVaults = collectSelectedVaults(discoveryResult.vaults ?? [])

      const missingAddresses = MAINNET_EARN_SELECTED_VAULT_ADDRESSES.filter(
        (address) => !selectedVaults.has(address.toLowerCase()),
      )

      for (const vaultAddressValue of missingAddresses) {
        try {
          const directResult = await earnKit.getVaults({
            vaults: [{
              chain: MAINNET_EARN_CHAIN,
              vaultAddress: vaultAddressValue,
            }],
          } as never) as unknown as { vaults?: readonly EarnVault[] }

          const directVaults = collectSelectedVaults(directResult.vaults ?? [])
          for (const [address, vault] of directVaults.entries()) {
            selectedVaults.set(address, vault)
          }
        } catch {
          // Keep any vaults already returned by discovery. A failed direct
          // lookup must not hide the other reviewed vault.
        }
      }

      const stillMissingAddresses = MAINNET_EARN_SELECTED_VAULT_ADDRESSES.filter(
        (address) => !selectedVaults.has(address.toLowerCase()),
      )

      for (const vaultAddressValue of stillMissingAddresses) {
        try {
          const morphoVault = await fetchMorphoVaultFallback(vaultAddressValue)
          if (morphoVault) {
            const fallbackVaults = collectSelectedVaults([morphoVault])
            for (const [address, vault] of fallbackVaults.entries()) {
              selectedVaults.set(address, vault)
            }
          }
        } catch {
          // Keep the remaining reviewed vaults visible if Morpho fallback fails.
        }
      }

      const galaxyAddress = GALAXY_USDC_ADDRESS.toLowerCase()

      if (!selectedVaults.has(galaxyAddress)) {
        selectedVaults.set(
          galaxyAddress,
          GALAXY_USDC_FALLBACK,
        )
      }

      const orderedVaults = [...selectedVaults.values()].sort((left, right) => {
        const leftOrder =
          selectedVaultOrder.get(vaultAddress(left).toLowerCase()) ?? Number.MAX_SAFE_INTEGER
        const rightOrder =
          selectedVaultOrder.get(vaultAddress(right).toLowerCase()) ?? Number.MAX_SAFE_INTEGER
        return leftOrder - rightOrder
      })

      setVaults(orderedVaults)
    } catch (cause) {
      setVaults([GALAXY_USDC_FALLBACK])
      setError(
        cause instanceof Error
          ? cause.message
          : 'Arc Earn vault discovery is temporarily unavailable.',
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadVaults()
  }, [loadVaults])

  const arcSupported = useMemo(
    () => supportedChains.some((chain) => chain.name === MAINNET_EARN_CHAIN && !chain.isTestnet),
    [supportedChains],
  )

  return (
    <section className="bg-slate-50 px-4 py-5 text-slate-900">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_16px_45px_rgba(15,23,42,0.08)]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <TrendingUp size={20} className="text-[#2F6E0C]" />
                <h2 className="text-2xl font-semibold tracking-tight">Earn USDC</h2>
              </div>
              <p className="mt-2 max-w-xl text-sm leading-6 text-slate-500">
                Choose a vault, review the quote, and manage your USDC position on Arc.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadVaults()}
              disabled={loading}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs text-slate-500">Network</p>
              <p className="mt-1 font-semibold">Arc Mainnet</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs text-slate-500">Asset</p>
              <p className="mt-1 font-semibold">USDC</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs text-slate-500">Machina fee</p>
              <p className="mt-1 font-semibold text-emerald-700">0 USDC</p>
            </div>
          </div>

          {MAINNET_EARN_WRITES_ENABLED && <MainnetEarnActions />}

          {loading && vaults.length === 0 && (
            <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-500">
              Loading Arc USDC vaults...
            </div>
          )}

          {error && (
            <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-700">
              <p className="font-semibold">Earn discovery is not ready yet.</p>
              <p className="mt-1">{error}</p>
              {supportedChains.length > 0 && (
                <p className="mt-2 text-xs">
                  Supported networks reported: {supportedChains.map((chain) => chain.name).filter(Boolean).join(', ')}
                </p>
              )}
            </div>
          )}

          {!loading && !error && supportedChains.length > 0 && !arcSupported && (
            <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              Arc mainnet vault support is temporarily unavailable. Deposits remain locked.
            </div>
          )}

          {!loading && !error && vaults.length === 0 && (
            <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-500">
              No selected USDC vault is currently available on Arc mainnet.
            </div>
          )}

          {vaults.length > 0 && (
            <div className="mt-5 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">USDC vaults on Arc</h3>
                  <p className="mt-1 text-xs text-slate-500">
                    Compare current rates and withdrawable liquidity across selected vaults.
                  </p>
                  <p className="mt-1 text-[11px] leading-5 text-slate-400">
                    Circle Guarded adds protocol safeguards, but it does not remove smart contract or market risk.
                  </p>
                </div>
                <span className="rounded-full bg-[#eef7e8] px-3 py-1 text-xs font-semibold text-[#2F6E0C]">
                  {vaults.length} selected
                </span>
              </div>

              {vaults.map((vault, index) => {
                const address = vaultAddress(vault)
                const guarded = isCircleGuardedVault(vault)
                const hasPerformanceFee = vault.fee?.performance != null
                const hasManagementFee = vault.fee?.management != null
                const metricColumns =
                  hasPerformanceFee && hasManagementFee
                    ? 'lg:grid-cols-4'
                    : hasPerformanceFee || hasManagementFee
                      ? 'lg:grid-cols-3'
                      : 'lg:grid-cols-2'
                const warnings = [
                  ...(vault.riskSignals?.warnings ?? []),
                  ...(vault.riskSignals?.earnKitWarnings ?? []),
                ]
                  .map(warningText)
                  .filter((warning): warning is string => Boolean(warning))

                return (
                  <div
                    key={address || `${vault.name ?? 'vault'}-${index}`}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-semibold text-slate-900">
                            {vault.name || 'USDC Earn vault'}
                          </p>
                          {guarded && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-800">
                              <ShieldCheck size={12} />
                              Circle Guarded
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          Protocol: {vault.protocol || 'Not reported'}
                        </p>
                        {address && (
                          <p className="mt-1 font-mono text-[11px] text-slate-400" title={address}>
                            Contract: {shortAddress(address)}
                          </p>
                        )}
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-slate-500">Current APY</p>
                        <p className="text-xl font-semibold text-slate-900">{formatApy(vault)}</p>
                      </div>
                    </div>

                    <div className={`mt-4 grid gap-3 sm:grid-cols-2 ${metricColumns}`}>
                      <div>
                        <p className="text-[11px] text-slate-500">Total deposits</p>
                        <p className="mt-1 text-sm font-semibold">
                          {formatUsdc(vault.liquidityProfile?.totalDeposits ?? vault.totalDeposits)}
                        </p>
                      </div>
                      <div>
                        <p className="text-[11px] text-slate-500">Withdrawable liquidity</p>
                        <p className="mt-1 text-sm font-semibold">
                          {formatUsdc(vault.liquidityProfile?.available ?? vault.liquidity)}
                        </p>
                      </div>
                      {hasPerformanceFee && (
                        <div>
                          <p className="text-[11px] text-slate-500">Performance fee</p>
                          <p className="mt-1 text-sm font-semibold">
                            {`${(vault.fee!.performance! * 100).toFixed(2)}%`}
                          </p>
                        </div>
                      )}
                      {hasManagementFee && (
                        <div>
                          <p className="text-[11px] text-slate-500">Management fee</p>
                          <p className="mt-1 text-sm font-semibold">
                            {`${(vault.fee!.management! * 100).toFixed(2)}%`}
                          </p>
                        </div>
                      )}
                    </div>

                    {warnings.length > 0 && (
                      <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
                        {warnings.join(' ')}
                      </div>
                    )}

                    {address && (
                      <a
                        href={`https://explorer.arc.io/address/${address}`}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 hover:underline"
                      >
                        View vault contract
                        <ExternalLink size={12} />
                      </a>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          <p className="mt-5 text-[11px] leading-5 text-slate-500">
            Vaults are operated by third party DeFi protocols. Rates are variable and funds remain subject to protocol and market risk. Machina does not take custody of your funds.
          </p>
        </div>
      </div>
    </section>
  )
}
