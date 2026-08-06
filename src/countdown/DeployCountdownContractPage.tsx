import { useEffect, useState } from 'react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount, useDeployContract, usePublicClient, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { ArrowLeft, CheckCircle2, ExternalLink, Loader2 } from 'lucide-react'
import { ARC_EVM_CHAIN_ID } from '../lib/chains'
import { COUNTDOWN_ABI } from './contract'
import { COUNTDOWN_DEPLOY_ABI, COUNTDOWN_DEPLOY_BYTECODE } from './contractArtifact.generated'

const CAMPAIGN_START_SECONDS = BigInt(Math.floor(Date.UTC(2026, 7, 7, 0, 0, 0) / 1000))
const STORAGE_KEY = 'machina-countdown-contract-address'

export default function DeployCountdownContractPage() {
  const { address, chainId, isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const publicClient = usePublicClient({ chainId: ARC_EVM_CHAIN_ID })
  const { deployContractAsync, data: deployHash, isPending, error } = useDeployContract()
  const { writeContractAsync, isPending: isMetadataWalletPending } = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash: deployHash, chainId: ARC_EVM_CHAIN_ID })
  const [savedAddress, setSavedAddress] = useState<string | null>(() => window.localStorage.getItem(STORAGE_KEY))
  const [metadataMessage, setMetadataMessage] = useState<string | null>(null)
  const [metadataBusy, setMetadataBusy] = useState(false)

  const metadataUri = `${window.location.origin}/api/countdown-metadata?id={id}&v=2`

  useEffect(() => {
    const contractAddress = receipt.data?.contractAddress
    if (!contractAddress) return
    window.localStorage.setItem(STORAGE_KEY, contractAddress)
    setSavedAddress(contractAddress)
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
      args: [metadataUri, CAMPAIGN_START_SECONDS, true],
      chainId: ARC_EVM_CHAIN_ID,
    })
  }

  const updateMetadata = async () => {
    if (!savedAddress || !publicClient) return
    if (chainId !== ARC_EVM_CHAIN_ID) {
      await switchChainAsync({ chainId: ARC_EVM_CHAIN_ID })
      return
    }

    setMetadataBusy(true)
    setMetadataMessage(null)
    try {
      const hash = await writeContractAsync({
        abi: COUNTDOWN_ABI,
        address: savedAddress as `0x${string}`,
        functionName: 'setMetadataUri',
        args: [metadataUri],
        chainId: ARC_EVM_CHAIN_ID,
      })
      const metadataReceipt = await publicClient.waitForTransactionReceipt({ hash })
      if (metadataReceipt.status !== 'success') throw new Error('Metadata transaction reverted.')
      setMetadataMessage('NFT metadata URI updated. The explorer will now fetch the new v2 metadata endpoint for existing and future token IDs.')
    } catch (metadataError) {
      setMetadataMessage(metadataError instanceof Error ? metadataError.message : 'Metadata update failed.')
    } finally {
      setMetadataBusy(false)
    }
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
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Countdown Test Contract</h1>
          <p className="mt-4 text-sm leading-6 text-slate-600">
            Deploy a new test contract or connect metadata to the contract you already deployed. Metadata gives each token its Day number, name, traits and NFT artwork in explorers and wallets.
          </p>

          <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
            <p><strong>Wallet:</strong> {address ?? 'Not connected'}</p>
            <p className="mt-1"><strong>Network:</strong> {chainId === ARC_EVM_CHAIN_ID ? 'Arc Testnet' : 'Switch to Arc Testnet'}</p>
            <p className="mt-1"><strong>Token IDs:</strong> Day 1 = #1 through Day 40 = #40</p>
            {savedAddress && <p className="mt-1 break-all"><strong>Current test contract:</strong> {savedAddress}</p>}
          </div>

          {savedAddress ? (
            <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
              <p className="flex items-center gap-2 font-semibold text-emerald-900"><CheckCircle2 size={18} /> Test contract available</p>
              <p className="mt-2 break-all text-sm text-emerald-800">{savedAddress}</p>
              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void updateMetadata()}
                  disabled={!isConnected || metadataBusy || isMetadataWalletPending}
                  className="inline-flex items-center gap-2 rounded-xl bg-[#2f6e0c] px-4 py-2.5 text-sm font-semibold text-white disabled:bg-slate-300"
                >
                  {(metadataBusy || isMetadataWalletPending) && <Loader2 size={16} className="animate-spin" />}
                  {metadataBusy ? 'Waiting for Arc confirmation' : 'Set NFT metadata v2'}
                </button>
                <a href="/countdown?smoke=1" className="inline-flex items-center gap-2 rounded-xl bg-emerald-800 px-4 py-2.5 text-sm font-semibold text-white">
                  Open Countdown <ExternalLink size={15} />
                </a>
              </div>
              {metadataMessage && <p className="mt-4 rounded-xl bg-white/70 px-4 py-3 text-sm text-emerald-900">{metadataMessage}</p>}
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
                    ? 'Confirm deployment in wallet'
                    : receipt.isLoading
                      ? 'Waiting for Arc Testnet confirmation'
                      : 'Deploy Test Contract'}
            </button>
          )}

          {error && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error.message}</p>}
          {receipt.error && <p className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{receipt.error.message}</p>}
        </section>
      </main>
    </div>
  )
}
