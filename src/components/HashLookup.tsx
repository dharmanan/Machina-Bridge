import { useState } from 'react'
import { formatUnits } from 'viem'
import { ARC_EXECUTION_EXPLORER } from '../lib/uniswapArcExecution'
import { inspectHash, type HashInspection } from '../lib/swap/hashLookup'

// Read-only: look up any Arc transaction by its hash, for example when the saved record of a swap is missing. It says in plain words what
// the network shows and what could not be checked; the technical findings (sender, nonce, block, the contract program) are in a closed
// "Technical details" disclosure. Nothing is saved and nothing is ever marked as verified against a swap the user reviewed.
export function HashLookup() {
  const [value, setValue] = useState(''), [busy, setBusy] = useState(false), [result, setResult] = useState<HashInspection | null>(null)
  async function lookup() {
    if (busy) return
    setBusy(true); setResult(null)
    try { setResult(await inspectHash(value)) } catch { setResult({ hash: value as `0x${string}`, state: 'unreadable', final: false, flows: [], program: { kind: 'none', summary: '', thirdPartyPortions: [] }, notRechecked: [] }) }
    finally { setBusy(false) }
  }
  const stateText: Record<HashInspection['state'], string> = {
    invalid: 'That is not a transaction hash.', not_found: 'Arc doesn’t know this transaction (yet).', pending: 'This transaction is still being processed.',
    success: 'This transaction succeeded on Arc.', reverted: 'This transaction failed on Arc.', unreadable: 'Arc couldn’t be read just now, or this isn’t an Arc Mainnet transaction. This says nothing about the transaction.',
  }
  const moved = (flow: HashInspection['flows'][number]) => [flow.received !== '0' ? `received ${flow.received} ${flow.symbol}` : '', flow.sent !== '0' ? `sent ${flow.sent} ${flow.symbol}` : ''].filter(Boolean).join(', ')
  return <details aria-label="Look up a transaction" className="rounded-xl border border-slate-100 p-3">
    <summary className="cursor-pointer font-medium text-slate-800">Look up a transaction</summary>
    <p className="mt-2 text-xs text-slate-500">Paste a transaction hash to see what happened on Arc. This only reads; nothing is sent or saved.</p>
    <div className="mt-2 flex gap-2">
      <input aria-label="Transaction hash to look up" value={value} onChange={event => setValue(event.target.value)} maxLength={66} placeholder="0x…" className="min-w-0 flex-1 rounded-lg border border-slate-300 p-2 text-xs" />
      <button type="button" onClick={() => { void lookup() }} disabled={busy || value.trim().length === 0} className="rounded-lg border border-slate-300 px-3 py-2 disabled:opacity-50">{busy ? 'Reading…' : 'Look up'}</button>
    </div>
    {result && <article aria-label="Transaction look-up result" className="mt-3 space-y-1 text-sm">
      <p className={`font-semibold ${result.state === 'success' ? 'text-[#2F6E0C]' : result.state === 'reverted' ? 'text-red-700' : 'text-amber-800'}`}>{stateText[result.state]}</p>
      {(result.state === 'success' || result.state === 'reverted') && <>
        {result.flows.length > 0 && <p>{result.flows.map(flow => moved(flow)).filter(Boolean).join(' · ')}</p>}
        {result.nativeValue && <p>USDC sent with the transaction: {formatUnits(BigInt(result.nativeValue), 18)}</p>}
        {result.fee && <p>Network fee: {formatUnits(BigInt(result.fee), 18)} USDC</p>}
        {!result.final && <p className="text-xs text-slate-600">It was just included; the result is final after one more block.</p>}
        {result.program.thirdPartyPortions.length > 0 && <div role="note" className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          <p className="font-medium">Part of the amount went to another address</p>
          <ul className="list-disc pl-5">{result.program.thirdPartyPortions.map(portion => { const pct = /^([0-9.]+)%/.exec(portion)?.[1]; return <li key={portion}>{pct ? `${pct}% of the amount received was taken as a fee by another address.` : 'A fee was taken by another address.'}</li> })}</ul>
        </div>}
        <p className="text-xs text-slate-600">This transaction isn’t among the swaps saved in this browser, so it can’t be compared with a swap you reviewed. Only what the network shows is listed.</p>
        <a href={ARC_EXECUTION_EXPLORER + result.hash} target="_blank" rel="noopener noreferrer" className="block text-[#2F6E0C] underline">View on Arc Explorer</a>
        <details className="text-xs text-slate-500"><summary className="cursor-pointer">Technical details</summary>
          <ul className="mt-1 space-y-1 break-all">
            <li>Transaction: {result.hash}</li><li>From {result.from} · nonce {result.nonce} · block {result.blockNumber}{result.final ? '' : ' · not yet two blocks deep'}</li>
            <li>{result.program.summary}</li>{result.program.thirdPartyPortions.map(portion => <li key={portion}>fee portion: {portion}</li>)}{result.notRechecked.map(text => <li key={text}>{text}</li>)}
          </ul></details>
      </>}
    </article>}
  </details>
}
