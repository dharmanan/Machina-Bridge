import { useEffect, useMemo, useState } from 'react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount, useSwitchChain } from 'wagmi'
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
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

type Phase = 'Signal' | 'Flow' | 'Settlement' | 'Ignition'
type WalletProgress = { claimedDays: number[] }

function getPhase(day: number): Phase {
  if (day <= 10) return 'Signal'
  if (day <= 20) return 'Flow'
  if (day <= 30) return 'Settlement'
  return 'Ignition'
}

function getCalendarDay(now = Date.now()) {
  const day = Math.floor((now - CAMPAIGN_START_UTC) / DAY_MS) + 1
  if (day < 1) return 0
  if (day > TOTAL_DAYS) return TOTAL_DAYS + 1
  return day
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
    return {
      claimedDays: Array.isArray(parsed.claimedDays)
        ? parsed.claimedDays.filter((day) => Number.isInteger(day) && day >= 1 && day <= TOTAL_DAYS)
        : [],
    }
  } catch {
    return { claimedDays: [] }
  }
}

function saveProgress(address: string, progress: WalletProgress) {
  window.localStorage.setItem(getStorageKey(address), JSON.stringify(progress))
}

function shortenAddress(address?: string) {
  if (!address) return 'Not connected'
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

function formatRemaining(milliseconds: number) {
  if (milliseconds <= 0) return 'Target reached'

  const seconds = Math.floor(milliseconds / 1000)
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainingSeconds = seconds % 60

  return `${days}d ${hours.toString().padStart(2, '0')}h ${minutes
    .toString()
    .padStart(2, '0')}m ${remainingSeconds.toString().padStart(2, '0')}s`
}

function CountdownCard({
  day,
  claimed,
  wallet,
}: {
  day: number
  claimed: boolean
  wallet?: string
}) {
  const phase = getPhase(day)

  return (
    <div className="relative overflow-hidden rounded-[32px] border border-emerald-300/20 bg-[#07110b] p-5 text-white shadow-[0_30px_90px_rgba(8,35,17,0.35)] sm:p-7">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_35%,rgba(102,209,33,0.18),transparent_38%),linear-gradient(145deg,rgba(255,255,255,0.04),transparent_45%)]" />

      <div className="relative flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.32em] text-emerald-300/80">Machina Countdown</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Day {day.toString().padStart(2, '0')} / 40</h2>
        </div>
        <span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-200">
          {phase}
        </span>
      </div>

      <div className="relative mx-auto my-5 aspect-square w-full max-w-[360px]">
        {Array.from({ length: TOTAL_DAYS }, (_, index) => {
          const isActive = index < day
          return (
            <span
              key={index}
              className="absolute left-1/2 top-1/2 h-6 w-1.5 rounded-full"
              style={{
                transform: `translate(-50%, -50%) rotate(${index * 9}deg) translateY(-145px)`,
                background: isActive
                  ? 'linear-gradient(180deg, #d9ffbb 0%, #66d121 45%, #246c0b 100%)'
                  : 'rgba(255,255,255,0.12)',
                boxShadow: isActive ? '0 0 16px rgba(102,209,33,0.7)' : 'none',
              }}
            />
          )
        })}

        <div className="absolute inset-[17%] grid place-items-center rounded-full border border-emerald-300/25 bg-black/55 shadow-[inset_0_0_50px_rgba(102,209,33,0.12),0_0_45px_rgba(102,209,33,0.12)]">
          <div
            className="absolute h-[78%] w-[82%] bg-gradient-to-b from-[#78e82f] via-[#47b91b] to-[#235f0c] opacity-90"
            style={{ clipPath: 'polygon(50% 0%, 100% 100%, 0% 100%)' }}
          />
          <img
            src={arcLogo}
            alt="Machina"
            className="relative z-10 h-[58%] w-[58%] object-contain drop-shadow-[0_14px_24px_rgba(0,0,0,0.55)]"
          />
        </div>
      </div>

      <div className="relative text-center">
        <h3 className="text-2xl font-semibold tracking-tight sm:text-3xl">{DAY_TITLES[day - 1]}</h3>
        <p className="mt-2 text-sm text-slate-300">Progress signal {day} of 40. One record per connected wallet.</p>
        {claimed && wallet && (
          <p className="mt-4 inline-flex rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-emerald-100">
            Claimed by {shortenAddress(wallet)}
          </p>
        )}
        <div className="mt-5 flex items-center justify-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
          {claimed ? <Check size={14} className="text-emerald-300" /> : <Lock size={14} />}
          {claimed ? 'Claimed in smoke test' : 'Not claimed'}
        </div>
      </div>
    </div>
  )
}

export default function CountdownPage() {
  const { address, chainId, isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const [now, setNow] = useState(Date.now())
  const [simulatedDay, setSimulatedDay] = useState(1)
  const [progress, setProgress] = useState<WalletProgress>({ claimedDays: [] })
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const smokeMode = useMemo(() => {
    if (typeof window === 'undefined') return false
    const query = new URLSearchParams(window.location.search)
    const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    const isVercelPreview = window.location.hostname.endsWith('.vercel.app')
    return import.meta.env.DEV || import.meta.env.VITE_COUNTDOWN_SMOKE_TEST === 'true' || ((isLocal || isVercelPreview) && query.get('smoke') === '1')
  }, [])

  const realCalendarDay = getCalendarDay(now)
  const activeDay = smokeMode
    ? simulatedDay
    : Math.min(TOTAL_DAYS, Math.max(1, realCalendarDay || 1))
  const claimedDays = progress.claimedDays
  const hasClaimedActiveDay = claimedDays.includes(activeDay)
  const isArcTestnet = chainId === ARC_EVM_CHAIN_ID
  const canClaim = smokeMode && isConnected && isArcTestnet && !hasClaimedActiveDay

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    setProgress(loadProgress(address))
  }, [address])

  const claimActiveDay = () => {
    if (!address || !canClaim) return
    const next = {
      claimedDays: [...claimedDays, activeDay].sort((a, b) => a - b),
    }
    saveProgress(address, next)
    setProgress(next)
    setStatusMessage(`Smoke claim recorded for Day ${activeDay.toString().padStart(2, '0')}. No blockchain transaction was sent.`)
  }

  const resetSmokeProgress = () => {
    if (!address) return
    window.localStorage.removeItem(getStorageKey(address))
    setProgress({ claimedDays: [] })
    setStatusMessage('Smoke-test progress reset for the connected wallet.')
  }

  const downloadPersonalizedCard = async () => {
    if (!address || !hasClaimedActiveDay) return

    const canvas = document.createElement('canvas')
    canvas.width = 1200
    canvas.height = 1200
    const context = canvas.getContext('2d')
    if (!context) return

    const gradient = context.createRadialGradient(600, 420, 40, 600, 600, 760)
    gradient.addColorStop(0, '#173a1f')
    gradient.addColorStop(0.48, '#08120c')
    gradient.addColorStop(1, '#020604')
    context.fillStyle = gradient
    context.fillRect(0, 0, 1200, 1200)

    context.save()
    context.translate(600, 530)
    for (let index = 0; index < TOTAL_DAYS; index += 1) {
      context.save()
      context.rotate((Math.PI * 2 * index) / TOTAL_DAYS)
      context.fillStyle = index < activeDay ? '#66d121' : 'rgba(255,255,255,0.14)'
      context.shadowColor = index < activeDay ? 'rgba(102,209,33,0.8)' : 'transparent'
      context.shadowBlur = index < activeDay ? 18 : 0
      context.fillRect(-6, -365, 12, 54)
      context.restore()
    }
    context.restore()

    const image = new Image()
    image.src = arcLogo
    await image.decode()

    context.fillStyle = '#58c91f'
    context.beginPath()
    context.moveTo(600, 230)
    context.lineTo(880, 770)
    context.lineTo(320, 770)
    context.closePath()
    context.fill()
    context.drawImage(image, 405, 345, 390, 390)

    context.textAlign = 'center'
    context.fillStyle = '#d9ffbb'
    context.font = '700 34px Arial'
    context.fillText('MACHINA COUNTDOWN', 600, 95)
    context.fillStyle = '#ffffff'
    context.font = '700 78px Arial'
    context.fillText(`DAY ${activeDay.toString().padStart(2, '0')} / 40`, 600, 890)
    context.font = '700 48px Arial'
    context.fillText(DAY_TITLES[activeDay - 1].toUpperCase(), 600, 958)
    context.fillStyle = '#b9c8bf'
    context.font = '500 31px Arial'
    context.fillText(`Claimed by ${shortenAddress(address)}`, 600, 1030)
    context.fillStyle = '#7e9387'
    context.font = '500 25px Arial'
    context.fillText('Wallet-based participation record', 600, 1080)

    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `machina-countdown-day-${activeDay.toString().padStart(2, '0')}-${address.slice(2, 8)}.png`
      anchor.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }

  const tier = claimedDays.length >= 40
    ? 'Genesis 40'
    : claimedDays.length >= 30
      ? 'Pioneer'
      : claimedDays.length >= 20
        ? 'Initiate'
        : 'Not eligible'

  return (
    <div className="min-h-screen bg-[#f3f7f2] text-slate-900">
      <header className="border-b border-slate-200 bg-white/90 backdrop-blur-lg">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <div className="flex items-center gap-3">
            <img src={arcLogo} alt="Machina" className="h-11 w-11 rounded-xl border border-slate-200 bg-white object-contain p-1" />
            <div>
              <p className="text-lg font-semibold tracking-tight">Machina Countdown</p>
              <p className="text-xs text-slate-500">Wallet-only preview route. Existing bridge and swap flows remain unchanged.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href="/"
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              <ArrowLeft size={16} /> Back to Machina Bridge
            </a>
            <ConnectButton chainStatus="none" accountStatus="address" showBalance={false} />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <section className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
          <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-emerald-800">
                <Clock size={14} /> Mainnet target countdown
              </span>
              {smokeMode && (
                <span className="inline-flex items-center gap-2 rounded-full bg-amber-50 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-amber-800">
                  <FlaskConical size={14} /> Smoke mode
                </span>
              )}
            </div>

            <h1 className="mt-5 max-w-3xl text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
              Build a 40-day onchain participation record.
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-slate-600">
              The connected wallet is the only identity and the canonical record for all daily claims. No X account, paid social API or external login is required.
            </p>

            <div className="mt-7 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Target</p>
                <p className="mt-2 text-lg font-semibold">16 Sep 2026</p>
                <p className="mt-1 text-xs text-slate-500">Launch time remains configurable.</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Remaining</p>
                <p className="mt-2 text-lg font-semibold tabular-nums">{formatRemaining(MAINNET_TARGET_UTC - now)}</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Your record</p>
                <p className="mt-2 text-lg font-semibold">{claimedDays.length} / 40</p>
                <p className="mt-1 text-xs text-slate-500">Current tier: {tier}</p>
              </div>
            </div>

            <div className={`mt-6 rounded-2xl border p-4 ${isConnected ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-white'}`}>
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-white text-slate-700 shadow-sm"><Wallet size={18} /></span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">Wallet participation record</p>
                  <p className="truncate text-xs text-slate-600">{shortenAddress(address)}</p>
                </div>
                {isConnected && <Check size={17} className="ml-auto text-emerald-700" />}
              </div>
            </div>

            {!isArcTestnet && isConnected && (
              <button
                type="button"
                onClick={() => void switchChainAsync({ chainId: ARC_EVM_CHAIN_ID })}
                className="mt-4 inline-flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-900"
              >
                Switch to Arc Testnet <ExternalLink size={15} />
              </button>
            )}

            {statusMessage && (
              <p className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-700">{statusMessage}</p>
            )}
          </div>

          <CountdownCard day={activeDay} claimed={hasClaimedActiveDay} wallet={address} />
        </section>

        {smokeMode && (
          <section className="mt-6 rounded-[28px] border border-amber-200 bg-amber-50 p-5 sm:p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="inline-flex items-center gap-2 text-sm font-semibold text-amber-950"><FlaskConical size={17} /> Preview smoke-test controls</p>
                <p className="mt-1 text-sm text-amber-800">Local browser records only. No NFT contract call is made in this phase.</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => setSimulatedDay((day) => Math.max(1, day - 1))} className="rounded-xl border border-amber-300 bg-white p-2.5 text-amber-950" aria-label="Previous day"><ChevronLeft size={17} /></button>
                <span className="min-w-28 rounded-xl border border-amber-300 bg-white px-4 py-2.5 text-center text-sm font-semibold text-amber-950">Day {simulatedDay} / 40</span>
                <button type="button" onClick={() => setSimulatedDay((day) => Math.min(TOTAL_DAYS, day + 1))} className="rounded-xl border border-amber-300 bg-white p-2.5 text-amber-950" aria-label="Next day"><ChevronRight size={17} /></button>
                <button type="button" onClick={resetSmokeProgress} disabled={!address} className="inline-flex items-center gap-2 rounded-xl border border-amber-300 bg-white px-3 py-2.5 text-sm font-semibold text-amber-950 disabled:opacity-45"><RotateCcw size={16} /> Reset wallet</button>
              </div>
            </div>
          </section>
        )}

        <section className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-xl font-semibold tracking-tight">Daily collection record</h2>
                <p className="mt-1 text-sm text-slate-500">Each connected wallet maintains its own 40-day claim history.</p>
              </div>
              <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700">{claimedDays.length} claimed</span>
            </div>

            <div className="mt-5 grid grid-cols-5 gap-2 sm:grid-cols-8 lg:grid-cols-10">
              {Array.from({ length: TOTAL_DAYS }, (_, index) => {
                const day = index + 1
                const claimed = claimedDays.includes(day)
                const selected = day === activeDay
                return (
                  <button
                    key={day}
                    type="button"
                    disabled={!smokeMode}
                    onClick={() => smokeMode && setSimulatedDay(day)}
                    className={`aspect-square rounded-xl border text-xs font-semibold transition ${
                      claimed
                        ? 'border-emerald-300 bg-emerald-100 text-emerald-900'
                        : selected
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-slate-200 bg-slate-50 text-slate-500'
                    } disabled:cursor-default`}
                  >
                    {day.toString().padStart(2, '0')}
                  </button>
                )
              })}
            </div>
          </div>

          <aside className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <h2 className="text-xl font-semibold tracking-tight">Claim Day {activeDay.toString().padStart(2, '0')}</h2>
            <div className="mt-4 space-y-2 text-sm text-slate-600">
              <p className="flex items-center gap-2">{isConnected ? <Check size={16} className="text-emerald-600" /> : <Lock size={16} />} Wallet connected</p>
              <p className="flex items-center gap-2">{isArcTestnet ? <Check size={16} className="text-emerald-600" /> : <Lock size={16} />} Arc Testnet selected</p>
              <p className="flex items-center gap-2">{!hasClaimedActiveDay ? <Check size={16} className="text-emerald-600" /> : <Lock size={16} />} Day not previously claimed</p>
            </div>

            <button
              type="button"
              onClick={claimActiveDay}
              disabled={!canClaim}
              className="mt-5 w-full rounded-2xl bg-[#2f6e0c] px-4 py-3.5 text-sm font-semibold text-white transition hover:bg-[#25580a] disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500"
            >
              {hasClaimedActiveDay ? 'Already claimed' : smokeMode ? 'Run smoke claim' : 'Onchain mint not deployed yet'}
            </button>

            <button
              type="button"
              onClick={() => void downloadPersonalizedCard()}
              disabled={!hasClaimedActiveDay || !address}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Download size={16} /> Download wallet card
            </button>
          </aside>
        </section>

        <section className="mt-6 rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-xl font-semibold tracking-tight">Mainnet eligibility rules</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4"><p className="text-sm font-semibold">0–19 claims</p><p className="mt-1 text-xs leading-5 text-slate-500">No mainnet NFT mint eligibility.</p></div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4"><p className="text-sm font-semibold">20–29 claims</p><p className="mt-1 text-xs leading-5 text-slate-500">Machina Initiate eligibility.</p></div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4"><p className="text-sm font-semibold">30–39 claims</p><p className="mt-1 text-xs leading-5 text-slate-500">Machina Pioneer eligibility.</p></div>
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4"><p className="text-sm font-semibold text-emerald-950">40 / 40 claims</p><p className="mt-1 text-xs leading-5 text-emerald-800">Genesis 40 plus 0% Machina service fee during the first mainnet week. Network and protocol fees remain payable by the user.</p></div>
          </div>
        </section>
      </main>
    </div>
  )
}
