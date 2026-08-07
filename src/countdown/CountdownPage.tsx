import { useEffect, useState } from 'react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount, useSwitchChain } from 'wagmi'
import {
  ArrowLeft,
  Check,
  ExternalLink,
  Lock,
  Wallet,
} from 'lucide-react'
import arcLogo from '../assets/arc.png'
import { ARC_EVM_CHAIN_ID } from '../lib/chains'
import { useCountdownContract } from './useCountdownContract'

const TOTAL_DAYS = 40
const TARGET = Date.UTC(2026, 8, 16)

const TITLES = [
  'First Signal','Boot Sequence','Green Pulse','Relay Online','Vector Lock','Machine Heart','Proof of Motion','Route Found','Channel Open','Network Pulse',
  'Flow State','Stable Current','Liquidity Thread','Crosschain Echo','Packet Forward','Deterministic','Settlement Beam','Finality Mark','Threshold Near','Threshold',
  'Engine Sync','Route Matrix','Signal Mesh','Chain Link','Liquidity Route','Proof Layer','Relay Core','State Verified','Forward Motion','Final Approach',
  'Ignition Key','Mainnet Vector','Launch Window','Orbit Locked','Systems Ready','Signal Six','Signal Five','Signal Four','Last Orbit','Mainnet Ignition',
] as const

const SUBTITLES = [
  'The journey begins.','Systems come online.','The network wakes.','The first route opens.','Direction confirmed.','Core systems active.','Momentum is visible.','A path is established.','Value can now move.','The network responds.',
  'The current stabilizes.','Stable value in motion.','Liquidity begins to connect.','A signal crosses chains.','The message moves forward.','Settlement becomes predictable.','The path to settlement.','State becomes final.','The minimum is close.','Mainnet eligibility begins.',
  'The engine synchronizes.','Routes become a system.','Signals become a network.','Chains begin to align.','Liquidity finds its route.','The record grows stronger.','The relay remains active.','The state is confirmed.','Momentum continues.','We are getting closer.',
  'The launch sequence starts.','Mainnet is in sight.','The window is opening.','The final orbit begins.','All systems are ready.','Six signals remain.','Five signals remain.','Four signals remain.','One final orbit.','The future is onchain.',
] as const

const short = (address?: string) => address ? `${address.slice(0, 6)}...${address.slice(-4)}` : 'Wallet not connected'
const tier = (count: number) => count >= 40 ? 'Genesis 40' : count >= 35 ? 'Degen' : count >= 30 ? 'Pioneer' : count >= 20 ? 'Initiate' : 'Not eligible'

function countdown(now: number) {
  const seconds = Math.max(0, Math.floor((TARGET - now) / 1000))
  return [
    Math.floor(seconds / 86400),
    Math.floor((seconds % 86400) / 3600),
    Math.floor((seconds % 3600) / 60),
    seconds % 60,
  ]
}

function NftCard({ day, claimed, wallet }: { day: number; claimed: boolean; wallet?: string }) {
  const phase = day <= 10 ? 'SIGNAL' : day <= 20 ? 'FLOW' : day <= 30 ? 'SETTLEMENT' : 'IGNITION'

  return (
    <article className="relative mx-auto w-full max-w-[430px] self-start overflow-hidden rounded-[28px] bg-[linear-gradient(145deg,#9aa39d_0%,#2d3530_8%,#0b100d_22%,#030604_68%,#59635d_100%)] p-[8px] shadow-[0_36px_85px_rgba(2,14,7,0.42)]">
      <div className="relative overflow-hidden rounded-[21px] border border-[#39443e] bg-[radial-gradient(circle_at_50%_38%,rgba(77,176,34,0.11),transparent_36%),linear-gradient(180deg,#080e0a,#030604)] px-5 pb-5 pt-6 sm:px-7">
        <div className="pointer-events-none absolute inset-0 opacity-55 [background-image:radial-gradient(rgba(210,224,214,0.13)_0.65px,transparent_0.9px)] [background-size:3px_3px]" />
        <div className="pointer-events-none absolute inset-0 opacity-30 [background-image:repeating-linear-gradient(117deg,transparent_0px,transparent_18px,rgba(255,255,255,0.035)_19px,transparent_20px,transparent_39px)]" />
        <div className="absolute left-4 top-4 h-6 w-16 border-l border-t border-[#707b74]" />
        <div className="absolute right-4 top-4 h-6 w-16 border-r border-t border-[#707b74]" />
        <div className="absolute bottom-4 left-4 h-6 w-16 border-b border-l border-[#515c55]" />
        <div className="absolute bottom-4 right-4 h-6 w-16 border-b border-r border-[#515c55]" />

        <header className="relative flex items-start justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[#8bf15a]">Arc Mainnet Countdown</p>
            <p className="mt-3 text-xs uppercase tracking-[0.3em] text-slate-300">Day</p>
            <p className="mt-1 text-5xl font-light leading-none text-white">{String(day).padStart(2, '0')}</p>
            <p className="mt-1 text-lg text-slate-300">/ 40</p>
          </div>
          <span className="rounded-full border border-[#4e7e58] bg-[#102718] px-3 py-1.5 text-[11px] font-semibold tracking-[0.18em] text-[#bafc9a]">{phase}</span>
        </header>

        <div className="relative mx-auto mt-4 aspect-square w-full max-w-[330px]">
          <div className="absolute inset-[8%] rounded-full border border-[#314438] bg-[radial-gradient(circle,rgba(65,142,32,0.17),rgba(1,5,3,0.98)_68%)]" />
          {Array.from({ length: TOTAL_DAYS }, (_, index) => (
            <span
              key={index}
              className="absolute left-1/2 top-1/2 h-6 w-2 rounded-sm"
              style={{
                transform: `translate(-50%,-50%) rotate(${index * 9}deg) translateY(-145px)`,
                background: index < day
                  ? 'linear-gradient(180deg,#f2ffd8,#7cf03e 48%,#2c830d)'
                  : 'linear-gradient(180deg,#323a35,#171c19)',
                boxShadow: index < day ? '0 0 15px rgba(124,240,62,.75)' : 'none',
              }}
            />
          ))}
          <div className="absolute inset-[23%] overflow-hidden rounded-full border border-[#415c4b] bg-[#020503]">
            <div
              className="absolute left-1/2 top-1/2 h-[78%] w-[88%] -translate-x-1/2 -translate-y-1/2 border border-[#4eca23] opacity-80"
              style={{ clipPath: 'polygon(50% 0%,100% 100%,0 100%)' }}
            />
            <img
              src={arcLogo}
              alt="Machina robot head"
              className="absolute left-1/2 top-[2%] z-10 h-auto w-[121%] max-w-none -translate-x-1/2 object-contain"
              style={{ clipPath: 'inset(0 0 34% 0)' }}
            />
          </div>
        </div>

        <div className="relative mt-3 border-y border-[#263129] py-5 text-center">
          <h2 className="text-2xl font-medium uppercase tracking-[0.04em] text-white">{TITLES[day - 1]}</h2>
          <p className="mt-2 text-sm text-slate-400">{SUBTITLES[day - 1]}</p>
        </div>

        <div className="relative mt-5 flex items-center justify-between gap-3">
          <div className="flex gap-1.5">
            {Array.from({ length: 8 }, (_, index) => (
              <span
                key={index}
                className={`h-1.5 w-5 rounded-full ${index < Math.ceil(day / 5) ? 'bg-[#77ef38] shadow-[0_0_8px_rgba(119,239,56,.75)]' : 'bg-[#202923]'}`}
              />
            ))}
          </div>
          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            {claimed ? <Check size={13} className="text-[#7bef3b]" /> : <Lock size={12} />}
            {claimed ? short(wallet) : 'Not claimed'}
          </span>
        </div>
      </div>
    </article>
  )
}

export default function CountdownPage() {
  const { address, isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const contract = useCountdownContract()

  const [now, setNow] = useState(Date.now())
  const [message, setMessage] = useState<string | null>(null)

  const [days, hours, minutes, seconds] = countdown(now)
  const rawCurrentDay = contract.currentDay
  const campaignNotStarted = rawCurrentDay === 0
  const campaignEnded = rawCurrentDay > TOTAL_DAYS
  const campaignActive = rawCurrentDay >= 1 && rawCurrentDay <= TOTAL_DAYS
  const displayDay = campaignNotStarted ? 1 : campaignEnded ? TOTAL_DAYS : rawCurrentDay
  const displayDayClaimed = contract.claimedDays.includes(displayDay)

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const doClaim = async () => {
    try {
      setMessage(null)
      await contract.claim()
      setMessage(`Day ${displayDay} NFT claimed successfully on Arc Testnet.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Claim failed.')
    }
  }

  const canClaim = contract.contractConfigured
    && campaignActive
    && isConnected
    && contract.onArcTestnet
    && !displayDayClaimed
    && !contract.isWalletPending
    && !contract.isConfirming

  const claimButtonLabel = campaignNotStarted
    ? 'Countdown has not started yet'
    : campaignEnded
      ? 'Countdown complete'
      : displayDayClaimed
        ? 'Already claimed'
        : contract.isWalletPending
          ? 'Confirm in wallet'
          : contract.isConfirming
            ? 'Confirming...'
            : 'Claim NFT on Arc Testnet'

  return (
    <div className="min-h-screen bg-[#f3f7f2] text-slate-950">
      <header className="border-b border-slate-200 bg-white/90 backdrop-blur-lg">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-4">
            <img src={arcLogo} alt="Machina Bridge Logo" className="machina-brand-logo flex-shrink-0" />
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <a href="/" className="text-[1.9rem] font-semibold leading-[0.95] tracking-tight text-slate-900 sm:text-[2.05rem] lg:text-[2.15rem]">
                Machina Bridge
              </a>
              <span className="rounded-full border border-[#66D121]/35 bg-[#eef7e8] px-3 py-1 text-sm font-semibold text-[#2F6E0C]">Countdown</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a href="/" className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700">
              <ArrowLeft size={16} /> Back to Bridge
            </a>
            <ConnectButton chainStatus="none" accountStatus="address" showBalance={false} />
          </div>
        </div>
      </header>

      <section className="bg-[#06100a] py-8 text-center text-white">
        <h1 className="text-3xl font-semibold sm:text-5xl">Countdown to Arc Mainnet</h1>
        <div className="mx-auto mt-6 grid max-w-3xl grid-cols-4 gap-3">
          {[
            ['DAYS', days],
            ['HOURS', hours],
            ['MINUTES', minutes],
            ['SECONDS', seconds],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-2xl border border-[#3a5644] bg-black/25 py-4">
              <div className="text-4xl font-light">{String(value).padStart(2, '0')}</div>
              <div className="mt-1 text-[10px] tracking-[.2em] text-slate-400">{label}</div>
            </div>
          ))}
        </div>
      </section>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <section className="grid items-start gap-7 lg:grid-cols-[minmax(0,1fr)_460px]">
          <div className="space-y-5">
            <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[.18em] text-slate-500">Your progress</p>
                  <p className="mt-2 text-4xl font-semibold">{contract.claimedCount} / 40</p>
                  <p className="mt-1 text-sm text-slate-500">Current tier: {tier(contract.claimedCount)}</p>
                </div>
                <div className="shrink-0 self-start whitespace-nowrap rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                  <p className="flex items-center gap-2 whitespace-nowrap text-sm font-semibold">
                    <Wallet size={16} className="shrink-0" /> {short(address)}
                  </p>
                </div>
              </div>

              <div className="mt-5 border-t border-slate-100 pt-4 text-sm leading-6 text-slate-600">
                Claim one NFT each day during the 40-day countdown. Collect <strong>20</strong> to reach Initiate, <strong>30</strong> to reach Pioneer, and <strong>35</strong> to reach <strong>Degen</strong>. Degen wallets unlock <strong className="text-emerald-700">0% Machina service fee</strong> for the first 7 days after Arc Mainnet launches.
                <p className="mt-2 text-xs text-slate-400">The 0% benefit applies only to the Machina service fee. Network and protocol fees still apply. Collect all 40 for Genesis 40 completion status.</p>
              </div>

              {!contract.contractConfigured && (
                <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">Claiming is temporarily unavailable.</p>
              )}

              {isConnected && !contract.onArcTestnet && (
                <button
                  type="button"
                  onClick={() => void switchChainAsync({ chainId: ARC_EVM_CHAIN_ID })}
                  className="mt-4 inline-flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-900"
                >
                  Switch to Arc Testnet <ExternalLink size={15} />
                </button>
              )}
            </div>

            <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-xl font-semibold">Daily collection</h2>
                  <p className="text-sm text-slate-500">Green days are NFTs already collected by this wallet.</p>
                </div>
                <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold">{contract.claimedCount} claimed</span>
              </div>

              <div className="mt-5 grid grid-cols-5 gap-2 sm:grid-cols-10">
                {Array.from({ length: TOTAL_DAYS }, (_, index) => {
                  const day = index + 1
                  const got = contract.claimedDays.includes(day)
                  const active = campaignActive && day === rawCurrentDay
                  return (
                    <div
                      key={day}
                      aria-label={`Day ${day}${got ? ', collected' : active ? ', current day' : ''}`}
                      className={`flex aspect-square items-center justify-center rounded-xl border text-xs font-semibold ${
                        got
                          ? 'border-lime-400 bg-lime-50 text-green-800'
                          : active
                            ? 'border-slate-950 bg-slate-950 text-white'
                            : 'border-slate-200 bg-slate-50 text-slate-500'
                      }`}
                    >
                      {String(day).padStart(2, '0')}
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-xl font-semibold">{displayDayClaimed ? 'Collected' : 'Claim'} Day {String(displayDay).padStart(2, '0')}</h2>

              <div className="mt-4 grid gap-2 text-sm text-slate-600 sm:grid-cols-3">
                <p className="flex items-center gap-2">{isConnected ? <Check size={16} className="text-emerald-600" /> : <Lock size={16} />} Wallet connected</p>
                <p className="flex items-center gap-2">{contract.onArcTestnet ? <Check size={16} className="text-emerald-600" /> : <Lock size={16} />} Arc Testnet selected</p>
                <p className="flex items-center gap-2">
                  {displayDayClaimed ? <Check size={16} className="text-emerald-600" /> : campaignActive ? <Check size={16} className="text-emerald-600" /> : <Lock size={16} />}
                  {displayDayClaimed ? 'Already collected' : campaignNotStarted ? 'Not started yet' : campaignEnded ? 'Countdown complete' : 'Ready to claim'}
                </p>
              </div>

              <div className="mt-5">
                <button
                  type="button"
                  onClick={() => void doClaim()}
                  disabled={!canClaim}
                  className="w-full rounded-2xl bg-[#2f6e0c] px-5 py-3.5 text-sm font-semibold text-white disabled:bg-slate-200 disabled:text-slate-500"
                >
                  {claimButtonLabel}
                </button>
              </div>

              {message && <p className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-700">{message}</p>}
            </div>
          </div>

          <NftCard day={displayDay} claimed={displayDayClaimed} wallet={address} />
        </section>
      </main>
    </div>
  )
}
