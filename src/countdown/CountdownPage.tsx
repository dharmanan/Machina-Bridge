import { useEffect, useMemo, useState } from 'react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount, useSwitchChain } from 'wagmi'
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FlaskConical,
  Lock,
  RotateCcw,
  Wallet,
} from 'lucide-react'
import arcLogo from '../assets/arc.png'
import { ARC_EVM_CHAIN_ID } from '../lib/chains'

const TOTAL_DAYS = 40
const DAY_MS = 24 * 60 * 60 * 1000
const CAMPAIGN_START_UTC = Date.UTC(2026, 7, 7, 0, 0, 0)
const MAINNET_TARGET_UTC = Date.UTC(2026, 8, 16, 0, 0, 0)
const OWNER_TEST_WALLET = '0xafbb6cc5c0a9c0eb1bff8db2ed807e83aab8e321'

const DAY_TITLES = [
  'First Signal',
  'Boot Sequence',
  'Green Pulse',
  'Relay Online',
  'Vector Lock',
  'Machine Heart',
  'Proof of Motion',
  'Route Found',
  'Channel Open',
  'Network Pulse',
  'Flow State',
  'Stable Current',
  'Liquidity Thread',
  'Crosschain Echo',
  'Packet Forward',
  'Deterministic',
  'Settlement Beam',
  'Finality Mark',
  'Threshold Near',
  'Threshold',
  'Engine Sync',
  'Route Matrix',
  'Signal Mesh',
  'Chain Link',
  'Liquidity Route',
  'Proof Layer',
  'Relay Core',
  'State Verified',
  'Forward Motion',
  'Final Approach',
  'Ignition Key',
  'Mainnet Vector',
  'Launch Window',
  'Orbit Locked',
  'Systems Ready',
  'Signal Six',
  'Signal Five',
  'Signal Four',
  'Last Orbit',
  'Mainnet Ignition',
] as const

const DAY_SUBTITLES = [
  'The journey begins.',
  'Systems come online.',
  'The network wakes.',
  'The first route opens.',
  'Direction confirmed.',
  'Core systems active.',
  'Momentum is visible.',
  'A path is established.',
  'Value can now move.',
  'The network responds.',
  'The current stabilizes.',
  'Stable value in motion.',
  'Liquidity begins to connect.',
  'A signal crosses chains.',
  'The message moves forward.',
  'Settlement becomes predictable.',
  'The path to settlement.',
  'State becomes final.',
  'The minimum is close.',
  'Mainnet eligibility begins.',
  'The engine synchronizes.',
  'Routes become a system.',
  'Signals become a network.',
  'Chains begin to align.',
  'Liquidity finds its route.',
  'The record grows stronger.',
  'The relay remains active.',
  'The state is confirmed.',
  'Momentum continues.',
  'We are getting closer.',
  'The launch sequence starts.',
  'Mainnet is in sight.',
  'The window is opening.',
  'The final orbit begins.',
  'All systems are ready.',
  'Six signals remain.',
  'Five signals remain.',
  'Four signals remain.',
  'One final orbit.',
  'The future is onchain.',
] as const

type WalletProgress = {
  claimedDays: number[]
}

function getStorageKey(address: string) {
  return `machina-countdown-smoke:${address.toLowerCase()}`
}

function loadProgress(address?: string): WalletProgress {
  if (!address || typeof window === 'undefined') return { claimedDays: [] }

  try {
    const raw = window.localStorage.getItem(getStorageKey(address))
    if (!raw) return { claimedDays: [] }

    const parsed = JSON.parse(raw) as WalletProgress
    const claimedDays = Array.isArray(parsed.claimedDays)
      ? parsed.claimedDays.filter(
          (day) => Number.isInteger(day) && day >= 1 && day <= TOTAL_DAYS,
        )
      : []

    return { claimedDays: [...new Set(claimedDays)].sort((a, b) => a - b) }
  } catch {
    return { claimedDays: [] }
  }
}

function saveProgress(address: string, progress: WalletProgress) {
  window.localStorage.setItem(getStorageKey(address), JSON.stringify(progress))
}

function shortenAddress(address?: string) {
  if (!address) return 'Wallet not connected'
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function getCalendarDay(now: number) {
  const day = Math.floor((now - CAMPAIGN_START_UTC) / DAY_MS) + 1
  if (day < 1) return 1
  if (day > TOTAL_DAYS) return TOTAL_DAYS
  return day
}

function getCountdownParts(now: number) {
  const remaining = Math.max(0, MAINNET_TARGET_UTC - now)
  const totalSeconds = Math.floor(remaining / 1000)

  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  }
}

function getTier(claimCount: number) {
  if (claimCount >= 40) return 'Genesis 40'
  if (claimCount >= 30) return 'Pioneer'
  if (claimCount >= 20) return 'Initiate'
  return 'Not eligible'
}

function NftCard({
  day,
  claimed,
  wallet,
}: {
  day: number
  claimed: boolean
  wallet?: string
}) {
  const litSegments = day
  const phase = day <= 10 ? 'SIGNAL' : day <= 20 ? 'FLOW' : day <= 30 ? 'SETTLEMENT' : 'IGNITION'

  return (
    <article className="relative mx-auto w-full max-w-[430px] overflow-hidden rounded-[26px] border border-[#56605a] bg-[#050908] p-[7px] shadow-[0_35px_80px_rgba(3,16,8,0.38)]">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.16),transparent_20%,transparent_78%,rgba(102,209,33,0.18))]" />
      <div className="relative overflow-hidden rounded-[20px] border border-[#242c27] bg-[#070d0a] px-5 pb-5 pt-6 sm:px-7">
        <div className="pointer-events-none absolute inset-0 opacity-40 [background-image:linear-gradient(rgba(102,209,33,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(102,209,33,0.05)_1px,transparent_1px)] [background-size:24px_24px]" />
        <div className="pointer-events-none absolute inset-x-5 top-3 h-px bg-gradient-to-r from-transparent via-[#6f7d74] to-transparent" />

        <header className="relative flex items-start justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.32em] text-slate-300">Day</p>
            <p className="mt-1 text-5xl font-light leading-none tracking-tight text-white">
              {day.toString().padStart(2, '0')}
            </p>
            <p className="mt-1 text-lg font-light text-slate-300">/ 40</p>
          </div>
          <span className="rounded-full border border-[#4e7e58] bg-[#102718] px-3 py-1.5 text-[11px] font-semibold tracking-[0.18em] text-[#bafc9a]">
            {phase}
          </span>
        </header>

        <div className="relative mx-auto mt-3 aspect-square w-full max-w-[330px]">
          <div className="absolute inset-[8%] rounded-full border border-[#23372b] bg-[radial-gradient(circle,rgba(61,128,31,0.18),rgba(2,8,4,0.96)_65%)] shadow-[inset_0_0_45px_rgba(67,190,22,0.1)]" />

          {Array.from({ length: TOTAL_DAYS }, (_, index) => {
            const active = index < litSegments
            return (
              <span
                key={index}
                className="absolute left-1/2 top-1/2 h-6 w-2 rounded-sm"
                style={{
                  transform: `translate(-50%, -50%) rotate(${index * 9}deg) translateY(-145px)`,
                  background: active
                    ? 'linear-gradient(180deg,#ecffd9,#70ef35 48%,#2c7f0d)'
                    : 'linear-gradient(180deg,#303933,#171d19)',
                  boxShadow: active ? '0 0 14px rgba(109,239,49,0.7)' : 'inset 0 0 0 1px rgba(255,255,255,0.03)',
                }}
              />
            )
          })}

          <div className="absolute inset-[22%] grid place-items-center overflow-hidden rounded-full border border-[#375443] bg-[#030604] shadow-[0_0_26px_rgba(71,181,25,0.16)]">
            <div
              className="absolute h-[76%] w-[86%] border border-[#4eca23] bg-transparent"
              style={{ clipPath: 'polygon(50% 0%, 100% 100%, 0 100%)' }}
            />
            <div className="relative z-10 h-[86%] w-[78%] overflow-hidden">
              <img
                src={arcLogo}
                alt="Machina"
                className="absolute left-1/2 top-[40%] h-[162%] w-[162%] max-w-none -translate-x-1/2 -translate-y-1/2 object-contain drop-shadow-[0_10px_18px_rgba(0,0,0,0.65)]"
              />
            </div>
          </div>
        </div>

        <div className="relative mt-2 border-y border-[#1f2a23] py-5 text-center">
          <h2 className="text-2xl font-medium uppercase tracking-[0.04em] text-white">
            {DAY_TITLES[day - 1]}
          </h2>
          <p className="mt-2 text-sm text-slate-400">{DAY_SUBTITLES[day - 1]}</p>
        </div>

        <div className="relative mt-5 flex items-center justify-between gap-3">
          <div className="flex gap-1.5">
            {Array.from({ length: 8 }, (_, index) => {
              const active = index < Math.ceil(day / 5)
              return (
                <span
                  key={index}
                  className={`h-1.5 w-5 rounded-full ${
                    active
                      ? 'bg-[#77ef38] shadow-[0_0_8px_rgba(119,239,56,0.75)]'
                      : 'bg-[#202923]'
                  }`}
                />
              )
            })}
          </div>
          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            {claimed ? <Check size={13} className="text-[#7bef3b]" /> : <Lock size={12} />}
            {claimed ? shortenAddress(wallet) : 'Not claimed'}
          </span>
        </div>
      </div>
    </article>
  )
}

export default function CountdownPage() {
  const { address, chainId, isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const [now, setNow] = useState(Date.now())
  const [simulatedDay, setSimulatedDay] = useState(1)
  const [progress, setProgress] = useState<WalletProgress>({ claimedDays: [] })
  const [repeatAttempts, setRepeatAttempts] = useState<Record<number, number>>({})
  const [message, setMessage] = useState<string | null>(null)

  const smokeMode = useMemo(() => {
    const params = new URLSearchParams(window.location.search)
    const previewHost = window.location.hostname.endsWith('.vercel.app')
    return import.meta.env.DEV || import.meta.env.VITE_COUNTDOWN_SMOKE_TEST === 'true' || (previewHost && params.get('smoke') === '1')
  }, [])

  const activeDay = smokeMode ? simulatedDay : getCalendarDay(now)
  const claimedDays = progress.claimedDays
  const claimed = claimedDays.includes(activeDay)
  const arcSelected = chainId === ARC_EVM_CHAIN_ID
  const ownerTestWallet = Boolean(
    smokeMode && address && address.toLowerCase() === OWNER_TEST_WALLET,
  )
  const canClaim = smokeMode && isConnected && arcSelected && (!claimed || ownerTestWallet)
  const countdown = getCountdownParts(now)
  const tier = getTier(claimedDays.length)

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    setProgress(loadProgress(address))
    setRepeatAttempts({})
    setMessage(null)
  }, [address])

  const claimDay = () => {
    if (!address || !canClaim) return

    if (claimed && ownerTestWallet) {
      const attempt = (repeatAttempts[activeDay] ?? 1) + 1
      setRepeatAttempts((current) => ({ ...current, [activeDay]: attempt }))
      setMessage(`Day ${activeDay.toString().padStart(2, '0')} repeat smoke test #${attempt} completed.`)
      return
    }

    const next = {
      claimedDays: [...claimedDays, activeDay].sort((a, b) => a - b),
    }
    saveProgress(address, next)
    setProgress(next)
    setRepeatAttempts((current) => ({ ...current, [activeDay]: 1 }))
    setMessage(`Day ${activeDay.toString().padStart(2, '0')} smoke claim completed.`)
  }

  const resetCurrentDay = () => {
    if (!address) return
    const next = { claimedDays: claimedDays.filter((day) => day !== activeDay) }
    saveProgress(address, next)
    setProgress(next)
    setMessage(`Day ${activeDay.toString().padStart(2, '0')} test record reset.`)
  }

  const resetAll = () => {
    if (!address) return
    window.localStorage.removeItem(getStorageKey(address))
    setProgress({ claimedDays: [] })
    setRepeatAttempts({})
    setMessage('All preview claim records reset.')
  }

  const downloadWalletCard = async () => {
    if (!address || !claimed) return

    const canvas = document.createElement('canvas')
    canvas.width = 1080
    canvas.height = 1350
    const context = canvas.getContext('2d')
    if (!context) return

    const gradient = context.createLinearGradient(0, 0, 1080, 1350)
    gradient.addColorStop(0, '#07120b')
    gradient.addColorStop(0.55, '#020604')
    gradient.addColorStop(1, '#0c190f')
    context.fillStyle = gradient
    context.fillRect(0, 0, 1080, 1350)

    context.strokeStyle = '#5d6a61'
    context.lineWidth = 6
    context.strokeRect(36, 36, 1008, 1278)

    context.textAlign = 'center'
    context.fillStyle = '#d8e2db'
    context.font = '500 34px Arial'
    context.fillText('DAY', 540, 120)
    context.fillStyle = '#ffffff'
    context.font = '300 96px Arial'
    context.fillText(activeDay.toString().padStart(2, '0'), 540, 220)
    context.font = '300 32px Arial'
    context.fillText('/ 40', 540, 268)

    context.save()
    context.translate(540, 600)
    for (let index = 0; index < TOTAL_DAYS; index += 1) {
      context.save()
      context.rotate((Math.PI * 2 * index) / TOTAL_DAYS)
      context.fillStyle = index < activeDay ? '#75ef39' : '#202923'
      context.shadowColor = index < activeDay ? 'rgba(117,239,57,0.8)' : 'transparent'
      context.shadowBlur = index < activeDay ? 18 : 0
      context.fillRect(-7, -310, 14, 54)
      context.restore()
    }
    context.restore()

    const image = new Image()
    image.src = arcLogo
    await image.decode()
    context.drawImage(image, 300, 365, 480, 480)

    context.fillStyle = '#ffffff'
    context.font = '600 48px Arial'
    context.fillText(DAY_TITLES[activeDay - 1].toUpperCase(), 540, 990)
    context.fillStyle = '#aab7ae'
    context.font = '400 28px Arial'
    context.fillText(DAY_SUBTITLES[activeDay - 1], 540, 1042)
    context.fillStyle = '#79ef3d'
    context.font = '600 28px Arial'
    context.fillText(shortenAddress(address), 540, 1150)

    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `machina-day-${activeDay.toString().padStart(2, '0')}-${address.slice(2, 8)}.png`
      anchor.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }

  return (
    <div className="min-h-screen bg-[#f3f7f2] text-slate-950">
      <header className="border-b border-slate-200 bg-white/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <img src={arcLogo} alt="Machina" className="h-11 w-11 rounded-xl border border-slate-200 bg-white object-contain p-1" />
            <strong className="text-lg tracking-tight">Machina Countdown</strong>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href="/"
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              <ArrowLeft size={16} /> Machina Bridge
            </a>
            <ConnectButton chainStatus="none" accountStatus="address" showBalance={false} />
          </div>
        </div>
      </header>

      <main>
        <section className="relative overflow-hidden border-b border-[#203127] bg-[#06100a] text-white">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(91,211,35,0.22),transparent_46%)]" />
          <div className="relative mx-auto max-w-7xl px-4 py-12 text-center sm:px-6 sm:py-16 lg:px-8">
            <p className="text-xs font-semibold uppercase tracking-[0.38em] text-[#91f05d]">40 Days to Mainnet</p>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-6xl">Machina Mainnet Countdown</h1>
            <p className="mx-auto mt-4 max-w-2xl text-base text-slate-300 sm:text-lg">
              Claim one daily NFT. Complete at least 20 days to unlock a mainnet badge.
            </p>

            <div className="mx-auto mt-8 grid max-w-4xl grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['DAYS', countdown.days],
                ['HOURS', countdown.hours],
                ['MINUTES', countdown.minutes],
                ['SECONDS', countdown.seconds],
              ].map(([label, value]) => (
                <div key={label} className="rounded-2xl border border-[#3a5644] bg-black/25 px-3 py-5 shadow-[inset_0_0_28px_rgba(89,211,35,0.07)]">
                  <div className="text-4xl font-light tabular-nums sm:text-5xl">
                    {String(value).padStart(2, '0')}
                  </div>
                  <div className="mt-2 text-[10px] font-semibold tracking-[0.25em] text-slate-400">{label}</div>
                </div>
              ))}
            </div>
            <p className="mt-5 text-xs uppercase tracking-[0.2em] text-slate-500">Target: 16 September 2026</p>
          </div>
        </section>

        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <section className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_460px] lg:items-start">
            <div className="space-y-5">
              <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Your progress</p>
                    <p className="mt-2 text-4xl font-semibold tracking-tight">{claimedDays.length} / 40</p>
                    <p className="mt-1 text-sm text-slate-500">Current tier: {tier}</p>
                  </div>
                  <div className={`rounded-2xl border px-4 py-3 ${isConnected ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-slate-50'}`}>
                    <p className="flex items-center gap-2 text-sm font-semibold">
                      <Wallet size={16} /> {shortenAddress(address)}
                    </p>
                  </div>
                </div>

                {!arcSelected && isConnected && (
                  <button
                    type="button"
                    onClick={() => void switchChainAsync({ chainId: ARC_EVM_CHAIN_ID })}
                    className="mt-4 inline-flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-900"
                  >
                    Switch to Arc Testnet <ExternalLink size={15} />
                  </button>
                )}

                {ownerTestWallet && (
                  <p className="mt-4 inline-flex rounded-full bg-violet-50 px-3 py-1.5 text-xs font-semibold text-violet-800">
                    Unlimited owner smoke testing enabled
                  </p>
                )}
              </div>

              <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-xl font-semibold">Daily collection</h2>
                    <p className="mt-1 text-sm text-slate-500">Select a day to inspect it in preview mode.</p>
                  </div>
                  <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700">{claimedDays.length} claimed</span>
                </div>

                <div className="mt-5 grid grid-cols-5 gap-2 sm:grid-cols-8 lg:grid-cols-10">
                  {Array.from({ length: TOTAL_DAYS }, (_, index) => {
                    const day = index + 1
                    const isClaimed = claimedDays.includes(day)
                    const selected = day === activeDay
                    return (
                      <button
                        key={day}
                        type="button"
                        disabled={!smokeMode}
                        onClick={() => smokeMode && setSimulatedDay(day)}
                        className={`aspect-square rounded-xl border text-xs font-semibold ${
                          isClaimed
                            ? 'border-[#7ee84a] bg-[#ebfbe4] text-[#286b0c]'
                            : selected
                              ? 'border-slate-950 bg-slate-950 text-white'
                              : 'border-slate-200 bg-slate-50 text-slate-500'
                        }`}
                      >
                        {day.toString().padStart(2, '0')}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                <h2 className="text-xl font-semibold">Claim Day {activeDay.toString().padStart(2, '0')}</h2>
                <div className="mt-4 grid gap-2 text-sm text-slate-600 sm:grid-cols-3">
                  <p className="flex items-center gap-2">{isConnected ? <Check size={16} className="text-emerald-600" /> : <Lock size={16} />} Wallet connected</p>
                  <p className="flex items-center gap-2">{arcSelected ? <Check size={16} className="text-emerald-600" /> : <Lock size={16} />} Arc Testnet selected</p>
                  <p className="flex items-center gap-2">{!claimed || ownerTestWallet ? <Check size={16} className="text-emerald-600" /> : <Lock size={16} />} {claimed && ownerTestWallet ? 'Repeat test available' : 'Available today'}</p>
                </div>

                <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                  <button
                    type="button"
                    onClick={claimDay}
                    disabled={!canClaim}
                    className="flex-1 rounded-2xl bg-[#2f6e0c] px-5 py-3.5 text-sm font-semibold text-white hover:bg-[#25580a] disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
                  >
                    {claimed
                      ? ownerTestWallet
                        ? 'Repeat smoke claim'
                        : 'Already claimed'
                      : 'Run smoke claim'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void downloadWalletCard()}
                    disabled={!claimed || !address}
                    className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 px-5 py-3.5 text-sm font-semibold text-slate-700 disabled:opacity-40"
                  >
                    <Download size={16} /> Download card
                  </button>
                </div>

                {message && <p className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-700">{message}</p>}
              </div>
            </div>

            <NftCard day={activeDay} claimed={claimed} wallet={address} />
          </section>

          {smokeMode && (
            <section className="mt-7 rounded-[24px] border border-amber-200 bg-amber-50 p-4 sm:p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="inline-flex items-center gap-2 text-sm font-semibold text-amber-950"><FlaskConical size={17} /> Preview controls</p>
                  <p className="mt-1 text-xs text-amber-800">Local preview data only. No contract transaction is sent.</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => setSimulatedDay((day) => Math.max(1, day - 1))} className="rounded-xl border border-amber-300 bg-white p-2.5"><ChevronLeft size={17} /></button>
                  <span className="min-w-28 rounded-xl border border-amber-300 bg-white px-4 py-2.5 text-center text-sm font-semibold">Day {activeDay} / 40</span>
                  <button type="button" onClick={() => setSimulatedDay((day) => Math.min(TOTAL_DAYS, day + 1))} className="rounded-xl border border-amber-300 bg-white p-2.5"><ChevronRight size={17} /></button>
                  <button type="button" onClick={resetCurrentDay} disabled={!claimed || !address} className="inline-flex items-center gap-2 rounded-xl border border-amber-300 bg-white px-3 py-2.5 text-sm font-semibold disabled:opacity-40"><RotateCcw size={16} /> Reset day</button>
                  <button type="button" onClick={resetAll} disabled={!address || claimedDays.length === 0} className="inline-flex items-center gap-2 rounded-xl border border-amber-300 bg-white px-3 py-2.5 text-sm font-semibold disabled:opacity-40"><RotateCcw size={16} /> Reset all</button>
                </div>
              </div>
            </section>
          )}

          <section className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-4"><strong>0–19</strong><p className="mt-1 text-sm text-slate-500">No mainnet badge.</p></div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4"><strong>20–29</strong><p className="mt-1 text-sm text-slate-500">Machina Initiate.</p></div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4"><strong>30–39</strong><p className="mt-1 text-sm text-slate-500">Machina Pioneer.</p></div>
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4"><strong>40 / 40</strong><p className="mt-1 text-sm text-emerald-800">Genesis 40 and 0% Machina fee during the first mainnet week. Network and protocol fees still apply.</p></div>
          </section>
        </div>
      </main>
    </div>
  )
}
