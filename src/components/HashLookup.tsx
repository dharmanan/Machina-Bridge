import { useState } from 'react'
import { formatUnits } from 'viem'
import { ARC_EXECUTION_EXPLORER } from '../lib/uniswapArcExecution'
import { inspectHash, type HashInspection } from '../lib/swap/hashLookup'

// Read-only: look up any Arc transaction hash when its stored Review is missing. Shows only what the chain proves.
export function HashLookup() {
  const [value, setValue] = useState(''), [busy, setBusy] = useState(false), [result, setResult] = useState<HashInspection | null>(null)
  async function lookup() {
    if (busy) return
    setBusy(true); setResult(null)
    try { setResult(await inspectHash(value)) } catch { setResult({ hash: value as `0x${string}`, state: 'unreadable', final: false, flows: [], program: { kind: 'none', summary: '', thirdPartyPortions: [] }, notRechecked: [] }) }
    finally { setBusy(false) }
  }
  const stateText: Record<HashInspection['state'], string> = {
    invalid: 'That is not a transaction hash.', not_found: 'Arc does not know this hash (yet).', pending: 'The transaction is known but not yet included in a block.',
    success: 'Blockchain transaction successful', reverted: 'Blockchain: transaction reverted', unreadable: 'Arc could not be read just now, or this is not an Arc Mainnet transaction. This is not a result about the transaction.',
  }
  return <details aria-label="Look up a transaction" className="rounded-xl border border-slate-100 p-3">
    <summary className="cursor-pointer font-medium text-slate-800">Look up a transaction by hash</summary>
    <p className="mt-2 text-xs text-slate-500">Read-only. Use it when the saved record of a transaction is missing. It shows what the chain proves and what it cannot.</p>
    <div className="mt-2 flex gap-2">
      <input aria-label="Transaction hash to look up" value={value} onChange={event => setValue(event.target.value)} maxLength={66} placeholder="0x…" className="min-w-0 flex-1 rounded-lg border border-slate-300 p-2 text-xs" />
      <button type="button" onClick={() => { void lookup() }} disabled={busy || value.trim().length === 0} className="rounded-lg border border-slate-300 px-3 py-2 disabled:opacity-50">{busy ? 'Reading…' : 'Look up'}</button>
    </div>
    {result && <article aria-label="Transaction look-up result" className="mt-3 space-y-1 text-sm">
      <p className={`font-semibold ${result.state === 'success' ? 'text-[#2F6E0C]' : result.state === 'reverted' ? 'text-red-700' : 'text-amber-800'}`}>{stateText[result.state]}</p>
      {(result.state === 'success' || result.state === 'reverted') && <>
        <p className="break-all text-xs text-slate-600">From {result.from} · nonce {result.nonce} · block {result.blockNumber}{result.final ? '' : ' · not yet two blocks deep'}</p>
        {result.flows.length > 0 && <p>{result.flows.map(flow => `${flow.symbol}: ${flow.received !== '0' ? `received ${flow.received}` : ''}${flow.received !== '0' && flow.sent !== '0' ? ', ' : ''}${flow.sent !== '0' ? `sent ${flow.sent}` : ''}`).join(' · ')}</p>}
        {result.nativeValue && <p>Native USDC sent with the transaction: {formatUnits(BigInt(result.nativeValue), 18)}</p>}
        {result.fee && <p>Network fee: {formatUnits(BigInt(result.fee), 18)} USDC</p>}
        <p className="text-slate-700">{result.program.summary}</p>
        {result.program.thirdPartyPortions.length > 0 && <ul className="list-disc space-y-1 pl-5 text-xs text-amber-800">{result.program.thirdPartyPortions.map(portion => <li key={portion}>{portion}</li>)}</ul>}
        <a href={ARC_EXECUTION_EXPLORER + result.hash} target="_blank" rel="noopener noreferrer" className="block break-all text-[#2F6E0C] underline">View on Arc Explorer</a>
      </>}
      {result.notRechecked.map(text => <p key={text} className="text-xs text-amber-800">{text}</p>)}
    </article>}
  </details>
}
