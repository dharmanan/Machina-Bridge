// Test utilities for local development

export const MOCK_TOKENS = {
  ETH: {
    address: '0xfFf9976782d46CC05630D06953f7751f7DA666DC',
    name: 'Ethereum',
    symbol: 'ETH',
    decimals: 18,
    balance: '2.5',
  },
  USDC: {
    address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    name: 'USD Coin',
    symbol: 'USDC',
    decimals: 6,
    balance: '1000',
  },
}

export const MOCK_SWAP_RESPONSE = {
  amountsOut: ['1000000000000000000', '2500000000'],
  path: [
    '0xfFf9976782d46CC05630D06953f7751f7DA666DC',
    '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  ],
}

export const MOCK_BRIDGE_TX = {
  hash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
  from: '0x1234567890123456789012345678901234567890',
  to: '0x0987654321098765432109876543210987654321',
  value: '1000000000',
  gasPrice: '20000000000',
  gasLimit: '300000',
}

// Helper functions for testing

export const logTestInfo = (title: string, data: any) => {
  console.log(`\n📝 ${title}:`, data)
}

export const logSuccess = (message: string) => {
  console.log(`✅ ${message}`)
}

export const logError = (message: string, error?: any) => {
  console.error(`❌ ${message}`, error)
}

export const logWarning = (message: string) => {
  console.warn(`⚠️ ${message}`)
}
