import { useState, useCallback, useEffect } from 'react';
import { useAccount, useSwitchChain, useWalletClient } from 'wagmi';
import { createAdapterFromProvider } from '@circle-fin/adapter-viem-v2';
import { BridgeKit, type BridgeResult } from '@circle-fin/bridge-kit';
import { CCTPV2BridgingProvider } from '@circle-fin/provider-cctp-v2';
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
import { markTrackedTransferMinted, registerTrackedTransfer, upsertServerBridgeActivity } from '../lib/transferTrackerApi';

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
  id?: string;
  sourceChainId: number;
  destinationChainId: number;
  amount: string;
  token: string;
  walletAddress: string;
  startedAt: number; // Date.now()
  status?: 'awaiting_approve' | 'awaiting_burn' | 'pending_attestation' | 'ready_to_mint' | 'minted' | 'failed' | 'dismissed';
  step?: BridgeStep;
  signatureCount?: number;
  approvalTxHash?: string;
  sourceTxHash?: string;
  receiveTxHash?: string;
  txHashes?: string[];
}

export interface BridgeActivityRecord extends PendingBridgeRecord {
  id: string;
  updatedAt: number;
}

export const BRIDGE_ACTIVITY_KEY = 'arc_bridge_activity';
const BRIDGE_ACTIVITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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

const readMessageDestinationDomain = (message: any): number | null => {
  const value = message?.destinationDomain ?? message?.destination_domain ?? message?.destination_domain_id;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
};

const readAttestationValue = (message: any): string => {
  const value =
    message?.attestation
    ?? message?.signedAttestation
    ?? message?.signed_attestation
    ?? message?.attestationSignature;
  return typeof value === 'string' ? value : '';
};

const isAttestationReady = (message: any): boolean => {
  const attestation = readAttestationValue(message);
  const hasHexAttestation = attestation.startsWith('0x') && attestation.length > 130 && attestation.toLowerCase() !== 'pending';
  if (hasHexAttestation) {
    return true;
  }

  const statusRaw = message?.attestationStatus ?? message?.attestation_status;
  const status = typeof statusRaw === 'string' ? statusRaw.toLowerCase() : '';
  return status === 'complete' || status === 'ready' || status === 'available';
};

const isIrisStatusReady = (message: any): boolean => {
  const status = typeof message?.status === 'string' ? message.status.toLowerCase() : '';
  return status === 'complete' || status === 'attested' || status === 'ready_to_mint' || status === 'ready';
};

const hasDestinationMintTx = (message: any) => {
  const destinationTxHash =
    message?.destinationTxHash
    ?? message?.destination_tx_hash
    ?? message?.destinationTransactionHash
    ?? message?.mintTxHash;
  return typeof destinationTxHash === 'string' && destinationTxHash.startsWith('0x') && destinationTxHash.length > 10;
};

const isIrisMessageMintReady = (message: any, expectedDestinationDomain?: number) => {
  const readyByStatus = isIrisStatusReady(message);
  const readyByAttestation = isAttestationReady(message);
  const destinationDomain = readMessageDestinationDomain(message);
  const destinationMatches = expectedDestinationDomain == null || destinationDomain == null || destinationDomain === expectedDestinationDomain;
  const alreadyMinted = hasDestinationMintTx(message);
  return (readyByStatus || readyByAttestation) && destinationMatches && !alreadyMinted;
};

const isNonceAlreadyUsedError = (error: unknown) => {
  const message = String((error as any)?.message ?? error ?? '').toLowerCase();
  return message.includes('nonce already used');
};

const readBridgeActivities = (): BridgeActivityRecord[] => {
  try {
    const raw = localStorage.getItem(BRIDGE_ACTIVITY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      return [];
    }

    const cutoffMs = Date.now() - BRIDGE_ACTIVITY_RETENTION_MS;
    return parsed.filter((record) => {
      const ts = Number(record?.updatedAt ?? record?.startedAt ?? 0);
      return Number.isFinite(ts) && ts >= cutoffMs;
    });
  } catch {
    return [];
  }
};

const writeBridgeActivities = (records: BridgeActivityRecord[]) => {
  const cutoffMs = Date.now() - BRIDGE_ACTIVITY_RETENTION_MS;
  const retained = records
    .filter((record) => {
      const ts = Number(record?.updatedAt ?? record?.startedAt ?? 0);
      return Number.isFinite(ts) && ts >= cutoffMs;
    })
    .sort((a, b) => Number(b.updatedAt ?? b.startedAt ?? 0) - Number(a.updatedAt ?? a.startedAt ?? 0));

  localStorage.setItem(BRIDGE_ACTIVITY_KEY, JSON.stringify(retained));
};

const upsertBridgeActivity = (record: BridgeActivityRecord) => {
  const normalized: BridgeActivityRecord = {
    ...record,
    id: record.id,
    updatedAt: Number(record.updatedAt ?? Date.now()),
  };

  const all = readBridgeActivities();
  const next = [
    normalized,
    ...all.filter((item) => item.id !== normalized.id),
  ];
  writeBridgeActivities(next);

  void upsertServerBridgeActivity({
    id: normalized.id,
    walletAddress: normalized.walletAddress,
    sourceChainId: normalized.sourceChainId,
    destinationChainId: normalized.destinationChainId,
    amount: normalized.amount,
    token: normalized.token,
    startedAt: normalized.startedAt,
    status: normalized.status,
    step: normalized.step,
    signatureCount: normalized.signatureCount,
    approvalTxHash: normalized.approvalTxHash,
    sourceTxHash: normalized.sourceTxHash,
    receiveTxHash: normalized.receiveTxHash,
    txHashes: normalized.txHashes,
    updatedAt: normalized.updatedAt,
  });
};

export const readBridgeActivitiesForWallet = (walletAddress?: string | null): BridgeActivityRecord[] => {
  const all = readBridgeActivities();
  if (!walletAddress) {
    return all;
  }

  return all.filter((item) => item.walletAddress.toLowerCase() === walletAddress.toLowerCase());
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
let cctpProviderInstance: CCTPV2BridgingProvider | null = null;

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
      const routeKey = `${sourceChainId}-${destinationChainId}`;
      const shouldTrackPendingBridge = SUPPORTED_BRIDGE_ROUTES.has(routeKey);

      if (sourceChainId === destinationChainId) {
        setState({
          step: 'error',
          error: 'Source and destination chains must be different',
          result: null,
          isLoading: false,
        });
        return;
      }

      if (!SUPPORTED_BRIDGE_ROUTES.has(routeKey)) {
        setState({
          step: 'error',
          error: `Bridge route ${getChainName(sourceChainId)} -> ${getChainName(destinationChainId)} is not enabled yet.`,
          result: null,
          isLoading: false,
        });
        return;
      }

      // Initialize the staged tracker flow for all supported EVM bridge routes.
      if (shouldTrackPendingBridge) {
        const now = Date.now();
        const id = `activity-${sourceChainId}-${destinationChainId}-${now}`;
        const pendingEntry: PendingBridgeRecord = {
          id,
          sourceChainId,
          destinationChainId,
          amount,
          token,
          walletAddress: address,
          startedAt: now,
          status: 'awaiting_approve',
          step: 'idle',
          signatureCount: 0,
          txHashes: [],
        };
        writePendingBridge(pendingEntry);
        upsertBridgeActivity({
          ...pendingEntry,
          id,
          updatedAt: now,
        });

        setState({
          step: 'idle',
          error: null,
          result: null,
          isLoading: false,
          sourceTxHash: undefined,
          receiveTxHash: undefined,
          sourceChainId,
          destinationChainId,
        });

        logger.debug('🧭 Manual staged bridge initialized: awaiting approve.');
        return;
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
            ...(shouldTrackPendingBridge ? { useForwarder: false } : {}),
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

        if (shouldTrackPendingBridge && sourceTxHash) {
          void registerTrackedTransfer({
            walletAddress: address,
            sourceChainId,
            destinationChainId,
            amount,
            token,
            sourceTxHash,
          });
        }

        if (shouldTrackPendingBridge && sourceTxHash && receiveTxHash) {
          void markTrackedTransferMinted(sourceTxHash, receiveTxHash)
        }

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

  const approvePendingBridge = useCallback(
    async (pending: PendingBridgeRecord) => {
      if (!isConnected || !address) {
        return null;
      }

      if (!cctpProviderInstance) {
        cctpProviderInstance = new CCTPV2BridgingProvider();
      }

      if (!bridgeKitInstance) {
        bridgeKitInstance = new BridgeKit();
      }

      const supportedChains = bridgeKitInstance.getSupportedChains();
      const sourceChain = supportedChains.find((c: any) => ('chainId' in c) && c.chainId === pending.sourceChainId);
      if (!sourceChain) {
        throw new Error('Unsupported source chain for approve step.');
      }

      if (chainId !== pending.sourceChainId) {
        if (!switchChainAsync) {
          throw new Error(`Please switch your wallet to ${getChainName(pending.sourceChainId)}.`);
        }
        await switchChainAsync({ chainId: pending.sourceChainId });
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }

      const provider = getConnectedProvider();
      if (!provider) {
        throw new Error('Connected wallet provider is not available.');
      }

      const adapter = await createAdapterFromProvider({ provider });
      const amountInMinorUnits = ethers.parseUnits(pending.amount, 6).toString();

      setState((prev) => ({ ...prev, isLoading: true, step: 'approving', error: null }));
      const preparedApprove = await cctpProviderInstance.approve({ adapter, chain: sourceChain as any, address } as any, amountInMinorUnits);
      const approveTxHash = await preparedApprove.execute();
      await cctpProviderInstance.waitForTransaction(adapter as any, approveTxHash, sourceChain as any);

      const updated: PendingBridgeRecord = {
        ...pending,
        approvalTxHash: approveTxHash,
        txHashes: [...(pending.txHashes ?? []), approveTxHash].filter((h, i, arr) => arr.indexOf(h) === i),
        status: 'awaiting_burn',
        step: 'signing-bridge',
      };

      writePendingBridge(updated);
      upsertBridgeActivity({ ...(updated as BridgeActivityRecord), id: updated.id ?? `activity-${Date.now()}`, updatedAt: Date.now() });
      setState((prev) => ({ ...prev, isLoading: false, step: 'signing-bridge' }));

      return approveTxHash;
    },
    [address, chainId, getConnectedProvider, isConnected, switchChainAsync],
  );

  const startPendingBridge = useCallback(
    async (pending: PendingBridgeRecord) => {
      if (!isConnected || !address) {
        return null;
      }

      if (!cctpProviderInstance) {
        cctpProviderInstance = new CCTPV2BridgingProvider();
      }

      if (!bridgeKitInstance) {
        bridgeKitInstance = new BridgeKit();
      }

      const supportedChains = bridgeKitInstance.getSupportedChains();
      const sourceChain = supportedChains.find((c: any) => ('chainId' in c) && c.chainId === pending.sourceChainId);
      const destinationChain = supportedChains.find((c: any) => ('chainId' in c) && c.chainId === pending.destinationChainId);
      if (!sourceChain || !destinationChain) {
        throw new Error('Could not map pending bridge chains.');
      }

      if (chainId !== pending.sourceChainId) {
        if (!switchChainAsync) {
          throw new Error(`Please switch your wallet to ${getChainName(pending.sourceChainId)}.`);
        }
        await switchChainAsync({ chainId: pending.sourceChainId });
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }

      const provider = getConnectedProvider();
      if (!provider) {
        throw new Error('Connected wallet provider is not available.');
      }

      const adapter = await createAdapterFromProvider({ provider });
      const amountInMinorUnits = ethers.parseUnits(pending.amount, 6).toString();

      setState((prev) => ({ ...prev, isLoading: true, step: 'signing-bridge', error: null }));
      const preparedBurn = await cctpProviderInstance.burn({
        source: { adapter, chain: sourceChain as any, address } as any,
        destination: { adapter, chain: destinationChain as any, address } as any,
        amount: amountInMinorUnits,
        token: 'USDC',
        config: {
          transferSpeed: 'SLOW',
        },
      } as any);

      const sourceTxHash = await preparedBurn.execute();
      await cctpProviderInstance.waitForTransaction(adapter as any, sourceTxHash, sourceChain as any);

      const updated: PendingBridgeRecord = {
        ...pending,
        sourceTxHash,
        txHashes: [...(pending.txHashes ?? []), sourceTxHash].filter((h, i, arr) => arr.indexOf(h) === i),
        status: 'pending_attestation',
        step: 'waiting-receive-message',
      };

      writePendingBridge(updated);
      upsertBridgeActivity({ ...(updated as BridgeActivityRecord), id: updated.id ?? `activity-${Date.now()}`, updatedAt: Date.now() });

      void registerTrackedTransfer({
        walletAddress: address,
        sourceChainId: pending.sourceChainId,
        destinationChainId: pending.destinationChainId,
        amount: pending.amount,
        token: pending.token,
        sourceTxHash,
      });

      setState((prev) => ({ ...prev, isLoading: false, step: 'waiting-receive-message', sourceTxHash }));
      return sourceTxHash;
    },
    [address, chainId, getConnectedProvider, isConnected, switchChainAsync],
  );

  const refreshBridgeActivities = useCallback(
    async (walletAddress?: string | null) => {
      if (!walletAddress) {
        return [] as BridgeActivityRecord[];
      }

      if (!bridgeKitInstance) {
        bridgeKitInstance = new BridgeKit();
      }

      const all = readBridgeActivitiesForWallet(walletAddress);
      const supportedChains = bridgeKitInstance.getSupportedChains();

      const next = await Promise.all(all.map(async (activity) => {
        if (activity.status !== 'pending_attestation' || !activity.sourceTxHash) {
          return activity;
        }

        const sourceChain = supportedChains.find((c: any) => ('chainId' in c) && c.chainId === activity.sourceChainId);
        const destinationChain = supportedChains.find((c: any) => ('chainId' in c) && c.chainId === activity.destinationChainId);
        if (!sourceChain) {
          return activity;
        }

        try {
          const domain = sourceChain?.cctp?.domain;
          const destinationDomain = destinationChain?.cctp?.domain;
          if (domain == null) {
            return activity;
          }

          const response = await fetch(
            `https://iris-api-sandbox.circle.com/v2/messages/${domain}?transactionHash=${activity.sourceTxHash}`,
          );

          if (response.ok) {
            const payload = await response.json();
            const messages = Array.isArray(payload?.messages) ? payload.messages : [];
            if (messages.some((message: any) => isIrisMessageMintReady(message, destinationDomain))) {
              return {
                ...activity,
                status: 'ready_to_mint' as const,
                updatedAt: Date.now(),
              };
            }
          }

          if (response.status === 404) {
            return activity;
          }

          return activity;
        } catch {
          return activity;
        }

        return activity;
      }));

      writeBridgeActivities(next);

      void Promise.all(
        next.map((activity) =>
          upsertServerBridgeActivity({
            id: activity.id,
            walletAddress: activity.walletAddress,
            sourceChainId: activity.sourceChainId,
            destinationChainId: activity.destinationChainId,
            amount: activity.amount,
            token: activity.token,
            startedAt: activity.startedAt,
            status: activity.status,
            step: activity.step,
            signatureCount: activity.signatureCount,
            approvalTxHash: activity.approvalTxHash,
            sourceTxHash: activity.sourceTxHash,
            receiveTxHash: activity.receiveTxHash,
            txHashes: activity.txHashes,
            updatedAt: activity.updatedAt,
          }),
        ),
      );

      const pendingCurrent = readPendingBridge();
      if (pendingCurrent?.sourceTxHash) {
        const matched = next.find((item) => item.sourceTxHash?.toLowerCase() === pendingCurrent.sourceTxHash?.toLowerCase());
        if (matched && pendingCurrent.status !== matched.status) {
          writePendingBridge({
            ...pendingCurrent,
            status: matched.status,
          });
        }
      }

      return next;
    },
    [],
  );

  const isTransferReadyToMint = useCallback(
    async (sourceChainId: number, sourceTxHash: string, destinationChainId?: number) => {
      if (!bridgeKitInstance) {
        bridgeKitInstance = new BridgeKit();
      }

      const supportedChains = bridgeKitInstance.getSupportedChains();
      const sourceChain = supportedChains.find((c: any) => ('chainId' in c) && c.chainId === sourceChainId);
      const destinationChain = destinationChainId
        ? supportedChains.find((c: any) => ('chainId' in c) && c.chainId === destinationChainId)
        : null;
      const domain = sourceChain?.cctp?.domain;
      const destinationDomain = destinationChain?.cctp?.domain;

      if (domain == null || !sourceTxHash) {
        return false;
      }

      try {
        const response = await fetch(
          `https://iris-api-sandbox.circle.com/v2/messages/${domain}?transactionHash=${sourceTxHash}`,
        );

        if (!response.ok) {
          return false;
        }

        const payload = await response.json();
        const messages = Array.isArray(payload?.messages) ? payload.messages : [];
        return messages.some((message: any) => isIrisMessageMintReady(message, destinationDomain));
      } catch {
        return false;
      }
    },
    [],
  );

  const claimBridgedTransfer = useCallback(
    async (
      sourceChainId: number,
      destinationChainId: number,
      sourceTxHash: string,
    ) => {
      if (!isConnected || !address) {
        setState({
          step: 'error',
          error: 'Please connect your wallet first',
          result: null,
          isLoading: false,
        });
        return null;
      }

      if (!bridgeKitInstance) {
        bridgeKitInstance = new BridgeKit();
      }

      if (!cctpProviderInstance) {
        cctpProviderInstance = new CCTPV2BridgingProvider();
      }

      try {
        const readyToMint = await isTransferReadyToMint(sourceChainId, sourceTxHash, destinationChainId);
        if (!readyToMint) {
          throw new Error('Attestation is not ready yet. Try again in a few minutes.');
        }

        setState((prev) => ({
          ...prev,
          step: 'waiting-receive-message',
          error: null,
          result: null,
          isLoading: true,
          sourceChainId,
          destinationChainId,
          sourceTxHash,
          receiveTxHash: undefined,
        }));

        const supportedChains = bridgeKitInstance.getSupportedChains();
        const sourceChain = supportedChains.find((c: any) => ('chainId' in c) && c.chainId === sourceChainId);
        const destinationChain = supportedChains.find((c: any) => ('chainId' in c) && c.chainId === destinationChainId);

        if (!sourceChain || !destinationChain) {
          throw new Error('Could not resolve source/destination chain for claim.');
        }

        if (chainId !== destinationChainId) {
          if (!switchChainAsync) {
            throw new Error(`Please switch your wallet to ${getChainName(destinationChainId)}.`);
          }

          setState((prev) => ({ ...prev, step: 'switching-network' }));
          await switchChainAsync({ chainId: destinationChainId });
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }

        const provider = getConnectedProvider();
        if (!provider) {
          throw new Error('Connected wallet provider is not available. Reconnect and try again.');
        }

        const adapter = await createAdapterFromProvider({ provider });
        const sourceContext = {
          adapter,
          chain: sourceChain as any,
          address,
        };
        const destinationContext = {
          adapter,
          chain: destinationChain as any,
          address,
        };

        const attestation = await cctpProviderInstance.fetchAttestation(sourceContext as any, sourceTxHash);
        const preparedMint = await cctpProviderInstance.mint(sourceContext as any, destinationContext as any, attestation as any);
        const receiveTxHash = await preparedMint.execute();
        await cctpProviderInstance.waitForTransaction(adapter as any, receiveTxHash, destinationChain as any);

        if (!receiveTxHash) {
          throw new Error('Claim transaction hash is missing.');
        }

        void markTrackedTransferMinted(sourceTxHash, receiveTxHash);

        const existing = readBridgeActivities().find((item) => item.sourceTxHash?.toLowerCase() === sourceTxHash.toLowerCase());
        if (existing) {
          upsertBridgeActivity({
            ...existing,
            receiveTxHash,
            status: 'minted',
            step: 'success',
            updatedAt: Date.now(),
          });
        }

        const pendingCurrent = readPendingBridge();
        if (pendingCurrent?.sourceTxHash?.toLowerCase() === sourceTxHash.toLowerCase()) {
          writePendingBridge({
            ...pendingCurrent,
            receiveTxHash,
            status: 'minted',
            step: 'success',
          });
        }

        setState((prev) => ({
          ...prev,
          step: 'success',
          error: null,
          isLoading: false,
          receiveTxHash,
          sourceTxHash,
          destinationChainId,
          sourceChainId,
        }));

        return receiveTxHash;
      } catch (err: any) {
        if (isNonceAlreadyUsedError(err)) {
          const now = Date.now();
          const existing = readBridgeActivities().find((item) => item.sourceTxHash?.toLowerCase() === sourceTxHash.toLowerCase());
          if (existing) {
            upsertBridgeActivity({
              ...existing,
              status: 'minted',
              step: 'success',
              updatedAt: now,
            });
          }

          const pendingCurrent = readPendingBridge();
          if (pendingCurrent?.sourceTxHash?.toLowerCase() === sourceTxHash.toLowerCase()) {
            writePendingBridge({
              ...pendingCurrent,
              status: 'minted',
              step: 'success',
            });
          }

          setState((prev) => ({
            ...prev,
            step: 'success',
            error: null,
            isLoading: false,
            sourceTxHash,
            sourceChainId,
            destinationChainId,
          }));

          logger.warn('Mint already executed previously (nonce already used). Marked transfer as completed.');
          return sourceTxHash;
        }

        logger.error('❌ Manual claim failed:', err);
        setState((prev) => ({
          ...prev,
          step: 'error',
          error: err?.message || 'Manual claim failed.',
          isLoading: false,
        }));
        return null;
      }
    },
    [address, chainId, getConnectedProvider, isConnected, isTransferReadyToMint, switchChainAsync],
  );

  return {
    state,
    tokenBalance,
    isLoadingBalance,
    balanceError,
    fetchTokenBalance,
    bridge,
    resumePendingBridge,
    approvePendingBridge,
    startPendingBridge,
    refreshBridgeActivities,
    isTransferReadyToMint,
    claimBridgedTransfer,
    reset,
  };
}
