import { useEffect, useMemo, useRef } from 'react'
import { useCurrentAccount, useCurrentWallet } from '@mysten/dapp-kit'
import { useAccount } from 'wagmi'
import { MAINNET_ARC_WALLET_SEND_ENABLED, MAINNET_SUI_CCTP_WRITES_ENABLED } from '../config/sui'
import { createSuiMainnetWriteController, type SuiWriteWallets } from '../lib/mainnetSuiWritePorts'
import { SuiWriteSignatureRejected, type SuiWriteAttempt, type SuiWriteIntent, type SuiWriteReconciliation, type SuiWriteReview } from '../lib/mainnetSuiExecution'
import { CIRCLE_MAINNET } from '../config/circle'

// The surface the Review/Confirm UI depends on. Production gets it only from
// useSuiMainnetWrite (source gate constant); controlled tests inject their own.
export type SuiTransferWriter = {
  writesEnabled: boolean
  // Independent gate for Arc eth_sendTransaction; false in production.
  walletSendEnabled: boolean
  prepare(i: SuiWriteIntent): Promise<SuiWriteReview>
  confirm(review: SuiWriteReview): Promise<SuiWriteAttempt>
  recover(): Promise<SuiWriteAttempt | null>
  saved(): SuiWriteAttempt | null
  // Mismatch only: read evidence, then release ONLY with the key the user saw.
  inspectMismatch(): Promise<SuiWriteReconciliation>
  reconcile(acknowledgedKey: `0x${string}`): Promise<SuiWriteAttempt>
  invalidate(): void
  feeBps(direction: 'sui-to-arc' | 'arc-to-sui'): Promise<number>
}

// Circle Standard Transfer (finality 2000) minimum fee in basis points. Any
// missing, malformed or out-of-range quote fails closed; no default is used.
export async function fetchSuiCctpStandardFeeBps(direction: 'sui-to-arc' | 'arc-to-sui', fetcher: typeof fetch = fetch) {
  const [src, dst] = direction === 'sui-to-arc' ? [8, 26] : [26, 8]
  const res = await fetcher(`${CIRCLE_MAINNET.irisApiBase}/v2/burn/USDC/fees/${src}/${dst}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error('Circle fee quote is unavailable.')
  const body = await res.json() as unknown
  const rows = Array.isArray(body) ? body.filter(r => r && typeof r === 'object' && (r as { finalityThreshold?: unknown }).finalityThreshold === 2000) : []
  const fee = rows.length === 1 ? (rows[0] as { minimumFee?: unknown }).minimumFee : undefined
  if (typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0 || fee > 100) throw new Error('Circle fee quote is unavailable.')
  return fee
}

// Adapter for the EXISTING Slush/Wallet Standard and wagmi connections. No new
// wallet provider, automatic connection, network switch or signing effect.
// The caller's binding must include direction, recipients, amount and ceilings.
export function useSuiMainnetWrite(binding: string): SuiTransferWriter {
  const account = useCurrentAccount(), wallet = useCurrentWallet(), evm = useAccount()
  const live = useRef({ account, wallet, evm, binding })
  live.current = { account, wallet, evm, binding }
  const captured = useRef<{ binding: string; wallet: typeof wallet.currentWallet; connector: typeof evm.connector } | null>(null)
  const provider = useRef<{ connector: typeof evm.connector; rpc: NonNullable<ReturnType<SuiWriteWallets['evm']>> } | null>(null)
  const controller = useRef<ReturnType<typeof createSuiMainnetWriteController>>()
  if (!controller.current) controller.current = createSuiMainnetWriteController({
    sui: () => {
      const c = live.current
      return c.wallet.isConnected && c.wallet.currentWallet && c.account ? { wallet: c.wallet.currentWallet, account: c.account } : null
    },
    evm: () => provider.current?.connector === live.current.evm.connector ? provider.current?.rpc ?? null : null,
    current: (i: SuiWriteIntent) => {
      const c = live.current, old = captured.current
      return Boolean(old && old.binding === c.binding && old.wallet === c.wallet.currentWallet && old.connector === c.evm.connector && c.evm.isConnected && c.evm.chainId === 5042 && c.wallet.isConnected && c.account?.chains.includes('sui:mainnet') && c.account.address.toLowerCase() === i.suiOwner.toLowerCase() && c.evm.address?.toLowerCase() === i.evmOwner.toLowerCase())
    },
  })
  const api = controller.current
  useEffect(() => { api.invalidate() }, [api, binding, account?.address, wallet.currentWallet, evm.address, evm.chainId, evm.connector])
  useEffect(() => () => api.invalidate(), [api])
  async function bind() {
    const before = live.current, connector = before.evm.connector
    if (!connector || before.evm.chainId !== 5042 || !before.account || !before.wallet.currentWallet) throw new Error('Connect the original Sui and Arc Mainnet wallets.')
    // No chainId argument: some connectors treat it as a network-switch request.
    const rpc = await connector.getProvider() as NonNullable<ReturnType<SuiWriteWallets['evm']>>
    const after = live.current
    if (!rpc || typeof rpc.request !== 'function' || before.binding !== after.binding || connector !== after.evm.connector || before.evm.address !== after.evm.address || before.account !== after.account || before.wallet.currentWallet !== after.wallet.currentWallet) throw new Error('Wallet connection changed while preparing the provider.')
    provider.current = { connector, rpc: { request: args => rpc.request(args) } }
    captured.current = { binding: after.binding, wallet: after.wallet.currentWallet, connector }
  }
  async function safe<T>(phase: 'prepare' | 'confirm' | 'recover', work: () => Promise<T>) {
    try { return await work() }
    catch (error) {
      if (error instanceof SuiWriteSignatureRejected) throw error
      // Our own fixed lock explanations carry no provider data; show them.
      if (error instanceof Error && /(stays locked|stays blocked)\.?$/.test(error.message)) throw new Error(error.message)
      // UI callers never receive provider error objects, payloads or URLs.
      throw new Error(phase === 'prepare' ? 'Transfer preparation could not be verified. No wallet request was made.' : phase === 'recover' ? 'Transaction status is not verified yet. Keep its ID and do not submit again.' : 'The wallet operation could not be verified. Check the saved transfer before requesting another transaction.')
    }
  }
  // Stable identity: consumers invalidate their Review when the writer changes.
  // Every method reads live refs, so memoizing on the controller is safe.
  return useMemo(() => ({
    writesEnabled: MAINNET_SUI_CCTP_WRITES_ENABLED,
    walletSendEnabled: MAINNET_ARC_WALLET_SEND_ENABLED,
    prepare: (i: SuiWriteIntent) => safe('prepare', async () => { await bind(); return api.prepare(i) }),
    confirm: (review: SuiWriteReview) => safe('confirm', async () => {
      if (!MAINNET_SUI_CCTP_WRITES_ENABLED) throw new Error('Sui writes disabled.')
      return api.confirm(review)
    }),
    recover: () => safe('recover', async () => { await bind(); return api.recover() }),
    saved: () => api.saved(),
    inspectMismatch: () => safe('recover', async () => { await bind(); return await api.reconcile() as SuiWriteReconciliation }),
    reconcile: key => safe('recover', async () => { await bind(); return await api.reconcile(key) as SuiWriteAttempt }),
    invalidate: () => api.invalidate(),
    feeBps: direction => fetchSuiCctpStandardFeeBps(direction),
  }), [api])
}
