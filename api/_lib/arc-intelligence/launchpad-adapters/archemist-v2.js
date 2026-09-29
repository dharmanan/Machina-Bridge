import { parseAbiItem } from 'viem';

// Official Arc V2 factory/event reference: https://archemist.fun/docs
export const ARCHEMIST_V2_ADAPTER = Object.freeze({
  protocol: 'Archemist V2',
  abi: parseAbiItem('event TokenCreated(address indexed token, address indexed creator, address indexed pool, uint256 positionId, address creatorFeeRecipient, uint24 poolFee, int24 normalizedTick, int24 actualPoolTick, uint160 initialSqrtPriceX96, uint256 tokensInPosition, uint256 creatorBuyNative, uint256 creatorBuyTokens)'),
  creatorField: 'creator',
  view: null,
  project: (args) => ({ pool: args.pool.toLowerCase(), positionIdRaw: args.positionId.toString(10),
    tokensInPositionRaw: args.tokensInPosition.toString(10),
    creatorBuyNativeRaw: args.creatorBuyNative.toString(10),
    creatorBuyTokensRaw: args.creatorBuyTokens.toString(10) }),
});
