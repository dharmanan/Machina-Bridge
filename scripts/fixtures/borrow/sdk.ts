// Browser-only controlled replay of the real SDK boundary; never imported by the application.
import { BorrowKit } from '@circle-fin/borrow-kit'
import { BorrowServiceProvider } from '@circle-fin/provider-borrow-service'
import * as v from 'viem'
import { encodeAbiParameters, encodeFunctionResult, parseAbiParameters, decodeFunctionData, parseAbi, encodeEventTopics } from 'viem'
import * as f from './operations'
import * as b from './batch'
import * as t from '../../../src/lib/borrowSdkTransport'
import * as r from '../../../src/lib/borrowRecovery'
import * as policy from '../../../src/lib/borrowBatchPolicy'
import * as safety from '../../../src/lib/borrowWriteSafety'
const BLUE = '0x34cd04070dd72b14e241112f6d83812df5af7fcd', ADAPTER = '0x7FB8c7260b63934d8da38aF902f87ae6e284a845'
const HASH = '0x' + 'aa'.repeat(32), BLOCK = '0x' + 'bb'.repeat(32), owner = f.WALLET
const stateAbi = parseAbi(['function price() view returns(uint256)', 'function accrueInterest((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) params)', 'function isAuthorized(address owner,address authorized) view returns(bool)'])
let external = 0
const assert = { equal(a, b) { if (a !== b) throw Error('SDK replay fixture invariant failed') }, ok(value) { if (!value) throw Error('SDK replay fixture invariant failed') } }
export async function setupSdk(kind = 'borrow', initialMode = '') {
  let mode = initialMode
  const callbacks = { walletRequested: null as null | (() => void), prepared: null as null | ((d: any) => void) }
  const built = await f.build(kind, d => { if (mode === 'full-repay') { d.action.repayAmount = '1000.25'; d.response.repayAmount.amount = '1000.25' } }), now = Date.now(); built.context.quote.fetchedAt = now
  const review = { action: built.action, prepared: built.context.quote, evidence: built.context.evidence, wallet: built.context.wallet, expiresAt: now + 60000, actionId: safety.borrowActionId(built.action, owner), maxGasCostWei: 10n ** 18n }
  const x = b.batchFixture(kind, now, review.prepared)
  const before = { collateral: kind === 'borrow' ? 0n : 5000000n, debtShares: kind === 'borrow' ? 0n : 1000250000000000n }
  const borrowShares = x.review.borrowAssets * 1000000n, repayAssets = kind === 'close-loan' ? before.debtShares / 1000000n : x.review.repayAssets
  const repayShares = kind === 'close-loan' ? before.debtShares : repayAssets * 1000000n
  if (kind === 'close-loan' || mode === 'full-repay') { x.review.repayShares = before.debtShares; const leg = x.params.instructions[0]; leg.data = v.encodeFunctionData({ abi: policy.BORROW_MORPHO_ABI, functionName: 'repay', args: [x.review.market, 0n, before.debtShares, owner, '0x'] }) }
  const after = { collateral: before.collateral + x.review.collateralIn - x.review.collateralOut, debtShares: before.debtShares + borrowShares - repayShares }
  const walletRequests = [], persisted = [], storage = f.fakeStorage(), store = r.createBorrowRecoveryStore(storage, owner); let currentBound, mined = false, hashCallbacks = 0
  const block = { number: 100n, hash: BLOCK, timestamp: BigInt(Math.floor(now / 1000)), baseFeePerGas: 25000000000n }
  const request = async ({ method, params }) => {
    walletRequests.push({ method, params })
    if (method === 'eth_chainId') return '0x13b2'
    if (method === 'eth_accounts') return [owner]
    if (method === 'wallet_getCapabilities') {
      if (mode === 'atomic-wallet') return { '0x13b2': { atomic: { status: 'supported' } } }
      throw Object.assign(Error('unsupported'), { code: 4200 })
    }
    if (method === 'eth_getTransactionCount') return mode === 'wallet-nonce' ? '0x8' : '0x7'
    if (method === 'eth_sendTransaction') { if (mode === 'reject') throw Object.assign(Error('declined'), { code: 4001 }); mined = true; return HASH }
    throw Error('Unexpected wallet method ' + method)
  }
  const price = 8140086n * 10n ** 32n
  const rpc = {
    getChainId: async () => 5042, getBlock: async ({ blockNumber } = {}) => ({ ...block, number: blockNumber ?? 100n, hash: mode === 'reorg' ? '0x' + 'dd'.repeat(32) : blockNumber === 101n ? '0x' + 'cc'.repeat(32) : BLOCK }), getBlockNumber: async () => 102n,
    getCode: async ({ address }) => address.toLowerCase() === owner.toLowerCase() ? '0x' : '0x6000',
    getBalance: async () => mode === 'balance' ? 0n : 10n ** 25n, getGasPrice: async () => mode === 'fee' ? 10n ** 20n : 25000000000n,
    getTransactionCount: async () => mode === 'pending' ? 8 : 7,
    readContract: async ({ functionName, address, blockNumber }) => {
      if (functionName === 'allowance') return 0n
      if (functionName === 'decimals') return address.toLowerCase() === x.review.market.loanToken.toLowerCase() ? 6 : 8
      if (functionName === 'isAuthorized') return false
      if (functionName === 'balanceOf') return 10n ** 25n
      if (functionName === 'position') return [0n, before.debtShares, before.collateral]
      if (functionName === 'market') return [10n ** 14n, 10n ** 20n, 10n ** 12n, 10n ** 18n, block.timestamp, 0n]
      if (functionName === 'price') return price
      throw Error('Unexpected read ' + functionName)
    },
    call: async ({ data, blockNumber }) => {
      assert.ok(blockNumber === 100n || blockNumber === 101n)
      if (mode === 'simulation') throw Error('signed execution reverted')
      const decoded = decodeFunctionData({ abi: t.BORROW_AGGREGATE_ABI, data }), calls = decoded.args[0]
      const returns = calls.map((c, i) => {
        if (c.callData.startsWith('0x5c60da1b')) throw Error('Unexpected implementation')
        const selector = c.callData.slice(0, 10)
        for (const [abi, functionName, value] of [[t.BORROW_CHAIN_ABI, 'market', [10n ** 14n, 10n ** 20n, 10n ** 12n, 10n ** 18n, block.timestamp, 0n]], [t.BORROW_CHAIN_ABI, 'position', [0n, mode === 'reverted' ? before.debtShares : after.debtShares, mode === 'reverted' ? before.collateral : after.collateral]], [stateAbi, 'price', price], [stateAbi, 'isAuthorized', false]]) {
          const name = v.toFunctionSelector(abi.find(a => a.name === functionName))
          if (selector === name) return { success: true, returnData: encodeFunctionResult({ abi, functionName, result: value }) }
        }
        return { success: true, returnData: '0x' }
      })
      return { data: encodeFunctionResult({ abi: t.BORROW_AGGREGATE_ABI, functionName: 'aggregate3', result: returns }) }
    },
    estimateGas: async ({ blockNumber }) => { if (blockNumber !== undefined) assert.equal(blockNumber, 100n); return 400000n },
    waitForTransactionReceipt: async () => { if (mode === 'timeout') throw Error('controlled timeout'); return { status: 'success', logs: [] } },
  }
  const transport = t.createBorrowSdkTransport({ review, request, client: rpc, isCurrent: () => mode !== 'context-changed', walletRequested: () => callbacks.walletRequested?.(), prepared: d => callbacks.prepared?.(d), persist: record => { if (mode === 'storage-after-hash' && record.txHash) throw Error('controlled storage failure'); store.save(record); currentBound = structuredClone(record); persisted.push(currentBound) }, submitted: h => { hashCallbacks++; assert.equal(h, HASH) } })
  const signed = { loanId: '11111111-1111-4111-8111-111111111111', chain: 'Arc', executionParams: x.params, signature: '0x' + '11'.repeat(65) }
  const client = new BorrowKit({ disableAnalytics: true, disableErrorReporting: true, providers: [new BorrowServiceProvider()] })
  const serviceRequests = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url)); serviceRequests.push(u.pathname)
    if (u.hostname !== 'api.circle.com' || !u.pathname.startsWith('/v1/borrowKit/loans/')) { external++; throw Error('Unexpected service endpoint') }
    if (!u.pathname.endsWith('/quote')) {
      if (!/\/(borrow|repay|closeLoan|addCollateral|withdrawCollateral)$/.test(u.pathname)) { external++; throw Error('Unexpected signed endpoint') }
      const data = { ...signed, chain: 'ARC', execId: '1', fees: [] }
      if (kind === 'withdraw-collateral') delete data.chain
      return new Response(JSON.stringify({ data }, (_k, v) => typeof v === 'bigint' ? v.toString() : v), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const quote = { ...structuredClone(f.RESPONSES[kind]), chain: 'ARC' }, native = amount => ({ token: 'USDC', tokenAddress: x.review.market.loanToken, amount, decimals: 18 })
    if (mode === 'full-repay') quote.repayAmount.amount = '1000.25'
    quote.gasFees = ['Approve', 'Borrow', 'Repay', 'CloseLoan', 'SupplyCollateral', 'WithdrawCollateral'].map(name => ({ name, fees: { gas: '400000', gasPrice: native('0.000000025'), fee: native('0.01') } }))
    if (quote.bundledRepayment) quote.repayAmount = quote.bundledRepayment
    return new Response(JSON.stringify({ data: quote }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const run = async () => {
    const from = { chain: 'Arc', adapter: transport.adapter }
    try {
      if (kind === 'borrow' || kind === 'borrow-more') return await client.borrow({ from, ...(kind === 'borrow' ? { marketId: x.review.marketId } : { loanId: signed.loanId }), borrowAmount: '1000' })
      if (kind === 'repay') return await client.repay({ from, loanId: signed.loanId, repayAmount: review.action.repayAmount })
      if (kind === 'close-loan') return await client.closeLoan({ from, loanId: signed.loanId })
      if (kind === 'add-collateral') return await client.addCollateral({ from, loanId: signed.loanId, collateralAmount: '0.01' })
      return await client.withdrawCollateralRepayIfNeeded({ from, loanId: signed.loanId, collateralAmount: '0.01' })
    } finally { globalThis.fetch = previousFetch }
  }
  return { callbacks, serviceRequests, storage, store, hashCallbacks: () => hashCallbacks, setMode: m => { mode = m }, borrowShares, repayShares, repayAssets, run, transport, walletRequests, persisted, getBound: () => currentBound, x, rpc, request, before, after, review, mined: () => mined }
}
export function attachSdkReceipt(s, status = 'success') {
  const record = s.getBound(), tx = s.walletRequests.find(x => x.method === 'eth_sendTransaction').params[0], logs = []
  const event = (address, name, args) => {
    const abi = r.BORROW_RECOVERY_ABI, def = abi.find(x => x.name === name)
    logs.push({ address, topics: encodeEventTopics({ abi, eventName: name, args }), data: encodeAbiParameters(def.inputs.filter(x => !x.indexed), def.inputs.filter(x => !x.indexed).map(x => args[x.name])), logIndex: logs.length, removed: false, transactionHash: HASH, blockNumber: 101n, blockHash: '0x' + 'cc'.repeat(32) })
  }
  const base = { id: record.terms.marketId, caller: ADAPTER, onBehalf: owner, receiver: ADAPTER }
  if (status === 'success') {
    if (record.terms.collateralIn) event(BLUE, 'SupplyCollateral', { ...base, assets: record.terms.collateralIn })
    if (record.terms.borrowAssets) event(BLUE, 'Borrow', { ...base, assets: record.terms.borrowAssets, shares: s.borrowShares })
    if (record.terms.repayAssets) event(BLUE, 'Repay', { ...base, assets: s.repayAssets, shares: s.repayShares })
    if (record.terms.collateralOut) event(BLUE, 'WithdrawCollateral', { ...base, assets: record.terms.collateralOut })
    const transfer = (token, from, to, value) => { if (value) event(token, 'Transfer', { from, to, value }) }
    transfer(record.terms.market.collateralToken, owner, ADAPTER, record.terms.collateralIn)
    transfer(record.terms.market.collateralToken, ADAPTER, owner, record.terms.collateralOut)
    transfer(record.terms.market.loanToken, owner, ADAPTER, record.terms.repayAssets)
    transfer(record.terms.market.loanToken, ADAPTER, owner, record.terms.repayAssets - s.repayAssets)
    transfer(record.terms.market.loanToken, ADAPTER, owner, record.terms.borrowAssets)
  }
  const receipt = { from: owner, to: t.BORROW_BATCHER, transactionHash: HASH, blockNumber: 101n, blockHash: '0x' + 'cc'.repeat(32), gasUsed: 300000n, effectiveGasPrice: 25000000000n, status, logs }
  s.rpc.getTransactionReceipt = async () => receipt
  s.rpc.getTransaction = async () => ({ hash: HASH, blockNumber: 101n, blockHash: '0x' + 'cc'.repeat(32), from: owner, to: tx.to, input: tx.data, gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas), chainId: 5042, value: 0n, nonce: 7 })
  return { record, receipt }
}
