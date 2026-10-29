// Move call sequence adapted from Circle's Apache-2.0 licensed reference:
// circlefin/sui-cctp@b23b83b0d957bb9dfd876e6c1aa02dbf89d88eba
// scripts/sui/ptbV2.ts. Copyright 2026 Circle Internet Group, Inc.
// These offline builders are NOT an enabled Mainnet transport. A verified
// deployment, simulation, wallet byte binding and independent recovery reader
// must be connected before the source write gate can be reviewed for opening.
import { Transaction, coinWithBalance } from '@mysten/sui/transactions'
import { getAddress, isAddress, hexToBytes, keccak256, stringToHex } from 'viem'
import { validateSuiWalletAccount } from './suiBalances'
import { decodeCctpRecoveryMessage, cctpWord } from './mainnetCctpRecovery'
import { ARC_CCTP_DOMAIN, SUI_CCTP_DOMAIN, SUI_NETWORKS } from '../config/sui'
import { getMainnetCctpChain } from '../config/mainnetCctp'

export type SuiCctpV2Deployment = {
  mtPackage: string; mtState: string; tmmPackage: string; tmmState: string
  handlerPackage: string; handlerState: string; treasury: string
  // Event/auth type identities retain original package IDs across upgrades.
  mtOriginalPackage: string; tmmOriginalPackage: string
  inboundAuthRecipient: `0x${string}`
}

export function validateSuiCctpDeployment(config: SuiCctpV2Deployment) {
  for (const value of Object.values(config)) {
    if (!/^0x[0-9a-f]{64}$/i.test(value) || /^0x0{64}$/i.test(value)) throw new Error('Missing or malformed CCTP V2 deployment identity.')
  }
  if (new Set([config.mtState, config.tmmState, config.handlerState, config.treasury].map(x => x.toLowerCase())).size !== 4) throw new Error('CCTP shared-state identities overlap.')
  const auth = keccak256(stringToHex(`${config.tmmOriginalPackage.slice(2).toLowerCase()}::message_transmitter_authenticator::MessageTransmitterAuthenticator`))
  if (config.inboundAuthRecipient.toLowerCase() !== auth) throw new Error('CCTP authenticator does not match the original package identity.')
}

function baseTransaction(sender: string, gasBudget: bigint) {
  validateSuiWalletAccount({ address: sender, chains: ['sui:mainnet'] }, 'mainnet')
  if (gasBudget <= 0n || gasBudget > (1n << 64n) - 1n) throw new Error('A valid explicit SUI gas budget is required.')
  const tx = new Transaction()
  tx.setSender(sender)
  tx.setGasBudget(gasBudget)
  return tx
}

export function buildSuiToArcBurn(config: SuiCctpV2Deployment, input: { sender: string; recipient: string; amount: bigint; maxFee: bigint; gasBudget: bigint }) {
  validateSuiCctpDeployment(config)
  if (!isAddress(input.recipient) || /^0x0{40}$/i.test(input.recipient)) throw new Error('Invalid Arc recipient.')
  if (input.amount <= 0n || input.amount > (1n << 64n) - 1n || input.maxFee < 0n || input.maxFee >= input.amount) throw new Error('Invalid USDC amount or maximum fee.')
  const tx = baseTransaction(input.sender, input.gasBudget)
  const usdc = SUI_NETWORKS.mainnet.usdcCoinType
  // The Mysten intent resolver supports both SIP-58 address balances and coins;
  // never treat a successful empty Coin-object list as zero total USDC.
  const coin = tx.add(coinWithBalance({ type: usdc, balance: input.amount }))
  const [receipt, returnedCoin] = tx.moveCall({
    target: `${config.tmmPackage}::deposit_for_burn::deposit_for_burn`,
    typeArguments: [usdc],
    arguments: [coin, tx.pure.u32(ARC_CCTP_DOMAIN), tx.pure.address(cctpWord(getAddress(input.recipient))), tx.pure.address(cctpWord(getAddress(input.recipient))), tx.pure.u256(input.maxFee), tx.pure.u32(2000), tx.pure.vector('u8', []), tx.object(config.tmmState)],
  })
  const [ticket] = tx.moveCall({ target: `${config.handlerPackage}::handler::burn`, arguments: [tx.object(config.handlerState), receipt, returnedCoin, tx.object('0x403'), tx.object(config.treasury)] })
  tx.moveCall({ target: `${config.tmmPackage}::deposit_for_burn::complete_burn`, typeArguments: [usdc, `${config.handlerPackage}::handler::Auth`], arguments: [ticket, tx.object(config.tmmState), tx.object(config.mtState)] })
  return tx
}

export function buildArcToSuiMint(config: SuiCctpV2Deployment, input: { sender: string; message: `0x${string}`; attestation: `0x${string}`; gasBudget: bigint }) {
  validateSuiCctpDeployment(config)
  const m = decodeCctpRecoveryMessage(input.message)
  const arc = getMainnetCctpChain(5042)
  if (!arc || m.sender !== cctpWord(arc.tokenMessengerAddress).toLowerCase() || m.burnToken !== cctpWord(arc.usdcAddress).toLowerCase()) throw new Error('CCTP message does not use the Arc USDC/messenger deployment.')
  // Matching source receipt, remote messenger/token, fees, expiration and nonce
  // consumption must additionally be established by the recovery/read port.
  if (m.sourceDomain !== ARC_CCTP_DOMAIN || m.destinationDomain !== SUI_CCTP_DOMAIN || m.mintRecipient.toLowerCase() !== input.sender.toLowerCase() || m.recipient.toLowerCase() !== config.inboundAuthRecipient.toLowerCase() || ![input.sender.toLowerCase(), `0x${'0'.repeat(64)}`].includes(m.destinationCaller.toLowerCase()) || m.minFinality !== 2000 || m.executedFinality < 2000 || /^0x0{64}$/.test(m.nonce) || m.amount <= 0n || m.amount > (1n << 64n) - 1n || m.feeExecuted > m.maxFee || m.maxFee >= m.amount) throw new Error('CCTP message does not match this Sui mint.')
  if (!/^0x(?:[0-9a-f]{130}){1,20}$/i.test(input.attestation)) throw new Error('Invalid Circle attestation encoding.')
  const tx = baseTransaction(input.sender, input.gasBudget)
  const usdc = SUI_NETWORKS.mainnet.usdcCoinType
  const [receipt] = tx.moveCall({ target: `${config.mtPackage}::receive_message::receive_message`, arguments: [tx.pure.vector('u8', [...hexToBytes(input.message)]), tx.pure.vector('u8', [...hexToBytes(input.attestation)]), tx.object(config.mtState)] })
  const [mintReceipt] = tx.moveCall({ target: `${config.tmmPackage}::handle_receive_message::prepare_mint`, typeArguments: [usdc], arguments: [receipt, tx.object(config.tmmState), tx.object('0x6')] })
  const [ticket] = tx.moveCall({ target: `${config.handlerPackage}::handler::mint`, arguments: [tx.object(config.handlerState), mintReceipt, tx.object(config.tmmState), tx.object(config.treasury), tx.object('0x403')] })
  tx.moveCall({ target: `${config.tmmPackage}::handle_receive_message::complete_mint`, typeArguments: [usdc, `${config.handlerPackage}::handler::Auth`], arguments: [ticket, tx.object(config.tmmState), tx.object(config.mtState)] })
  return tx
}
