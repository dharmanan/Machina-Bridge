// Unified bridge history (Dashboard + Activity): merge, de-duplication and
// statuses over EVM, Solana and Sui records. Pure functions; no network.
// The five Sui <-> Arc rows are the real Mainnet transfers of 2026-10-29/30,
// each re-read from Arc, Sui and Circle before being written down here.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const require = createRequire(import.meta.url), ts = require('typescript')
require.extensions['.ts'] = (m, p) => m._compile(ts.transpileModule(readFileSync(p, 'utf8').replaceAll('import.meta.env', '({})'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, p)
const { buildBridgeHistory, bridgeRouteStats, dedupeBridgeHistory, suiHistoryItem, noteSuiSessionCheck, readSuiSessionChecks } = require('../src/lib/bridgeHistory.ts')
const { REAL_SUI_TRANSFERS, realSuiRecords } = require('./fixtures/real-sui-transfers.cjs')

let count = 0
function test(name, run) { run(); count++; console.log('PASS ' + name) }
const sui = realSuiRecords()
const evm = { id: 'cctp-1-0xaa-3', walletAddress: REAL_SUI_TRANSFERS.evm, sourceChainId: 1, destinationChainId: 5042, amount: '2', token: 'USDC', mode: 'standard', recipient: REAL_SUI_TRANSFERS.evm, destinationCaller: '0x' + '0'.repeat(40), stage: 'complete', approvalRequired: false, createdAt: Date.parse('2026-10-20T10:00:00Z'), updatedAt: Date.parse('2026-10-20T10:30:00Z'), sourceTxHash: '0x' + 'aa'.repeat(32), sourceLogIndex: 3, destinationTxHash: '0x' + 'bb'.repeat(32) }
const solana = { id: 'sol-1', evmWallet: REAL_SUI_TRANSFERS.evm, solanaWallet: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', direction: 'solana-to-arc', amount: '1.5', status: 'complete', createdAt: Date.parse('2026-10-25T08:00:00Z'), sourceTxHash: '5'.repeat(87), destinationTxHash: '0x' + 'cc'.repeat(32) }

test('the five real Sui <-> Arc transfers are five distinct rows with real source and destination explorers', () => {
  const items = buildBridgeHistory({ sui, suiChecks: new Map() })
  assert.equal(items.length, 5)
  assert.deepEqual(items.map(i => `${i.from}->${i.to}`), ['Arc->Sui', 'Sui->Arc', 'Sui->Arc', 'Arc->Sui', 'Arc->Sui'], 'newest first by recorded start time')
  for (const t of REAL_SUI_TRANSFERS.transfers) {
    const row = items.find(i => i.sourceId === (t.direction === 'arc-to-sui' ? t.source.toLowerCase() : t.source))
    assert.ok(row, t.source)
    assert.equal(row.amount, '0.1'); assert.equal(row.status, 'complete'); assert.equal(row.statusLabel, 'Complete')
    assert.equal(row.sourceUrl, t.direction === 'arc-to-sui' ? `https://explorer.arc.io/tx/${t.source.toLowerCase()}` : `https://suiscan.xyz/mainnet/tx/${t.source}`)
    assert.equal(row.destinationUrl, t.direction === 'arc-to-sui' ? `https://suiscan.xyz/mainnet/tx/${t.destination}` : `https://explorer.arc.io/tx/${t.destination}`)
    assert.equal(row.verification, 'saved', 'a stored completion is not presented as verified now')
  }
})
test('EVM, Solana and Sui rows share one list, one time order and per-route completed counts', () => {
  const items = buildBridgeHistory({ evm: [evm], solana: [solana], sui, suiChecks: new Map() })
  assert.equal(items.length, 7)
  assert.deepEqual(items.map(i => i.family), ['sui', 'sui', 'sui', 'sui', 'sui', 'solana', 'evm'])
  assert.deepEqual(bridgeRouteStats(items), [{ label: 'Arc → Sui', count: 3 }, { label: 'Sui → Arc', count: 2 }, { label: 'Ethereum → Arc', count: 1 }, { label: 'Solana → Arc', count: 1 }])
})
test('the same transfer read from two places is counted once; different CCTP event indexes are never merged', () => {
  const one = suiHistoryItem(sui[0], new Map())
  assert.equal(dedupeBridgeHistory([one, { ...one, key: 'copy' }]).length, 1, 'same source + same event index')
  assert.equal(dedupeBridgeHistory([one, { ...one, key: 'other-event', sourceEventIndex: one.sourceEventIndex + 1 }]).length, 2, 'same source tx, different event index')
  const loose = { ...one, key: 'loose', sourceEventIndex: undefined, status: 'in_progress' }
  const merged = dedupeBridgeHistory([loose, one])
  assert.equal(merged.length, 1, 'a row without an index merges into the only indexed row of the same source')
  assert.equal(merged[0].status, 'complete', 'the merged row keeps the furthest known status')
  assert.equal(dedupeBridgeHistory([loose, one, { ...one, key: 'second', sourceEventIndex: 99 }]).length, 3, 'ambiguous: a loose row next to two indexed rows stays separate')
  assert.equal(dedupeBridgeHistory([{ ...one, from: 'Sui', to: 'Arc' }, one]).length, 2, 'other route, same hash text: separate')
  const upper = { ...evm, id: 'upper', sourceTxHash: evm.sourceTxHash.toUpperCase().replace('0X', '0x') }
  assert.equal(buildBridgeHistory({ evm: [evm, upper] }).length, 1, 'EVM hashes compare case-insensitively')
})
test('a status check made on this page marks the row as verified now; nothing else does', () => {
  const r = sui[0]
  assert.equal(suiHistoryItem(r, readSuiSessionChecks()).verification, 'saved')
  noteSuiSessionCheck(r.id, { stage: 'complete', checkedAt: Date.parse('2026-10-30T01:40:00Z') })
  const row = suiHistoryItem(r)
  assert.equal(row.verification, 'session'); assert.equal(row.verifiedAt, Date.parse('2026-10-30T01:40:00Z'))
})
test('statuses are named the same way for every family; unknown outcomes are not shown as complete', () => {
  const waiting = suiHistoryItem({ ...sui[0], stage: 'waiting_attestation', destinationTx: undefined }, new Map())
  assert.deepEqual([waiting.status, waiting.statusLabel], ['in_progress', 'Waiting for Circle'])
  const ready = suiHistoryItem({ ...sui[0], stage: 'ready_to_mint', destinationTx: undefined }, new Map())
  assert.deepEqual([ready.status, ready.statusLabel], ['action', 'Ready to receive'])
  const [unknownSolana] = buildBridgeHistory({ solana: [{ ...solana, status: 'unknown', destinationTxHash: undefined }] })
  assert.deepEqual([unknownSolana.status, unknownSolana.statusLabel], ['unknown', 'Outcome unverified'])
  const [evmMint] = buildBridgeHistory({ evm: [{ ...evm, stage: 'ready_to_mint', destinationTxHash: undefined }] })
  assert.deepEqual([evmMint.status, evmMint.statusLabel, evmMint.destinationUrl], ['action', 'Ready to receive', undefined])
})
test('records saved before start times existed show their last check time, labelled as such', () => {
  const { createdAt, ...old } = sui[0]
  const row = suiHistoryItem(old, new Map())
  assert.equal(row.timestampKind, 'checked'); assert.equal(row.timestamp, old.checkedAt)
})
console.log(`RESULT ${count}/${count} unified bridge history groups PASS; 5 real Sui <-> Arc transfers, EVM and Solana rows; no network.`)
