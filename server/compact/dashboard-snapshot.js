// Bounded, disposable read-model cache on the existing volume. Canonical SQLite remains read-only here.
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { ECOSYSTEM_READ_TIMEOUT_MS, ECOSYSTEM_RESPONSE_TIMEOUT_MS, READ_WORKER_RESOURCE_LIMITS } from './ecosystem-reader.js';
import { MAX_RESPONSE_BYTES } from './http.js';

const FORMAT = 'machina.dashboard.30d.snapshot.v1';
export const SNAPSHOT_MAX_BYTES = 3 * MAX_RESPONSE_BYTES + 4096;
export const SNAPSHOT_FREE_RESERVE_BYTES = 256 * 1024 * 1024;
const fail = code => Object.assign(new Error(code), { code });
const digest = text => createHash('sha256').update(text).digest('hex');
const iso = seconds => new Date(seconds * 1000).toISOString();
const sections = ['v3', 'v4', 'ecosystem'];
const PREPARE_ERRORS = new Set(['snapshot_disk_budget', 'snapshot_size_limit', 'snapshot_invalid',
  'snapshot_inputs_changed', 'snapshot_write_failed']);
const checkpointEqual = (a,b) => a?.hourStart === b?.hourStart && a?.lastBlock === b?.lastBlock && a?.lastHash === b?.lastHash;

// A deployment changing any compact/API source cannot silently reuse a cache produced under different rules.
export function snapshotCompatibility() {
  const roots = [new URL('./', import.meta.url), new URL('../../api/_lib/arc-intelligence/', import.meta.url)];
  const hash = createHash('sha256');
  for (const root of roots) {
    const dir = fileURLToPath(root);
    for (const entry of readdirSync(dir, { recursive: true }).filter(p => /\.(js|mjs)$/.test(p)).sort()) {
      hash.update(entry); hash.update(readFileSync(join(dir, entry)));
    }
  }
  return hash.digest('hex');
}

export function validateSnapshot(bundle, compatibility) {
  const { sha256, ...contents } = bundle ?? {};
  if (sha256 !== digest(JSON.stringify(contents))) throw fail('snapshot_invalid');
  if (!bundle || bundle.format !== FORMAT || bundle.compatibility !== compatibility || !bundle.checkpoint
    || !Number.isSafeInteger(bundle.checkpoint.hourStart) || bundle.checkpoint.hourStart < 0 || bundle.checkpoint.hourStart % 3600
    || !Number.isSafeInteger(bundle.checkpoint.lastBlock) || bundle.checkpoint.lastBlock < 0
    || !/^0x[0-9a-f]{64}$/.test(bundle.checkpoint.lastHash) || !Number.isFinite(Date.parse(bundle.preparedAt))) throw fail('snapshot_invalid');
  const end = iso(bundle.checkpoint.hourStart + 3600);
  for (const key of sections) {
    const part = bundle.sections?.[key];
    if (typeof part?.json !== 'string' || Buffer.byteLength(part.json) > MAX_RESPONSE_BYTES - 1024
      || digest(part.json) !== part.sha256) throw fail('snapshot_invalid');
    const body = JSON.parse(part.json);
    if (body.chain?.id !== 5042 || body.window?.key !== '30d' || body.window.end !== end
      || !Number.isFinite(Date.parse(body.window.start)) || Date.parse(body.window.start) >= Date.parse(end)) throw fail('snapshot_invalid');
    if (key === 'ecosystem') {
      if (body.schema !== 'machina.intelligence.ecosystem.v1' || typeof body.coverage?.status !== 'string'
        || !Array.isArray(body.discoveredTokens?.rows) || body.discoveredTokens.rows.length > 50
        || !Array.isArray(body.launches?.rows) || body.launches.rows.length > 50) throw fail('snapshot_invalid');
    } else if (body.schema !== 'machina.intelligence.pools.v1' || body.protocol !== key || !Array.isArray(body.pools)
      || body.freshness?.checkpointHour !== iso(bundle.checkpoint.hourStart)
      || body.freshness?.verifiedThrough !== end || body.freshness?.checkpointBlock !== bundle.checkpoint.lastBlock) throw fail('snapshot_invalid');
  }
  const bodies = sections.map(k => JSON.parse(bundle.sections[k].json));
  if (bodies.some(body => JSON.stringify(body.window) !== JSON.stringify(bodies[0].window))) throw fail('snapshot_window_mismatch');
  return bundle;
}

export function createDashboardSnapshotStore({ path, compatibility = snapshotCompatibility(), now = Date.now,
  freeReserveBytes = SNAPSHOT_FREE_RESERVE_BYTES, filesystem = fs, verifyCheckpoint = () => false }) {
  const directory = `${path}.dashboard-30d`, activePath = join(directory, 'active.json'), pendingPath = join(directory, 'pending.json');
  const previousPath = join(directory, 'previous.json'), previousPending = join(directory, 'previous.pending.json');
  let cache = null, fingerprint = null, loading = null;
  async function load() {
    loading ??= (async () => {
      const readBundle = async file => {
        const stat = await filesystem.stat(file);
        if (stat.size > SNAPSHOT_MAX_BYTES || !stat.isFile()) throw fail('snapshot_invalid');
        const nextFingerprint = `${file}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        if (cache && fingerprint === nextFingerprint) return cache;
        const bundle = validateSnapshot(JSON.parse(await filesystem.readFile(file, 'utf8')), compatibility);
        cache = bundle; fingerprint = nextFingerprint;
        return bundle;
      };
      try { return await readBundle(activePath); }
      catch (error) {
        // Never accept the corrupt bundle. The independently verified previous generation remains usable.
        try { return await readBundle(previousPath); }
        catch { throw fail(error.code === 'ENOENT' ? 'not_ready' : 'snapshot_invalid'); }
      }
    })().finally(() => { loading = null; });
    let timer;
    try {
      return await Promise.race([loading, new Promise((_, reject) => {
        timer = setTimeout(() => reject(fail('snapshot_read_timeout')), ECOSYSTEM_RESPONSE_TIMEOUT_MS);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function publish(checkpoint, values) {
    const bundle = { format: FORMAT, compatibility, checkpoint: { hourStart: checkpoint.hourStart,
      lastBlock: checkpoint.lastBlock, lastHash: checkpoint.lastHash }, preparedAt: new Date(now()).toISOString(),
      sections: Object.fromEntries(sections.map(key => { const json = JSON.stringify(values[key]); return [key, { json, sha256: digest(json) }]; })) };
    bundle.sha256 = digest(JSON.stringify(bundle));
    validateSnapshot(bundle, compatibility);
    const text = JSON.stringify(bundle);
    if (Buffer.byteLength(text) > SNAPSHOT_MAX_BYTES) throw fail('snapshot_size_limit');
    // Two committed generations + two bounded staging files, at most 3.02 MiB, independent of window row counts.
    const capacity = await filesystem.statfs(dirname(path));
    if (Number(capacity.bavail) * Number(capacity.bsize) < freeReserveBytes + 4 * SNAPSHOT_MAX_BYTES) throw fail('snapshot_disk_budget');
    await filesystem.mkdir(directory, { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await filesystem.open(pendingPath, 'w', 0o600);
      await handle.writeFile(text); await handle.sync(); await handle.close(); handle = null;
      validateSnapshot(JSON.parse(await filesystem.readFile(pendingPath, 'utf8')), compatibility);
      // Retain the old verified generation before replacing active, including after an ambiguous fsync failure.
      let previous;
      try { previous = await load(); } catch { /* no compatible valid generation yet */ }
      if (previous) {
        handle = await filesystem.open(previousPending, 'w', 0o600);
        await handle.writeFile(JSON.stringify(previous)); await handle.sync(); await handle.close(); handle = null;
        validateSnapshot(JSON.parse(await filesystem.readFile(previousPending, 'utf8')), compatibility);
        await filesystem.rename(previousPending, previousPath);
        const directoryHandle = await filesystem.open(directory, 'r');
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      }
      await filesystem.rename(pendingPath, activePath); // Same-filesystem atomic activation; never an incomplete triple.
      const dir = await filesystem.open(directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
      cache = null; fingerprint = null;
    } finally { await handle?.close(); }
    return bundle;
  }
  async function read(key, current) {
    const started = performance.now();
    if (!sections.includes(key)) throw fail('unsupported_snapshot_section');
    const bundle = await load(), cp = bundle.checkpoint;
    if (!current || cp.hourStart > current.hourStart || (cp.hourStart === current.hourStart && !checkpointEqual(cp,current))) throw fail('snapshot_checkpoint_mismatch');
    if (!verifyCheckpoint(cp)) throw fail('snapshot_checkpoint_mismatch');
    const body = JSON.parse(bundle.sections[key].json);
    const latestComplete = Math.floor(now() / 3600000) * 3600 - 3600;
    const lagHours = Math.max(0, (current.hourStart - cp.hourStart) / 3600);
    const ageSeconds = Math.max(0, Math.floor(now() / 1000) - cp.hourStart - 3600);
    const stale = lagHours > 0 || latestComplete - cp.hourStart >= 7200;
    body.snapshot = { status: stale ? 'stale' : 'current', checkpointHour: iso(cp.hourStart), verifiedThrough: iso(cp.hourStart + 3600),
      preparedAt: bundle.preparedAt, latestCheckpointHour: iso(current.hourStart), lagHours, ageSeconds };
    body.freshness = { ...body.freshness, checkpointHour: iso(cp.hourStart), checkpointBlock: cp.lastBlock,
      verifiedThrough: iso(cp.hourStart + 3600), latestCompleteHour: iso(latestComplete),
      lagHours: Math.max(0, (latestComplete - cp.hourStart) / 3600), stale, staleRule: 'snapshot behind checkpoint or lagHours >= 2' };
    if (Buffer.byteLength(JSON.stringify(body)) > MAX_RESPONSE_BYTES) throw fail('snapshot_size_limit');
    if (performance.now() - started >= ECOSYSTEM_RESPONSE_TIMEOUT_MS) throw fail('snapshot_read_timeout');
    return body;
  }
  return { load, publish, read, activePath, compatibility };
}

// Uses the scheduler's existing single child-process slot, not another HTTP worker. Each read stage gets the same 6s
// execution bound; HTTP's 7s total / proxy's 8s remain untouched. A pinned read transaction survives between stages.
export function createSnapshotRunner({ path, store, readModel, log = () => {}, spawnImpl = spawn,
  timeoutMs = ECOSYSTEM_READ_TIMEOUT_MS, now = Date.now }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 6000) throw fail('invalid_snapshot_timeout');
  let attempted = null, retryAt = 0, running = false;
  const key = cp => JSON.stringify(cp);
  const checkpointKey = cp => JSON.stringify([cp.hourStart, cp.lastBlock, cp.lastHash]);
  async function needed() {
    if (running) return false;
    const cp = readModel.snapshotIdentity();
    // Disk is the durable completion marker, including a crash after activation but before the child acknowledgement.
    try { if (checkpointEqual((await store.load()).checkpoint, cp)) return false; } catch { /* damaged/missing cache */ }
    // A successful checkpoint is prepared once, not rebuilt after every Discovery Drain commit.
    return attempted !== checkpointKey(cp) || now() >= retryAt;
  }
  function run() {
    if (running) throw fail('snapshot_already_running');
    const cp = readModel.snapshotIdentity();
    attempted = checkpointKey(cp); retryAt = now() + 5 * 60_000;
    const child = spawnImpl(process.execPath, ['--max-old-space-size='+READ_WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb,
      '--max-semi-space-size='+READ_WORKER_RESOURCE_LIMITS.maxYoungGenerationSizeMb,
      fileURLToPath(new URL('../../scripts/prepare-compact-dashboard-snapshot.mjs', import.meta.url))],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH } });
    running = true;
    let timer, deadline, failed = null, closed = false, completed = false, stopped = false, stage = 0;
    const stages = ['begin','v3','v4','ecosystem','end'];
    let resolve;
    const done = new Promise(r => { resolve = r; }).finally(() => { running = false; });
    const stop = code => { failed ??= code; clearTimeout(timer); if (!closed) child.kill('SIGKILL'); };
    const dispatch = () => {
      const name = stages[stage];
      if (name === 'end' && key(readModel.snapshotIdentity()) !== key(cp)) return stop('snapshot_inputs_changed');
      deadline = performance.now() + timeoutMs;
      timer = setTimeout(() => stop('snapshot_stage_timeout'), timeoutMs);
      try { child.send({ stage: name, path, checkpoint: cp, compatibility: store.compatibility, preparedAtMs: now() }); }
      catch { stop('snapshot_child_failed'); }
    };
    child.on('message', message => {
      if (stopped || failed || completed) return;
      clearTimeout(timer);
      if (performance.now() >= deadline) return stop('snapshot_stage_timeout');
      if (!message || message.stage !== stages[stage]) return stop('snapshot_prepare_failed');
      if (message.error) return stop(PREPARE_ERRORS.has(message.error) ? message.error : 'snapshot_prepare_failed');
      stage++;
      if (stage === stages.length) {
        completed = true;
        try { child.disconnect(); } catch { stop('snapshot_child_failed'); }
      }
      else dispatch();
    });
    // An IPC error is not an exit. Only a failed spawn (no pid) or `exit` releases the scheduler's child slot.
    child.on('error', () => {
      if (child.pid) stop('snapshot_child_failed');
      else { closed = true; clearTimeout(timer); failed = 'snapshot_child_failed'; resolve({exitCode:1,error:failed}); }
    });
    child.on('exit', async code => {
      closed = true; clearTimeout(timer);
      try {
        if (stopped || failed || !completed || code !== 0) throw fail(failed ?? 'snapshot_prepare_failed');
        if (key(readModel.snapshotIdentity()) !== key(cp)) throw fail('snapshot_inputs_changed');
        log(`SNAPSHOT_READY hour=${iso(cp.hourStart)}`);
        resolve({exitCode:0,error:null});
      } catch (error) {
        const reason = /^[a-z_]{1,64}$/.test(error.code) ? error.code : 'snapshot_prepare_failed';
        log(`SNAPSHOT_FAILED code=${reason} stage=${stages[Math.min(stage, stages.length - 1)]}`); resolve({exitCode:1,error:reason});
      }
    });
    dispatch();
    return { hour: iso(cp.hourStart), done, async terminate() { stopped = true; stop('snapshot_cancelled'); return done; } };
  }
  return { needed, run };
}
