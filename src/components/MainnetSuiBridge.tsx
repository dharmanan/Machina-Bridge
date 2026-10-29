import { useEffect, useMemo, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { useSuiWallet } from '../hooks/useSuiWallet'
import { parseUnits } from 'viem'
import { MAINNET_SUI_CCTP_BLOCKER, MAINNET_SUI_CCTP_TEST_MAX_UNITS } from '../config/sui'
import { createSuiRecoveryController, suiRecoveryContext, type SuiRecoveryInput, type SuiRecoveryResult } from '../lib/mainnetSuiRecovery'
import { useSuiMainnetWrite } from '../hooks/useSuiMainnetWrite'
import MainnetSuiTransfer from './MainnetSuiTransfer'
import { importSuiRecovery, readSuiRecoveryQueue, subscribeSuiRecovery, type SuiRecoveryRecord } from '../lib/mainnetSuiQueue'

function stageLabel(stage: SuiRecoveryResult['stage'], direction: SuiRecoveryInput['direction']) {
  const destination = direction === 'arc-to-sui' ? 'Sui' : 'Arc'
  return stage === 'waiting_attestation' ? 'Waiting for Circle attestation' : stage === 'ready_to_mint' ? `Attestation ready · USDC can be received on ${destination}` : 'Destination mint independently verified'
}
function stageNext(r: SuiRecoveryResult) {
  const destination = r.direction === 'arc-to-sui' ? 'Sui' : 'Arc', wallet = r.direction === 'arc-to-sui' ? 'Slush' : 'Arc wallet'
  if (r.stage === 'waiting_attestation') return 'Circle has not attested this burn yet. Check again in a few minutes; checking never sends anything.'
  if (r.stage === 'complete') return `Already received on ${destination}. Nothing more to do.`
  if (parseUnits(r.amount, 6) > MAINNET_SUI_CCTP_TEST_MAX_UNITS) return 'This transfer is above the 0.1 USDC test limit, so receiving is not offered in this test phase. Nothing was sent.'
  return `Continue below with "Review: Receive USDC on ${destination}". Nothing is sent until you confirm it in ${wallet}.`
}
function explorer(direction: SuiRecoveryInput['direction'], source: string) {
  return direction === 'sui-to-arc' ? `https://suiscan.xyz/mainnet/tx/${encodeURIComponent(source)}` : `https://arcscan.app/tx/${source}`
}
function displayError(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  // Only our bounded, non-sensitive validation messages are presented. Raw
  // SDK/RPC errors and payloads are never logged or displayed.
  if (/^(Enter the original base58|Invalid Sui transaction digest|Sui source transaction belongs|No unique Sui DepositForBurn|Wallet, route or source transaction changed|Sui status check timed out|A Sui status check is already running|This transfer is outside)/.test(message)) return message
  if (/^Stored Sui source identity belongs/.test(message)) return 'A saved record for this transaction lists other wallets or another amount. Connect the wallets that made the original transfer. Nothing was sent.'
  if (/^(Stored completion cannot be reconciled|Connect a valid Sui wallet account|Connect the original Sui and Arc wallets|This wallet account does not support Sui|Unsupported source chain or invalid connected wallet|No unique USDC DepositForBurn|This burn is not an existing supported same-wallet|The source transaction is not a successful confirmed burn|Enter a valid source transaction hash|Arc attestation expired|CCTP attestation expired|Multiple Circle messages match|Unsupported or malformed CCTP V2 message|Unsupported finality or invalid CCTP fee bound)/.test(message)) return message
  if (/(timed out|read budget|canonical|block changed|Retry|HTTP \d+|is missing|unavailable|RPC (network identity|returned))/.test(message)) return 'Arc, Sui or Circle did not answer consistently. Nothing was sent; try again in a moment.'
  return 'The source, attestation or destination state could not be verified. No transaction was requested. Check the selected wallets and try again later.'
}
export default function MainnetSuiBridge({ compact = false }: { compact?: boolean }) {
  const { address: evmOwner, isConnected } = useAccount()
  const sui = useSuiWallet('mainnet')
  const [direction, setDirection] = useState<SuiRecoveryInput['direction']>('sui-to-arc')
  const [sourceId, setSourceId] = useState('')
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<SuiRecoveryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [records, setRecords] = useState<SuiRecoveryRecord[]>(readSuiRecoveryQueue)
  const controller = useMemo(() => createSuiRecoveryController(), [])
  // Production writer: source gate constant false, so Review/Confirm stay locked.
  const writer = useSuiMainnetWrite(`${direction}|${sui.address ?? ''}|${evmOwner ?? ''}`)
  const input: SuiRecoveryInput = { direction, sourceId: sourceId.trim(), suiOwner: sui.address ?? '', evmOwner: evmOwner ?? '' }
  const key = suiRecoveryContext(input), current = useRef(key); current.current = key
  useEffect(() => { controller.invalidate(); setChecking(false); setResult(null); setError(null); return () => controller.invalidate() }, [controller, key])
  useEffect(() => subscribeSuiRecovery(() => setRecords(readSuiRecoveryQueue())), [])
  const inspect = async () => {
    if (!isConnected || !sui.walletSupportsNetwork || !sourceId.trim()) return
    setChecking(true); setError(null); setResult(null)
    try {
      const r = await controller.inspect(input, () => current.current === key, importSuiRecovery)
      if (current.current === key) setResult(r)
    } catch (e) { if (current.current === key) setError(displayError(e)) }
    finally { if (current.current === key) setChecking(false) }
  }
  const visible = records.filter(r => r.evmOwner.toLowerCase() === evmOwner?.toLowerCase() && r.suiOwner.toLowerCase() === sui.address?.toLowerCase())
  const content = <div className="space-y-4 break-words text-sm">
    <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">{MAINNET_SUI_CCTP_BLOCKER} Existing transfers can be checked below. Checking never burns USDC, requests a signature or sends a mint.</p>
    <div className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-3 text-xs">
      <div>USDC balance<p className="mt-1 font-semibold">{sui.usdcBalance ?? 'Unavailable'}</p></div>
      <div>SUI gas balance<p className="mt-1 font-semibold">{sui.suiBalance ?? 'Unavailable'}</p></div>
    </div>
    {!sui.isConnected && <button type="button" className="rounded-xl border px-4 py-2 font-semibold" disabled={sui.isConnecting || !sui.isWalletAvailable} onClick={() => { void sui.connect().catch(() => setError('Could not connect the Sui wallet. No signature was requested.')) }}>Connect Slush</button>}
    {!isConnected && <p className="text-xs text-slate-500">Connect the original EVM wallet using the existing wallet menu.</p>}
    {sui.balanceError && <p className="text-xs text-amber-800">{sui.balanceError} Read-only recovery can still check source evidence; sending remains disabled.</p>}
    <label className="block font-medium">Route<select aria-label="Sui recovery route" value={direction} onChange={e => setDirection(e.target.value as SuiRecoveryInput['direction'])} className="mt-1 w-full rounded-xl border border-slate-200 bg-white p-3"><option value="sui-to-arc">Sui Mainnet → Arc Mainnet</option><option value="arc-to-sui">Arc Mainnet → Sui Mainnet</option></select></label>
    <label className="block font-medium">{direction === 'sui-to-arc' ? 'Source Sui transaction digest' : 'Source Arc transaction hash'}<input aria-label="Sui recovery source transaction" value={sourceId} onChange={e => setSourceId(e.target.value)} maxLength={66} autoComplete="off" spellCheck={false} className="mt-1 w-full min-w-0 rounded-xl border border-slate-200 px-3 py-3 font-mono text-xs" placeholder={direction === 'sui-to-arc' ? 'Original base58 digest — no 0x prefix' : '0x…'} /></label>
    <p className="text-xs leading-5 text-slate-500">Standard transfer only. Sui has no Circle forwarding service. Source and destination gas are separate; no fee estimate is available until the required live checks succeed. Receiving a USDC Coin object does not mean the mint failed when address balance is zero.</p>
    <button type="button" onClick={() => void inspect()} disabled={checking || !isConnected || !sui.walletSupportsNetwork || !sourceId.trim()} className="w-full rounded-xl bg-[#66D121] px-4 py-3 font-semibold text-slate-950 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500">{checking ? 'Checking source and destination…' : 'Check existing transfer'}</button>
    {(!isConnected || !sui.walletSupportsNetwork) && <p className="text-xs text-slate-500">Connect both the Arc wallet and Slush on Sui Mainnet to check a transfer.</p>}
    <MainnetSuiTransfer writer={writer} direction={direction} suiOwner={sui.address ?? undefined} evmOwner={evmOwner} ready={isConnected && sui.walletSupportsNetwork} recovery={result} onSource={(d, id) => { setDirection(d); setSourceId(id); setResult(null) }} />
    {error && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">{error}</p>}
    {result && <div role="status" className="rounded-xl border border-slate-200 p-3 text-xs leading-6"><p className="font-semibold">{stageLabel(result.stage, result.direction)}</p><p>Source amount: {result.amount} USDC</p>{result.feeUsdc !== undefined && <p>Attested Circle fee: {result.feeUsdc} USDC</p>}{result.receivedUsdc && <p>{result.stage === 'complete' && result.direction === 'arc-to-sui' ? 'Minted (Sui event verified)' : 'Attested net amount'}: {result.receivedUsdc} USDC</p>}<p>{stageNext(result)}</p></div>}
    <details className="rounded-xl border border-slate-200 p-3"><summary className="cursor-pointer font-medium">Sui Bridge Tracker ({visible.length})</summary><p className="mt-2 text-xs text-slate-500">Stored history is not a current chain check. Wallet Activity and refundable Solana deposits remain separate.</p>{visible.map(r => <article key={r.id} className="mt-3 space-y-2 border-t pt-3 text-xs"><p>{r.direction === 'sui-to-arc' ? 'Sui → Arc' : 'Arc → Sui'} · {r.amount} USDC</p><a className="block break-all underline" href={explorer(r.direction, r.sourceId)} target="_blank" rel="noreferrer">{r.sourceId}</a><p>Stored result: {stageLabel(r.stage, r.direction)} · not rechecked</p><button type="button" className="font-semibold underline" onClick={() => { setDirection(r.direction); setSourceId(r.sourceId); setResult(null) }}>Select for a fresh check</button></article>)}</details>
  </div>
  return compact ? <details className="mb-5 rounded-2xl border border-slate-200 bg-white p-4"><summary className="cursor-pointer font-semibold">Sui transfers and recovery</summary><div className="mt-4">{content}</div></details> : <section aria-label="Sui Mainnet bridge" className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="mb-4 text-xl font-semibold">Sui ↔ Arc</h2>{content}</section>
}
