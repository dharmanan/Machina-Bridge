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

// Sepolia Uniswap V2 Addresses
export const UNISWAP_SEPOLIA = {
  ROUTER: '0x68b3465833fb72B5A828cCEEAa5BE01d33e3B3d8',
  FACTORY: '0x1F98431c8aD98523631AE4a59f267346ea3113F',
  WETH: '0xfFf9976782d46CC05630D06953f7751f7DA666DC',
  USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
}

// Token decimals
export const TOKEN_DECIMALS = {
  ETH: 18,
  USDC: 6,
}

// Circle Bridge Kit config
export const CIRCLE_CONFIG = {
  appId: process.env.REACT_APP_CIRCLE_APP_ID || '',
  apiKey: process.env.REACT_APP_CIRCLE_API_KEY || '',
}
