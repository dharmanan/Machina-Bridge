import { useAccount, useDeployContract, useSwitchChain, useWaitForTransactionReceipt } from 'wagmi'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { ARC_EVM_CHAIN_ID } from '../lib/chains'
import { COUNTDOWN_DEPLOY_ABI, COUNTDOWN_DEPLOY_BYTECODE } from './contractArtifact.generated'

const OWNER = '0xafbB6Cc5C0a9C0eB1BfF8dB2eD807e83aAB8e321'.toLowerCase()
const CAMPAIGN_START_SECONDS = BigInt(Math.floor(Date.UTC(2026, 7, 7, 0, 0, 0) / 1000))

export default function FinalizeProductionCountdownPage() {
  const { address, chainId, isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { deployContractAsync, data: deployHash, isPending, error } = useDeployContract()
  const receipt = useWaitForTransactionReceipt({ hash: deployHash, chainId: ARC_EVM_CHAIN_ID })

  const isPreviewHost = typeof window !== 'undefined' && window.location.hostname.includes('-git-feature-')
  const isOwner = Boolean(address && address.toLowerCase() === OWNER)

  if (!isPreviewHost) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Not found.</div>
  }

  const deploy = async () => {
    if (!isConnected || !isOwner) return
    if (chainId !== ARC_EVM_CHAIN_ID) {
      await switchChainAsync({ chainId: ARC_EVM_CHAIN_ID })
      return
    }

    await deployContractAsync({
      abi: COUNTDOWN_DEPLOY_ABI,
      bytecode: COUNTDOWN_DEPLOY_BYTECODE,
      args: [CAMPAIGN_START_SECONDS, false],
      chainId: ARC_EVM_CHAIN_ID,
    })
  }

  const contractAddress = receipt.data?.contractAddress

  return (
    <div className="min-h-screen bg-[#f3f7f2] px-4 py-10 text-slate-950">
      <main className="mx-auto max-w-2xl rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">One-time preview finalization</p>
            <h1 className="mt-2 text-3xl font-semibold">Deploy final countdown contract</h1>
          </div>
          <ConnectButton chainStatus="none" accountStatus="address" showBalance={false} />
        </div>

        <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
          <p><strong>Contract:</strong> working Metadata V3</p>
          <p><strong>Campaign start:</strong> 7 Aug 2026, 00:00 UTC</p>
          <p><strong>Total days:</strong> 40</p>
          <p><strong>Test mode:</strong> OFF</p>
          <p><strong>Owner:</strong> deploying wallet</p>
          <p className="mt-2 text-amber-700">This page is temporary and will be removed before production merge.</p>
        </div>

        {!isConnected ? (
          <p className="mt-6 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800">Connect the owner wallet to continue.</p>
        ) : !isOwner ? (
          <p className="mt-6 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">This wallet is not authorized to finalize the countdown contract.</p>
        ) : contractAddress ? (
          <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
            <p className="flex items-center gap-2 font-semibold text-emerald-900"><CheckCircle2 size={18} /> Final contract deployed</p>
            <p className="mt-2 break-all font-mono text-sm text-emerald-800">{contractAddress}</p>
            <p className="mt-3 text-sm text-emerald-800">Copy this address. The app must be pinned to it before production merge.</p>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void deploy()}
            disabled={isPending || receipt.isLoading}
            className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#2f6e0c] px-5 py-3.5 text-sm font-semibold text-white disabled:bg-slate-200 disabled:text-slate-500"
          >
            {(isPending || receipt.isLoading) && <Loader2 size={17} className="animate-spin" />}
            {chainId !== ARC_EVM_CHAIN_ID
              ? 'Switch to Arc Testnet'
              : isPending
                ? 'Confirm final deployment in wallet'
                : receipt.isLoading
                  ? 'Waiting for Arc Testnet confirmation'
                  : 'Deploy final V3 contract'}
          </button>
        )}

        {error && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error.message}</p>}
        {receipt.error && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{receipt.error.message}</p>}
      </main>
    </div>
  )
}
