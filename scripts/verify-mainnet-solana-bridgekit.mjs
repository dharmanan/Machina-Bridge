import { BridgeKit } from '@circle-fin/bridge-kit'

const ARC_MAINNET_CHAIN_ID = 5042

function isEvmChain(chain) {
  return chain && typeof chain === 'object' && 'chainId' in chain
}

function isSolanaChain(chain) {
  return chain
    && typeof chain === 'object'
    && !('chainId' in chain)
    && String(chain.name ?? '').toLowerCase().includes('solana')
}

function main() {
  console.log('=== Bridge Kit Solana ↔ Arc mainnet support check ===')
  console.log('Read-only only. No wallet signature and no transaction broadcast.\n')

  const kit = new BridgeKit()
  const chains = kit.getSupportedChains()

  const solanaMainnet = chains.find(
    (chain) => isSolanaChain(chain) && chain.isTestnet === false,
  )
  const arcMainnet = chains.find(
    (chain) => isEvmChain(chain) && Number(chain.chainId) === ARC_MAINNET_CHAIN_ID,
  )

  console.log(
    `${solanaMainnet ? 'PASS' : 'FAIL'}  Solana mainnet chain`
    + (solanaMainnet ? ` — ${solanaMainnet.name}` : ''),
  )
  console.log(
    `${arcMainnet ? 'PASS' : 'FAIL'}  Arc mainnet chain`
    + (arcMainnet ? ` — ${arcMainnet.name} / ${arcMainnet.chainId}` : ''),
  )

  const mainnetNames = chains
    .filter((chain) => chain?.isTestnet === false)
    .map((chain) => isEvmChain(chain)
      ? `${chain.name}:${chain.chainId}`
      : String(chain.name ?? 'unknown'))
    .sort()

  console.log('\nBridge Kit mainnet chains:')
  for (const name of mainnetNames) {
    console.log(`- ${name}`)
  }

  const ok = Boolean(solanaMainnet && arcMainnet)

  console.log('\n=== RESULT ===')
  console.log(ok
    ? 'MAINNET_SOLANA_BRIDGEKIT_SUPPORT=PASS'
    : 'MAINNET_SOLANA_BRIDGEKIT_SUPPORT=FAIL')
  console.log('TRANSACTION_BROADCAST=NO')

  if (!ok) {
    process.exitCode = 1
  }
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  console.log('MAINNET_SOLANA_BRIDGEKIT_SUPPORT=FAIL')
  console.log('TRANSACTION_BROADCAST=NO')
  process.exitCode = 1
}
