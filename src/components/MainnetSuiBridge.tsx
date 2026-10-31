import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAccount, useReadContract } from 'wagmi'
import { useSuiWallet } from '../hooks/useSuiWallet'
import { MAINNET_SUI_CCTP_BLOCKER } from '../config/sui'
import { CCTP_V2_ERC20_ABI, getMainnetCctpChain } from '../config/mainnetCctp'
import { createSuiRecoveryController, type SuiRecoveryInput } from '../lib/mainnetSuiRecovery'
import { useSuiMainnetWrite } from '../hooks/useSuiMainnetWrite'
import { importSuiRecovery, readSuiRecoveryQueue, subscribeSuiRecovery, type SuiRecoveryRecord } from '../lib/mainnetSuiQueue'
import SuiBridgeFlow from './SuiBridgeFlow'

const arc = getMainnetCctpChain(5042)!
// A phone or tablet browser without an injected EVM provider (the Slush app browser, Safari): MetaMask is reachable
// only through a WalletConnect hand-off to another app, which is not dependable there.
function isPhoneWithoutEvmWallet() {
  if (typeof window === 'undefined') return false
  const phone = /Android|iPhone|iPad|iPod/i.test(window.navigator.userAgent || '') || window.matchMedia?.('(pointer: coarse)').matches
  return Boolean(phone) && typeof window.ethereum?.request !== 'function'
}
export function displayError(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  // Only our bounded, non-sensitive validation messages are presented. Raw
  // SDK/RPC errors and payloads are never logged or displayed.
  if (/^(Enter the original base58|Invalid Sui transaction digest|Sui source transaction belongs|No unique Sui DepositForBurn|Wallet, route or source transaction changed|Sui status check timed out|A Sui status check is already running|This transfer is outside)/.test(message)) return message
  if (/^Stored Sui source identity belongs/.test(message)) return 'A saved record for this transaction lists other wallets or another amount. Connect the wallets that made the original transfer. Nothing was sent.'
  if (/^(Stored completion cannot be reconciled|Connect a valid Sui wallet account|Connect the original Sui and Arc wallets|This wallet account does not support Sui|Unsupported source chain or invalid connected wallet|No unique USDC DepositForBurn|This burn is not an existing supported same-wallet|The source transaction is not a successful confirmed burn|Enter a valid source transaction hash|Arc attestation expired|CCTP attestation expired|Multiple Circle messages match|Unsupported or malformed CCTP V2 message|Unsupported finality or invalid CCTP fee bound)/.test(message)) return message
  if (/(timed out|read budget|canonical|block changed|Retry|HTTP \d+|is missing|unavailable|RPC (network identity|returned))/.test(message)) return 'Arc, Sui or Circle did not answer consistently. Nothing was sent; try again in a moment.'
  return 'The source, Circle or destination status could not be verified. Nothing was sent. Check that the original wallets are connected and try again.'
}

// Wires the real wallets (wagmi, Mysten dApp Kit), the guarded writer and the
// read-only recovery into the single Sui Bridge flow. Dashboard and Activity read
// the same history through useBridgeHistory; transfers are driven only from here.
export default function MainnetSuiBridge() {
  const { address: evmOwner, chainId, connector } = useAccount()
  const sui = useSuiWallet('mainnet')
  const [phoneWithoutEvm] = useState(isPhoneWithoutEvmWallet)
  const [records, setRecords] = useState<SuiRecoveryRecord[]>(readSuiRecoveryQueue)
  useEffect(() => subscribeSuiRecovery(() => setRecords(readSuiRecoveryQueue())), [])
  const controller = useMemo(() => createSuiRecoveryController(), [])
  const writer = useSuiMainnetWrite(`${sui.address ?? ''}|${evmOwner ?? ''}`)
  const read = { chainId: 5042, query: { enabled: Boolean(evmOwner) } } as const
  const balance = useReadContract({ ...read, address: arc.usdcAddress, abi: CCTP_V2_ERC20_ABI, functionName: 'balanceOf', args: evmOwner ? [evmOwner] : undefined })
  const allowance = useReadContract({ ...read, address: arc.usdcAddress, abi: CCTP_V2_ERC20_ABI, functionName: 'allowance', args: evmOwner ? [evmOwner, arc.tokenMessengerAddress] : undefined })
  const refresh = useCallback(async () => {
    const [, a] = await Promise.all([balance.refetch(), allowance.refetch()])
    return { allowanceUnits: typeof a.data === 'bigint' ? a.data : undefined }
  }, [balance, allowance])
  const inspect = useCallback(async (input: SuiRecoveryInput) => {
    // Candidate Arc mint hashes for Sui -> Arc: this browser's verified wallet step and the saved record.
    // The recovery reader proves any candidate on chain before using it.
    const hints: string[] = []
    if (input.direction === 'sui-to-arc') {
      try { const a = writer.saved(); if (a?.state === 'verified' && a.intent.action === 'arc-mint' && a.intent.sourceId === input.sourceId && a.digest) hints.push(a.digest) } catch { /* journal errors are shown by the flow */ }
      const saved = readSuiRecoveryQueue().find(r => r.direction === 'sui-to-arc' && r.sourceId === input.sourceId)?.destinationTx
      if (saved) hints.push(saved)
    }
    try { return await controller.inspect({ ...input, ...(hints.length ? { destinationHints: hints } : {}) }, () => true, importSuiRecovery) }
    catch (e) { throw new Error(displayError(e)) }
  }, [controller, writer])
  return <section aria-label="Sui Mainnet bridge" className="rounded-3xl border border-slate-200 bg-white p-4 shadow-[0_16px_45px_rgba(15,23,42,0.08)] sm:p-6">
    <h2 className="text-xl font-semibold">Sui ↔ Arc</h2>
    <p className="mb-4 mt-1 text-xs leading-5 text-slate-500">{MAINNET_SUI_CCTP_BLOCKER}</p>
    <SuiBridgeFlow writer={writer} records={records} inspect={inspect}
      evm={{ address: evmOwner, walletName: connector?.name, onArc: chainId === 5042, desktopHint: !evmOwner && phoneWithoutEvm }}
      sui={{ address: sui.address ?? undefined, walletName: sui.currentWalletName ?? undefined, ready: sui.walletSupportsNetwork, usdc: sui.usdcBalance, gas: sui.suiBalance }}
      arc={{ usdcUnits: typeof balance.data === 'bigint' ? balance.data : undefined, refresh }} />
  </section>
}
