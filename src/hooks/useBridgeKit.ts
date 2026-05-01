import { useState, useCallback, useEffect } from 'react';
import { useAccount, useSwitchChain, useWalletClient } from 'wagmi';
import { createAdapterFromProvider } from '@circle-fin/adapter-viem-v2';
import { BridgeKit, type BridgeResult } from '@circle-fin/bridge-kit';
import { type EIP1193Provider, createPublicClient, fallback, getAddress, http, parseAbi } from 'viem';
import { ethers } from 'ethers';
import {
  ARBITRUM_SEPOLIA_EVM_CHAIN,
  ARBITRUM_SEPOLIA_EVM_CHAIN_ID,
  ARC_EVM_CHAIN,
  ARC_EVM_CHAIN_ID,
  BASE_SEPOLIA_EVM_CHAIN,
  BASE_SEPOLIA_EVM_CHAIN_ID,
  OPTIMISM_SEPOLIA_EVM_CHAIN,
  OPTIMISM_SEPOLIA_EVM_CHAIN_ID,
  SEPOLIA_EVM_CHAIN,
  SEPOLIA_EVM_CHAIN_ID,
} from '../lib/chains';
import { logger } from '../lib/logger';

export const SEPOLIA_CHAIN_ID = SEPOLIA_EVM_CHAIN_ID;
export const ARC_CHAIN_ID = ARC_EVM_CHAIN_ID;
export const BASE_CHAIN_ID = BASE_SEPOLIA_EVM_CHAIN_ID;
export const OPTIMISM_CHAIN_ID = OPTIMISM_SEPOLIA_EVM_CHAIN_ID;
export const ARBITRUM_CHAIN_ID = ARBITRUM_SEPOLIA_EVM_CHAIN_ID;

export type BridgeToken = 'USDC';
export type BridgeStep = 
  | 'idle' 
  | 'switching-network'
  | 'approving' 
  | 'signing-bridge'
  | 'waiting-receive-message'
  | 'success' 
  | 'error';

export interface BridgeState {
  step: BridgeStep;
  error: string | null;
  result: any | null;
  isLoading: boolean;
  sourceTxHash?: string;
  receiveTxHash?: string;
  sourceChainId?: number;
  destinationChainId?: number;
}

export interface TokenInfo {
  symbol: string;
  name: string;
  decimals: number;
  contractAddress: string;
}

// Token configurations for both chains - Bridge Kit USDC addresses
export const CHAIN_TOKENS: Record<number, Record<BridgeToken, TokenInfo>> = {
  [SEPOLIA_CHAIN_ID]: {
    USDC: {
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      contractAddress: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238', // Bridge Kit USDC on Sepolia
    },
  },
  [ARC_CHAIN_ID]: {
    USDC: {
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      contractAddress: '0x3600000000000000000000000000000000000000', // Bridge Kit USDC on Arc Testnet
    },
  },
  [BASE_CHAIN_ID]: {
    USDC: {
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      contractAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia USDC
    },
  },
  [OPTIMISM_CHAIN_ID]: {
    USDC: {
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      contractAddress: '0x5fd84259d66cd46123540766be93dfe6d43130d7', // Optimism Sepolia USDC
    },
  },
  [ARBITRUM_CHAIN_ID]: {
    USDC: {
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      contractAddress: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d', // Arbitrum Sepolia USDC
    },
  },
};

export const CHAIN_NAMES = {
  [SEPOLIA_CHAIN_ID]: 'Sepolia',
  [ARC_CHAIN_ID]: 'Arc Testnet',
  [BASE_CHAIN_ID]: 'Base Sepolia',
  [OPTIMISM_CHAIN_ID]: 'Optimism Sepolia',
  [ARBITRUM_CHAIN_ID]: 'Arbitrum Sepolia',
};

const SUPPORTED_BRIDGE_ROUTES = new Set<string>([
  `${SEPOLIA_CHAIN_ID}-${ARC_CHAIN_ID}`,
  `${ARC_CHAIN_ID}-${SEPOLIA_CHAIN_ID}`,
  `${BASE_CHAIN_ID}-${ARC_CHAIN_ID}`,
  `${ARC_CHAIN_ID}-${BASE_CHAIN_ID}`,
  `${OPTIMISM_CHAIN_ID}-${ARC_CHAIN_ID}`,
  `${ARC_CHAIN_ID}-${OPTIMISM_CHAIN_ID}`,
  `${ARBITRUM_CHAIN_ID}-${ARC_CHAIN_ID}`,
  `${ARC_CHAIN_ID}-${ARBITRUM_CHAIN_ID}`,
]);

function getChainName(chainId: number) {
  return CHAIN_NAMES[chainId as keyof typeof CHAIN_NAMES] ?? `Chain ${chainId}`;
}

export const PENDING_BRIDGE_KEY = 'arc_pending_bridge';

export interface PendingBridgeRecord {
  sourceChainId: number;
  destinationChainId: number;
  amount: string;
  token: string;
  walletAddress: string;
  startedAt: number; // Date.now()
  step?: BridgeStep;
  signatureCount?: number;
  approvalTxHash?: string;
  sourceTxHash?: string;
  receiveTxHash?: string;
  txHashes?: string[];
}

const readPendingBridge = (): PendingBridgeRecord | null => {
  try {
    const raw = localStorage.getItem(PENDING_BRIDGE_KEY);
    return raw ? JSON.parse(raw) as PendingBridgeRecord : null;
  } catch {
    return null;
  }
};

const writePendingBridge = (record: PendingBridgeRecord) => {
  localStorage.setItem(PENDING_BRIDGE_KEY, JSON.stringify(record));
};

const updatePendingBridge = (patch: Partial<PendingBridgeRecord>) => {
  const current = readPendingBridge();
  if (!current) {
    return;
  }

  writePendingBridge({
    ...current,
    ...patch,
  });
};

type RetryStep = {
  name: string;
  state: 'pending' | 'success' | 'error' | 'noop';
  txHash?: string;
};

const buildRetryStepsFromTxHashes = (txHashes: string[]): RetryStep[] => {
  if (txHashes.length === 0) {
    return [{ name: 'Burn', state: 'pending' }];
  }

  if (txHashes.length === 1) {
    return [{ name: 'Burn', state: 'success', txHash: txHashes[0] }];
  }

  return [
    { name: 'Approve', state: 'success', txHash: txHashes[0] },
    { name: 'Burn', state: 'success', txHash: txHashes[1] },
  ];
};

// ERC20 ABI for balance reading
const ERC20_ABI = parseAbi([
  'function balanceOf(address account) external view returns (uint256)',
]);

interface Eip1193RequestArguments {
  method: string;
  params?: unknown[] | Record<string, unknown>;
}

// Public clients for each chain with timeout
const createClientWithTimeout = (url: string) => {
  return createPublicClient({
    transport: http(url, {
      timeout: 3000, // 3 second timeout
      retryCount: 0, // No retries
    }),
  });
};

const createClientWithFallback = (urls: readonly string[]) => {
  if (urls.length === 1) {
    return createClientWithTimeout(urls[0]);
  }

  return createPublicClient({
    transport: fallback(
      urls.map((url) =>
        http(url, {
          timeout: 3000,
          retryCount: 0,
        }),
      ),
    ),
  });
};

const publicClients: Record<number, any> = {
  [SEPOLIA_CHAIN_ID]: createClientWithFallback(SEPOLIA_EVM_CHAIN.rpcUrls.default.http),
  [ARC_CHAIN_ID]: createClientWithFallback(ARC_EVM_CHAIN.rpcUrls.default.http),
  [BASE_CHAIN_ID]: createClientWithFallback(BASE_SEPOLIA_EVM_CHAIN.rpcUrls.default.http),
  [OPTIMISM_CHAIN_ID]: createClientWithFallback(OPTIMISM_SEPOLIA_EVM_CHAIN.rpcUrls.default.http),
  [ARBITRUM_CHAIN_ID]: createClientWithFallback(ARBITRUM_SEPOLIA_EVM_CHAIN.rpcUrls.default.http),
};

let bridgeKitInstance: BridgeKit | null = null;

export function useBridgeKit() {
  const { address, isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { data: walletClient } = useWalletClient();

  const [state, setState] = useState<BridgeState>({
    step: 'idle',
    error: null,
    result: null,
    isLoading: false,
    sourceTxHash: undefined,
    receiveTxHash: undefined,
    sourceChainId: undefined,
    destinationChainId: undefined,
  });

  const [tokenBalance, setTokenBalance] = useState('0');
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);
  const [balanceError, setBalanceError] = useState('');

  // Initialize Bridge Kit
  useEffect(() => {
    const initBridgeKit = async () => {
      try {
        if (!bridgeKitInstance) {
          bridgeKitInstance = new BridgeKit();
          logger.debug('✅ Bridge Kit initialized');
        }
      } catch (err) {
        logger.error('❌ Failed to initialize Bridge Kit:', err);
      }
    };

    initBridgeKit();
  }, []);

  // Fetch token balance
  const getWalletProvider = useCallback(
    async (targetChainId: number) => {
      // walletClient.chain can lag briefly after a network switch; use active account chain.
      if (!walletClient || chainId !== targetChainId) {
        return null;
      }

      return new ethers.BrowserProvider(
        {
          request: async ({ method, params }: Eip1193RequestArguments) => {
            return walletClient.transport.request({ method, params } as never);
          },
        },
        {
          chainId: targetChainId,
          name: getChainName(targetChainId),
          ensAddress: walletClient.chain.contracts?.ensRegistry?.address,
        },
      );
    },
    [walletClient, chainId],
  );

  const fetchTokenBalance = useCallback(
    async (token: BridgeToken, targetChainId: number) => {
      if (!address) {
        setTokenBalance('0');
        setBalanceError('');
        return;
      }

      setIsLoadingBalance(true);
      setBalanceError('');

      try {
        const tokenInfo = CHAIN_TOKENS[targetChainId]?.[token];
        if (!tokenInfo) {
          throw new Error(`Token ${token} not found on chain ${targetChainId}`);
        }

        logger.debug(`🔍 Fetching ${token} balance from ${getChainName(targetChainId)}...`);
        const walletProvider = await getWalletProvider(targetChainId);

        let balance: bigint;

        if (walletProvider) {
          const tokenContract = new ethers.Contract(
            getAddress(tokenInfo.contractAddress),
            ['function balanceOf(address) view returns (uint256)'],
            walletProvider,
          );
          balance = await tokenContract.balanceOf(address);
        } else {
          const publicClient = publicClients[targetChainId];
          if (!publicClient) {
            throw new Error(`Public client not found for chain ${targetChainId}`);
          }

          balance = await publicClient.readContract({
            address: getAddress(tokenInfo.contractAddress),
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [address as `0x${string}`],
          });
        }

        const balanceFloat = Number(balance) / Math.pow(10, tokenInfo.decimals);
        setTokenBalance(balanceFloat.toFixed(6));
        logger.debug(`✅ Balance fetched for ${token} on chain ${targetChainId}: ${balanceFloat.toFixed(6)}`);
      } catch (err: any) {
        logger.warn(`⚠️ Balance fetch failed for ${getChainName(targetChainId)}: ${err.message}`);
        setTokenBalance('0.000000');
        setBalanceError(`Failed to read ${getChainName(targetChainId)} ${token} balance. Refresh or switch to that network and try again.`);
      } finally {
        setIsLoadingBalance(false);
      }
    },
    [address, getWalletProvider]
  );

  const getConnectedProvider = useCallback((): EIP1193Provider | null => {
    if (!walletClient) {
      return null;
    }

    return {
      request: async ({ method, params }: Eip1193RequestArguments) => {
        return walletClient.transport.request({ method, params } as never);
      },
    } as EIP1193Provider;
  }, [walletClient]);

  // Reset state
  const reset = useCallback(() => {
    setState({
      step: 'idle',
      error: null,
      result: null,
      isLoading: false,
      sourceTxHash: undefined,
      receiveTxHash: undefined,
      sourceChainId: undefined,
      destinationChainId: undefined,
    });
  }, []);

  const bridge = useCallback(
    async (
      token: BridgeToken,
      amount: string,
      route: {
        sourceChainId: number;
        destinationChainId: number;
      },
    ) => {
      if (!isConnected || !address) {
        setState({
          step: 'error',
          error: 'Please connect your wallet first',
          result: null,
          isLoading: false,
        });
        return;
      }

      if (!amount || parseFloat(amount) <= 0) {
        setState({
          step: 'error',
          error: `Please enter a valid ${token} amount`,
          result: null,
          isLoading: false,
        });
        return;
      }

      const { sourceChainId, destinationChainId } = route;
      const shouldTrackPendingBridge =
        destinationChainId === ARC_CHAIN_ID
        && (sourceChainId === OPTIMISM_CHAIN_ID || sourceChainId === BASE_CHAIN_ID);

      if (sourceChainId === destinationChainId) {
        setState({
          step: 'error',
          error: 'Source and destination chains must be different',
          result: null,
          isLoading: false,
        });
        return;
      }

      const routeKey = `${sourceChainId}-${destinationChainId}`;
      if (!SUPPORTED_BRIDGE_ROUTES.has(routeKey)) {
        setState({
          step: 'error',
          error: `Bridge route ${getChainName(sourceChainId)} -> ${getChainName(destinationChainId)} is not enabled yet.`,
          result: null,
          isLoading: false,
        });
        return;
      }

      // Save pending bridge for slower CCTP-to-Arc flows.
      if (shouldTrackPendingBridge) {
        const pendingEntry: PendingBridgeRecord = {
          sourceChainId,
          destinationChainId,
          amount,
          token,
          walletAddress: address,
          startedAt: Date.now(),
          step: 'idle',
          signatureCount: 0,
          txHashes: [],
        };
        writePendingBridge(pendingEntry);
      }

      try {
        setState(prev => ({
          ...prev,
          step: 'idle',
          error: null,
          isLoading: true,
          sourceChainId,
          destinationChainId,
        }));

        const provider = getConnectedProvider();
        if (!provider) {
          throw new Error('Connected wallet provider is not available. Reconnect your wallet and try again.');
        }

        if (!bridgeKitInstance) {
          bridgeKitInstance = new BridgeKit();
        }

        logger.debug(`🌉 Bridging ${amount} ${token} from ${getChainName(sourceChainId)} to ${getChainName(destinationChainId)}`);

        // Get supported chains from Bridge Kit
        const supportedChains = bridgeKitInstance.getSupportedChains();
        logger.debug(`📋 Supported chains:`, supportedChains.map((c: any) => ({
          name: c.name,
          chainId: 'chainId' in c ? c.chainId : 'unknown',
        })));

        // Find source and destination chains
        let sourceChain = supportedChains.find((c: any) => {
          const isEVM = 'chainId' in c;
          if (!isEVM) return false;
          return c.chainId === sourceChainId;
        });

        let destinationChain = supportedChains.find((c: any) => {
          const isEVM = 'chainId' in c;
          if (!isEVM) return false;
          return c.chainId === destinationChainId;
        });

        // Fallback: search by name for Sepolia
        if (!sourceChain && sourceChainId === SEPOLIA_CHAIN_ID) {
          sourceChain = supportedChains.find((c: any) => {
            const name = c.name.toLowerCase();
            return (name.includes('sepolia') || name.includes('ethereum')) && name.includes('sepolia');
          });
        }

        if (!destinationChain && destinationChainId === SEPOLIA_CHAIN_ID) {
          destinationChain = supportedChains.find((c: any) => {
            const name = c.name.toLowerCase();
            return (name.includes('sepolia') || name.includes('ethereum')) && name.includes('sepolia');
          });
        }

        // Fallback: search by name for Arc
        if (!sourceChain && sourceChainId === ARC_CHAIN_ID) {
          sourceChain = supportedChains.find((c: any) => c.name.toLowerCase().includes('arc'));
        }

        if (!destinationChain && destinationChainId === ARC_CHAIN_ID) {
          destinationChain = supportedChains.find((c: any) => c.name.toLowerCase().includes('arc'));
        }

        if (!sourceChain) {
          throw new Error(`Source chain ${sourceChainId} not supported by Bridge Kit`);
        }

        if (!destinationChain) {
          throw new Error(`Destination chain ${destinationChainId} not supported by Bridge Kit`);
        }

        logger.debug(`✅ Source chain: ${sourceChain.name}`);
        logger.debug(`✅ Destination chain: ${destinationChain.name}`);

        // Switch to source chain if needed and fail closed if the wallet stays on the wrong chain.
        if (chainId !== sourceChainId) {
          if (!switchChainAsync) {
            throw new Error(`Please switch your wallet to ${getChainName(sourceChainId)} before bridging.`);
          }

          setState(prev => ({ ...prev, step: 'switching-network' }));
          if (shouldTrackPendingBridge) {
            updatePendingBridge({ step: 'switching-network' });
          }

          try {
            await switchChainAsync({ chainId: sourceChainId });
            await new Promise(resolve => setTimeout(resolve, 1200));
          } catch (err: any) {
            throw new Error(
              err?.message?.includes('User rejected')
                ? `You rejected the switch to ${getChainName(sourceChainId)}.`
                : `Failed to switch your wallet to ${getChainName(sourceChainId)}.`
            );
          }
        }

        const trackedProvider: EIP1193Provider = {
          request: async (args: any) => {
            const { method, params } = args ?? {};
            const response = await (provider as any).request({ method, params } as any);

            if (
              shouldTrackPendingBridge
              &&
              (method === 'eth_sendTransaction' || method === 'eth_sendRawTransaction')
              && typeof response === 'string'
              && response.startsWith('0x')
            ) {
              const current = readPendingBridge();
              const txHashes = current?.txHashes ?? [];

              if (!txHashes.includes(response)) {
                const patch: Partial<PendingBridgeRecord> = {
                  txHashes: [...txHashes, response],
                };

                if (current?.step === 'waiting-receive-message') {
                  patch.receiveTxHash = response;
                } else if (!current?.approvalTxHash) {
                  patch.approvalTxHash = response;
                } else if (!current?.sourceTxHash) {
                  patch.sourceTxHash = response;
                }

                updatePendingBridge(patch);
              }
            }

            if (
              shouldTrackPendingBridge
              &&
              (
                method === 'eth_sign'
                || method === 'personal_sign'
                || method === 'eth_signTypedData'
                || method === 'eth_signTypedData_v3'
                || method === 'eth_signTypedData_v4'
              )
            ) {
              const current = readPendingBridge();
              const signatureCount = current?.signatureCount ?? 0;
              updatePendingBridge({
                signatureCount: signatureCount + 1,
              });
            }

            return response;
          },
          on: (event: any, listener: any) => {
            if (typeof (provider as any).on === 'function') {
              (provider as any).on(event, listener);
            }
          },
          removeListener: (event: any, listener: any) => {
            if (typeof (provider as any).removeListener === 'function') {
              (provider as any).removeListener(event, listener);
            }
          },
        };

        const activeChainHex = await trackedProvider.request({ method: 'eth_chainId' }) as string;
        const activeChainId = Number.parseInt(activeChainHex, 16);

        if (activeChainId !== sourceChainId) {
          throw new Error(`Wallet is still connected to the wrong chain. Switch to ${getChainName(sourceChainId)} and try again.`);
        }

        // Create adapter from the active wagmi wallet provider
        const adapter = await createAdapterFromProvider({
          provider: trackedProvider,
        });

        // Execute bridge
        setState(prev => ({ ...prev, step: 'approving' }));
        if (shouldTrackPendingBridge) {
          updatePendingBridge({ step: 'approving' });
        }
        logger.debug('🔄 Step changed to: approving');

        logger.debug(`🔄 Starting bridge transaction...`);
        logger.debug(`💰 Amount: ${amount} USDC`);

        const result = await bridgeKitInstance.bridge({
          from: {
            adapter: adapter,
            chain: sourceChain,
          },
          to: {
            adapter: adapter,
            chain: destinationChain,
          },
          amount: amount, // Bridge Kit expects string amount directly
        });

        logger.debug('✅ Bridge result:', result);

        // Update step to signing-bridge after approval
        setState(prev => ({ ...prev, step: 'signing-bridge' }));
        if (shouldTrackPendingBridge) {
          updatePendingBridge({ step: 'signing-bridge' });
        }

        // Update step to waiting for receive confirmation
        setState(prev => ({ ...prev, step: 'waiting-receive-message' }));
        if (shouldTrackPendingBridge) {
          updatePendingBridge({ step: 'waiting-receive-message' });
        }

        // Extract transaction hashes
        let sourceTxHash: string | undefined;
        let receiveTxHash: string | undefined;

        if (result && result.steps) {
          // steps[1] typically contains the burn/transfer tx
          if (result.steps[1]?.txHash) {
            sourceTxHash = result.steps[1].txHash;
          }

          if (result.steps[3]?.txHash) {
            receiveTxHash = result.steps[3].txHash;
          }
        }

        // Update step to waiting for receive confirmation
        setState(prev => ({ ...prev, step: 'waiting-receive-message' }));
        if (shouldTrackPendingBridge) {
          updatePendingBridge({
            step: 'waiting-receive-message',
            sourceTxHash: sourceTxHash ?? readPendingBridge()?.sourceTxHash,
            receiveTxHash: receiveTxHash ?? readPendingBridge()?.receiveTxHash,
            txHashes: [
              ...(readPendingBridge()?.txHashes ?? []),
              ...[sourceTxHash, receiveTxHash].filter((hash): hash is string => Boolean(hash)),
            ].filter((hash, index, hashes) => hashes.indexOf(hash) === index),
          });
        }
        logger.debug('🔄 Step changed to: waiting-receive-message');

        setState({
          step: 'success',
          error: null,
          result,
          isLoading: false,
          sourceTxHash,
          receiveTxHash,
          sourceChainId,
          destinationChainId,
        });

        logger.debug('🎉 Bridge successful!');
        if (shouldTrackPendingBridge) {
          localStorage.removeItem(PENDING_BRIDGE_KEY);
        }

        // Refresh balances after bridge
        setTimeout(async () => {
          logger.debug('🔄 Refreshing balances after bridge...');

          // Fetch both balances
          await fetchTokenBalance('USDC', sourceChainId);
          await fetchTokenBalance('USDC', destinationChainId);
          logger.debug('✅ Balances updated!');
        }, 1000); // Wait 1 second before refreshing
      } catch (err: any) {
        logger.error('❌ Bridge error:', err);
        if (shouldTrackPendingBridge) {
          localStorage.removeItem(PENDING_BRIDGE_KEY);
        }

        let errorMessage = err.message || 'Bridge transaction failed';

        if (errorMessage.includes('User rejected') || errorMessage.includes('user rejected')) {
          errorMessage = 'You rejected the bridge request in your wallet';
        } else if (errorMessage.includes('iris-api-sandbox.circle.com') && errorMessage.includes('404')) {
          errorMessage = 'Circle attestation is not indexed yet (404). Wait 2-5 minutes and try Continue pending bridge again.';
        } else if (errorMessage.includes('Insufficient funds')) {
          errorMessage = 'Insufficient balance for bridge transaction';
        } else if (errorMessage.includes('not supported')) {
          errorMessage = `Bridge Kit doesn't support this chain. Make sure Arc Testnet is properly configured.`;
        }

        setState({
          step: 'error',
          error: errorMessage,
          result: null,
          isLoading: false,
        });
      }
    },
    [address, isConnected, chainId, switchChainAsync, fetchTokenBalance, getConnectedProvider]
  );

  const resumePendingBridge = useCallback(
    async (pending: PendingBridgeRecord) => {
      if (!isConnected || !address) {
        setState({
          step: 'error',
          error: 'Please connect your wallet first',
          result: null,
          isLoading: false,
        });
        return;
      }

      if (!bridgeKitInstance) {
        bridgeKitInstance = new BridgeKit();
      }

      try {
        setState((prev) => ({
          ...prev,
          step: 'waiting-receive-message',
          error: null,
          isLoading: true,
          sourceChainId: pending.sourceChainId,
          destinationChainId: pending.destinationChainId,
        }));

        const provider = getConnectedProvider();
        if (!provider) {
          throw new Error('Connected wallet provider is not available. Reconnect your wallet and try again.');
        }

        const adapter = await createAdapterFromProvider({ provider });
        const supportedChains = bridgeKitInstance.getSupportedChains();

        const sourceChain = supportedChains.find((c: any) => ('chainId' in c) && c.chainId === pending.sourceChainId);
        const destinationChain = supportedChains.find((c: any) => ('chainId' in c) && c.chainId === pending.destinationChainId);

        if (!sourceChain || !destinationChain) {
          throw new Error('Could not map pending bridge chains to supported BridgeKit routes.');
        }

        const txHashes = pending.txHashes ?? [];
        const failedResult: BridgeResult = {
          amount: pending.amount,
          token: 'USDC',
          state: 'error',
          provider: 'CCTPV2BridgingProvider',
          source: {
            address,
            chain: sourceChain,
          },
          destination: {
            address,
            chain: destinationChain,
          },
          steps: buildRetryStepsFromTxHashes(txHashes),
        };

        logger.debug('🔄 Attempting to resume pending bridge via BridgeKit retry...');
        const result = await bridgeKitInstance.retry(failedResult, {
          from: adapter,
          to: adapter,
        });

        let sourceTxHash: string | undefined;
        let receiveTxHash: string | undefined;

        if (result && result.steps) {
          sourceTxHash = result.steps.find((step) => step.name.toLowerCase().includes('burn'))?.txHash;
          receiveTxHash = result.steps.find((step) => step.name.toLowerCase().includes('mint'))?.txHash;
        }

        setState({
          step: 'success',
          error: null,
          result,
          isLoading: false,
          sourceTxHash,
          receiveTxHash,
          sourceChainId: pending.sourceChainId,
          destinationChainId: pending.destinationChainId,
        });

        localStorage.removeItem(PENDING_BRIDGE_KEY);
        logger.debug('✅ Pending bridge resumed successfully.');
      } catch (err: any) {
        logger.error('❌ Pending bridge resume failed:', err);
        setState((prev) => ({
          ...prev,
          step: 'error',
          error: err?.message || 'Could not resume the pending bridge automatically.',
          isLoading: false,
        }));
      }
    },
    [address, getConnectedProvider, isConnected]
  );

  return {
    state,
    tokenBalance,
    isLoadingBalance,
    balanceError,
    fetchTokenBalance,
    bridge,
    resumePendingBridge,
    reset,
  };
}
