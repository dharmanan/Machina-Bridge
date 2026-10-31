import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount } from 'wagmi'
import { Check, ExternalLink, Github, Menu, Twitter, Wallet, X } from 'lucide-react'
import type { AppNetwork } from '../config/runtime'
import { shortAddress, useDismissibleError, WalletError, type WalletBarProps } from './WalletBar'

export type MobileNavItem = { id: string; label: string; icon: ReactNode }
export type MobileNavLink = { label: string; href: string; icon?: ReactNode }

type MobileAppBarProps = WalletBarProps & {
  logoSrc: string
  activeTab: string
  navItems: MobileNavItem[]
  navLinks: MobileNavLink[]
  onSelectTab(id: string): void
  onNetworkChange(network: AppNetwork): void
  evmNetworks: { id: number; name: string }[]
  evmChainId?: number
  onEvmNetworkSwitch(id: number): void
  slushOpenUrl?: string | null
  metaMaskOpenUrl?: string | null
}

// Phones only (below md): one compact bar and one right-side menu with navigation,
// wallets, network and links. Desktop keeps its own header. The menu is not rendered
// while closed, so it never covers the page.
export default function MobileAppBar(props: MobileAppBarProps) {
  const { appNetwork, logoSrc } = props
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const close = useCallback((restoreFocus = true) => {
    setOpen(false)
    // The menu button stays mounted, so focus can return to it at once.
    if (restoreFocus) trigger.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panel.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (event.key !== 'Tab' || !panel.current) return
      // Keep keyboard focus inside the open menu.
      const focusable = [...panel.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      if (!focusable.length) return
      const first = focusable[0], last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = previousOverflow }
  }, [open, close])

  return <div className="md:hidden">
    <header aria-label="Machina Bridge" className="sticky top-0 z-50 border-b border-slate-200 bg-white/90 backdrop-blur-lg">
      <div className="flex h-14 items-center justify-between gap-2 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <img src={logoSrc} alt="" className="h-8 w-8 flex-shrink-0 rounded-xl border border-slate-200 bg-white p-0.5" />
          <h1 className="truncate text-base font-semibold tracking-tight text-slate-900">Machina Bridge</h1>
          <span className="hidden flex-shrink-0 items-center rounded-full border border-[#66D121]/30 bg-[#eef7e8] px-1.5 py-0.5 text-[10px] font-medium text-[#2F6E0C] min-[375px]:inline-flex">Public Beta</span>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <span aria-label={`Network: ${appNetwork === 'mainnet' ? 'Mainnet' : 'Testnet'}`} className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${appNetwork === 'mainnet' ? 'border-[#66D121]/40 bg-[#eef7e8] text-[#2F6E0C]' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
            {appNetwork === 'mainnet' ? 'Mainnet' : 'Testnet'}
          </span>
          <button ref={trigger} type="button" aria-label="Open menu" aria-haspopup="dialog" aria-expanded={open} aria-controls="mobile-menu" onClick={() => setOpen(true)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 shadow-sm">
            <Menu size={18} aria-hidden />
          </button>
        </div>
      </div>
    </header>

    {open && <div className="fixed inset-0 z-[70]">
      <div aria-hidden data-menu-backdrop onClick={() => close()} className="absolute inset-0 bg-slate-950/40" />
      <div ref={panel} id="mobile-menu" role="dialog" aria-modal="true" aria-label="Menu"
        className="absolute inset-y-0 right-0 flex w-[min(22rem,88vw)] flex-col overflow-y-auto overscroll-contain bg-white shadow-2xl">
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate font-semibold">Machina Bridge</p>
            <span className="flex-shrink-0 rounded-full border border-[#66D121]/30 bg-[#eef7e8] px-1.5 py-0.5 text-[10px] font-medium text-[#2F6E0C]">Public Beta</span>
          </div>
          <button type="button" data-autofocus aria-label="Close menu" onClick={() => close()} className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-600"><X size={16} aria-hidden /></button>
        </div>
        <MenuBody {...props} close={close} />
      </div>
    </div>}
  </div>
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section aria-label={title} className="border-b border-slate-100 px-4 py-3 last:border-b-0">
    <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
    {children}
  </section>
}

function MenuBody({ appNetwork, activeTab, navItems, navLinks, onSelectTab, onNetworkChange, evmNetworks, evmChainId, onEvmNetworkSwitch, evmNetworkName, phantomOpenUrl, slushOpenUrl, metaMaskOpenUrl, solana, sui, close }: MobileAppBarProps & { close(restoreFocus?: boolean): void }) {
  const { connector, isConnected: evmConnected } = useAccount()
  return <>
    <Section title="Navigation">
      <ul>
        {navItems.map(item => <li key={item.id}>
          <button type="button" aria-current={activeTab === item.id ? 'page' : undefined} onClick={() => { onSelectTab(item.id); close() }}
            className={`flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left text-sm ${activeTab === item.id ? 'bg-[#eef7e8] font-semibold text-[#2F6E0C]' : 'text-slate-700 hover:bg-slate-50'}`}>
            <span aria-hidden className="flex-shrink-0">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            {activeTab === item.id && <Check size={16} aria-hidden />}
          </button>
        </li>)}
        {navLinks.map(link => <li key={link.href}>
          <a href={link.href} target="_blank" rel="noopener noreferrer" onClick={() => close(false)} className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-sm text-slate-700 hover:bg-slate-50">
            <span aria-hidden className="flex-shrink-0">{link.icon ?? <ExternalLink size={18} />}</span>
            <span className="flex-1">{link.label}</span>
            <ExternalLink size={13} aria-hidden className="text-slate-400" />
          </a>
        </li>)}
      </ul>
    </Section>

    <Section title="Wallets">
      {(metaMaskOpenUrl || phantomOpenUrl || slushOpenUrl) && <p className="mb-1 text-[11px] leading-4 text-slate-500">
        On phones, a wallet connects most reliably inside its own app’s browser; Safari does not always switch back from wallet apps. Routes that need two wallets at once (Arc ↔ Solana, Arc ↔ Sui) can be easier in a desktop browser.
      </p>}
      <ConnectButton.Custom>{({ account, chain, mounted, openConnectModal, openAccountModal, openChainModal }) => {
        const ready = mounted && account && chain
        // RainbowKit opens its own dialog: close the menu first so nothing sits above it or holds focus.
        const open = (fn?: () => void) => { close(false); fn?.() }
        return <WalletRow family="EVM" walletName={ready ? connector?.name ?? 'EVM wallet' : 'MetaMask or another EVM wallet'} address={ready ? account.address : null}
          detail={ready ? (chain.unsupported ? 'Wrong network · choose one below' : evmNetworkName) : 'Not connected'} warning={Boolean(ready && chain.unsupported)}
          action={ready ? { label: 'Disconnect', onClick: () => open(chain.unsupported ? openChainModal : openAccountModal) } : { label: 'Connect', onClick: () => open(openConnectModal) }}
          note={!ready && metaMaskOpenUrl ? <>MetaMask works most reliably in its own browser. <a className="underline" href={metaMaskOpenUrl}>Open in MetaMask</a>.</> : null} />
      }}</ConnectButton.Custom>
      <WalletRow family="Solana" walletName="Phantom" address={solana.address} error={solana.error}
        detail={solana.address ? (appNetwork === 'mainnet' ? 'Solana Mainnet' : 'Solana Devnet') : solana.available || phantomOpenUrl ? 'Not connected' : 'Phantom not detected'}
        action={solana.address ? { label: 'Disconnect', onClick: solana.disconnect, busy: solana.connecting }
          : solana.available ? { label: 'Connect', onClick: solana.connect, busy: solana.connecting }
            : phantomOpenUrl ? { label: 'Open in Phantom', href: phantomOpenUrl } : { label: 'Install', disabled: true }}
        note={!solana.address && !solana.available && phantomOpenUrl ? 'On phones Phantom connects only inside the Phantom app’s browser. This opens Machina there; it requires the Phantom app.' : null} />
      <WalletRow family="Sui" walletName={sui.walletName ?? 'Slush'} address={sui.address} error={sui.error}
        detail={sui.address ? (sui.supported ? (appNetwork === 'mainnet' ? 'Sui Mainnet' : 'Sui Testnet') : `Switch Slush to Sui ${appNetwork === 'mainnet' ? 'Mainnet' : 'Testnet'}`) : 'Not connected'}
        warning={Boolean(sui.address && !sui.supported)}
        action={sui.address ? { label: 'Disconnect', onClick: sui.disconnect, busy: sui.connecting }
          : slushOpenUrl ? { label: 'Open in Slush', href: slushOpenUrl }
            : { label: sui.available ? 'Connect' : 'Install', onClick: sui.connect, busy: sui.connecting, disabled: !sui.available }}
        note={!sui.address && slushOpenUrl ? <>
          Open in Slush loads Machina inside the Slush app, where your app wallet connects. Your EVM wallet is not connected there automatically.
          <span className="mt-1.5 block">Or use the Slush web wallet: a separate web session in a new window, signed in with Google, Apple, Facebook or Twitch. It cannot hand over to the Slush app.</span>
          {sui.available && <button type="button" onClick={sui.connect} disabled={sui.connecting} className="mt-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 disabled:opacity-50">{sui.connecting ? 'Waiting for the web wallet…' : 'Use the Slush web wallet'}</button>}
        </> : null} />
    </Section>

    <Section title="Network">
      <div aria-label="Network environment" className="grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
        {(['mainnet', 'testnet'] as const).map(network => <button key={network} type="button" aria-pressed={appNetwork === network} onClick={() => onNetworkChange(network)}
          className={`rounded-lg py-2 text-sm font-semibold ${appNetwork === network ? 'bg-white text-slate-900 shadow-sm ring-1 ring-[#66D121]/30' : 'text-slate-500'}`}>
          {network === 'mainnet' ? 'Mainnet' : 'Testnet'}
        </button>)}
      </div>
      {evmConnected && <div className="mt-2">
        <p className="px-1 text-xs text-slate-500">EVM network</p>
        <ul aria-label="EVM network" className="mt-1">
          {evmNetworks.map(network => <li key={network.id}>
            <button type="button" aria-pressed={evmChainId === network.id} onClick={() => onEvmNetworkSwitch(network.id)}
              className={`flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-sm ${evmChainId === network.id ? 'font-semibold text-[#2F6E0C]' : 'text-slate-700 hover:bg-slate-50'}`}>
              {network.name}{evmChainId === network.id && <Check size={14} aria-hidden />}
            </button>
          </li>)}
        </ul>
      </div>}
    </Section>

    <Section title="Links">
      <div className="flex gap-2">
        <a href="https://github.com/dharmanan/Machina-Bridge" target="_blank" rel="noopener noreferrer" className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-slate-200 py-2 text-sm text-slate-700"><Github size={16} aria-hidden />GitHub</a>
        <a href="https://x.com/KohenEric" target="_blank" rel="noopener noreferrer" className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-slate-200 py-2 text-sm text-slate-700"><Twitter size={16} aria-hidden />X</a>
      </div>
    </Section>
  </>
}

type RowAction = { label: string; onClick?: () => void; href?: string; busy?: boolean; disabled?: boolean }
function WalletRow({ family, walletName, address, detail, warning, error, action, note }: { family: string; walletName: string; address: string | null; detail: string; warning?: boolean; error?: string | null; action: RowAction; note?: ReactNode }) {
  const shownError = useDismissibleError(family, error ?? null)
  const connected = Boolean(address)
  const button = 'flex-shrink-0 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-50'
  return <div aria-label={`${family} wallet`} className="py-2">
    <div className="flex items-center gap-3">
      <Wallet size={18} aria-hidden className="flex-shrink-0 text-slate-500" />
      <div className="min-w-0 flex-1 leading-tight">
        <p className="text-sm font-semibold text-slate-900">{family}</p>
        <p className="truncate text-xs text-slate-600">{walletName}{connected ? ` · ${shortAddress(address)}` : ''}</p>
        <p className={`truncate text-[11px] ${warning ? 'text-amber-700' : 'text-slate-500'}`}>{detail}</p>
      </div>
      <span aria-hidden className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${warning ? 'bg-amber-500' : connected ? 'bg-green-500' : 'bg-slate-300'}`} />
      {action.href
        ? <a href={action.href} className={button}>{action.label}</a>
        : <button type="button" onClick={action.onClick} disabled={action.busy || action.disabled} className={button}>{action.busy ? '…' : action.label}</button>}
    </div>
    {note && <p className="mt-1 pl-[30px] text-[11px] leading-4 text-slate-500">{note}</p>}
    {shownError.visible && <div className="pl-[30px]"><WalletError family={family} message={shownError.visible} onDismiss={shownError.dismiss} /></div>}
  </div>
}
