import { logger } from './logger';

interface CreateTransferPayload {
  walletAddress: string;
  sourceChainId: number;
  destinationChainId: number;
  amount: string;
  token: string;
  sourceTxHash: string;
}

export interface TrackedTransfer {
  id: string;
  walletAddress: string;
  sourceChainId: number;
  destinationChainId: number;
  amount: string;
  token: string;
  sourceTxHash: string;
  destinationTxHash: string | null;
  status: 'pending_attestation' | 'ready_to_mint' | 'minted' | 'dismissed';
  createdAt: number;
  updatedAt: number;
}

export interface ServerBridgeActivity {
  id: string;
  walletAddress: string;
  sourceChainId: number;
  destinationChainId: number;
  amount: string;
  token: string;
  startedAt: number;
  status: 'awaiting_approve' | 'awaiting_burn' | 'pending_attestation' | 'ready_to_mint' | 'minted' | 'failed' | 'dismissed';
  step?: string;
  signatureCount?: number;
  approvalTxHash?: string;
  sourceTxHash?: string;
  receiveTxHash?: string;
  txHashes?: string[];
  updatedAt: number;
}

interface UpsertActivityPayload {
  id?: string;
  walletAddress: string;
  sourceChainId: number;
  destinationChainId: number;
  amount: string;
  token: string;
  startedAt: number;
  status?: string;
  step?: string;
  signatureCount?: number;
  approvalTxHash?: string;
  sourceTxHash?: string;
  receiveTxHash?: string;
  txHashes?: string[];
  updatedAt: number;
}

let hasWarnedTrackerApiUnavailable = false;

function createIdempotencyKey(prefix: string) {
  const rand = Math.random().toString(36).slice(2);
  return `${prefix}-${Date.now()}-${rand}`;
}

function isJsonResponse(response: Response) {
  const contentType = response.headers.get('content-type') || '';
  return contentType.includes('application/json');
}

function warnTrackerApiUnavailableOnce(status: number) {
  if (hasWarnedTrackerApiUnavailable) {
    return;
  }

  hasWarnedTrackerApiUnavailable = true;
  logger.warn(`Tracker API is unavailable in this runtime (status ${status}). This is expected in Vite dev unless using Vercel runtime.`);
}

export async function registerTrackedTransfer(payload: CreateTransferPayload): Promise<void> {
  try {
    const response = await fetch('/api/transfers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Idempotency-Key': createIdempotencyKey('register-transfer'),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      if (response.status === 404 || !isJsonResponse(response)) {
        warnTrackerApiUnavailableOnce(response.status);
        return;
      }

      const text = await response.text();
      throw new Error(`Transfer registration failed (${response.status}): ${text}`);
    }
  } catch (error) {
    logger.warn('Failed to register tracked transfer:', error);
  }
}

export async function fetchTrackedTransfers(walletAddress: string): Promise<TrackedTransfer[]> {
  try {
    const response = await fetch(`/api/transfers?wallet=${encodeURIComponent(walletAddress)}`);
    if (!response.ok) {
      if (response.status === 404 || !isJsonResponse(response)) {
        warnTrackerApiUnavailableOnce(response.status);
      }
      return [];
    }

    if (!isJsonResponse(response)) {
      warnTrackerApiUnavailableOnce(response.status);
      return [];
    }

    const data = await response.json();
    return Array.isArray(data?.transfers) ? data.transfers : [];
  } catch (error) {
    logger.warn('Failed to fetch tracked transfers:', error);
    return [];
  }
}

export async function fetchServerBridgeActivities(walletAddress: string, retentionDays = 30): Promise<ServerBridgeActivity[]> {
  try {
    const response = await fetch(
      `/api/activities?wallet=${encodeURIComponent(walletAddress)}&retentionDays=${encodeURIComponent(String(retentionDays))}`,
    );

    if (!response.ok) {
      if (response.status === 404 || !isJsonResponse(response)) {
        warnTrackerApiUnavailableOnce(response.status);
      }
      return [];
    }

    if (!isJsonResponse(response)) {
      warnTrackerApiUnavailableOnce(response.status);
      return [];
    }

    const data = await response.json();
    return Array.isArray(data?.activities) ? data.activities : [];
  } catch (error) {
    logger.warn('Failed to fetch server bridge activities:', error);
    return [];
  }
}

export async function upsertServerBridgeActivity(payload: UpsertActivityPayload): Promise<void> {
  try {
    const response = await fetch('/api/activities', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Idempotency-Key': createIdempotencyKey('upsert-activity'),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      if (response.status === 404 || !isJsonResponse(response)) {
        warnTrackerApiUnavailableOnce(response.status);
        return;
      }

      const text = await response.text();
      logger.warn(`Failed to upsert bridge activity (${response.status}): ${text}`);
    }
  } catch (error) {
    logger.warn('Failed to upsert server bridge activity:', error);
  }
}

export async function dismissTrackedTransfer(id: string): Promise<boolean> {
  try {
    const response = await fetch('/api/transfers-update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Idempotency-Key': createIdempotencyKey('dismiss-transfer'),
      },
      body: JSON.stringify({ action: 'dismiss', id }),
    });

    if (response.status === 404 || !isJsonResponse(response)) {
      warnTrackerApiUnavailableOnce(response.status);
      return false;
    }

    return response.ok;
  } catch (error) {
    logger.warn('Failed to dismiss tracked transfer:', error);
    return false;
  }
}

export async function dismissTrackedTransferBySourceTxHash(sourceTxHash: string): Promise<boolean> {
  try {
    const response = await fetch('/api/transfers-update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Idempotency-Key': createIdempotencyKey('dismiss-transfer-by-source'),
      },
      body: JSON.stringify({ action: 'dismiss_by_source', sourceTxHash }),
    });

    if (response.status === 404 || !isJsonResponse(response)) {
      warnTrackerApiUnavailableOnce(response.status);
      return false;
    }

    return response.ok;
  } catch (error) {
    logger.warn('Failed to dismiss tracked transfer by source hash:', error);
    return false;
  }
}

export async function dismissServerBridgeActivity(id: string): Promise<boolean> {
  try {
    const response = await fetch('/api/activities', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Idempotency-Key': createIdempotencyKey('dismiss-activity'),
      },
      body: JSON.stringify({ action: 'dismiss', id }),
    });

    if (response.status === 404 || !isJsonResponse(response)) {
      warnTrackerApiUnavailableOnce(response.status);
      return false;
    }

    return response.ok;
  } catch (error) {
    logger.warn('Failed to dismiss server bridge activity:', error);
    return false;
  }
}

export async function markTrackedTransferMinted(sourceTxHash: string, destinationTxHash: string): Promise<void> {
  try {
    const response = await fetch('/api/transfers-update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Idempotency-Key': createIdempotencyKey('mark-minted'),
      },
      body: JSON.stringify({
        action: 'mark_minted',
        sourceTxHash,
        destinationTxHash,
      }),
    });

    if (!response.ok && (response.status === 404 || !isJsonResponse(response))) {
      warnTrackerApiUnavailableOnce(response.status);
    }
  } catch (error) {
    logger.warn('Failed to mark tracked transfer minted:', error);
  }
}
