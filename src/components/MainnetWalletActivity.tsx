import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  ExternalLink,
  FileCode2,
  Landmark,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import { useAccount } from 'wagmi'
import { MAINNET_NETWORKS } from '../config/mainnetNetworks'
import {
  fetchMainnetWalletActivity,
  normalizeWalletActivity,
  shortWalletAddress,
  type WalletActivity,
} from '../lib/mainnetWalletActivity'
import { Card, Container } from './ui'

export default function MainnetWalletActivity() {
  const { address } = useAccount()
  const [walletActivity, setWalletActivity] = useState<WalletActivity[]>([])
  const [walletActivityLoading, setWalletActivityLoading] = useState(false)
  const [walletActivityError, setWalletActivityError] = useState<string | null>(null)
  const [walletActivityDataAddress, setWalletActivityDataAddress] = useState<string | null>(null)
  const walletActivityDataAddressRef = useRef<string | null>(null)
  const walletActivityRequestId = useRef(0)
  const walletActivityController = useRef<AbortController | null>(null)
  const walletActivityAddress = address?.toLowerCase() ?? null
  const walletActivityAddressRef = useRef(walletActivityAddress)
  walletActivityAddressRef.current = walletActivityAddress

  const loadWalletActivity = useCallback(async (walletAddress: string) => {
    const requestId = ++walletActivityRequestId.current
    const addressIdentity = walletAddress.toLowerCase()
    walletActivityController.current?.abort()
    const controller = new AbortController()
    walletActivityController.current = controller

    if (walletActivityDataAddressRef.current !== addressIdentity) {
      setWalletActivity([])
      walletActivityDataAddressRef.current = addressIdentity
    }
    setWalletActivityDataAddress(addressIdentity)
    setWalletActivityLoading(true)
    setWalletActivityError(null)

    const isCurrentRequest = () =>
      requestId === walletActivityRequestId.current
      && walletActivityAddressRef.current === addressIdentity
      && !controller.signal.aborted

    try {
      const response = await fetchMainnetWalletActivity(walletAddress, controller.signal)
      if (!isCurrentRequest()) return
      setWalletActivity(normalizeWalletActivity(walletAddress, response))
    } catch (error) {
      if (!isCurrentRequest()) return
      setWalletActivityError(error instanceof Error ? error.message : 'Wallet activity is unavailable')
    } finally {
      if (isCurrentRequest()) setWalletActivityLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!address) {
      walletActivityRequestId.current += 1
      walletActivityController.current?.abort()
      walletActivityController.current = null
      setWalletActivity([])
      setWalletActivityDataAddress(null)
      walletActivityDataAddressRef.current = null
      setWalletActivityLoading(false)
      setWalletActivityError(null)
      return
    }

    void loadWalletActivity(address)
    return () => {
      if (walletActivityAddressRef.current === address.toLowerCase()) {
        walletActivityRequestId.current += 1
        walletActivityController.current?.abort()
        walletActivityController.current = null
      }
    }
  }, [address, loadWalletActivity])

  const visibleWalletActivity = walletActivityDataAddress === walletActivityAddress
    ? walletActivity
    : []
  const visibleWalletActivityLoading = walletActivityAddress !== null
    && (walletActivityDataAddress !== walletActivityAddress || walletActivityLoading)
  const visibleWalletActivityError = walletActivityDataAddress === walletActivityAddress
    ? walletActivityError
    : null

  return (
    <Container className="py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Wallet Activity</h1>
          <p className="mt-1 text-sm text-slate-500">Recent activity from this Arc wallet.</p>
        </div>
        <button
          type="button"
          onClick={() => address && void loadWalletActivity(address)}
          disabled={!address || visibleWalletActivityLoading}
          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw size={13} className={visibleWalletActivityLoading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <Card>
        {visibleWalletActivityLoading && visibleWalletActivity.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">Loading wallet activity...</p>
        ) : (
          <>
            {visibleWalletActivityError && (
              <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                <div className="flex items-center gap-2">
                  <AlertCircle size={15} />
                  <span>{visibleWalletActivityError}</span>
                </div>
                {visibleWalletActivity.length > 0 && (
                  <p className="mt-2 text-xs">Showing the last activity that loaded successfully.</p>
                )}
              </div>
            )}

            {visibleWalletActivity.length === 0 && !visibleWalletActivityError ? (
              <p className="py-8 text-center text-sm text-slate-500">No Arc wallet activity found.</p>
            ) : visibleWalletActivity.length > 0 ? (
              <div className="divide-y divide-slate-100">
                {visibleWalletActivity.map((item) => {
                  const Icon = item.type === 'send'
                    ? ArrowUpRight
                    : item.type === 'receive'
                      ? ArrowDownLeft
                      : item.type === 'swap'
                        ? ArrowLeftRight
                        : item.type === 'bridge' || item.type === 'earn'
                          ? Landmark
                          : item.type === 'approve'
                            ? ShieldCheck
                            : FileCode2
                  const explorerUrl = `${MAINNET_NETWORKS.arc.explorerUrl}/tx/${item.txHash}`

                  return (
                    <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                      <div className="flex min-w-0 items-start gap-3">
                        <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#eef7e8] text-[#2F6E0C]">
                          <Icon size={17} />
                        </span>
                        <div className="min-w-0">
                          <p className="font-semibold text-sm text-slate-900">{item.title}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                            {item.amount && <span className="font-medium text-slate-700">{item.amount}</span>}
                            {item.protocol && <span>{item.protocol}</span>}
                            <span>{item.timestamp ? new Date(item.timestamp).toLocaleString() : 'Time unavailable'}</span>
                          </div>
                          <a
                            href={explorerUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1 inline-flex items-center gap-1 font-mono text-[11px] text-slate-400 hover:text-emerald-800"
                          >
                            {shortWalletAddress(item.txHash)} <ExternalLink size={10} />
                          </a>
                        </div>
                      </div>
                      {item.status !== 'Unknown' && (
                        <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                          item.status === 'Failed'
                            ? 'bg-red-50 text-red-700'
                            : 'bg-[#eef7e8] text-[#2F6E0C]'
                        }`}>
                          {item.status}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : null}
          </>
        )}

        <p className="mt-4 border-t border-slate-100 pt-3 text-[10px] text-slate-400">
          Activity data provided by Etherscan.
        </p>
      </Card>
    </Container>
  )
}
