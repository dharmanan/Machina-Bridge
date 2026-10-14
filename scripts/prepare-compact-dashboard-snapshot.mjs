// Service-owned read-only preparation child. No writer, RPC, collector, recovery or independently scheduled work.
import { DatabaseSync } from 'node:sqlite';
import { getHeapStatistics } from 'node:v8';
import { createCompactReadModel } from '../server/compact/read-model.js';
import { createDashboardSnapshotStore } from '../server/compact/dashboard-snapshot.js';
import { safeSnapshotError } from '../server/compact/snapshot-diagnostics.js';
if (!process.send || getHeapStatistics().heap_size_limit > 64 * 1024 * 1024) process.exit(1);
let model, sourceVersion, expected = 'begin';
const values = {};
const next = {begin:'v3',v3:'v4',v4:'ecosystem',ecosystem:'end'};
process.on('message', async ({ stage, path, checkpoint, compatibility, preparedAtMs }) => {
  try {
    if (stage !== expected) throw Error('invalid_stage');
    if (stage === 'begin') {
      model = createCompactReadModel({ path, DatabaseSync, busyTimeoutMs: 1000 });
      sourceVersion = model.snapshotIdentity().dataVersion;
      model.beginPrepared30d(checkpoint);
    } else if (stage === 'end') {
      model.endPrepared30d();
      if (model.snapshotIdentity().dataVersion !== sourceVersion) throw Error('snapshot_inputs_changed');
      const store = createDashboardSnapshotStore({ path, compatibility, now: () => preparedAtMs });
      await store.publish(checkpoint, values); // File IO is also bounded/killable by the parent's stage deadline.
      model.close();
    } else values[stage] = stage === 'ecosystem' ? model.ecosystem('30d') : model.pools(stage,'30d');
    expected = next[stage];
    process.send({stage});
  } catch (error) {
    const diagnostic = safeSnapshotError(error);
    process.send({stage,error:diagnostic.code,detail:diagnostic.detail}); process.exitCode=1; process.disconnect();
  }
});
process.on('disconnect', () => { model?.close(); });
