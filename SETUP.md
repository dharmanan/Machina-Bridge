# Arc Sepolia DEX Bridge - Setup & Deployment Guide

## 🚀 Quick Start

### 1. Prerequisites
- Node.js 18+
- npm or yarn
- MetaMask wallet
- Sepolia testnet ETH

### 2. Installation

```bash
# Clone repository
git clone <repo-url>
cd arc-sepolia-dex-bridge

# Install dependencies
npm install --legacy-peer-deps

# Setup environment
cp .env.example .env.local
# Edit .env.local with your values
```

### 3. Development

```bash
npm run dev
# App will be available at http://localhost:5173
```

### 4. Build for Production

```bash
npm run build
npm run preview
```

## 📋 Features

### Swap Tab
- **ETH ↔ USDC Swapping** on Sepolia testnet
- Real-time price estimation via Uniswap V2
- Adjustable slippage tolerance (0.1% - 5%)
- Direct wallet integration with MetaMask
- Transaction confirmation and feedback

### Bridge Tab
- **Bridge USDC** from Sepolia to Arc Testnet
- Circle Bridge Kit integration ready
- Balance display
- Transaction tracking

### Dashboard Tab
- **Wallet Info** - Connected address and network
- **Token Balances** - ETH and USDC holdings
- **Transaction History** - Recent operations

## 🔧 Key Addresses (Sepolia Testnet)

```
Uniswap V2 Router:  0x68b3465833fb72B5A828cCEEAa5BE01d33e3B3d8
Uniswap Factory:    0x1F98431c8aD98523631AE4a59f267346ea3113F
WETH:               0xfFf9976782d46CC05630D06953f7751f7DA666DC
USDC:               0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
```

## 🛠️ Stack

- **Frontend**: React 18 + TypeScript
- **Build**: Vite
- **Styling**: Tailwind CSS
- **Web3**: ethers.js + wagmi + RainbowKit
- **DEX**: Uniswap V2 SDK
- **Bridge**: Circle Bridge Kit (integration ready)

## 📝 Implementation Notes

### Swap Logic
1. Uses Uniswap V2 Router on Sepolia
2. Fetches prices via `getAmountsOut()`
3. Executes swap with slippage protection
4. Handles both ETH→USDC and USDC→ETH

### Bridge Logic
- Currently simulated for demo
- Ready for Circle Bridge Kit integration
- Requires approval for ERC20 transfers
- Tracks transaction hashes

## 🔐 Security Notes

- Always verify contract addresses before transactions
- Use MetaMask wallet for signing
- Transactions occur on testnet (no real funds at risk)
- Slippage tolerance protects against price impact

## 📚 Useful Resources

- [Uniswap V2 Docs](https://docs.uniswap.org/contracts/v2/overview)
- [ethers.js Docs](https://docs.ethers.org/v6/)
- [wagmi Docs](https://wagmi.sh/)
- [Sepolia Faucet](https://www.sepoliafaucet.com/)
- [Circle Bridge Kit](https://developers.circle.com/bridge-kit)

## 🐛 Troubleshooting

**Wallet not connecting?**
- Make sure MetaMask is installed
- Check that you're on Sepolia testnet
- Try refreshing the page

**Swap fails?**
- Ensure you have enough ETH for gas
- Check slippage tolerance
- Verify token addresses

**Bridge not working?**
- Requires Circle Bridge Kit API setup
- Ensure USDC balance is sufficient
- Check testnet connectivity

## 📧 Support

For issues or questions, please create an issue on the GitHub repository.

## 📄 License

MIT
