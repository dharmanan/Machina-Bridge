import { useEffect, useState } from 'react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount, useDeployContract, useSwitchChain, useWaitForTransactionReceipt } from 'wagmi'
import { ArrowLeft, CheckCircle2, ExternalLink, Loader2 } from 'lucide-react'
import { ARC_EVM_CHAIN_ID } from '../lib/chains'
import { COUNTDOWN_DEPLOY_ABI, COUNTDOWN_DEPLOY_BYTECODE } from './contractArtifact.generated'

const CAMPAIGN_START_SECONDS = BigInt(Math.floor(Date.UTC(2026, 7, 7, 0, 0, 0) / 1000))
const STORAGE_KEY = 'machina-countdown-contract-address'

export default function DeployCountdownContractPage() {
  const { address, chainId, isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { deployContractAsync, data: deployHash, isPending, error } = useDeployContract()
  const receipt = useWaitForTransactionReceipt({ hash: deployHash, chainId: ARC_EVM_CHAIN_ID })
  const [previousAddress] = useState<string | null>(() => window.localStorage.getItem(STORAGE_KEY))
  const [newAddress, setNewAddress] = useState<string | null>(null)

  useEffect(() => {
    const contractAddress = receipt.data?.contractAddress
    if (!contractAddress) return
    window.localStorage.setItem(STORAGE_KEY, contractAddress)
    setNewAddress(contractAddress)
  }, [receipt.data?.contractAddress])

  const deploy = async () => {
    if (!isConnected) return
    if (chainId !== ARC_EVM_CHAIN_ID) {
      await switchChainAsync({ chainId: ARC_EVM_CHAIN_ID })
      return
    }

    await deployContractAsync({
      abi: COUNTDOWN_DEPLOY_ABI,
      bytecode: COUNTDOWN_DEPLOY_BYTECODE,
      args: [CAMPAIGN_START_SECONDS, true],
      chainId: ARC_EVM_CHAIN_ID,
    })
  }

  return (
    <div className="min-h-screen bg-[#f3f7f2] text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <a href="/countdown?smoke=1" className="inline-flex items-center gap-2 text-sm font-semibold text-slate-700">
            <ArrowLeft size={16} /> Countdown
          </a>
          <ConnectButton chainStatus="none" accountStatus="address" showBalance={false} />
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">Arc Testnet setup</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Deploy Stable V3 Test Contract</h1>
          <p className="mt-4 text-sm leading-6 text-slate-600">
            This restores the metadata V3 contract that already rendered correctly in ArcScan. No V4, V5 or V6 artwork experiment is used.
          </p>

          <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            <p><strong>Wallet:</strong> {address ?? 'Not connected'}</p>
            <p className="mt-1"><strong>Network:</strong> {chainId === ARC_EVM_CHAIN_ID ? 'Arc Testnet' : 'Switch to Arc Testnet'}</p>
            <p className="mt-1"><strong>Collection:</strong> Arc Mainnet Countdown</p>
            <p className="mt-1"><strong>Symbol:</strong> ARC40</p>
            <p className="mt-1"><strong>Metadata:</strong> Stable V3 onchain SVG</p>
            <p className="mt-1"><strong>Token IDs:</strong> Day 1 = #1 through Day 40 = #40</p>
            {previousAddress && !newAddress && (
              <p className="mt-3 break-all text-amber-700"><strong>Current preview contract:</strong> {previousAddress}</p>
            )}
          </div>

          {newAddress ? (
            <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
              <p className="flex items-center gap-2 font-semibold text-emerald-900"><CheckCircle2 size={18} /> V3 contract deployed</p>
              <p className="mt-2 break-all text-sm text-emerald-800">{newAddress}</p>
              <a href="/countdown?smoke=1" className="mt-4 inline-flex items-center gap-2 rounded-xl bg-emerald-800 px-4 py-2.5 text-sm font-semibold text-white">
                Open Countdown <ExternalLink size={15} />
              </a>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void deploy()}
              disabled={!isConnected || isPending || receipt.isLoading}
              className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#2f6e0c] px-5 py-3.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
            >
              {(isPending || receipt.isLoading) && <Loader2 size={17} className="animate-spin" />}
              {!isConnected
                ? 'Connect wallet first'
                : chainId !== ARC_EVM_CHAIN_ID
                  ? 'Switch to Arc Testnet'
                  : isPending
                    ? 'Confirm V3 deployment in wallet'
                    : receipt.isLoading
                      ? 'Waiting for Arc Testnet confirmation'
                      : 'Deploy Stable V3 Contract'}
            </button>
          )}

          {error && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error.message}</p>}
          {receipt.error && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{receipt.error.message}</p>}
        </section>
      </main>
    </div>
  )
}
