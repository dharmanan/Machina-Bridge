import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount } from 'wagmi'
import type { AppNetwork } from '../config/runtime'

const short = (v?: string | null) => !v ? '' : v.length > 12 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v

type ChipProps = {
  family: string
  walletName: string | null
  address: string | null
  network: string
  warning?: string | null
  busy?: boolean
  disabled?: boolean
  connectLabel?: string
  onConnect(): void
  onDisconnect(): void
}
// One wallet: name, short address, network and status, with its own connect /
// disconnect that never touches the other wallets.
function WalletChip({ family, walletName, address, network, warning, busy, disabled, connectLabel = 'Connect', onConnect, onDisconnect }: ChipProps) {
  const connected = Boolean(address)
  return <div aria-label={`${family} wallet`} className="flex min-w-0 items-center gap-2 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 shadow-sm">
    <span aria-hidden className={`h-2 w-2 flex-shrink-0 rounded-full ${warning ? 'bg-amber-500' : connected ? 'bg-green-500' : 'bg-slate-300'}`} />
    <div className="min-w-0 leading-tight">
      <p className="truncate text-xs font-semibold text-slate-800">{connected ? `${walletName ?? family} · ${short(address)}` : family}</p>
      <p className={`truncate text-[11px] ${warning ? 'text-amber-700' : 'text-slate-500'}`}>{warning ?? (connected ? network : 'Not connected')}</p>
    </div>
    <button type="button" onClick={connected ? onDisconnect : onConnect} disabled={busy || (!connected && disabled)}
      className="ml-auto flex-shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
      {busy ? '…' : connected ? 'Disconnect' : connectLabel}
    </button>
  </div>
}

export type WalletBarProps = {
  appNetwork: AppNetwork
  evmNetworkName: string
  solana: { address: string | null; connecting: boolean; available: boolean; error: string | null; connect(): void; disconnect(): void }
  sui: { address: string | null; walletName: string | null; connecting: boolean; available: boolean; supported: boolean; error: string | null; connect(): void; disconnect(): void }
}
// EVM (RainbowKit/wagmi), Solana (Phantom) and Sui (Slush via Mysten dApp Kit)
// side by side on Mainnet and Testnet. No provider is created here.
export default function WalletBar({ appNetwork, evmNetworkName, solana, sui }: WalletBarProps) {
  const { connector } = useAccount()
  const errors = [solana.error, sui.error].filter(Boolean) as string[]
  return <div className="flex min-w-0 flex-col gap-1.5 lg:items-end">
    <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-3 lg:w-auto">
      <ConnectButton.Custom>{({ account, chain, mounted, openConnectModal, openAccountModal, openChainModal }) => {
        const ready = mounted && account && chain
        return <WalletChip family="EVM" walletName={connector?.name ?? null} address={ready ? account.address : null}
          network={evmNetworkName} warning={ready && chain.unsupported ? 'Wrong network · switch above' : null}
          onConnect={openConnectModal} onDisconnect={chain?.unsupported ? openChainModal : openAccountModal} />
      }}</ConnectButton.Custom>
      <WalletChip family="Solana" walletName="Phantom" address={solana.address} network={appNetwork === 'mainnet' ? 'Solana Mainnet' : 'Solana Devnet'}
        busy={solana.connecting} disabled={!solana.available} connectLabel={solana.available ? 'Connect' : 'Install'} onConnect={solana.connect} onDisconnect={solana.disconnect} />
      <WalletChip family="Sui" walletName={sui.walletName ?? 'Slush'} address={sui.address} network={appNetwork === 'mainnet' ? 'Sui Mainnet' : 'Sui Testnet'}
        warning={sui.address && !sui.supported ? `Switch Slush to Sui ${appNetwork === 'mainnet' ? 'Mainnet' : 'Testnet'}` : null}
        busy={sui.connecting} disabled={!sui.available} connectLabel={sui.available ? 'Connect' : 'Install'} onConnect={sui.connect} onDisconnect={sui.disconnect} />
    </div>
    {errors.length > 0 && <div className="text-[11px] text-red-500 lg:text-right">{errors.map(e => <p key={e}>{e}</p>)}</div>}
  </div>
}
