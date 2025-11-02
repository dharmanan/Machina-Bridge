export const SEPOLIA_TESTNET = {
  id: 11155111,
  name: 'Sepolia',
  network: 'sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: ['https://rpc.sepolia.org'],
    },
  },
  blockExplorers: {
    default: { name: 'Etherscan', url: 'https://sepolia.etherscan.io' },
  },
  testnet: true,
}

export const ARC_TESTNET = {
  id: 42124,
  name: 'Arc Testnet',
  network: 'arc-testnet',
  nativeCurrency: { name: 'Arc', symbol: 'ARC', decimals: 18 },
  rpcUrls: {
    default: {
      http: ['https://rpc.testnet.arccoin.io'],
    },
  },
  blockExplorers: {
    default: { name: 'ArcScan', url: 'https://testnet.arcscan.io' },
  },
  testnet: true,
}

// SushiSwap Sepolia Addresses (çalışan Sepolia DEX)
export const SUSHISWAP_SEPOLIA = {
  ROUTER: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', // SushiSwap Router
  FACTORY: '0xFBC12984063f1e1339AC3bd02d1adBAc89fED8ab',
  WETH: '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9',
  USDC: '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI (USDC yerine)
}

// Token decimals
export const TOKEN_DECIMALS = {
  ETH: 18,
  USDC: 6,
}

// Circle Bridge Kit config
export const CIRCLE_CONFIG = {
  appId: import.meta.env.VITE_CIRCLE_APP_ID || '',
  apiKey: import.meta.env.VITE_CIRCLE_API_KEY || '',
}
