import { Connection, PublicKey } from '@solana/web3.js'
import { SOLANA_MAINNET_CCTP } from '../config/mainnetSolana'

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

export type SolanaNetworkProfile = 'testnet' | 'mainnet'

export const SOLANA_DEVNET_NAME = 'Solana Devnet'
export const SOLANA_DEVNET_RPC_URL = import.meta.env.VITE_SOLANA_DEVNET_RPC?.trim() || 'https://api.devnet.solana.com'
export const SOLANA_DEVNET_DOMAIN_ID = 5
export const SOLANA_DEVNET_USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
export const SOLANA_DEVNET_GATEWAY_MINTER = new PublicKey('GATEmKK2ECL1brEngQZWCgMWPbvrEYqsV6u29dAaHavr')

export const SOLANA_MAINNET_NAME = SOLANA_MAINNET_CCTP.name
export const SOLANA_MAINNET_RPC_URL = SOLANA_MAINNET_CCTP.rpcUrl
export const SOLANA_MAINNET_DOMAIN_ID = SOLANA_MAINNET_CCTP.cctpDomain
export const SOLANA_MAINNET_USDC_MINT = new PublicKey(SOLANA_MAINNET_CCTP.usdcMint)

export function getSolanaNetworkConfig(network: SolanaNetworkProfile = 'testnet') {
  if (network === 'mainnet') {
    return {
      name: SOLANA_MAINNET_NAME,
      rpcUrl: SOLANA_MAINNET_RPC_URL,
      domainId: SOLANA_MAINNET_DOMAIN_ID,
      usdcMint: SOLANA_MAINNET_USDC_MINT,
    } as const
  }

  return {
    name: SOLANA_DEVNET_NAME,
    rpcUrl: SOLANA_DEVNET_RPC_URL,
    domainId: SOLANA_DEVNET_DOMAIN_ID,
    usdcMint: SOLANA_DEVNET_USDC_MINT,
  } as const
}

export function createSolanaConnection(network: SolanaNetworkProfile = 'testnet') {
  return new Connection(getSolanaNetworkConfig(network).rpcUrl, 'confirmed')
}

export function createSolanaDevnetConnection() {
  return createSolanaConnection('testnet')
}

export function createSolanaMainnetConnection() {
  return createSolanaConnection('mainnet')
}

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `0x${hex}`
}

export function isValidSolanaAddress(address: string) {
  try {
    new PublicKey(address.trim())
    return true
  } catch {
    return false
  }
}

export function toSolanaBytes32Hex(publicKey: PublicKey | string) {
  const resolvedKey = typeof publicKey === 'string' ? new PublicKey(publicKey.trim()) : publicKey
  return bytesToHex(resolvedKey.toBytes())
}

export function deriveSolanaUsdcAta(
  ownerAddress: string,
  network: SolanaNetworkProfile = 'testnet',
) {
  const owner = new PublicKey(ownerAddress.trim())
  const { usdcMint } = getSolanaNetworkConfig(network)
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), usdcMint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )

  return {
    owner,
    ata,
    ownerHex: toSolanaBytes32Hex(owner),
    ataHex: toSolanaBytes32Hex(ata),
  }
}

export async function fetchSolanaUsdcBalance(
  ownerAddress: string,
  network: SolanaNetworkProfile = 'testnet',
  connection?: Connection,
) {
  const owner = new PublicKey(ownerAddress.trim())
  const { usdcMint } = getSolanaNetworkConfig(network)

  const readBalance = async (activeConnection: Connection) => {
    const response = await activeConnection.getParsedTokenAccountsByOwner(owner, {
      mint: usdcMint,
    })

    const totalBalance = response.value.reduce((runningTotal, accountInfo) => {
      const parsedInfo = (accountInfo.account.data as any)?.parsed?.info?.tokenAmount
      const uiAmountString = parsedInfo?.uiAmountString
      const uiAmount = typeof uiAmountString === 'string'
        ? Number.parseFloat(uiAmountString)
        : Number(parsedInfo?.uiAmount || 0)

      if (!Number.isFinite(uiAmount)) {
        return runningTotal
      }

      return runningTotal + uiAmount
    }, 0)

    return totalBalance.toFixed(6)
  }

  if (connection) {
    return readBalance(connection)
  }

  if (network === 'testnet') {
    return readBalance(createSolanaConnection('testnet'))
  }

  let lastError: unknown = null

  for (const rpcUrl of SOLANA_MAINNET_CCTP.rpcUrls) {
    try {
      return await readBalance(new Connection(rpcUrl, 'confirmed'))
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Unable to read Solana mainnet USDC balance from configured RPCs.')
}
