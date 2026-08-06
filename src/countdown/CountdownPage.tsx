import { useEffect, useMemo, useState } from 'react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount, useSwitchChain } from 'wagmi'
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Download, ExternalLink, FlaskConical, Lock, RotateCcw, Wallet } from 'lucide-react'
import arcLogo from '../assets/arc.png'
import { ARC_EVM_CHAIN_ID } from '../lib/chains'

const TOTAL_DAYS = 40
const DAY_MS = 86_400_000
const START = Date.UTC(2026, 7, 7)
const TARGET = Date.UTC(2026, 8, 16)
const OWNER_TEST_WALLET = '0xafbb6cc5c0a9c0eb1bff8db2ed807e83aab8e321'

const TITLES = ['First Signal','Boot Sequence','Green Pulse','Relay Online','Vector Lock','Machine Heart','Proof of Motion','Route Found','Channel Open','Network Pulse','Flow State','Stable Current','Liquidity Thread','Crosschain Echo','Packet Forward','Deterministic','Settlement Beam','Finality Mark','Threshold Near','Threshold','Engine Sync','Route Matrix','Signal Mesh','Chain Link','Liquidity Route','Proof Layer','Relay Core','State Verified','Forward Motion','Final Approach','Ignition Key','Mainnet Vector','Launch Window','Orbit Locked','Systems Ready','Signal Six','Signal Five','Signal Four','Last Orbit','Mainnet Ignition'] as const
const SUBTITLES = ['The journey begins.','Systems come online.','The network wakes.','The first route opens.','Direction confirmed.','Core systems active.','Momentum is visible.','A path is established.','Value can now move.','The network responds.','The current stabilizes.','Stable value in motion.','Liquidity begins to connect.','A signal crosses chains.','The message moves forward.','Settlement becomes predictable.','The path to settlement.','State becomes final.','The minimum is close.','Mainnet eligibility begins.','The engine synchronizes.','Routes become a system.','Signals become a network.','Chains begin to align.','Liquidity finds its route.','The record grows stronger.','The relay remains active.','The state is confirmed.','Momentum continues.','We are getting closer.','The launch sequence starts.','Mainnet is in sight.','The window is opening.','The final orbit begins.','All systems are ready.','Six signals remain.','Five signals remain.','Four signals remain.','One final orbit.','The future is onchain.'] as const

type Progress = { claimedDays: number[] }
const keyFor = (address: string) => `machina-countdown-smoke:${address.toLowerCase()}`
const short = (address?: string) => address ? `${address.slice(0,6)}...${address.slice(-4)}` : 'Wallet not connected'

function load(address?: string): Progress {
  if (!address) return { claimedDays: [] }
  try {
    const raw = localStorage.getItem(keyFor(address))
    const parsed = raw ? JSON.parse(raw) as Progress : { claimedDays: [] }
    return { claimedDays: [...new Set((parsed.claimedDays || []).filter((d) => d >= 1 && d <= TOTAL_DAYS))].sort((a,b) => a-b) }
  } catch { return { claimedDays: [] } }
}

function tier(count: number) {
  if (count >= 40) return 'Genesis 40'
  if (count >= 30) return 'Pioneer'
  if (count >= 20) return 'Initiate'
  return 'Not eligible'
}

function countdown(now: number) {
  const s = Math.max(0, Math.floor((TARGET - now) / 1000))
  return [Math.floor(s/86400), Math.floor((s%86400)/3600), Math.floor((s%3600)/60), s%60]
}

function NftCard({ day, claimed, wallet }: { day: number; claimed: boolean; wallet?: string }) {
  const phase = day <= 10 ? 'SIGNAL' : day <= 20 ? 'FLOW' : day <= 30 ? 'SETTLEMENT' : 'IGNITION'
  return (
    <article className="relative mx-auto w-full max-w-[430px] rounded-[28px] bg-[linear-gradient(145deg,#7b857f_0%,#1a211d_12%,#050806_50%,#4b554f_100%)] p-[7px] shadow-[0_35px_80px_rgba(3,16,8,0.38)]">
      <div className="relative overflow-hidden rounded-[22px] border border-[#2d3732] bg-[#060b08] px-5 pb-5 pt-6 sm:px-7">
        <div className="pointer-events-none absolute inset-0 opacity-25 [background-image:radial-gradient(rgba(255,255,255,0.08)_0.6px,transparent_0.7px)] [background-size:4px_4px]" />
        <div className="pointer-events-none absolute inset-0 opacity-25 [background-image:linear-gradient(rgba(102,209,33,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(102,209,33,0.05)_1px,transparent_1px)] [background-size:22px_22px]" />
        <div className="absolute left-4 top-4 h-5 w-14 border-l border-t border-[#4a554e]"/><div className="absolute right-4 top-4 h-5 w-14 border-r border-t border-[#4a554e]"/><div className="absolute bottom-4 left-4 h-5 w-14 border-b border-l border-[#4a554e]"/><div className="absolute bottom-4 right-4 h-5 w-14 border-b border-r border-[#4a554e]"/>

        <header className="relative flex items-start justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[#8bf15a]">Arc Mainnet Countdown</p>
            <p className="mt-3 text-xs uppercase tracking-[0.3em] text-slate-300">Day</p>
            <p className="mt-1 text-5xl font-light leading-none text-white">{String(day).padStart(2,'0')}</p>
            <p className="mt-1 text-lg text-slate-300">/ 40</p>
          </div>
          <span className="rounded-full border border-[#4e7e58] bg-[#102718] px-3 py-1.5 text-[11px] font-semibold tracking-[0.18em] text-[#bafc9a]">{phase}</span>
        </header>

        <div className="relative mx-auto mt-4 aspect-square w-full max-w-[330px]">
          <div className="absolute inset-[8%] rounded-full border border-[#23372b] bg-[radial-gradient(circle,rgba(61,128,31,0.18),rgba(2,8,4,0.97)_68%)]" />
          {Array.from({length:TOTAL_DAYS},(_,i)=><span key={i} className="absolute left-1/2 top-1/2 h-6 w-2 rounded-sm" style={{transform:`translate(-50%,-50%) rotate(${i*9}deg) translateY(-145px)`,background:i<day?'linear-gradient(180deg,#f2ffd8,#7cf03e 48%,#2c830d)':'linear-gradient(180deg,#2c342f,#161b18)',boxShadow:i<day?'0 0 14px rgba(124,240,62,.72)':'none'}} />)}
          <div className="absolute inset-[22%] grid place-items-center overflow-hidden rounded-full border border-[#375443] bg-[#030604] shadow-[0_0_30px_rgba(71,181,25,0.14)]">
            <div className="absolute h-[76%] w-[86%] border border-[#4eca23]" style={{clipPath:'polygon(50% 0%,100% 100%,0 100%)'}} />
            <img src={arcLogo} alt="Machina robot head" className="absolute left-1/2 top-[-6%] z-10 h-auto w-[142%] max-w-none -translate-x-1/2 object-contain drop-shadow-[0_10px_18px_rgba(0,0,0,.65)]" />
          </div>
        </div>

        <div className="relative mt-3 border-y border-[#1f2a23] py-5 text-center">
          <h2 className="text-2xl font-medium uppercase tracking-[0.04em] text-white">{TITLES[day-1]}</h2>
          <p className="mt-2 text-sm text-slate-400">{SUBTITLES[day-1]}</p>
        </div>

        <div className="relative mt-5 flex items-center justify-between gap-3">
          <div className="flex gap-1.5">{Array.from({length:8},(_,i)=><span key={i} className={`h-1.5 w-5 rounded-full ${i<Math.ceil(day/5)?'bg-[#77ef38] shadow-[0_0_8px_rgba(119,239,56,.75)]':'bg-[#202923]'}`} />)}</div>
          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">{claimed?<Check size={13} className="text-[#7bef3b]"/>:<Lock size={12}/>} {claimed?short(wallet):'Not claimed'}</span>
        </div>
      </div>
    </article>
  )
}

export default function CountdownPage() {
  const { address, chainId, isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const [now,setNow] = useState(Date.now())
  const [day,setDay] = useState(1)
  const [progress,setProgress] = useState<Progress>({claimedDays:[]})
  const [message,setMessage] = useState<string|null>(null)

  const smoke = useMemo(() => {
    const q = new URLSearchParams(location.search)
    return import.meta.env.DEV || import.meta.env.VITE_COUNTDOWN_SMOKE_TEST === 'true' || (location.hostname.endsWith('.vercel.app') && q.get('smoke') === '1')
  },[])
  const calendarDay = Math.min(TOTAL_DAYS,Math.max(1,Math.floor((now-START)/DAY_MS)+1))
  const activeDay = smoke ? day : calendarDay
  const claimed = progress.claimedDays.includes(activeDay)
  const arcSelected = chainId === ARC_EVM_CHAIN_ID
  const owner = Boolean(smoke && address && address.toLowerCase() === OWNER_TEST_WALLET)
  const canClaim = smoke && isConnected && arcSelected && (!claimed || owner)
  const [days,hours,minutes,seconds] = countdown(now)

  useEffect(()=>{ const id=setInterval(()=>setNow(Date.now()),1000); return()=>clearInterval(id) },[])
  useEffect(()=>{ setProgress(load(address)); setMessage(null) },[address])

  const save = (next: Progress) => { if (!address) return; localStorage.setItem(keyFor(address),JSON.stringify(next)); setProgress(next) }
  const claim = () => {
    if (!address || !canClaim) return
    if (claimed && owner) { setMessage(`Day ${String(activeDay).padStart(2,'0')} repeat smoke test completed.`); return }
    save({claimedDays:[...progress.claimedDays,activeDay].sort((a,b)=>a-b)})
    setMessage(`Day ${String(activeDay).padStart(2,'0')} smoke claim completed.`)
  }
  const resetDay = () => save({claimedDays:progress.claimedDays.filter((d)=>d!==activeDay)})
  const resetAll = () => { if(!address)return; localStorage.removeItem(keyFor(address)); setProgress({claimedDays:[]}); setMessage('All preview claim records reset.') }

  const download = async () => {
    if (!address || !claimed) return
    const c=document.createElement('canvas'); c.width=1080; c.height=1350; const x=c.getContext('2d'); if(!x)return
    const g=x.createLinearGradient(0,0,1080,1350); g.addColorStop(0,'#07120b'); g.addColorStop(.55,'#020604'); g.addColorStop(1,'#0c190f'); x.fillStyle=g; x.fillRect(0,0,1080,1350)
    x.strokeStyle='#5d6a61'; x.lineWidth=6; x.strokeRect(36,36,1008,1278); x.textAlign='center'; x.fillStyle='#79ef3d'; x.font='600 28px Arial'; x.fillText('ARC MAINNET COUNTDOWN',540,82); x.fillStyle='#fff'; x.font='300 96px Arial'; x.fillText(String(activeDay).padStart(2,'0'),540,210); x.font='300 32px Arial'; x.fillText('/ 40',540,258)
    const img=new Image(); img.src=arcLogo; await img.decode(); x.drawImage(img,img.naturalWidth*.24,img.naturalHeight*.05,img.naturalWidth*.52,img.naturalHeight*.66,350,400,380,440)
    x.fillStyle='#fff'; x.font='600 48px Arial'; x.fillText(TITLES[activeDay-1].toUpperCase(),540,1010); x.fillStyle='#aab7ae'; x.font='400 28px Arial'; x.fillText(SUBTITLES[activeDay-1],540,1062); x.fillStyle='#79ef3d'; x.font='600 28px Arial'; x.fillText(short(address),540,1170)
    c.toBlob((b)=>{ if(!b)return; const u=URL.createObjectURL(b); const a=document.createElement('a'); a.href=u; a.download=`arc-mainnet-countdown-day-${String(activeDay).padStart(2,'0')}-${address.slice(2,8)}.png`; a.click(); URL.revokeObjectURL(u) },'image/png')
  }

  return <div className="min-h-screen bg-[#f3f7f2] text-slate-950">
    <header className="border-b border-slate-200 bg-white/90"><div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6 lg:px-8"><div className="flex items-center gap-3"><img src={arcLogo} alt="Machina" className="h-11 w-11 rounded-xl border border-slate-200 bg-white object-contain p-1"/><strong className="text-lg">Machina</strong></div><div className="flex gap-2"><a href="/" className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700"><ArrowLeft size={16}/> Machina Bridge</a><ConnectButton chainStatus="none" accountStatus="address" showBalance={false}/></div></div></header>

    <section className="border-b border-[#203127] bg-[#06100a] text-white"><div className="mx-auto max-w-7xl px-4 py-7 text-center sm:px-6 sm:py-9 lg:px-8"><h1 className="text-3xl font-semibold sm:text-5xl">Countdown to Arc Mainnet</h1><div className="mx-auto mt-6 grid max-w-3xl grid-cols-4 gap-2 sm:gap-3">{[['DAYS',days],['HOURS',hours],['MINUTES',minutes],['SECONDS',seconds]].map(([l,v])=><div key={String(l)} className="rounded-xl border border-[#3a5644] bg-black/25 px-2 py-3 sm:rounded-2xl sm:py-4"><div className="text-2xl font-light tabular-nums sm:text-4xl">{String(v).padStart(2,'0')}</div><div className="mt-1 text-[8px] font-semibold tracking-[0.2em] text-slate-400 sm:text-[10px]">{l}</div></div>)}</div></div></section>

    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <section className="mb-6 rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><h2 className="text-xl font-semibold">How the Countdown Works</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">Claim one NFT per day during the 40-day countdown to Arc Mainnet. Each claim builds your wallet-based participation record and unlocks mainnet eligibility tiers.</p><div className="mt-4 grid gap-3 sm:grid-cols-3"><div className="rounded-2xl border border-slate-200 bg-slate-50 p-4"><strong>1. Connect</strong><p className="mt-1 text-sm text-slate-500">Connect your wallet and switch to Arc Testnet.</p></div><div className="rounded-2xl border border-slate-200 bg-slate-50 p-4"><strong>2. Claim Daily</strong><p className="mt-1 text-sm text-slate-500">Claim one countdown NFT each day.</p></div><div className="rounded-2xl border border-slate-200 bg-slate-50 p-4"><strong>3. Unlock Rewards</strong><p className="mt-1 text-sm text-slate-500">20+ Initiate, 30+ Pioneer, 40/40 Genesis 40 + 0% Machina fee in mainnet week one.</p></div></div></section>

      <section className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_460px] lg:items-start"><div className="space-y-5">
        <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><div className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Your progress</p><p className="mt-2 text-4xl font-semibold">{progress.claimedDays.length} / 40</p><p className="mt-1 text-sm text-slate-500">Current tier: {tier(progress.claimedDays.length)}</p></div><div className={`rounded-2xl border px-4 py-3 ${isConnected?'border-emerald-200 bg-emerald-50':'border-slate-200 bg-slate-50'}`}><p className="flex items-center gap-2 text-sm font-semibold"><Wallet size={16}/>{short(address)}</p></div></div>{!arcSelected&&isConnected&&<button onClick={()=>void switchChainAsync({chainId:ARC_EVM_CHAIN_ID})} className="mt-4 inline-flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm font-semibold text-emerald-900">Switch to Arc Testnet <ExternalLink size={15}/></button>}</div>
        <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><div className="flex items-center justify-between"><div><h2 className="text-xl font-semibold">Daily collection</h2><p className="mt-1 text-sm text-slate-500">Select a day to inspect it in preview mode.</p></div><span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700">{progress.claimedDays.length} claimed</span></div><div className="mt-5 grid grid-cols-5 gap-2 sm:grid-cols-8 lg:grid-cols-10">{Array.from({length:40},(_,i)=>{const d=i+1,got=progress.claimedDays.includes(d),selected=d===activeDay;return <button key={d} disabled={!smoke} onClick={()=>smoke&&setDay(d)} className={`aspect-square rounded-xl border text-xs font-semibold ${got?'border-[#7ee84a] bg-[#ebfbe4] text-[#286b0c]':selected?'border-slate-950 bg-slate-950 text-white':'border-slate-200 bg-slate-50 text-slate-500'}`}>{String(d).padStart(2,'0')}</button>})}</div></div>
        <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><h2 className="text-xl font-semibold">Claim Day {String(activeDay).padStart(2,'0')}</h2><div className="mt-4 grid gap-2 text-sm text-slate-600 sm:grid-cols-3"><p className="flex items-center gap-2">{isConnected?<Check size={16} className="text-emerald-600"/>:<Lock size={16}/>} Wallet connected</p><p className="flex items-center gap-2">{arcSelected?<Check size={16} className="text-emerald-600"/>:<Lock size={16}/>} Arc Testnet selected</p><p className="flex items-center gap-2">{!claimed||owner?<Check size={16} className="text-emerald-600"/>:<Lock size={16}/>} {claimed&&owner?'Repeat test available':'Available today'}</p></div><div className="mt-5 flex flex-col gap-3 sm:flex-row"><button onClick={claim} disabled={!canClaim} className="flex-1 rounded-2xl bg-[#2f6e0c] px-5 py-3.5 text-sm font-semibold text-white disabled:bg-slate-200 disabled:text-slate-500">{claimed?(owner?'Repeat smoke claim':'Already claimed'):'Run smoke claim'}</button><button onClick={()=>void download()} disabled={!claimed||!address} className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 px-5 py-3.5 text-sm font-semibold text-slate-700 disabled:opacity-40"><Download size={16}/> Download card</button></div>{message&&<p className="mt-4 rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-700">{message}</p>}</div>
      </div><NftCard day={activeDay} claimed={claimed} wallet={address}/></section>

      {smoke&&<section className="mt-7 rounded-[24px] border border-amber-200 bg-amber-50 p-4 sm:p-5"><div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><p className="inline-flex items-center gap-2 text-sm font-semibold text-amber-950"><FlaskConical size={17}/> Preview controls</p><div className="flex flex-wrap items-center gap-2"><button onClick={()=>setDay((d)=>Math.max(1,d-1))} className="rounded-xl border border-amber-300 bg-white p-2.5"><ChevronLeft size={17}/></button><span className="min-w-28 rounded-xl border border-amber-300 bg-white px-4 py-2.5 text-center text-sm font-semibold">Day {activeDay} / 40</span><button onClick={()=>setDay((d)=>Math.min(40,d+1))} className="rounded-xl border border-amber-300 bg-white p-2.5"><ChevronRight size={17}/></button><button onClick={resetDay} disabled={!claimed||!address} className="inline-flex items-center gap-2 rounded-xl border border-amber-300 bg-white px-3 py-2.5 text-sm font-semibold disabled:opacity-40"><RotateCcw size={16}/> Reset day</button><button onClick={resetAll} disabled={!address||progress.claimedDays.length===0} className="inline-flex items-center gap-2 rounded-xl border border-amber-300 bg-white px-3 py-2.5 text-sm font-semibold disabled:opacity-40"><RotateCcw size={16}/> Reset all</button></div></div></section>}

      <section className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><div className="rounded-2xl border border-slate-200 bg-white p-4"><strong>0–19</strong><p className="mt-1 text-sm text-slate-500">No mainnet badge.</p></div><div className="rounded-2xl border border-slate-200 bg-white p-4"><strong>20–29</strong><p className="mt-1 text-sm text-slate-500">Machina Initiate.</p></div><div className="rounded-2xl border border-slate-200 bg-white p-4"><strong>30–39</strong><p className="mt-1 text-sm text-slate-500">Machina Pioneer.</p></div><div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4"><strong>40 / 40</strong><p className="mt-1 text-sm text-emerald-800">Genesis 40 and 0% Machina fee during the first mainnet week. Network and protocol fees still apply.</p></div></section>
      <p className="mt-6 text-center text-[11px] text-slate-400">Independent community countdown by Machina. Not affiliated with or endorsed by Circle or Arc.</p>
    </main>
  </div>
}
