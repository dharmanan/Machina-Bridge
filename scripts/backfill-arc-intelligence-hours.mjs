import { createPool } from '../server/arc-intelligence/db.js';
import { migrate } from '../server/arc-intelligence/migrate.js';
import { createMetricRepository } from '../server/arc-intelligence/metric-repository.js';

const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.slice('--limit='.length)) : 12;
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 24) {
  console.error('ARC_INTELLIGENCE_HOURLY_BACKFILL: FAIL invalid_limit');
  process.exitCode = 1;
} else if (!process.env.DATABASE_URL) {
  console.error('ARC_INTELLIGENCE_HOURLY_BACKFILL: FAIL database_url_required');
  process.exitCode = 1;
} else {
  const pool = createPool(process.env.DATABASE_URL);
  try {
    await migrate(pool);
    const result = await createMetricRepository(pool).reduceCandidateHours({ limit });
    console.log(JSON.stringify({
      status: 'ok',
      processed: result.processed,
      examined: result.examined,
      complete: result.complete,
      skipped: result.skipped,
      earliestCompleteBucket: result.earliestCompleteBucket === null ? null : new Date(result.earliestCompleteBucket * 1000).toISOString(),
      latestCompleteBucket: result.latestCompleteBucket === null ? null : new Date(result.latestCompleteBucket * 1000).toISOString(),
      hours: result.results.map((item) => ({
        bucketStart: new Date(item.bucketStart * 1000).toISOString(),
        status: item.status,
        reason: item.reason,
      })),
      rawDeletion: 'disabled',
    }));
  } catch {
    console.error('ARC_INTELLIGENCE_HOURLY_BACKFILL: FAIL backfill_unavailable');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
