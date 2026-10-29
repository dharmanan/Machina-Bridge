import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions'
import { fromBase64, normalizeStructTag, toBase64 } from '@mysten/sui/utils'
import { verifyTransactionSignature } from '@mysten/sui/verify'
import type { Wallet, WalletAccount, SuiSignTransactionFeature } from '@mysten/wallet-standard'
import { decodeEventLog, decodeFunctionData, parseAbiItem, stringToHex, encodeFunctionData, formatUnits, hexToBytes, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, serializeTransaction, toHex, type Hex, type TransactionSerialized } from 'viem'
import { MAINNET_ARC_WALLET_SEND_ENABLED, SUI_NETWORKS } from '../config/sui'
import { SUI_MAINNET_V2_REFERENCE as R } from '../config/mainnetSui'
import { CCTP_V2_ERC20_ABI, CCTP_V2_TOKEN_MESSENGER_ABI, CCTP_V2_MESSAGE_TRANSMITTER_ABI, getMainnetCctpChain } from '../config/mainnetCctp'
import { cctpRecoveryClient, cctpWord, decodeCctpRecoveryMessage, readBoundCctpAttestation, readCctpBurnProof, CCTP_RECOVERY_ABI } from './mainnetCctpRecovery'
import { createSuiMainnetReadPort, readSuiMainnetIdentity, readSuiBurnProof, readSuiNonceStatus, readCheckpointedSuiTransaction, type SuiMainnetReadPort, type SuiMainnetIdentity } from './mainnetSuiRead'
import { buildSuiToArcBurn, buildArcToSuiMint, type SuiCctpV2Deployment } from './suiCctpTransactions'
import { parseSuiBalance, validateSuiWalletAccount } from './suiBalances'
import { assertSuiTestAmount, browserSuiWriteEnvironment, createSuiWriteController, SuiWriteNotRequested, SuiWriteSignatureRejected, type SuiArcExpected, type SuiWriteIntent, type SuiWritePort, type SuiWriteAttempt } from './mainnetSuiExecution'
import { importSuiRecovery } from './mainnetSuiQueue'

const arc = getMainnetCctpChain(5042)!
const same = (a: string | undefined | null, b: string | undefined | null) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const key = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x)
const uint = (x: unknown): bigint => { if (typeof x !== 'string' || !/^(0|[1-9][0-9]*)$/.test(x) || x.length > 78) throw new Error('Missing canonical unsigned chain quantity.'); return BigInt(x) }
const quantity = (x: unknown, pending = false): bigint => {
  if (pending && typeof x === 'number' && Number.isSafeInteger(x) && x >= 0) return BigInt(x)
  if (typeof x !== 'string' || x.length > 66 || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(x)) throw new Error('Wallet returned an invalid chain quantity.')
  return BigInt(x)
}
// Official circlefin/evm-cctp-contracts src/v2/{MessageTransmitterV2,
// BaseTokenMessenger}.sol. V2 MintAndWithdraw includes feeCollected.
const MINT_ABI = parseAbi([
  'event MessageReceived(address indexed caller,uint32 sourceDomain,bytes32 indexed nonce,bytes32 sender,uint32 indexed finalityThresholdExecuted,bytes messageBody)',
  'event MintAndWithdraw(address indexed mintRecipient,uint256 amount,address indexed mintToken,uint256 feeCollected)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
])
export function verifyArcSuiMintReceipt(receipt: any, message: Hex, owner: string) {
  const m = decodeCctpRecoveryMessage(message), received: any[] = [], minted: any[] = [], transfers: any[] = []
  if (m.sourceDomain !== 8 || m.destinationDomain !== 26 || !same(m.mintRecipient, cctpWord(owner)) || !same(m.recipient, cctpWord(arc.tokenMessengerAddress))) throw new Error('Arc mint message is not bound to this recipient/deployment.')
  if (!Array.isArray(receipt.logs) || receipt.logs.length > 256) throw new Error('Arc receipt log count is unsupported.')
  for (const log of receipt.logs) {
    if (log.removed || log.transactionHash !== receipt.transactionHash || log.blockHash !== receipt.blockHash || log.blockNumber !== receipt.blockNumber) throw new Error('Arc mint log is removed or misattributed.')
    try {
      const d = decodeEventLog({ abi: MINT_ABI, data: log.data, topics: log.topics })
      if (d.eventName === 'MessageReceived' && same(log.address, arc.messageTransmitterAddress)) received.push(d.args)
      if (d.eventName === 'MintAndWithdraw' && same(log.address, arc.tokenMessengerAddress)) minted.push(d.args)
      if (d.eventName === 'Transfer' && same(log.address, arc.usdcAddress) && same(d.args.to, owner)) transfers.push(d.args)
    } catch { /* Unrelated logs are not mint evidence. */ }
  }
  if (received.length !== 1 || minted.length !== 1 || !same(received[0].caller, owner) || received[0].sourceDomain !== 8 || !same(received[0].nonce, m.nonce) || !same(received[0].sender, m.sender) || received[0].finalityThresholdExecuted !== m.executedFinality || !same(received[0].messageBody, `0x${message.slice(2 + 148 * 2)}`) || !same(minted[0].mintRecipient, owner) || !same(minted[0].mintToken, arc.usdcAddress) || minted[0].amount !== m.amount - m.feeExecuted || minted[0].feeCollected !== m.feeExecuted || transfers.reduce((n, t) => n + t.value, 0n) !== m.amount - m.feeExecuted || transfers.some(t => !/^0x0{40}$/i.test(t.from))) throw new Error('Arc receipt has no unique matching CCTP message, fee and actual USDC mint transfer.')
}
// Human-readable lines decoded from the EXACT bytes whose keccak commitment the
// review carries. Derived locally; nothing here comes from a wallet or RPC.
export function describeSuiWriteBytes(action: SuiWriteIntent['action'], bytes: Uint8Array): string[] {
  const short = (a: unknown) => typeof a === 'string' && a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : String(a)
  if (action.startsWith('sui-')) {
    const d = Transaction.from(bytes).getData(), g = d.gasData, ex = d.expiration
    const lines = [
      `Sui Mainnet transaction from ${d.sender}`,
      `Gas: budget ${formatUnits(BigInt(String(g.budget)), 9)} SUI at ${g.price} MIST, paid by ${g.payment?.length ? `${g.payment.length} SUI coin(s)` : 'the sender address balance'} (owner ${short(g.owner)})`,
      ex?.$kind === 'ValidDuring' ? `Valid only in Sui epochs ${ex.ValidDuring.minEpoch}–${ex.ValidDuring.maxEpoch}` : `Expiration: ${ex?.$kind ?? 'none'}`,
    ]
    d.commands.forEach((c, n) => lines.push(c.$kind === 'MoveCall' ? `${n + 1}. ${short(c.MoveCall.package)}::${c.MoveCall.module}::${c.MoveCall.function}` : `${n + 1}. ${c.$kind}`))
    return lines
  }
  const t = parseTransaction(toHex(bytes) as TransactionSerialized)
  const abi = [...CCTP_V2_ERC20_ABI, ...CCTP_V2_TOKEN_MESSENGER_ABI, ...CCTP_V2_MESSAGE_TRANSMITTER_ABI]
  const call = decodeFunctionData({ abi, data: t.data! }) as { functionName: string; args: readonly unknown[] }
  const args = call.functionName === 'approve' ? `spender ${short(call.args[0])}, exactly ${formatUnits(call.args[1] as bigint, 6)} USDC`
    : call.functionName === 'depositForBurn' ? `${formatUnits(call.args[0] as bigint, 6)} USDC to domain ${call.args[1]}, recipient ${short(call.args[2])}, max fee ${formatUnits(call.args[5] as bigint, 6)} USDC, finality ${call.args[6]}`
    : call.functionName === 'receiveMessage' ? `message ${short(call.args[0])}, attestation ${short(call.args[1])}` : 'unrecognised call'
  return [
    `Arc Mainnet (chain ${t.chainId}) call to ${t.to}`,
    `${call.functionName}: ${args}`,
    `Nonce ${t.nonce}, gas limit ${t.gas}, max fee per gas ${formatUnits(t.maxFeePerGas!, 18)} USDC`,
  ]
}

export type SuiWriteWallets = {
  // Getters must read the CURRENT connected Wallet Standard/wagmi identities,
  // not a captured account from the beginning of a wallet popup.
  sui(): { wallet: Wallet; account: WalletAccount } | null
  evm(): { request(args: { method: string; params?: unknown[] }): Promise<unknown> } | null
  current(intent: SuiWriteIntent): boolean
}
type CacheEntry = { i: SuiWriteIntent; identity: SuiMainnetIdentity; message?: Hex; attestation?: Hex; epoch?: bigint; nonce?: number; validityNonce?: number }
// allowWalletSend exists for controlled tests only; production uses the constant.
type Dependencies = { sui?: SuiGrpcClient; arc?: any; read?: () => SuiMainnetReadPort; fetcher?: typeof fetch; allowWalletSend?: boolean; paceMs?: number }
const APPROVAL_EVENT = parseAbiItem('event Approval(address indexed owner, address indexed spender, uint256 value)')
// Every effect a mismatch may have and still be reconcilable. Emitters/events
// observed in real Arc Mainnet CCTP receipts (2026-10-29): USDC Transfer/Burn/
// Mint/Approval, TokenMessenger DepositForBurn/MintAndWithdraw, MessageTransmitter
// MessageSent/MessageReceived, and Arc's native-gas system Transfer mirror.
const ARC_NATIVE_SYSTEM = '0xfffffffffffffffffffffffffffffffffffffffe'
const EFFECT_ABI = [...MINT_ABI, APPROVAL_EVENT, ...parseAbi(['event Burn(address indexed burner,uint256 amount)', 'event Mint(address indexed minter,address indexed to,uint256 amount)']), ...CCTP_RECOVERY_ABI.filter(e => e.type === 'event')]
// Arc has deterministic finality (Malachite BFT: a committed block is final,
// no reorgs, per docs.arc.network). This buffer is NOT a protocol requirement;
// it is Machina's operational margin so a lagging or inconsistent public RPC
// node cannot hand us a receipt its own head does not yet include.
const RECONCILE_DEPTH = 12n
// A successful mismatch is reconcilable only if the call itself is one of the
// three reviewed CCTP/USDC calls: then known contract code bounds its outcome.
// Logs alone prove nothing about a foreign target (a zero-log call passes them).
const RECONCILE_CALLS = {
  approve: { target: arc.usdcAddress, effects: [[arc.usdcAddress, 'Approval']], key: 'Approval' },
  depositForBurn: { target: arc.tokenMessengerAddress, effects: [[arc.usdcAddress, 'Transfer'], [arc.usdcAddress, 'Burn'], [ARC_NATIVE_SYSTEM, 'Transfer'], [arc.messageTransmitterAddress, 'MessageSent'], [arc.tokenMessengerAddress, 'DepositForBurn']], key: 'DepositForBurn' },
  receiveMessage: { target: arc.messageTransmitterAddress, effects: [[arc.usdcAddress, 'Transfer'], [arc.usdcAddress, 'Mint'], [ARC_NATIVE_SYSTEM, 'Transfer'], [arc.tokenMessengerAddress, 'MintAndWithdraw'], [arc.messageTransmitterAddress, 'MessageReceived']], key: 'MessageReceived' },
} as const
const RECONCILE_ABI = [...CCTP_V2_ERC20_ABI, ...CCTP_V2_TOKEN_MESSENGER_ABI, ...CCTP_V2_MESSAGE_TRANSMITTER_ABI]
function boundedArcCall(tx: { to?: string | null; input: Hex; value: bigint }) {
  const locked = (why: string) => new Error(`${why} The transfer stays locked.`)
  let d: { functionName: string; args: readonly unknown[] }
  try { d = decodeFunctionData({ abi: RECONCILE_ABI, data: tx.input }) as { functionName: string; args: readonly unknown[] } } catch { throw locked('The mismatched call is not a known CCTP/USDC function.') }
  const call = RECONCILE_CALLS[d.functionName as keyof typeof RECONCILE_CALLS]
  if (!call || !tx.to || !same(tx.to, call.target)) throw locked('The mismatched call targets an unexpected contract for its function.')
  // Canonical encoding only: no trailing bytes or alternative encodings.
  if (encodeFunctionData({ abi: RECONCILE_ABI, functionName: d.functionName as never, args: d.args as never }).toLowerCase() !== tx.input.toLowerCase()) throw locked('The mismatched calldata is not canonically encoded.')
  if (tx.value !== 0n) throw locked('The mismatched call carried native value.')
  if (d.functionName === 'approve' && !same(d.args[0] as string, arc.tokenMessengerAddress)) throw locked('The mismatched approval names an unexpected spender.')
  if (d.functionName === 'depositForBurn' && !same(d.args[3] as string, arc.usdcAddress)) throw locked('The mismatched burn names an unexpected token.')
  return { name: d.functionName as keyof typeof RECONCILE_CALLS, args: d.args, call }
}

function deployment(i: SuiMainnetIdentity): SuiCctpV2Deployment {
  return { mtPackage: R.mtPackage, tmmPackage: R.tmmPackage, handlerPackage: R.handlerPackage, mtState: R.mtState, tmmState: R.tmmState, handlerState: R.handlerState, treasury: R.treasury, mtOriginalPackage: i.mtOriginalPackage, tmmOriginalPackage: i.tmmOriginalPackage, inboundAuthRecipient: i.inboundAuthRecipient }
}
function identityKey(i: SuiMainnetIdentity) {
  return key([i.mtOriginalPackage, i.tmmOriginalPackage, i.inboundAuthRecipient, i.nonceTable, i.mtState.type, i.tmmState.type, i.handlerState.type, i.depositType, i.mintType, i.tokenIdentifier])
}
export function createSuiMainnetWritePort(wallets: SuiWriteWallets, deps: Dependencies = {}): SuiWritePort {
  const sui = deps.sui ?? new SuiGrpcClient({ network: 'mainnet', baseUrl: SUI_NETWORKS.mainnet.url, timeout: 10_000 })
  const evm = deps.arc ?? cctpRecoveryClient(arc.rpcUrls), read = deps.read ?? createSuiMainnetReadPort
  const cache = new Map<string, CacheEntry>()
  const ensure = (i: SuiWriteIntent) => { if (!wallets.current(i)) throw new Error('Wallet, chain or transfer context changed.') }
  function suiAccount(i: SuiWriteIntent) {
    const w = wallets.sui()
    if (!w || validateSuiWalletAccount(w.account, 'mainnet') !== i.suiOwner.toLowerCase() || !w.wallet.accounts.some(a => a === w.account)) throw new Error('Reconnect the reviewed Sui Mainnet account.')
    const feature = w.wallet.features['sui:signTransaction'] as SuiSignTransactionFeature['sui:signTransaction'] | undefined
    if (!feature || feature.version !== '2.0.0') throw new Error('This Sui wallet cannot sign reviewed bytes separately from execution. No sign-and-execute fallback is allowed.')
    return { ...w, feature }
  }
  async function sourceMessage(i: SuiWriteIntent, identity: SuiMainnetIdentity, port: SuiMainnetReadPort) {
    const proof = i.action === 'sui-mint'
      ? await readCctpBurnProof({ sourceChainId: 5042, sourceTxHash: i.sourceId!, owner: i.evmOwner, mintRecipients: [i.suiOwner], suiDestinationMessenger: identity.inboundAuthRecipient }, evm)
      : await readSuiBurnProof({ digest: i.sourceId!, suiOwner: i.suiOwner, evmOwner: i.evmOwner }, identity, port)
    if (proof.fields.amount !== i.amount || proof.fields.maxFee !== i.maxCctpFee) throw new Error('Source amount or Circle maximum fee differs from the review.')
    const a = await readBoundCctpAttestation(proof, deps.fetcher)
    if (a.status !== 'complete') throw new Error('Circle attestation is not complete. No mint can be prepared.')
    const m = decodeCctpRecoveryMessage(a.message!)
    if (m.minFinality !== 2000 || m.executedFinality < 2000 || m.feeExecuted > i.maxCctpFee || m.feeExecuted >= i.amount) throw new Error('Circle finality or fee exceeds the reviewed policy.')
    return { message: a.message!, attestation: a.attestation! }
  }
  async function walletNonce(i: SuiWriteIntent) {
    ensure(i)
    const provider = wallets.evm(); if (!provider) throw new Error('Arc wallet provider is unavailable.')
    const check = async () => {
      const chain = quantity(await provider.request({ method: 'eth_chainId' }))
      const accounts = await provider.request({ method: 'eth_accounts' })
      if (chain !== 5042n || !Array.isArray(accounts) || !accounts.some(a => typeof a === 'string' && same(a, i.evmOwner))) throw new Error('Arc wallet account or network changed.')
    }
    await check()
    // Keep each provider's latest -> pending -> latest ordering intact.
    const wallet = (async () => {
      const a = quantity(await provider.request({ method: 'eth_getTransactionCount', params: [i.evmOwner, 'latest'] }))
      const b = quantity(await provider.request({ method: 'eth_getTransactionCount', params: [i.evmOwner, 'pending'] }), true)
      const c = quantity(await provider.request({ method: 'eth_getTransactionCount', params: [i.evmOwner, 'latest'] }))
      if (a !== b || a !== c || a > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Wallet has a pending transaction or unstable nonce.')
      return Number(a)
    })()
    const publicNonce = (async () => {
      if (await evm.getChainId() !== 5042) throw new Error('Public RPC is not Arc Mainnet.')
      const a = await evm.getTransactionCount({ address: i.evmOwner, blockTag: 'latest' })
      const b = await evm.getTransactionCount({ address: i.evmOwner, blockTag: 'pending' })
      const c = await evm.getTransactionCount({ address: i.evmOwner, blockTag: 'latest' })
      if (![a,b,c].every(x => Number.isSafeInteger(x) && x >= 0) || a !== b || a !== c) throw new Error('Arc public RPC has a pending transaction or unstable nonce.')
      return a as number
    })()
    const [a,b] = await Promise.all([wallet, publicNonce]); await check(); ensure(i)
    if (a !== b) throw new Error('Arc public and wallet nonces disagree. No fallback or automatic nonce correction is allowed.')
    return a
  }
  async function arcSnapshot() {
    if (await evm.getChainId() !== 5042) throw new Error('Wrong Arc chain.')
    const b = await evm.getBlock()
    if (typeof b.number !== 'bigint' || !/^0x[0-9a-f]{64}$/i.test(b.hash ?? '')) throw new Error('Arc canonical snapshot unavailable.')
    return b
  }
  async function checkArc(i: SuiWriteIntent, tx: any, e: CacheEntry) {
    const nonce = await walletNonce(i)
    if (nonce !== tx.nonce) throw new Error('Arc nonce changed since review.')
    const b = await arcSnapshot(), blockNumber = b.number
    const [code, balance] = await Promise.all([evm.getCode({ address: tx.to, blockNumber }), evm.getBalance({ address: i.evmOwner, blockNumber })])
    if (!code || code === '0x' || balance < tx.gas * tx.maxFeePerGas) throw new Error('Arc contract or native USDC gas balance is unavailable.')
    // Viem omits a zero RLP value when parsing; absence here means encoded zero,
    // not an unknown RPC field (the input is our locally serialized envelope).
    if (tx.chainId !== 5042 || (tx.value ?? 0n) !== 0n || tx.type !== 'eip1559' || tx.gas <= 0n || (tx.maxPriorityFeePerGas ?? 0n) < 0n || (tx.maxPriorityFeePerGas ?? 0n) > tx.maxFeePerGas || tx.gas * tx.maxFeePerGas > i.gasCeiling || (tx.accessList?.length ?? 0) !== 0 || (b.baseFeePerGas != null && b.baseFeePerGas > tx.maxFeePerGas)) throw new Error('Arc fee or transaction envelope is outside the review.')
    if (i.action === 'arc-burn' || i.action === 'arc-approval') {
      const [amount, allowance] = await Promise.all(['balanceOf','allowance'].map(functionName => evm.readContract({ address: arc.usdcAddress, abi: CCTP_V2_ERC20_ABI, functionName, args: functionName === 'balanceOf' ? [i.evmOwner] : [i.evmOwner,arc.tokenMessengerAddress], blockNumber })))
      if (typeof amount !== 'bigint' || typeof allowance !== 'bigint' || amount < i.amount) throw new Error('Arc ERC-20 USDC balance is insufficient or unknown.')
      // Native gas USDC uses 18 decimals; ERC-20 USDC uses 6. They represent
      // the same underlying spendable funds, not two independent balances.
      if (balance < i.amount * 1000000000000n + BigInt(tx.gas) * BigInt(tx.maxFeePerGas)) throw new Error('Arc native USDC cannot cover both the token amount and maximum gas.')
      if (i.action === 'arc-burn' && allowance < i.amount) throw new Error('Exact token approval is required first. A burn will never add an implicit approval.')
      if (i.action === 'arc-approval' && allowance >= i.amount) throw new Error('Existing allowance already covers this amount. Do not request another approval.')
    }
    if (i.action === 'arc-mint') {
      const m = decodeCctpRecoveryMessage(e.message!)
      const used = await evm.readContract({ address: arc.messageTransmitterAddress, abi: CCTP_RECOVERY_ABI, functionName: 'usedNonces', args: [m.nonce], blockNumber })
      if (used !== 0n || (m.expirationBlock > 0n && blockNumber >= m.expirationBlock)) throw new Error('Arc mint nonce is used, unknown or expired. Recover without resending.')
    }
    const result = await evm.call({ account: i.evmOwner, to: tx.to, data: tx.data, value: 0n, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? 0n, blockNumber })
    if (i.action !== 'arc-burn' && result.data !== `0x${'0'.repeat(63)}1`) throw new Error('Arc approval/mint simulation did not return true.')
    const gas = await evm.estimateGas({ account: i.evmOwner, to: tx.to, data: tx.data, value: 0n, blockNumber })
    if (typeof gas !== 'bigint' || gas <= 0n || gas > tx.gas) throw new Error('Arc simulated gas exceeds the reviewed bound.')
    if ((await evm.getBlock({ blockNumber })).hash !== b.hash) throw new Error('Arc snapshot changed during simulation.')
    return gas * tx.maxFeePerGas
  }
  // Live Mainnet (2026-10-29) rejects a transaction without address-owned
  // inputs unless it carries a ValidDuring expiration of at most two epochs;
  // address-balance gas and an all-shared mint PTB have none. Real Arc->Sui
  // mints use exactly this form. The reviewed window, chain and replay nonce
  // must be byte-for-byte the values fixed at preparation.
  function validDuring(expiration: unknown, e: CacheEntry) {
    const x = expiration as { $kind?: string; ValidDuring?: { minEpoch: unknown; maxEpoch: unknown; minTimestamp: unknown; maxTimestamp: unknown; chain: unknown; nonce: unknown } } | null | undefined
    const v = x?.$kind === 'ValidDuring' ? x.ValidDuring : undefined
    return Boolean(v && e.epoch !== undefined && e.validityNonce !== undefined && uint(String(v.minEpoch)) === e.epoch && uint(String(v.maxEpoch)) === e.epoch + 1n && v.minTimestamp == null && v.maxTimestamp == null && v.chain === SUI_NETWORKS.mainnet.chainIdentifier && v.nonce === e.validityNonce)
  }
  async function checkSui(i: SuiWriteIntent, bytes: Uint8Array, e: CacheEntry) {
    suiAccount(i)
    if ((await sui.core.getChainIdentifier()).chainIdentifier !== SUI_NETWORKS.mainnet.chainIdentifier) throw new Error('Wrong Sui genesis.')
    const data = Transaction.from(bytes).getData(), gas = data.gasData
    if (!same(data.sender, i.suiOwner) || !same(gas.owner, i.suiOwner) || uint(String(gas.budget)) > i.gasCeiling || uint(String(gas.budget)) <= 0n || uint(String(gas.price)) <= 0n || !Array.isArray(gas.payment) || gas.payment.length > 256 || !validDuring(data.expiration, e)) throw new Error('Sui sender, gas funding, budget or expiration differs from review.')
    const [system, suiBalance, usdcBalance, price] = await Promise.all([sui.core.getCurrentSystemState(), sui.core.getBalance({ owner: i.suiOwner, coinType: '0x2::sui::SUI' }), i.action === 'sui-burn' ? sui.core.getBalance({ owner: i.suiOwner, coinType: SUI_NETWORKS.mainnet.usdcCoinType }) : Promise.resolve(null), sui.core.getReferenceGasPrice()])
    if (system.systemState.safeMode || e.epoch === undefined || uint(system.systemState.epoch) < e.epoch || uint(system.systemState.epoch) > e.epoch + 1n || uint(price.referenceGasPrice) > uint(String(gas.price))) throw new Error('Sui epoch, safe mode or gas price changed.')
    if (usdcBalance && parseSuiBalance(usdcBalance.balance, SUI_NETWORKS.mainnet.usdcCoinType).total < i.amount) throw new Error('Sui USDC balance is insufficient.')
    const suiFunds = parseSuiBalance(suiBalance.balance, normalizeStructTag('0x2::sui::SUI'))
    // SIP-58: with no gas coin objects the gas owner's own SUI address balance
    // pays (live Mainnet holders keep all SUI there). It must cover the full
    // budget by itself; no sponsor or foreign gas owner is accepted.
    if (!gas.payment.length) {
      if (suiFunds.address < uint(String(gas.budget))) throw new Error('Sui address balance does not cover the full gas budget.')
      return simulateExact(i, bytes, gas, e)
    }
    // Otherwise only owned SUI coins may fund gas; no sponsor, foreign owner,
    // or overlap with another selected gas object is accepted.
    const ids = new Set<string>(); let gasFunds = 0n
    for (const p of gas.payment) {
      if (ids.has(p.objectId)) throw new Error('Duplicate Sui gas payment.'); ids.add(p.objectId)
      const { object: o } = await sui.core.getObject({ objectId: p.objectId, include: { json: true } })
      if (o.owner.$kind !== 'AddressOwner' || !same(o.owner.AddressOwner, i.suiOwner) || o.digest !== p.digest || String(o.version) !== String(p.version) || normalizeStructTag(o.type) !== normalizeStructTag('0x2::coin::Coin<0x2::sui::SUI>')) throw new Error('Sui gas object owner, coin type or version changed.')
      gasFunds += uint(o.json?.balance)
    }
    if (gasFunds < uint(String(gas.budget))) throw new Error('Selected SUI gas coins do not cover the full budget.')
    return simulateExact(i, bytes, gas, e)
  }
  async function simulateExact(i: SuiWriteIntent, bytes: Uint8Array, gas: { budget: unknown }, e: CacheEntry) {
    if (i.action === 'sui-mint') {
      const port = read(), identity = await readSuiMainnetIdentity(port)
      if ((await readSuiNonceStatus(e.message!, identity, port)).used) throw new Error('Sui mint is already consumed. Recover without sending again.')
    }
    const res = await sui.core.simulateTransaction({ transaction: bytes.slice(), checksEnabled: true, include: { effects: true, bcs: true } })
    // Live gRPC simulate (sui-node 1.82.4) leaves Transaction.digest empty; the
    // effects carry the digest. Bind both returned BCS and effects to our bytes.
    const local = TransactionDataBuilder.getDigestFromBytes(bytes)
    if (res.$kind !== 'Transaction' || !res.Transaction.status.success || !res.Transaction.bcs || keccak256(res.Transaction.bcs) !== keccak256(bytes) || (res.Transaction.digest && res.Transaction.digest !== local) || !res.Transaction.effects || res.Transaction.effects.transactionDigest !== local) throw new Error('Sui dry-run failed or does not bind the exact reviewed bytes.')
    const costs = res.Transaction.effects.gasUsed
    // Storage cost includes the non-refundable portion; do not count that field
    // twice. The estimate is conservative before the storage rebate.
    const estimate = uint(costs.computationCost) + uint(costs.storageCost)
    if (estimate > uint(String(gas.budget))) throw new Error('Sui simulated cost exceeds the enforceable gas budget.')
    return estimate
  }
  return {
    async prepare(i) {
      ensure(i)
      assertSuiTestAmount(i.amount)
      const port = read(), identity = await readSuiMainnetIdentity(port)
      const e: CacheEntry = { i: { ...i }, identity }
      if (i.action.endsWith('mint')) Object.assign(e, await sourceMessage(i, identity, port))
      // A consumed nonce is reported as such before any PTB/RPC resolution.
      if (i.action === 'sui-mint' && (await readSuiNonceStatus(e.message!, identity, port)).used) throw new Error('This transfer is already minted on Sui. Recover it; nothing will be sent.')
      let bytes: Uint8Array, estimatedGas: bigint, digest: string | undefined, arcExpected: SuiArcExpected | undefined
      if (i.action.startsWith('sui-')) {
        suiAccount(i)
        const { systemState } = await sui.core.getCurrentSystemState()
        if (systemState.safeMode) throw new Error('Sui is in safe mode.')
        e.epoch = uint(systemState.epoch)
        const tx = i.action === 'sui-burn'
          ? buildSuiToArcBurn(deployment(identity), { sender: i.suiOwner, recipient: i.evmOwner, amount: i.amount, maxFee: i.maxCctpFee, gasBudget: i.gasCeiling })
          : buildArcToSuiMint(deployment(identity), { sender: i.suiOwner, message: e.message!, attestation: e.attestation!, gasBudget: i.gasCeiling })
        e.validityNonce = crypto.getRandomValues(new Uint32Array(1))[0]
        tx.setGasOwner(i.suiOwner)
        tx.setExpiration({ ValidDuring: { minEpoch: e.epoch.toString(), maxEpoch: (e.epoch + 1n).toString(), minTimestamp: null, maxTimestamp: null, chain: SUI_NETWORKS.mainnet.chainIdentifier, nonce: e.validityNonce } })
        // After trusted CoinWithBalance expansion, RPC resolution may resolve
        // only object references/gas. Preserve ALL commands/pure/withdrawal data.
        tx.addBuildPlugin(async (data, _opts, next) => {
          const before = data.snapshot(); await next(); const after = data.snapshot()
          if (key(before.commands) !== key(after.commands) || before.inputs.length !== after.inputs.length || before.inputs.some((v, n) => v.$kind !== 'UnresolvedObject' && key(v) !== key(after.inputs[n]))) throw new Error('Sui RPC resolution changed the locally constructed transaction.')
        })
        bytes = await tx.build({ client: sui })
        estimatedGas = await checkSui(i, bytes, e)
        digest = TransactionDataBuilder.getDigestFromBytes(bytes)
      } else {
        let to: Hex, data: Hex
        if (i.action === 'arc-approval') {
          to = arc.usdcAddress; data = encodeFunctionData({ abi: CCTP_V2_ERC20_ABI, functionName: 'approve', args: [arc.tokenMessengerAddress, i.amount] })
        } else if (i.action === 'arc-burn') {
          to = arc.tokenMessengerAddress; data = encodeFunctionData({ abi: CCTP_V2_TOKEN_MESSENGER_ABI, functionName: 'depositForBurn', args: [i.amount, 8, i.suiOwner as Hex, arc.usdcAddress, i.suiOwner as Hex, i.maxCctpFee, 2000] })
        } else {
          to = arc.messageTransmitterAddress; data = encodeFunctionData({ abi: CCTP_V2_MESSAGE_TRANSMITTER_ABI, functionName: 'receiveMessage', args: [e.message!, e.attestation!] })
        }
        e.nonce = await walletNonce(i)
        const fees = await evm.estimateFeesPerGas()
        if (typeof fees.maxFeePerGas !== 'bigint' || fees.maxFeePerGas <= 0n || typeof fees.maxPriorityFeePerGas !== 'bigint') throw new Error('No bounded Arc fee estimate.')
        const gas = await evm.estimateGas({ account: i.evmOwner, to, data, value: 0n })
        if (typeof gas !== 'bigint' || gas <= 0n) throw new Error('Arc gas estimation failed.')
        const tx = { type: 'eip1559' as const, chainId: 5042, nonce: e.nonce, to, data, value: 0n, gas: (gas * 120n + 99n) / 100n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, accessList: [] }
        const fromBlock = i.arcMethod === 'wallet-send' ? (await arcSnapshot()).number : 0n
        bytes = hexToBytes(serializeTransaction(tx)); estimatedGas = await checkArc(i, tx, e)
        if (i.arcMethod === 'wallet-send') arcExpected = { to, dataHash: keccak256(data), nonce: tx.nonce, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, fromBlock, ...(i.action === 'arc-mint' ? { cctpNonce: decodeCctpRecoveryMessage(e.message!).nonce } : {}) }
      }
      ensure(i)
      const commitment = keccak256(bytes)
      cache.clear(); cache.set(commitment, e)
      return { bytes, digest, estimatedGas, content: describeSuiWriteBytes(i.action, bytes), ...(arcExpected ? { arc: arcExpected } : {}), maximumGas: i.action.startsWith('sui-') ? i.gasCeiling : (() => { const t = parseTransaction(toHex(bytes)); return t.gas! * t.maxFeePerGas! })(), binding: identityKey(identity), expiresAt: Date.now() + 120_000 }
    },
    async recheck(i, p) {
      ensure(i)
      const e = cache.get(keccak256(p.bytes))
      if (!e || key(e.i) !== key(i)) throw new Error('No locally constructed transfer matches this review.')
      const port = read(), identity = await readSuiMainnetIdentity(port)
      if (identityKey(identity) !== p.binding) throw new Error('CCTP deployment identity changed.')
      if (i.action.endsWith('mint')) {
        const a = await sourceMessage(i, identity, port)
        if (a.message !== e.message || a.attestation !== e.attestation) throw new Error('Circle attestation changed. Review the exact new message before signing.')
      }
      if (i.action.startsWith('sui-')) await checkSui(i, p.bytes, e)
      else await checkArc(i, parseTransaction(toHex(p.bytes)), e)
      ensure(i)
    },
    async sign(i, bytes, signal) {
      ensure(i)
      assertSuiTestAmount(i.amount)
      if (i.arcMethod === 'wallet-send') throw new Error('A wallet-send review is never signed separately.')
      if (i.action.startsWith('sui-')) {
        const { account, feature } = suiAccount(i)
        const tx = Transaction.from(bytes)
        let result
        try { result = await feature.signTransaction({ transaction: { toJSON: () => tx.toJSON() }, account, chain: 'sui:mainnet', signal }) }
        catch (error) { if ((error as { code?: unknown })?.code === 4001) throw new SuiWriteSignatureRejected('user'); throw new Error('Sui signature response is unknown.') }
        if (signal.aborted) throw new Error('Signature no longer belongs to an active request.')
        if (typeof result.bytes !== 'string' || result.bytes.length > 180000 || typeof result.signature !== 'string' || result.signature.length > 16384) throw new Error('Malformed Sui signing response.')
        return { bytes: fromBase64(result.bytes), signature: result.signature }
      }
      const provider = wallets.evm(); if (!provider) throw new Error('Arc provider unavailable.')
      const tx = parseTransaction(toHex(bytes))
      // eth_sendTransaction signs AND broadcasts and cannot provide pre-send
      // byte binding. No silent fallback: unsupported sign-only EOA is blocked.
      let raw
      try { raw = await provider.request({ method: 'eth_signTransaction', params: [{ from: i.evmOwner, chainId: toHex(5042), to: tx.to, data: tx.data, value: '0x0', nonce: toHex(tx.nonce!), gas: toHex(tx.gas!), type: '0x2', maxFeePerGas: toHex(tx.maxFeePerGas!), maxPriorityFeePerGas: toHex(tx.maxPriorityFeePerGas ?? 0n), accessList: [] }] }) }
      catch (error) { const code = (error as { code?: unknown })?.code; if (code === 4001) throw new SuiWriteSignatureRejected('user'); if (code === 4200 || code === -32601) throw new SuiWriteSignatureRejected('unsupported'); throw new Error('Arc signature response is unknown.') }
      if (signal.aborted || typeof raw !== 'string' || raw.length > 262144 || !/^0x[0-9a-f]+$/i.test(raw) || raw.length % 2) throw new Error('Arc wallet cannot return a validated signed raw transaction. No send fallback is allowed.')
      return { bytes: hexToBytes(raw as Hex), signature: '' }
    },
    async validateSigned(i, p, signed) {
      ensure(i)
      if (i.action.startsWith('sui-')) {
        if (keccak256(signed.bytes) !== keccak256(p.bytes)) throw new Error('Wallet modified the reviewed Sui bytes.')
        await verifyTransactionSignature(p.bytes, signed.signature, { address: i.suiOwner })
        return TransactionDataBuilder.getDigestFromBytes(p.bytes)
      }
      const raw = toHex(signed.bytes), t = parseTransaction(raw)
      if (t.type !== 'eip1559' || t.r === undefined || t.s === undefined || t.yParity === undefined) throw new Error('Arc transaction is not signed EIP-1559.')
      const { r: _r, s: _s, yParity: _parity, v: _v, ...unsigned } = t
      if (serializeTransaction(unsigned) !== toHex(p.bytes) || !same(await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerialized }), i.evmOwner)) throw new Error('Wallet modified the reviewed Arc fields or signed for another sender.')
      return keccak256(raw)
    },
    async broadcast(i, signed, digest) {
      ensure(i)
      if (i.action.startsWith('sui-')) {
        const r = await sui.core.executeTransaction({ transaction: signed.bytes.slice(), signatures: [signed.signature] })
        const actual = r.Transaction?.digest ?? r.FailedTransaction?.digest
        if (actual !== digest) throw new Error('Sui submission response differs from the recorded digest.')
      } else if (await evm.sendRawTransaction({ serializedTransaction: toHex(signed.bytes) }) !== digest) throw new Error('Arc submission response differs from the recorded hash.')
    },
    // eth_sendTransaction: exactly one request with the reviewed fields. The wallet
    // may still sign/broadcast other fields; recover() is the only judge of that.
    async send(i, p) {
      try { assertSuiTestAmount(i.amount) } catch (error) { throw new SuiWriteNotRequested((error as Error).message) }
      if (!(deps.allowWalletSend ?? MAINNET_ARC_WALLET_SEND_ENABLED)) throw new SuiWriteNotRequested('Wallet-sent Arc transactions are disabled.')
      if (!i.action.startsWith('arc-') || i.arcMethod !== 'wallet-send' || !p.arc) throw new SuiWriteNotRequested('This review is not a wallet-send review.')
      const t = parseTransaction(toHex(p.bytes) as TransactionSerialized), x = p.arc
      if (!t.to || !same(t.to, x.to) || keccak256(t.data ?? '0x') !== x.dataHash || t.nonce !== x.nonce || t.gas !== x.gas || t.maxFeePerGas !== x.maxFeePerGas || t.chainId !== 5042) throw new SuiWriteNotRequested('Reviewed Arc fields are inconsistent. Nothing was sent.')
      const provider = wallets.evm()
      try {
        if (!provider || !wallets.current(i)) throw new Error()
        // Last read-only identity check immediately before the only request.
        const chain = quantity(await provider.request({ method: 'eth_chainId' })), accounts = await provider.request({ method: 'eth_accounts' })
        if (chain !== 5042n || !Array.isArray(accounts) || !accounts.some(a => typeof a === 'string' && same(a, i.evmOwner)) || !wallets.current(i)) throw new Error()
      } catch { throw new SuiWriteNotRequested('Arc wallet account or network changed before the request. Nothing was sent.') }
      let hash: unknown
      try { hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: i.evmOwner, to: t.to, data: t.data, value: '0x0', nonce: toHex(t.nonce!), gas: toHex(t.gas!), maxFeePerGas: toHex(t.maxFeePerGas!), maxPriorityFeePerGas: toHex(t.maxPriorityFeePerGas ?? 0n), chainId: toHex(5042), type: '0x2' }] }) }
      catch (error) {
        const code = (error as { code?: unknown })?.code
        if (code === 4001) throw new SuiWriteSignatureRejected('user')
        if (code === 4200 || code === -32601) throw new SuiWriteNotRequested('This wallet does not support eth_sendTransaction. Nothing was sent.')
        throw new Error('Arc wallet send result is unknown.')
      }
      if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('Arc wallet returned no valid transaction hash.')
      return hash.toLowerCase()
    },
    // Read-only search for a lost wallet-send hash. Only the transaction that
    // consumed the reviewed (sender, nonce) counts; recover() then checks its
    // fields, receipt and CCTP/approval events. Anything ambiguous returns null.
    async locate(a) {
      const i = a.intent, x = a.expected
      if (!x || i.arcMethod !== 'wallet-send') return null
      ensure(i)
      if (await evm.getChainId() !== 5042) throw new Error('Recovery RPC is not Arc Mainnet.')
      if (await evm.getTransactionCount({ address: i.evmOwner, blockTag: 'latest' }) <= x.nonce) return null
      const head = (await arcSnapshot()).number, pace = () => new Promise(r => setTimeout(r, deps.paceMs ?? 150))
      const count = async (blockNumber: bigint) => { await pace(); return BigInt(await evm.getTransactionCount({ address: i.evmOwner, blockNumber })) }
      const hit = (t: any) => typeof t === 'object' && t && same(t.from, i.evmOwner) && t.nonce === x.nonce && /^0x[0-9a-f]{64}$/i.test(t.hash)
      try {
        // Smallest block whose post-state nonce exceeds the reviewed nonce.
        if (await count(x.fromBlock - 1n) > BigInt(x.nonce)) return null // consumed before this review
        let lo = x.fromBlock, hi = head
        for (let n = 0; lo < hi && n < 64; n++) { const mid = (lo + hi) / 2n; if (await count(mid) > BigInt(x.nonce)) hi = mid; else lo = mid + 1n }
        await pace(); const block = await evm.getBlock({ blockNumber: lo, includeTransactions: true })
        const matches = (block.transactions ?? []).filter(hit)
        return matches.length === 1 ? matches[0].hash.toLowerCase() : null
      } catch {
        // No historical state on this RPC: bounded event search near the review.
        const filter = i.action === 'arc-approval' ? { address: arc.usdcAddress, event: APPROVAL_EVENT, args: { owner: i.evmOwner, spender: arc.tokenMessengerAddress } }
          : i.action === 'arc-burn' ? { address: arc.tokenMessengerAddress, event: CCTP_RECOVERY_ABI.find(e => e.type === 'event' && e.name === 'DepositForBurn'), args: { depositor: i.evmOwner } }
          : { address: arc.messageTransmitterAddress, event: MINT_ABI[0], args: { nonce: x.cctpNonce } }
        const last = head < x.fromBlock + 19_999n ? head : x.fromBlock + 19_999n, hashes = new Set<string>()
        for (let from = x.fromBlock; from <= last; from += 10_000n) {
          await pace(); const logs = await evm.getLogs({ ...filter, fromBlock: from, toBlock: from + 9_999n < last ? from + 9_999n : last })
          for (const l of logs) if (/^0x[0-9a-f]{64}$/i.test(l.transactionHash ?? '')) hashes.add(l.transactionHash.toLowerCase())
        }
        if (hashes.size > 16) return null
        const matches: string[] = []
        for (const hash of hashes) { await pace(); const t = await evm.getTransaction({ hash }); if (hit(t)) matches.push(hash) }
        return matches.length === 1 ? matches[0] : null
      }
    },
    // Read-only evidence for a wallet-send mismatch. Every doubt throws, which
    // keeps the journal locked: unmined, shallow or non-canonical receipt, a
    // nonce other than the reviewed one, pending sender transactions, or any
    // effect outside the known CCTP/USDC contracts and events.
    async reconcile(a) {
      const i = a.intent, x = a.expected
      if (a.state !== 'mismatch' || i.arcMethod !== 'wallet-send' || !x || !a.digest) throw new Error('Not a recorded wallet-send mismatch.')
      ensure(i)
      if (await evm.getChainId() !== 5042) throw new Error('Recovery RPC is not Arc Mainnet.')
      const tx = await evm.getTransaction({ hash: a.digest }), receipt = await evm.getTransactionReceipt({ hash: a.digest })
      if (!tx || !receipt || tx.hash?.toLowerCase() !== a.digest || receipt.transactionHash?.toLowerCase() !== a.digest || typeof receipt.blockNumber !== 'bigint' || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber) throw new Error('The mismatched transaction is not mined on Arc. The transfer stays locked.')
      const u = { type: 'eip1559' as const, chainId: tx.chainId, to: tx.to, data: tx.input, value: tx.value, nonce: tx.nonce, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, accessList: tx.accessList ?? [] }
      if (tx.type !== 'eip1559' || tx.r === undefined || tx.s === undefined || tx.yParity === undefined || keccak256(serializeTransaction(u, { r: tx.r, s: tx.s, yParity: tx.yParity })) !== a.digest || tx.chainId !== 5042 || !same(tx.from, i.evmOwner)) throw new Error('The mismatched transaction does not bind its fields to this sender on Arc.')
      if (tx.nonce !== x.nonce) throw new Error('The wallet used another nonce, so the reviewed nonce cannot be accounted for. The transfer stays locked.')
      const head = (await arcSnapshot()).number
      if (head < receipt.blockNumber + RECONCILE_DEPTH) throw new Error('The mismatched receipt is inside Machina\'s RPC confirmation buffer (not an Arc finality requirement). The transfer stays locked.')
      if ((await evm.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('The mismatched receipt is not in the canonical chain served by this RPC. The transfer stays locked.')
      const [latest, pending] = await Promise.all(['latest', 'pending'].map(blockTag => evm.getTransactionCount({ address: i.evmOwner, blockTag })))
      if (latest <= x.nonce || pending !== latest) throw new Error('The sender has pending transactions or an unsettled nonce. The transfer stays locked.')
      const lines = [`Arc transaction ${a.digest} in block ${receipt.blockNumber} (${receipt.blockHash})`, `Sender ${tx.from}, reviewed nonce ${x.nonce} consumed by this transaction; no pending sender transactions`, `Called ${tx.to} with calldata hash ${keccak256(tx.input)}; the Review expected ${x.to} / ${x.dataHash}`, `Value ${tx.value} wei, gas used ${receipt.gasUsed} at ${receipt.effectiveGasPrice} wei, status ${receipt.status}`]
      if (receipt.status === 'reverted') {
        if (receipt.logs.length) throw new Error('A reverted receipt with logs cannot be classified. The transfer stays locked.')
        lines.push('No token, approval, burn or mint effect (reverted); only gas was spent.')
      } else if (receipt.status === 'success') {
        if (receipt.logs.length > 32) throw new Error('Too many effects to classify. The transfer stays locked.')
        const bounded = boundedArcCall(tx), seen: { eventName: string; args: any }[] = []
        lines.push(`Call ${bounded.name} on ${bounded.call.target}: canonical calldata, no native value`)
        const emitters = [arc.usdcAddress, arc.tokenMessengerAddress, arc.messageTransmitterAddress, ARC_NATIVE_SYSTEM]
        for (const log of receipt.logs) {
          if (log.removed || log.transactionHash?.toLowerCase() !== a.digest || log.blockHash !== receipt.blockHash || !emitters.some(e => same(e, log.address))) throw new Error('The mismatched transaction has an effect outside the known CCTP/USDC contracts. The transfer stays locked.')
          let d: { eventName: string; args: any }
          try { d = decodeEventLog({ abi: EFFECT_ABI, data: log.data, topics: log.topics, strict: true }) as { eventName: string; args: any } } catch { throw new Error('An effect of the mismatched transaction cannot be decoded. The transfer stays locked.') }
          if (same(log.address, ARC_NATIVE_SYSTEM) && d.eventName !== 'Transfer') throw new Error('Unexpected Arc system effect. The transfer stays locked.')
          if (!bounded.call.effects.some(([address, name]) => same(address, log.address) && name === d.eventName)) throw new Error(`Effect ${d.eventName} is not possible for ${bounded.name}. The transfer stays locked.`)
          seen.push(d)
          const g = d.args
          lines.push(d.eventName === 'Transfer' ? `${same(log.address, ARC_NATIVE_SYSTEM) ? 'Native' : 'USDC'} Transfer ${g.from} → ${g.to}: ${g.value}`
            : d.eventName === 'Approval' ? `USDC allowance ${g.owner} → ${g.spender} set to ${formatUnits(g.value, 6)} USDC`
            : d.eventName === 'Burn' ? `USDC burned by ${g.burner}: ${formatUnits(g.amount, 6)} USDC`
            : d.eventName === 'Mint' ? `USDC minted to ${g.to}: ${formatUnits(g.amount, 6)} USDC`
            : d.eventName === 'DepositForBurn' ? `CCTP burn ${formatUnits(g.amount, 6)} USDC from ${g.depositor} to domain ${g.destinationDomain}, recipient ${g.mintRecipient}, max fee ${formatUnits(g.maxFee, 6)} USDC${g.destinationDomain === 8 && same(g.mintRecipient, i.suiOwner) ? ' (to this Sui wallet: track it in recovery with this transaction hash)' : ''}`
            : d.eventName === 'MessageReceived' ? `CCTP message received, nonce ${g.nonce} from domain ${g.sourceDomain}`
            : d.eventName === 'MintAndWithdraw' ? `CCTP mint ${formatUnits(g.amount, 6)} USDC to ${g.mintRecipient}, fee ${formatUnits(g.feeCollected, 6)} USDC`
            : d.eventName === 'MessageSent' ? `CCTP message sent (${(log.data.length - 2) / 2} bytes)` : (() => { throw new Error('Unclassified effect. The transfer stays locked.') })())
          if (d.eventName === 'MessageReceived' && await evm.readContract({ address: arc.messageTransmitterAddress, abi: CCTP_RECOVERY_ABI, functionName: 'usedNonces', args: [g.nonce], blockNumber: receipt.blockNumber }) !== 1n) throw new Error('A CCTP mint effect is not reflected on chain. The transfer stays locked.')
        }
        // The call's characteristic effect must appear exactly once and match its calldata.
        const keys = seen.filter(d => d.eventName === bounded.call.key), k = keys[0]?.args, c = bounded.args
        const consistent = keys.length === 1 && (bounded.name === 'approve' ? same(k.owner, i.evmOwner) && same(k.spender, arc.tokenMessengerAddress) && k.value === c[1]
          : bounded.name === 'depositForBurn' ? same(k.depositor, i.evmOwner) && same(k.burnToken, arc.usdcAddress) && k.amount === c[0] && k.destinationDomain === c[1] && same(k.mintRecipient, c[2] as string) && seen.filter(d => d.eventName === 'MessageSent').length === 1
          : k.nonce === decodeCctpRecoveryMessage(c[0] as Hex).nonce)
        if (!consistent) throw new Error(`The ${bounded.name} outcome is not proven by exactly one matching ${bounded.call.key} event. The transfer stays locked.`)
        const allowance = await evm.readContract({ address: arc.usdcAddress, abi: CCTP_V2_ERC20_ABI, functionName: 'allowance', args: [i.evmOwner, arc.tokenMessengerAddress], blockNumber: receipt.blockNumber })
        if (typeof allowance !== 'bigint') throw new Error('Allowance after the mismatch is unknown. The transfer stays locked.')
        lines.push(`TokenMessenger allowance after this block: ${formatUnits(allowance, 6)} USDC`)
      } else throw new Error('Unknown receipt status. The transfer stays locked.')
      ensure(i)
      return { key: keccak256(stringToHex(JSON.stringify(lines))), digest: a.digest, lines }
    },
    async recover(a: SuiWriteAttempt) {
      const i = a.intent
      ensure(i)
      if (i.action.startsWith('sui-')) {
        const raw = await sui.core.getTransaction({ digest: a.digest!, include: { bcs: true, effects: true } })
        const t = raw.Transaction ?? raw.FailedTransaction
        if (!t?.bcs || t.digest !== a.digest || keccak256(t.bcs) !== a.commitment || TransactionDataBuilder.getDigestFromBytes(t.bcs) !== a.digest) throw new Error('Sui transaction bytes are unavailable or differ from review.')
        const gas = t.effects?.gasUsed
        if (!gas || t.effects?.transactionDigest !== a.digest || uint(gas.computationCost) + uint(gas.storageCost) - uint(gas.storageRebate) > i.gasCeiling) throw new Error('Sui actual gas is unavailable or exceeds review.')
        // A failure also needs canonical checkpoint membership. The existing
        // success-only CCTP reader remains unchanged.
        if (!t.status.success) {
          const port = read(), chain = await port.chain(), failed = await port.transaction(a.digest!)
          if (chain !== SUI_NETWORKS.mainnet.chainIdentifier || !failed || failed.digest !== a.digest || !same(failed.transaction?.sender, i.suiOwner) || failed.effects?.status?.success !== false || !failed.effects.digest || typeof failed.checkpoint !== 'bigint') throw new Error('Sui failure is not independently checkpointed.')
          const cp = await port.checkpoint(failed.checkpoint)
          if (!cp?.digest || cp.sequenceNumber !== failed.checkpoint || cp.contents?.transactions.filter(x => x.transaction === a.digest && x.effects === failed.effects!.digest).length !== 1 || (await port.checkpoint(failed.checkpoint))?.digest !== cp.digest) throw new Error('Sui failed receipt is not canonical.')
          return 'reverted'
        }
        const port = read(), identity = await readSuiMainnetIdentity(port)
        await readCheckpointedSuiTransaction(a.digest!, port)
        if (i.action === 'sui-burn') {
          const proof = await readSuiBurnProof({ digest: a.digest!, suiOwner: i.suiOwner, evmOwner: i.evmOwner }, identity, port)
          if (proof.fields.amount !== i.amount || proof.fields.maxFee !== i.maxCctpFee) throw new Error('Actual Sui burn economics differ from review.')
          importSuiRecovery({ direction: 'sui-to-arc', sourceId: a.digest!, suiOwner: i.suiOwner, evmOwner: i.evmOwner, amount: (i.amount / 1000000n).toString() + '.' + (i.amount % 1000000n).toString().padStart(6, '0'), sourceEventIndex: proof.sourceLogIndex, stage: 'waiting_attestation', checkedAt: Date.now() })
        } else {
          const { message } = await sourceMessage(i, identity, port), status = await readSuiNonceStatus(message, identity, port)
          if (!status.used || status.destinationTx !== a.digest) throw new Error('No matching checkpointed Sui mint.')
        }
        return 'verified'
      }
      if (await evm.getChainId() !== 5042) throw new Error('Recovery RPC is not Arc Mainnet.')
      const tx = await evm.getTransaction({ hash: a.digest }), receipt = tx ? await evm.getTransactionReceipt({ hash: a.digest }).catch(() => null) : null
      if (!tx) return 'pending'
      const walletSent = i.arcMethod === 'wallet-send'
      if (walletSent) {
        // The hash must bind the fields it reports, and those fields must be the
        // reviewed ones (fees may only be lower). Anything else is never success.
        const x = a.expected
        if (!x || tx.hash?.toLowerCase() !== a.digest) throw new Error('Arc wallet-send record is incomplete.')
        const u = { type: 'eip1559' as const, chainId: tx.chainId, to: tx.to, data: tx.input, value: tx.value, nonce: tx.nonce, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, accessList: tx.accessList ?? [] }
        const bound = tx.type === 'eip1559' && tx.r !== undefined && tx.s !== undefined && tx.yParity !== undefined && keccak256(serializeTransaction(u, { r: tx.r, s: tx.s, yParity: tx.yParity })) === a.digest
        if (!bound || tx.chainId !== 5042 || !same(tx.from, i.evmOwner) || !tx.to || !same(tx.to, x.to) || keccak256(tx.input) !== x.dataHash || tx.value !== 0n || tx.nonce !== x.nonce || tx.gas > x.gas || tx.maxFeePerGas > x.maxFeePerGas || (tx.maxPriorityFeePerGas ?? 0n) > tx.maxFeePerGas || (tx.accessList?.length ?? 0) !== 0 || tx.gas * tx.maxFeePerGas > i.gasCeiling) return 'mismatch'
      }
      if (!receipt) return 'pending'
      if (tx.hash !== a.digest || receipt.transactionHash !== a.digest || tx.chainId !== 5042 || !same(tx.from, i.evmOwner) || typeof receipt.blockNumber !== 'bigint' || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber) throw new Error('Arc receipt/sender/chain mismatch.')
      const unsigned = { type: 'eip1559' as const, chainId: tx.chainId, to: tx.to, data: tx.input, value: tx.value, nonce: tx.nonce, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, accessList: tx.accessList ?? [] }
      if (tx.r === undefined || tx.s === undefined || tx.yParity === undefined || keccak256(serializeTransaction(unsigned, { r: tx.r, s: tx.s, yParity: tx.yParity })) !== a.digest) throw new Error('Arc transaction hash does not bind these signed fields.')
      // sign-only: exact reviewed bytes. wallet-send: field checks above (weaker).
      if ((!walletSent && keccak256(serializeTransaction(unsigned)) !== a.commitment) || tx.gas * tx.maxFeePerGas > i.gasCeiling || typeof receipt.gasUsed !== 'bigint' || receipt.gasUsed < 0n || typeof receipt.effectiveGasPrice !== 'bigint' || receipt.effectiveGasPrice < 0n || receipt.gasUsed > tx.gas || receipt.effectiveGasPrice > tx.maxFeePerGas) throw new Error('Arc receipt economics or calldata differ from review.')
      if ((await evm.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('Arc receipt is not canonical.')
      if (receipt.status === 'reverted') return 'reverted'
      if (receipt.status !== 'success') throw new Error('Unknown Arc receipt status.')
      const port = read(), identity = await readSuiMainnetIdentity(port)
      if (i.action === 'arc-burn') {
        const proof = await readCctpBurnProof({ sourceChainId: 5042, sourceTxHash: a.digest!, owner: i.evmOwner, mintRecipients: [i.suiOwner], suiDestinationMessenger: identity.inboundAuthRecipient }, evm)
        if (proof.fields.amount !== i.amount || proof.fields.maxFee !== i.maxCctpFee) throw new Error('Actual Arc burn economics differ from review.')
        importSuiRecovery({ direction: 'arc-to-sui', sourceId: a.digest!, suiOwner: i.suiOwner, evmOwner: i.evmOwner, amount: (i.amount / 1000000n).toString() + '.' + (i.amount % 1000000n).toString().padStart(6, '0'), sourceEventIndex: proof.sourceLogIndex, stage: 'waiting_attestation', checkedAt: Date.now() })
      } else if (i.action === 'arc-mint') {
        const { message } = await sourceMessage(i, identity, port), m = decodeCctpRecoveryMessage(message)
        verifyArcSuiMintReceipt(receipt, message, i.evmOwner)
        if (await evm.readContract({ address: arc.messageTransmitterAddress, abi: CCTP_RECOVERY_ABI, functionName: 'usedNonces', args: [m.nonce], blockNumber: receipt.blockNumber }) !== 1n) throw new Error('Arc mint nonce is unavailable.')
      } else {
        const allowance = await evm.readContract({ address: arc.usdcAddress, abi: CCTP_V2_ERC20_ABI, functionName: 'allowance', args: [i.evmOwner, arc.tokenMessengerAddress], blockNumber: receipt.blockNumber })
        if (allowance !== i.amount) throw new Error('Confirmed approval does not leave the reviewed exact allowance.')
      }
      if ((await evm.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('Arc receipt changed during recovery.')
      ensure(i); return 'verified'
    },
  }
}

// Concrete Wallet Standard/Arc RPC wiring; callers cannot override the gate.
export function createSuiMainnetWriteController(wallets: SuiWriteWallets) {
  return createSuiWriteController(createSuiMainnetWritePort(wallets), browserSuiWriteEnvironment(wallets.current))
}
