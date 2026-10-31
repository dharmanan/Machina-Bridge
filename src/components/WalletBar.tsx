import { useState } from 'react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount } from 'wagmi'
import { X } from 'lucide-react'
import type { AppNetwork } from '../config/runtime'
import { useWalletConnectError } from '../lib/walletConnectStatus'

export const shortAddress = (v?: string | null) => !v ? '' : v.length > 12 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v

// Phantom injects its provider only inside its own in-app browser on phones; Safari or
// Chrome on iOS/Android never see it, even with the app installed. This official universal
// link opens the current page in Phantom's browser (docs.phantom.com: Deeplinks > Browse).
export function phantomBrowseUrl(href: string, origin: string) {
  return `https://phantom.app/ul/browse/${encodeURIComponent(href)}?ref=${encodeURIComponent(origin)}`
}
// Slush universal link for its in-app dApp browser (@mysten/slush-wallet docs: Deep Linking,
// route browse/:url). In other browsers the Slush web wallet connects through a popup.
export function slushBrowseUrl(href: string) {
  return `https://my.slush.app/browse/${href}`
}

// A wallet error stays visible until the user closes it; a different, newer error shows again,
// and so does the same error from a new attempt (errorKey).
// Dismissals are kept per wallet for the page session, so reopening the mobile menu or
// switching between the mobile and desktop bars does not bring a closed error back.
const dismissedErrors = new Map<string, string>()
export function useDismissibleError(family: string, error: string | null, errorKey: string | number = '') {
  const [, rerender] = useState(0)
  const key = `${errorKey}|${error}`
  return {
    visible: error && dismissedErrors.get(family) !== key ? error : null,
    dismiss: () => { if (error) dismissedErrors.set(family, key); rerender(n => n + 1) },
  }
}

export function WalletError({ family, message, onDismiss }: { family: string; message: string; onDismiss(): void }) {
  return <div role="alert" className="mt-1 flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[11px] leading-4 text-red-700">
    <span className="min-w-0 flex-1 break-words">{message}</span>
    <button type="button" aria-label={`Dismiss ${family} wallet error`} onClick={onDismiss} className="flex-shrink-0 rounded p-0.5 text-red-500 hover:bg-red-100 hover:text-red-800"><X size={12} aria-hidden /></button>
  </div>
}

type ChipProps = {
  family: string
  walletName: string | null
  address: string | null
  network: string
  warning?: string | null
  error?: string | null
  errorKey?: number
  busy?: boolean
  disabled?: boolean
  connectLabel?: string
  openUrl?: string | null
  onConnect(): void
  onDisconnect(): void
}
// One wallet: name, short address, network and status, with its own connect /
// disconnect that never touches the other wallets. Its error shows under it.
function WalletChip({ family, walletName, address, network, warning, error, errorKey, busy, disabled, connectLabel = 'Connect', openUrl, onConnect, onDisconnect }: ChipProps) {
  const connected = Boolean(address)
  const shownError = useDismissibleError(family, error ?? null, errorKey)
  return <div className="min-w-0">
    <div aria-label={`${family} wallet`} className="flex min-w-0 items-center gap-2 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 shadow-sm">
      <span aria-hidden className={`h-2 w-2 flex-shrink-0 rounded-full ${warning ? 'bg-amber-500' : connected ? 'bg-green-500' : 'bg-slate-300'}`} />
      <div className="min-w-0 leading-tight">
        <p className="truncate text-xs font-semibold text-slate-800">{connected ? `${walletName ?? family} · ${shortAddress(address)}` : family}</p>
        <p className={`truncate text-[11px] ${warning ? 'text-amber-700' : 'text-slate-500'}`}>{warning ?? (connected ? network : 'Not connected')}</p>
      </div>
      {!connected && openUrl
        ? <a href={openUrl} className="ml-auto flex-shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 transition-colors hover:bg-slate-50">Open in {walletName}</a>
        : <button type="button" onClick={connected ? onDisconnect : onConnect} disabled={busy || (!connected && disabled)}
          className="ml-auto flex-shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
          {busy ? '…' : connected ? 'Disconnect' : connectLabel}
        </button>}
    </div>
    {shownError.visible && <WalletError family={family} message={shownError.visible} onDismiss={shownError.dismiss} />}
  </div>
}

export type WalletBarProps = {
  appNetwork: AppNetwork
  evmNetworkName: string
  // Set on phones/tablets when Phantom is not injected: opens this page in Phantom's browser.
  phantomOpenUrl?: string | null
  solana: { address: string | null; connecting: boolean; available: boolean; error: string | null; connect(): void; disconnect(): void }
  sui: { address: string | null; walletName: string | null; connecting: boolean; available: boolean; supported: boolean; error: string | null; connect(): void; disconnect(): void }
}
// EVM (RainbowKit/wagmi), Solana (Phantom) and Sui (Slush via Mysten dApp Kit)
// side by side on Mainnet and Testnet. No provider is created here.
export default function WalletBar({ appNetwork, evmNetworkName, phantomOpenUrl, solana, sui }: WalletBarProps) {
  const { connector } = useAccount()
  const walletConnectError = useWalletConnectError()
  return <div className="flex min-w-0 flex-col gap-1.5 lg:items-end">
    <div className="grid w-full grid-cols-1 items-start gap-2 sm:grid-cols-3 lg:w-auto">
      <ConnectButton.Custom>{({ account, chain, mounted, openConnectModal, openAccountModal, openChainModal }) => {
        const ready = mounted && account && chain
        return <WalletChip family="EVM" walletName={connector?.name ?? null} address={ready ? account.address : null}
          network={evmNetworkName} warning={ready && chain.unsupported ? 'Wrong network · switch above' : null} error={ready ? null : walletConnectError?.message} errorKey={walletConnectError?.attempt}
          onConnect={openConnectModal} onDisconnect={chain?.unsupported ? openChainModal : openAccountModal} />
      }}</ConnectButton.Custom>
      <WalletChip family="Solana" walletName="Phantom" address={solana.address} network={appNetwork === 'mainnet' ? 'Solana Mainnet' : 'Solana Devnet'} error={solana.error}
        busy={solana.connecting} disabled={!solana.available} connectLabel={solana.available ? 'Connect' : 'Install'} openUrl={solana.available ? null : phantomOpenUrl} onConnect={solana.connect} onDisconnect={solana.disconnect} />
      <WalletChip family="Sui" walletName={sui.walletName ?? 'Slush'} address={sui.address} network={appNetwork === 'mainnet' ? 'Sui Mainnet' : 'Sui Testnet'} error={sui.error}
        warning={sui.address && !sui.supported ? `Switch Slush to Sui ${appNetwork === 'mainnet' ? 'Mainnet' : 'Testnet'}` : null}
        busy={sui.connecting} disabled={!sui.available} connectLabel={sui.available ? 'Connect' : 'Install'} onConnect={sui.connect} onDisconnect={sui.disconnect} />
    </div>
  </div>
}
