import { badRequest, json, methodNotAllowed, serverError } from './_lib/http.js';
import { redisDel, redisGetJson, redisSetJson, redisZadd, redisZrem, redisZrevrange } from './_lib/redis.js';
import {
  ACTIVITY_RETENTION_DAYS,
  activityKey,
  activityWalletIndexKey,
  createActivityRecord,
  isActivityStatus,
} from './_lib/activities.js';
import { applyCors, enforceIdempotency, enforceRateLimit } from './_lib/security.js';
import { isValidEvmAddress, isValidTxHash, toPositiveNumber } from './_lib/validate.js';

const MAX_LIMIT = 100;

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

function parseRetentionDays(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return ACTIVITY_RETENTION_DAYS;
  }

  return Math.min(Math.max(Math.floor(parsed), 1), 365);
}

export default async function handler(req, res) {
  try {
    const corsResponse = applyCors(req, res, ['GET', 'POST', 'OPTIONS']);
    if (corsResponse) {
      return corsResponse;
    }

    if (req.method === 'POST') {
      const rateLimitResponse = await enforceRateLimit(req, res, 'activities:post');
      if (rateLimitResponse) {
        return rateLimitResponse;
      }

      const idempotencyResponse = await enforceIdempotency(req, res, 'activities:post');
      if (idempotencyResponse) {
        return idempotencyResponse;
      }

      const body = await parseBody(req);
      const action = String(body.action || '');
      if (action === 'dismiss') {
        return await handleDismissActivity(res, body);
      }

      return await handleUpsertActivityBody(res, body);
    }

    if (req.method === 'GET') {
      const rateLimitResponse = await enforceRateLimit(req, res, 'activities:get');
      if (rateLimitResponse) {
        return rateLimitResponse;
      }

      return await handleListActivities(req, res);
    }

    return methodNotAllowed(res, ['GET', 'POST']);
  } catch (error) {
    return serverError(res, error);
  }
}

async function handleUpsertActivityBody(res, body) {
  const {
    id,
    walletAddress,
    sourceChainId,
    destinationChainId,
    amount,
    token,
    startedAt,
    status,
    step,
    signatureCount,
    approvalTxHash,
    sourceTxHash,
    receiveTxHash,
    txHashes,
    updatedAt,
  } = body;

  if (!isValidEvmAddress(walletAddress)) {
    return badRequest(res, 'Invalid walletAddress');
  }

  const src = Number(sourceChainId);
  const dst = Number(destinationChainId);
  if (!Number.isInteger(src) || !Number.isInteger(dst)) {
    return badRequest(res, 'Invalid source/destination chain id');
  }

  const safeAmount = toPositiveNumber(amount);
  if (!safeAmount) {
    return badRequest(res, 'Invalid amount');
  }

  if (status && !isActivityStatus(status)) {
    return badRequest(res, 'Invalid status');
  }

  const hashCandidates = [approvalTxHash, sourceTxHash, receiveTxHash].filter(Boolean);
  for (const hash of hashCandidates) {
    if (!isValidTxHash(String(hash))) {
      return badRequest(res, 'Invalid tx hash in activity payload');
    }
  }

  if (Array.isArray(txHashes)) {
    for (const hash of txHashes) {
      if (!isValidTxHash(String(hash))) {
        return badRequest(res, 'Invalid txHashes entry in activity payload');
      }
    }
  }

  const activity = createActivityRecord({
    id,
    walletAddress,
    sourceChainId: src,
    destinationChainId: dst,
    amount: String(safeAmount),
    token: token || 'USDC',
    startedAt,
    status,
    step,
    signatureCount,
    approvalTxHash,
    sourceTxHash,
    receiveTxHash,
    txHashes,
    updatedAt,
  });

  await redisSetJson(activityKey(activity.id), activity);
  await redisZadd(activityWalletIndexKey(activity.walletAddress), activity.updatedAt, activity.id);

  return json(res, 201, { activity });
}

async function handleDismissActivity(res, body) {
  const id = String(body.id || '');
  if (!id) {
    return badRequest(res, 'Missing activity id');
  }

  const activity = await redisGetJson(activityKey(id));
  if (!activity) {
    return badRequest(res, 'Activity not found');
  }

  const next = {
    ...activity,
    status: 'dismissed',
    updatedAt: Date.now(),
  };

  await redisSetJson(activityKey(id), next);
  await redisZadd(activityWalletIndexKey(next.walletAddress), next.updatedAt, next.id);

  return json(res, 200, { activity: next });
}

async function handleListActivities(req, res) {
  const wallet = String(req.query?.wallet || '').toLowerCase();
  if (!isValidEvmAddress(wallet)) {
    return badRequest(res, 'Invalid wallet query param');
  }

  const requestedLimit = Number(req.query?.limit || 100);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), MAX_LIMIT)
    : MAX_LIMIT;

  const retentionDays = parseRetentionDays(req.query?.retentionDays);
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  const ids = await redisZrevrange(activityWalletIndexKey(wallet), 0, limit - 1);
  const activities = [];

  for (const id of ids || []) {
    const key = activityKey(id);
    const activity = await redisGetJson(key);

    if (!activity) {
      await redisZrem(activityWalletIndexKey(wallet), id);
      continue;
    }

    const ts = Number(activity.updatedAt ?? activity.startedAt ?? 0);
    if (!Number.isFinite(ts) || ts < cutoffMs) {
      await redisDel(key);
      await redisZrem(activityWalletIndexKey(wallet), id);
      continue;
    }

    activities.push(activity);
  }

  return json(res, 200, { activities, retentionDays });
}
