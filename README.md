# Arc Sepolia DEX Bridge

Sepolia testnetinde ETH ↔ USDC swap ve Arc testnetine USDC bridge uygulaması.

## 🚀 Features

- **Swap**: Uniswap V2 kullanarak ETH ↔ USDC swap
- **Bridge**: Circle Bridge Kit ile USDC'yi Sepolia'dan Arc'a bridge et
- **Dashboard**: Bakiyeler ve işlem geçmişi görüntüle
- **Wallet Connect**: MetaMask ile bağlantı

## 📦 Tech Stack

- React 18 + TypeScript
- Vite
- Wagmi + RainbowKit
- Ethers.js
- Tailwind CSS
- Circle Bridge Kit
- Uniswap SDK

## 🛠️ Setup

```bash
npm install
npm run dev
```

## 📋 Networks

- **Sepolia**: Uniswap V2 + USDC
- **Arc Testnet**: Bridge destination

## 🔧 Uniswap Sepolia Adresleri

- Router V2: `0x68b3465833fb72B5A828cCEEAa5BE01d33e3B3d8`
- WETH: `0xfFf9976782d46CC05630D06953f7751f7DA666DC`
- USDC: `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`

## 📝 License

MIT
