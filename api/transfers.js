import { badRequest, json, methodNotAllowed, serverError } from './_lib/http.js';
import { redisGetJson, redisSadd, redisSetJson, redisZadd, redisZrevrange } from './_lib/redis.js';
import { createTransferRecord, pendingSetKey, transferKey, walletIndexKey } from './_lib/transfers.js';
import { applyCors, enforceIdempotency, enforceRateLimit } from './_lib/security.js';
import { isValidEvmAddress, isValidTxHash, toPositiveNumber } from './_lib/validate.js';

const MAX_LIMIT = 50;

async function parseBody(req) {
  if (!req.body) {
    return {};
  }

  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return req.body;
}

export default async function handler(req, res) {
  try {
    const corsResponse = applyCors(req, res, ['GET', 'POST', 'OPTIONS']);
    if (corsResponse) {
      return corsResponse;
    }

    if (req.method === 'POST') {
      const rateLimitResponse = await enforceRateLimit(req, res, 'transfers:post');
      if (rateLimitResponse) {
        return rateLimitResponse;
      }

      const idempotencyResponse = await enforceIdempotency(req, res, 'transfers:post');
      if (idempotencyResponse) {
        return idempotencyResponse;
      }

      return await handleCreateTransfer(req, res);
    }

    if (req.method === 'GET') {
      const rateLimitResponse = await enforceRateLimit(req, res, 'transfers:get');
      if (rateLimitResponse) {
        return rateLimitResponse;
      }

      return await handleListTransfers(req, res);
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (error) {
    return serverError(res, error);
  }
}

async function handleCreateTransfer(req, res) {
  const body = await parseBody(req);
  const {
    walletAddress,
    sourceChainId,
    destinationChainId,
    amount,
    token,
    sourceTxHash,
  } = body;

  if (!isValidEvmAddress(walletAddress)) {
    return badRequest(res, 'Invalid walletAddress');
  }

  if (!isValidTxHash(sourceTxHash)) {
    return badRequest(res, 'Invalid sourceTxHash');
  }

  const safeAmount = toPositiveNumber(amount);
  if (!safeAmount) {
    return badRequest(res, 'Invalid amount');
  }

  const src = Number(sourceChainId);
  const dst = Number(destinationChainId);
  if (!Number.isInteger(src) || !Number.isInteger(dst)) {
    return badRequest(res, 'Invalid source/destination chain id');
  }

  const transfer = createTransferRecord({
    walletAddress,
    sourceChainId: src,
    destinationChainId: dst,
    amount: String(safeAmount),
    token: token || 'USDC',
    sourceTxHash,
  });

  await redisSetJson(transferKey(transfer.id), transfer);
  await redisZadd(walletIndexKey(transfer.walletAddress), transfer.createdAt, transfer.id);
  await redisSadd(pendingSetKey(), transfer.id);
  await redisSadd(`bridge:source:${transfer.sourceTxHash.toLowerCase()}`, transfer.id);

  return json(res, 201, { transfer });
}

async function handleListTransfers(req, res) {
  const wallet = String(req.query?.wallet || '').toLowerCase();
  if (!isValidEvmAddress(wallet)) {
    return badRequest(res, 'Invalid wallet query param');
  }

  const requestedLimit = Number(req.query?.limit || 20);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), MAX_LIMIT)
    : 20;

  const ids = await redisZrevrange(walletIndexKey(wallet), 0, limit - 1);
  const transfers = [];

  for (const id of ids || []) {
    const transfer = await redisGetJson(transferKey(id));
    if (transfer) {
      transfers.push(transfer);
    }
  }

  return json(res, 200, { transfers });
}
