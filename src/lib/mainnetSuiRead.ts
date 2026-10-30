import { SuiGrpcClient, GrpcTypes } from '@mysten/sui/grpc'
import type { SuiClientTypes } from '@mysten/sui/client'
import { bcs } from '@mysten/sui/bcs'
import { fromBase58, toBase58, deriveDynamicFieldID, normalizeStructTag } from '@mysten/sui/utils'
import { keccak256, stringToHex, toHex, type Hex } from 'viem'
import { SUI_MAINNET_V2_REFERENCE as R } from '../config/mainnetSui'
import { SUI_NETWORKS } from '../config/sui'
import { cctpRecoveryClient, cctpWord, decodeCctpRecoveryMessage } from './mainnetCctpRecovery'
import { getMainnetCctpChain } from '../config/mainnetCctp'

export type SuiReadObject = SuiClientTypes.Object<{ json: true; content: true; previousTransaction: true }>
export type SuiMainnetReadPort = {
  chain(): Promise<string>
  package(id: string): Promise<GrpcTypes.Package | undefined>
  linkage(id: string): Promise<GrpcTypes.Linkage[]>
  object(id: string): Promise<SuiReadObject>
  nonceObject(id: string): Promise<GrpcTypes.GetObjectResult>
  transaction(digest: string): Promise<GrpcTypes.ExecutedTransaction | undefined>
  checkpoint(sequence: bigint): Promise<GrpcTypes.Checkpoint | undefined>
  arcRemote(): Promise<Hex>
}
const ID = /^0x[0-9a-f]{64}$/i
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
export function assertSuiDigest(digest: string) {
  if (typeof digest !== 'string' || digest.length < 32 || digest.length > 44) throw new Error('Enter the original base58 Sui transaction digest, without a 0x prefix.')
  let bytes: Uint8Array
  try { bytes = fromBase58(digest) } catch { throw new Error('Invalid Sui transaction digest.') }
  if (bytes.length !== 32 || toBase58(bytes) !== digest) throw new Error('Invalid Sui transaction digest.')
}
function address(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value) || /^0x0{64}$/i.test(value)) throw new Error('Missing Sui object/type identity.')
  return value.toLowerCase()
}
export function suiTypeIdentifier(type: string): Hex { return keccak256(stringToHex(normalizeStructTag(type).replace(/^0x/, ''))) }
// Live sui-node 1.82.4 MovePackageService.GetPackage (2026-10-29) returns empty
// typeOrigins/linkage lists; the defining package of each type is carried by the
// module's datatype descriptor (definingId). Exactly one descriptor must match.
function origin(pkg: GrpcTypes.Package, module: string, name: string) {
  const entries = pkg.modules.filter(m => m.name === module).flatMap(m => m.datatypes.filter(d => d.name === name))
  if (entries.length !== 1 || !entries[0].typeName?.endsWith(`::${module}::${name}`)) throw new Error(`No unique type-origin proof for ${module}::${name}.`)
  return address(entries[0].definingId)
}
// The handler's compiled signatures name the Treasury's defining (original)
// package. Exactly one such package may appear; nothing is assumed from docs.
function treasuryPackage(pkg: GrpcTypes.Package) {
  const found = new Set<string>()
  const walk = (v: unknown, depth: number): void => {
    if (depth > 24) throw new Error('Sui handler signature is too deep.')
    if (typeof v === 'string') { const m = /^(0x[0-9a-f]{64})::treasury::Treasury$/i.exec(v); if (m) found.add(m[1].toLowerCase()) }
    else if (Array.isArray(v)) v.forEach(x => walk(x, depth + 1))
    else if (v && typeof v === 'object' && !(v instanceof Uint8Array)) Object.values(v).forEach(x => walk(x, depth + 1))
  }
  walk(pkg.modules, 0)
  if (found.size !== 1) throw new Error('No unique USDC Treasury package in the Sui handler signatures.')
  return address([...found][0])
}
function linked(linkage: GrpcTypes.Linkage[], originalId: string, upgradedId?: string) {
  const entries = linkage.filter(l => typeof l.originalId === 'string' && same(l.originalId, originalId))
  if (entries.length !== 1 || (upgradedId && !same(address(entries[0].upgradedId), upgradedId))) throw new Error('Sui handler linkage does not bind the verified packages.')
  return address(entries[0].upgradedId)
}
function objectIdentity(o: SuiReadObject, id: string, type: string) {
  if (!same(o.objectId, id) || normalizeStructTag(o.type) !== normalizeStructTag(type) || o.owner.$kind !== 'Shared' || !/^[1-9][0-9]*$/.test(o.version) || !o.digest || !o.json) throw new Error('Sui shared object identity, owner or state is invalid.')
}
function table(value: unknown) {
  // gRPC JSON only; do not silently guess JSON-RPC's different field wrappers.
  if (!value || typeof value !== 'object') throw new Error('Sui nonce Table state is unavailable.')
  const v = value as Record<string, unknown>
  if (typeof v.size !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v.size)) throw new Error('Malformed Sui nonce Table size.')
  return address(v.id)
}

// Only read methods are exposed. This factory cannot sign, execute or mint.
export function createSuiMainnetReadPort(): SuiMainnetReadPort {
  const client = new SuiGrpcClient({ network: 'mainnet', baseUrl: SUI_NETWORKS.mainnet.url, timeout: 10_000 })
  const arc = getMainnetCctpChain(5042)!, evm = cctpRecoveryClient(arc.rpcUrls)
  let calls = 0; const deadline = Date.now() + 45_000
  const bounded = <T>(fn: () => Promise<T>): Promise<T> => { if (++calls > 40 || Date.now() >= deadline) throw new Error('Sui read budget expired. No transaction was requested.'); return fn() }
  return {
    chain: () => bounded(async () => (await client.core.getChainIdentifier()).chainIdentifier),
    package: id => bounded(async () => (await client.movePackageService.getPackage({ packageId: id })).response.package),
    // MovePackageService omits linkage on live nodes; LedgerService carries it.
    linkage: id => bounded(async () => { const o = (await client.ledgerService.getObject({ objectId: id, readMask: { paths: ['object_id', 'package'] } })).response.object; if (!o?.objectId || !same(address(o.objectId), id) || !o.package) throw new Error('Sui package linkage is unavailable.'); return o.package.linkage }),
    object: id => bounded(async () => (await client.core.getObject({ objectId: id, include: { json: true, content: true, previousTransaction: true } })).object),
    nonceObject: id => bounded(async () => { const { response } = await client.ledgerService.batchGetObjects({ requests: [{ objectId: id }], readMask: { paths: ['object_id', 'object_type', 'owner', 'contents', 'previous_transaction'] } }); if (response.objects.length !== 1) throw new Error('Malformed nonce lookup.'); return response.objects[0] }),
    transaction: digest => bounded(async () => (await client.ledgerService.getTransaction({ digest, readMask: { paths: ['digest', 'checkpoint', 'timestamp', 'transaction.sender', 'effects.status', 'effects.digest', 'events'] } })).response.transaction),
    checkpoint: sequenceNumber => bounded(async () => (await client.ledgerService.getCheckpoint({ checkpointId: { oneofKind: 'sequenceNumber', sequenceNumber }, readMask: { paths: ['sequence_number', 'digest', 'contents'] } })).response.checkpoint),
    arcRemote: () => bounded(async () => { if (await evm.getChainId() !== 5042) throw new Error('Wrong Arc network.'); const block = await evm.getBlock(); if (typeof block.number !== 'bigint' || !/^0x[0-9a-f]{64}$/i.test(block.hash ?? '')) throw new Error('Arc canonical snapshot is unavailable.'); const value = await evm.readContract({ address: arc.tokenMessengerAddress, abi: [{ type: 'function', name: 'remoteTokenMessengers', stateMutability: 'view', inputs: [{ type: 'uint32' }], outputs: [{ type: 'bytes32' }] }], functionName: 'remoteTokenMessengers', args: [8], blockNumber: block.number }); if ((await evm.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('Arc block changed.'); return value }),
  }
}

export async function readSuiMainnetIdentity(port: SuiMainnetReadPort) {
  if (await port.chain() !== SUI_NETWORKS.mainnet.chainIdentifier) throw new Error('Sui RPC is not the verified Mainnet genesis.')
  const usdcPackage = SUI_NETWORKS.mainnet.usdcCoinType.split('::')[0]
  const requested = [R.mtPackage, R.tmmPackage, R.handlerPackage, R.extensionsPackage, usdcPackage]
  const packages = await Promise.all(requested.map(async id => { const p = await port.package(id); if (!p || !same(address(p.storageId), id) || !p.originalId || !p.version || p.version < 1n) throw new Error('Sui callable package could not be verified.'); return p }))
  const [mt, tmm, handler, , usdc] = packages
  // Treasury<USDC> defining type + handler linkage: the handler package that the
  // mint/burn PTB calls must link the exact MT/TMM/USDC packages verified above
  // and the stablecoin package whose Treasury type the shared object carries.
  const stableOriginal = treasuryPackage(handler), handlerLinkage = await port.linkage(R.handlerPackage)
  linked(handlerLinkage, address(mt.originalId), R.mtPackage); linked(handlerLinkage, address(tmm.originalId), R.tmmPackage); linked(handlerLinkage, address(usdc.originalId), usdcPackage)
  const stable = await port.package(linked(handlerLinkage, stableOriginal))
  if (!stable || !same(address(stable.originalId), stableOriginal) || origin(stable, 'treasury', 'Treasury') !== stableOriginal) throw new Error('USDC Treasury defining package could not be verified.')
  const mtOriginalPackage = address(mt.originalId), tmmOriginalPackage = address(tmm.originalId)
  const authOrigin = origin(tmm, 'message_transmitter_authenticator', 'MessageTransmitterAuthenticator')
  if (authOrigin !== tmmOriginalPackage || origin(usdc, 'usdc', 'USDC') !== usdcPackage) throw new Error('Unsupported authenticator or USDC type-origin upgrade.')
  const inboundAuthRecipient = suiTypeIdentifier(`${authOrigin}::message_transmitter_authenticator::MessageTransmitterAuthenticator`)
  if (!same(await port.arcRemote(), inboundAuthRecipient)) throw new Error('Sui authenticator does not match Arc remoteTokenMessengers(8).')
  const [mtState, tmmState, handlerState, treasury] = await Promise.all([R.mtState, R.tmmState, R.handlerState, R.treasury].map(id => port.object(id)))
  objectIdentity(mtState, R.mtState, `${origin(mt, 'state', 'State')}::state::State`)
  objectIdentity(tmmState, R.tmmState, `${origin(tmm, 'state', 'State')}::state::State`)
  objectIdentity(handlerState, R.handlerState, `${origin(handler, 'state', 'State')}::state::State`)
  if (!same(treasury.objectId, R.treasury) || treasury.owner.$kind !== 'Shared' || normalizeStructTag(treasury.type) !== normalizeStructTag(`${stableOriginal}::treasury::Treasury<${SUI_NETWORKS.mainnet.usdcCoinType}>`)) throw new Error('Unexpected USDC Treasury object.')
  const state = mtState.json!
  if (state.local_domain !== 8 || state.message_version !== 1 || state.paused !== false || tmmState.json?.message_body_version !== 1 || tmmState.json?.paused !== false) throw new Error('Sui CCTP state is paused, incompatible or malformed.')
  const nonceTable = table(state.used_nonces)
  return { mtOriginalPackage, tmmOriginalPackage, inboundAuthRecipient, nonceTable, mtState, tmmState, handlerState,
    mtSendType: `${origin(mt, 'send_message', 'MessageSent')}::send_message::MessageSent`,
    mtReceiveType: `${origin(mt, 'receive_message', 'MessageReceived')}::receive_message::MessageReceived`,
    depositType: `${origin(tmm, 'deposit_for_burn', 'DepositForBurn')}::deposit_for_burn::DepositForBurn`,
    mintType: `${origin(tmm, 'handle_receive_message', 'MintAndWithdraw')}::handle_receive_message::MintAndWithdraw`,
    tokenIdentifier: suiTypeIdentifier(SUI_NETWORKS.mainnet.usdcCoinType),
  }
}
export type SuiMainnetIdentity = Awaited<ReturnType<typeof readSuiMainnetIdentity>>

// Source/schema derived from Circle's pinned V2 Move definitions. Strict BCS
// round-trip rejects trailing/unsupported fields rather than guessing JSON.
export const SUI_CCTP_EVENT_BCS = {
  sent: bcs.struct('MessageSent', { message: bcs.vector(bcs.u8()) }),
  deposit: bcs.struct('DepositForBurn', { burn_token: bcs.Address, amount: bcs.u256(), depositor: bcs.Address, mint_recipient: bcs.Address, destination_domain: bcs.u32(), destination_token_messenger: bcs.Address, destination_caller: bcs.Address, max_fee: bcs.u256(), min_finality_threshold: bcs.u32(), hook_data: bcs.vector(bcs.u8()) }),
  received: bcs.struct('MessageReceived', { caller: bcs.Address, source_domain: bcs.u32(), nonce: bcs.u256(), sender: bcs.Address, finality_threshold_executed: bcs.u32(), message_body: bcs.vector(bcs.u8()) }),
  minted: bcs.struct('MintAndWithdraw', { mint_recipient: bcs.Address, amount: bcs.u64(), mint_token: bcs.Address, fee_collected: bcs.u64() }),
}
function parseEvent<T>(schema: { parse(bytes: Uint8Array): T; serialize(value: any): { toBytes(): Uint8Array } }, bytes: Uint8Array) {
  if (bytes.length > 2048) throw new Error('Oversized CCTP event.')
  const value = schema.parse(bytes), roundTrip = schema.serialize(value).toBytes()
  if (toHex(roundTrip) !== toHex(bytes)) throw new Error('Unsupported CCTP event encoding.')
  return value
}
export async function readCheckpointedSuiTransaction(digest: string, port: SuiMainnetReadPort) {
  assertSuiDigest(digest)
  const tx = await port.transaction(digest)
  if (!tx || tx.digest !== digest || tx.effects?.status?.success !== true || typeof tx.checkpoint !== 'bigint' || tx.checkpoint < 0n || !tx.effects.digest || !tx.transaction?.sender) throw new Error('Sui transaction is failed, missing or not checkpointed; no completion is proven.')
  if ((tx.events?.events.length ?? 0) > 256) throw new Error('Too many events for safe recovery.')
  const checkpoint = await port.checkpoint(tx.checkpoint)
  const matches = checkpoint?.contents?.transactions.filter(t => t.transaction === digest && t.effects === tx.effects!.digest)
  if (!checkpoint?.digest || checkpoint.sequenceNumber !== tx.checkpoint || matches?.length !== 1 || checkpoint.contents!.transactions.length > 20000) throw new Error('Sui checkpoint does not prove these transaction effects.')
  return { tx, checkpoint }
}
async function unchangedCheckpoint(port: SuiMainnetReadPort, cp: GrpcTypes.Checkpoint) {
  if ((await port.checkpoint(cp.sequenceNumber!))?.digest !== cp.digest) throw new Error('Sui canonical checkpoint changed.')
}
export async function readSuiBurnProof(input: { digest: string; suiOwner: string; evmOwner: string }, identity: SuiMainnetIdentity, port: SuiMainnetReadPort) {
  const { tx, checkpoint } = await readCheckpointedSuiTransaction(input.digest, port)
  if (!same(tx.transaction!.sender!, input.suiOwner)) throw new Error('Sui source transaction belongs to another wallet.')
  const events = tx.events?.events ?? [], arc = getMainnetCctpChain(5042)!
  const deposits = events.map((e, index) => ({ e, index })).filter(({ e }) => e.eventType === identity.depositType && same(e.sender ?? '', input.suiOwner))
  if (deposits.length !== 1) throw new Error('No unique Sui DepositForBurn; ambiguous transfers are not guessed.')
  const d = parseEvent(SUI_CCTP_EVENT_BCS.deposit, deposits[0].e.contents?.value ?? new Uint8Array())
  const candidates = events.filter(e => e.eventType === identity.mtSendType && same(e.sender ?? '', input.suiOwner)).map(e => toHex(Uint8Array.from(parseEvent(SUI_CCTP_EVENT_BCS.sent, e.contents?.value ?? new Uint8Array()).message)))
  const valid = candidates.filter(raw => { const m = decodeCctpRecoveryMessage(raw); return m.sourceDomain === 8 && m.destinationDomain === 26 && m.sender === identity.inboundAuthRecipient && m.recipient === cctpWord(arc.tokenMessengerAddress).toLowerCase() && m.burnToken === identity.tokenIdentifier && m.messageSender === input.suiOwner.toLowerCase() && m.mintRecipient === cctpWord(input.evmOwner).toLowerCase() && m.minFinality === 2000 && m.amount === BigInt(d.amount) && m.amount > 0n && m.amount <= (1n << 64n) - 1n && m.maxFee === BigInt(d.max_fee) && m.maxFee < m.amount && m.feeExecuted === 0n && m.expirationBlock === 0n && m.nonce === toHex(0n, { size: 32 }) && m.destinationCaller === d.destination_caller.toLowerCase() && [toHex(0n, { size: 32 }), cctpWord(input.evmOwner).toLowerCase()].includes(m.destinationCaller) })
  if (valid.length !== 1 || d.burn_token.toLowerCase() !== identity.tokenIdentifier || !same(d.depositor, input.suiOwner) || !same(d.mint_recipient, cctpWord(input.evmOwner)) || d.destination_domain !== 26 || !same(d.destination_token_messenger, cctpWord(arc.tokenMessengerAddress)) || d.min_finality_threshold !== 2000 || d.hook_data.length) throw new Error('Sui burn event and MessageSent do not bind this route and recipients.')
  await unchangedCheckpoint(port, checkpoint)
  // Checkpoint time of the burn (display only); absent when the node does not report it.
  const ts = (tx as { timestamp?: { seconds?: bigint | string; nanos?: number } }).timestamp
  const sourceTime = ts?.seconds !== undefined && BigInt(ts.seconds) > 0n ? Number(BigInt(ts.seconds)) * 1000 + Math.floor((ts.nanos ?? 0) / 1e6) : undefined
  return { fields: decodeCctpRecoveryMessage(valid[0]), sourceMessage: valid[0], sourceTxHash: input.digest, sourceLogIndex: deposits[0].index, sourceTime }
}

export async function readSuiNonceStatus(message: Hex, identity: SuiMainnetIdentity, port: SuiMainnetReadPort) {
  const m = decodeCctpRecoveryMessage(message), nonce = BigInt(m.nonce)
  const arc = getMainnetCctpChain(5042)!
  if (m.sourceDomain !== 26 || m.destinationDomain !== 8 || m.recipient !== identity.inboundAuthRecipient || nonce === 0n || m.sender !== cctpWord(arc.tokenMessengerAddress).toLowerCase() || m.burnToken !== cctpWord(arc.usdcAddress).toLowerCase()) throw new Error('Message is not bound to this Sui deployment.')
  const before = await port.object(R.mtState)
  if (before.version !== identity.mtState.version || before.digest !== identity.mtState.digest) throw new Error('Sui state changed; read a fresh status.')
  const fieldId = deriveDynamicFieldID(identity.nonceTable, 'u256', bcs.u256().serialize(nonce).toBytes())
  const result = (await port.nonceObject(fieldId)).result
  let destinationTx: string | undefined
  if (result.oneofKind === 'error') {
    if (result.error.code !== 5) throw new Error('Sui nonce lookup failed; absence is not proven.')
  } else if (result.oneofKind === 'object') {
    const o = result.object, bytes = o.contents?.value
    if (!same(o.objectId ?? '', fieldId) || o.owner?.kind !== GrpcTypes.Owner_OwnerKind.OBJECT || !same(o.owner.address ?? '', identity.nonceTable) || normalizeStructTag(o.objectType ?? '') !== normalizeStructTag('0x2::dynamic_field::Field<u256,bool>') || !bytes || bytes.length !== 65 || toHex(bytes.slice(0, 32)) !== fieldId || BigInt(bcs.u256().parse(bytes.slice(32, 64))) !== nonce || bytes[64] !== 1 || !o.previousTransaction) throw new Error('Malformed, false or foreign Sui used-nonce field.')
    const { tx, checkpoint } = await readCheckpointedSuiTransaction(o.previousTransaction, port)
    const events = tx.events?.events ?? []
    const received = events.filter(e => e.eventType === identity.mtReceiveType).map(e => parseEvent(SUI_CCTP_EVENT_BCS.received, e.contents?.value ?? new Uint8Array())).filter(e => BigInt(e.nonce) === nonce && e.source_domain === 26 && same(e.sender, m.sender) && toHex(Uint8Array.from(e.message_body)) === ('0x' + message.slice(2 + 148 * 2)).toLowerCase())
    const minted = events.filter(e => e.eventType === identity.mintType).map(e => parseEvent(SUI_CCTP_EVENT_BCS.minted, e.contents?.value ?? new Uint8Array())).filter(e => same(e.mint_recipient, m.mintRecipient) && e.mint_token.toLowerCase() === identity.tokenIdentifier && BigInt(e.amount) === m.amount - m.feeExecuted && BigInt(e.fee_collected) === m.feeExecuted)
    if (received.length !== 1 || minted.length !== 1 || received[0].finality_threshold_executed !== m.executedFinality || !same(received[0].caller, tx.transaction!.sender!) || ![toHex(0n, { size: 32 }), received[0].caller.toLowerCase()].includes(m.destinationCaller)) throw new Error('Used nonce has no matching checkpointed receipt and actual mint event.')
    await unchangedCheckpoint(port, checkpoint); destinationTx = o.previousTransaction
  } else throw new Error('Malformed Sui nonce lookup response.')
  const after = await port.object(R.mtState)
  if (after.version !== before.version || after.digest !== before.digest) throw new Error('Sui nonce/state changed during the check.')
  if (!destinationTx && m.expirationBlock > 0n) {
    const clock = await port.object('0x6'), timestamp = clock.json?.timestamp_ms
    if (clock.objectId !== `0x${'0'.repeat(63)}6` || normalizeStructTag(clock.type) !== normalizeStructTag('0x2::clock::Clock') || clock.owner.$kind !== 'Shared' || typeof timestamp !== 'string' || !/^[0-9]+$/.test(timestamp) || BigInt(timestamp) >= m.expirationBlock) throw new Error('Sui message is expired or chain-clock verification is unavailable.')
  }
  return { used: Boolean(destinationTx), destinationTx }
}
