import { json, methodNotAllowed, serverError } from '../_lib/http.js';
import { redisGetJson, redisSetJson, redisSmembers } from '../_lib/redis.js';
import { pendingSetKey, transferKey, TRANSFER_STATUS } from '../_lib/transfers.js';

function isAuthorized(req) {
  const secret = process.env.BRIDGE_CRON_SECRET;
  if (!secret) return false;
  const incoming = req.headers['x-cron-secret'];
  return typeof incoming === 'string' && incoming === secret;
}

async function fetchAttestationStatus(transfer) {
  // Optional external indexer integration. Keep noop-safe by default.
  const statusUrl = process.env.CIRCLE_ATTESTATION_STATUS_URL;
  if (!statusUrl) {
    return null;
  }

  const url = new URL(statusUrl);
  url.searchParams.set('sourceTxHash', transfer.sourceTxHash);
  url.searchParams.set('sourceChainId', String(transfer.sourceChainId));

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  return typeof data?.status === 'string' ? data.status : null;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      return methodNotAllowed(res, ['GET']);
    }

    if (!isAuthorized(req)) {
      return json(res, 401, { error: 'Unauthorized cron request' });
    }

    const ids = await redisSmembers(pendingSetKey());
    let scanned = 0;
    let readyToMint = 0;

    for (const id of ids || []) {
      const key = transferKey(id);
      const transfer = await redisGetJson(key);
      if (!transfer || transfer.status !== TRANSFER_STATUS.PENDING_ATTESTATION) {
        continue;
      }

      scanned += 1;
      const status = await fetchAttestationStatus(transfer);
      if (status === TRANSFER_STATUS.READY_TO_MINT) {
        transfer.status = TRANSFER_STATUS.READY_TO_MINT;
        transfer.updatedAt = Date.now();
        await redisSetJson(key, transfer);
        readyToMint += 1;
      }
    }

    return json(res, 200, {
      ok: true,
      scanned,
      readyToMint,
    });
  } catch (error) {
    return serverError(res, error);
  }
}
