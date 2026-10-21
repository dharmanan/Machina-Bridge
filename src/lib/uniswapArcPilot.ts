import { getAddress, isAddress } from 'viem'
import { ARC_ROUTER, nativeAmount, sameAddress, validateArcRequest, type ArcRequest } from './uniswapArcPolicy'

export interface ArcPilotConfig { enabled: boolean; wallet: string }
export const ARC_PILOT_MAX_INPUT = 100000000000000000n // 0.1 native USDC (18 decimals)

// Public build configuration, not a credential or a server-side authentication boundary.
// An absent/invalid address or anything other than exact "true" fails closed.
export function arcPilotConfig(enabled?: string, wallet?: string): ArcPilotConfig {
  const valid = typeof wallet === 'string' && isAddress(wallet) && BigInt(wallet) > 2n && !sameAddress(wallet, ARC_ROUTER)
  return Object.freeze({ enabled: enabled === 'true' && valid, wallet: valid ? getAddress(wallet) : '' })
}

export function arcPilotAllows(config: ArcPilotConfig, input: ArcRequest | null, context: { connected: boolean; owner: string; chainId: number }): boolean {
  if (!config.enabled || !context.connected || context.chainId !== 5042 || !sameAddress(context.owner, config.wallet)) return false
  try {
    const request = validateArcRequest(input)
    return request.tokenOut === 'EURC' && sameAddress(request.owner, config.wallet) &&
      sameAddress(request.recipient, config.wallet) && nativeAmount(request.amount) <= ARC_PILOT_MAX_INPUT
  } catch { return false }
}
