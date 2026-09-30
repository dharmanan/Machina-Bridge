// Only successful work is disposable: canonical facts and certificates live in separate tables.
export const COMPLETE_WORK_RETAIN = 1000;
export const COMPLETE_WORK_PRUNE_BATCH = 100;

export async function pruneCompleteWork(client) {
  // The caller's transaction contains no RPC. A small, locked batch preserves all non-complete states.
  await client.query(`/* a2:prune_complete */ WITH boundary AS (
    SELECT id FROM arc_intelligence_work WHERE state='complete' ORDER BY id DESC OFFSET ($1-1) LIMIT 1
  ), obsolete AS (
    SELECT w.id FROM arc_intelligence_work w WHERE w.state='complete' AND w.id < (SELECT id FROM boundary)
    ORDER BY w.id LIMIT $2 FOR UPDATE OF w SKIP LOCKED
  ) DELETE FROM arc_intelligence_work w USING obsolete o WHERE w.id=o.id AND w.state='complete'`,
  [COMPLETE_WORK_RETAIN,COMPLETE_WORK_PRUNE_BATCH]);
}
