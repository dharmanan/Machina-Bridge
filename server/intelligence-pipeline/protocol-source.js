// Opt-in independent pipeline only. Existing ABI/family semantics are reused.
// Bodies/logs are transient; accepted metrics, exact membership and pinned views survive restart.
import { createHash } from 'node:crypto';
import { PROTOCOL_FAMILIES } from '../compact/protocols/index.js';
import { CCTP_EVENTS, GATEWAY_EVENTS } from '../compact/protocols/circle.js';
import { ACROSS_EVENTS } from '../compact/protocols/across.js';
import { AAVE_V4_EVENTS } from '../compact/protocols/aave.js';
import { MORPHO_BLUE_EVENTS, ERC4626_EVENTS } from '../compact/protocols/morpho.js';
import { bytes32Address } from '../compact/protocols/common.js';
import { createAssetsAccumulator, createUsdcAccumulator, FAMILY_WINDOWS } from '../compact/families.js';
import { sumWindow } from '../compact/windows.js';
import { validateLogs } from '../compact/logs.js';
import { codeIsPresent } from '../compact/registry.js';
import { LOG_STREAMS, FAMILY_VERSIONS, logFilter } from '../compact/sources.js';
import { hash, json, fail, assertHeapBudget, readDefinition } from './storage.js';
import { unpackAddresses } from './network-reducer.js';

const definitions = new Map(PROTOCOL_FAMILIES.map(f => [f.name, f]));
for (const [name, create] of [['assets', createAssetsAccumulator], ['usdc', createUsdcAccumulator]]) {
  definitions.set(name, { name, version: FAMILY_VERSIONS[name], create,
    streams: LOG_STREAMS.filter(s => s.key === name), codeAddresses: [] });
}
const events = new Map([CCTP_EVENTS, GATEWAY_EVENTS, ACROSS_EVENTS, AAVE_V4_EVENTS,
  MORPHO_BLUE_EVENTS, ERC4626_EVENTS].flatMap(group => Object.values(group)).map(e => [e.topic, e]));
const address = /^0x[0-9a-f]{40}$/;
const packed = set => Buffer.concat([...set].sort().map(a => Buffer.from(a.slice(2), 'hex'))).toString('base64');
export function protocolDefinition(name) {
  const family = definitions.get(name);
  if (!family) fail('protocol_source_unknown');
  return family;
}
export function protocolSource(name) {
  const f = protocolDefinition(name);
  return { id: 'protocol_' + name.toLowerCase(), definition: 'verified-protocol-reduction-v1',
    originalVersion: f.version, family: name, chainId: 5042, streams: f.streams,
    codeAddresses: f.codeAddresses, validity: 'code_required_at_hour_start_and_end' };
}

function validateMetrics(metrics, spec) {
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) fail('protocol_metrics_invalid');
  for (const key of spec.counts ?? [])
    if (!Number.isSafeInteger(metrics[key]) || metrics[key] < 0) fail('protocol_metrics_invalid');
  for (const key of spec.amounts ?? [])
    if (typeof metrics[key] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(metrics[key])) fail('protocol_metrics_invalid');
  for (const key of spec.constants ?? []) {
    const value = metrics[key];
    if (['rawDecimals', 'decimals'].includes(key)) {
      if (!Number.isInteger(value) || value < 0 || value > 36) fail('protocol_metrics_invalid');
    } else if (['reserveId', 'lltv'].includes(key)) {
      if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) fail('protocol_metrics_invalid');
    } else if (key === 'symbol') {
      if (typeof value !== 'string' || !value.trim() || value.length > 64) fail('protocol_metrics_invalid');
    } else if (!address.test(value ?? '')) fail('protocol_metrics_invalid');
  }
  for (const [field, entrySpec] of Object.entries(spec.tallies ?? {})) {
    if (!metrics[field] || typeof metrics[field] !== 'object' || Array.isArray(metrics[field])) fail('protocol_metrics_invalid');
    for (const entry of Object.values(metrics[field])) validateMetrics(entry, entrySpec);
  }
  for (const [field, entrySpec] of Object.entries(spec.lists ?? {})) {
    if (!Array.isArray(metrics[field])) fail('protocol_metrics_invalid');
    const keys = new Set();
    for (const entry of metrics[field]) {
      validateMetrics(entry, entrySpec);
      if (keys.has(entry[entrySpec.key])) fail('protocol_metrics_invalid');
      keys.add(entry[entrySpec.key]);
    }
  }
}

function memberships(name, logs, window, metrics) {
  const out = {};
  const add = (key, a) => {
    if (!address.test(a ?? '')) fail('protocol_member_unverified');
    (out[key] ??= new Set()).add(a);
  };
  for (const l of logs) {
    if (name === 'usdc' || name === 'assets') continue;
    if (name === 'morphoVaultsV2' && !Object.hasOwn(metrics.vaults, l.address)) {
      add('foreignEmitterCount', l.address); continue;
    }
    const e = events.get(l.topics[0])?.decode(l);
    if (!e) fail('protocol_event_unverified');
    if (name === 'aaveV4') add('uniqueUsers', e.user);
    if (name === 'morphoBlue' && l.topics[0] !== MORPHO_BLUE_EVENTS.createMarket.topic)
      add('uniqueAccounts', e.borrower ?? e.onBehalf);
    if (name === 'morphoVaultsV2') add('uniqueOwners', e.owner);
    if (name === 'cctp') {
      if (l.topics[0] === CCTP_EVENTS.depositForBurn.topic)
        add('uniqueOutboundSenders', window.get(l.blockNumber).txFrom[l.transactionIndex]);
      if (l.topics[0] === CCTP_EVENTS.mintAndWithdraw.topic) add('uniqueInboundRecipients', e.mintRecipient);
    }
    if (name === 'gateway') {
      if (l.topics[0] === GATEWAY_EVENTS.deposited.topic) add('uniqueDepositors', e.depositor);
      if (l.topics[0] === GATEWAY_EVENTS.attestationUsed.topic) add('uniqueInboundRecipients', e.recipient);
    }
    if (name === 'across') {
      if (l.topics[0] === ACROSS_EVENTS.fundsDeposited.topic) add('uniqueDepositors', bytes32Address(e.depositor));
      else add('uniqueFillRecipients', bytes32Address(e.relayExecutionInfo.updatedRecipient));
    }
  }
  // Empty activity is verified zero; absent evidence is never passed to this reducer.
  for (const key of Object.keys(metrics).filter(k => k.startsWith('unique') || k === 'foreignEmitterCount')) {
    out[key] ??= new Set();
    if (out[key].size !== metrics[key]) fail('protocol_membership_mismatch');
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, packed(v)]));
}

// Cache entries keep their immutable expected hash even if the value is accidentally lost.
// A damaged/missing value is reread narrowly and may only repair to the exact accepted value.
export function createPinnedViewCache(p) {
  p.transaction(() => p.db.exec(`CREATE TABLE IF NOT EXISTS arc_pipeline_pinned_views(
    cache_key TEXT PRIMARY KEY, request_json TEXT NOT NULL, response_json TEXT,
    response_sha TEXT NOT NULL, anchor_hash TEXT NOT NULL) STRICT, WITHOUT ROWID;
    CREATE TRIGGER IF NOT EXISTS arc_pipeline_view_identity BEFORE UPDATE OF
    cache_key,request_json,response_sha,anchor_hash ON arc_pipeline_pinned_views
    BEGIN SELECT RAISE(ABORT,'pinned_view_immutable'); END;`));
  return async (provider, method, params, anchorHash) => {
    if (!['eth_call', 'eth_getCode'].includes(method) || !/^0x[0-9a-f]+$/.test(params[1] ?? ''))
      fail('pinned_view_required');
    const request = json({ method, params, anchorHash }), key = hash(request);
    const row = p.db.prepare('SELECT * FROM arc_pipeline_pinned_views WHERE cache_key=?').get(key);
    if (row && row.request_json !== request) fail('pinned_view_conflict');
    if (row?.response_json && hash(row.response_json) === row.response_sha) return JSON.parse(row.response_json);
    if (!provider.canContinue()) fail('bounded_run_yield');
    const value = await provider.request(method, params), text = json(value), sha = hash(text);
    if (typeof value !== 'string' || !/^0x[0-9a-f]*$/i.test(value) || text.length > 262144)
      fail('pinned_view_invalid');
    if (row && row.response_sha !== sha) fail('pinned_view_conflict');
    p.transaction(() => {
      if (row) p.db.prepare('UPDATE arc_pipeline_pinned_views SET response_json=? WHERE cache_key=?').run(text, key);
      else p.db.prepare('INSERT INTO arc_pipeline_pinned_views VALUES(?,?,?,?,?)').run(key, request, text, sha, anchorHash);
    }, Buffer.byteLength(request) + Buffer.byteLength(text));
    return value;
  };
}

export function createProtocolProcessor(p, { family: name, loadVerifiedWindow, hourFirstBlock, hourLastBlock } = {}) {
  assertHeapBudget();
  const f = protocolDefinition(name), source = protocolSource(name), resolve = createPinnedViewCache(p);
  if (typeof loadVerifiedWindow !== 'function' || !Number.isSafeInteger(hourFirstBlock)
    || !Number.isSafeInteger(hourLastBlock) || hourLastBlock < hourFirstBlock) fail('canonical_verifier_required');
  return { source, async processJob(j, provider) {
    if (hash(j.spec.source) !== hash(source) || j.spec.first !== hourFirstBlock || j.spec.last !== hourLastBlock)
      fail('protocol_definition_conflict');
    const anchor = loadVerifiedWindow(hourLastBlock, hourLastBlock).get(hourLastBlock);
    if (anchor?.hash !== j.spec.anchorHash) fail('protocol_canonical_conflict');
    const blockTag = '0x' + hourLastBlock.toString(16), codes = new Map(), viewProofs = [];
    for (const a of f.codeAddresses) {
      for (const n of [...new Set([hourFirstBlock, hourLastBlock])]) {
        const tag = '0x' + n.toString(16), value = await resolve(provider, 'eth_getCode', [a, tag], j.spec.anchorHash);
        if (!codeIsPresent(value)) fail('protocol_validity_requires_deployment_evidence');
        viewProofs.push({ method: 'eth_getCode', to: a, blockTag: tag, responseSha256: hash(value) });
        codes.set(a, true);
      }
    }
    let viewFailure = null;
    const context = { blockTag, codePresent: a => codes.get(a) === true, provider: {
      async batch(calls) {
        const out = [];
        for (const [method, params] of calls) {
          if (method !== 'eth_call' || params[1] !== blockTag) fail('historical_view_block_mismatch');
          let value;
          try { value = await resolve(provider, method, params, j.spec.anchorHash); }
          catch (e) { viewFailure ??= e; throw e; }
          viewProofs.push({ method, ...params[0], blockTag, responseSha256: hash(value) }); out.push(value);
        }
        return out;
      },
    } };
    const accumulator = f.create(), all = [], input = createHash('sha256'), seen = new Set();
    let currentWindow;
    const sparse = { get(n) {
      if (!currentWindow?.has(n)) currentWindow = loadVerifiedWindow(n, n);
      if (!(currentWindow instanceof Map) || currentWindow.size !== 1) fail('canonical_window_incomplete');
      return currentWindow.get(n);
    } };
    for (const stream of f.streams) {
      if (!provider.canContinue()) fail('bounded_run_yield');
      const raw = await provider.request('eth_getLogs', [logFilter(stream, j.first_block, j.last_block)]);
      if (!Array.isArray(raw)) fail('protocol_logs_invalid');
      if (raw.length >= 10000) fail('suspect_log_result_count');
      const logs = validateLogs(raw, stream, { fromBlock: j.first_block, toBlock: j.last_block, window: sparse, seen });
      for (const l of logs) input.update(json(l) + '\n');
      accumulator.add(stream.key, logs, sparse); all.push(...logs);
    }
    let metrics;
    try { metrics = await accumulator.finish(context); }
    catch (e) { throw viewFailure ?? e; } // Keep provider/budget diagnostics through existing readViews wrappers.
    const membership = memberships(name, all, sparse, metrics);
    validateMetrics(metrics, FAMILY_WINDOWS[name]);
    input.update(json(viewProofs));
    return { summary: { format: 'arc-reduced-source-v1', first: j.first_block, last: j.last_block,
      sourceKey: hash(source), anchorHash: j.spec.anchorHash, inputSha256: input.digest('hex'),
      status: 'verified', reason: null, counts: { receivedEvents: all.length }, rows: [{
        kind: 'verified_protocol_range', family: name, definitionVersion: f.version, metrics, membership,
        historicalStateBlock: hourLastBlock, viewProofs,
      }] } };
  } };
}

export function deriveProtocolMetrics(p, unitId, name) {
  assertHeapBudget();
  const f = protocolDefinition(name);
  const u = p.db.prepare('SELECT unit_json FROM arc_pipeline_units WHERE unit_id=?').get(unitId);
  if (!u) fail('unit_missing');
  const spec = JSON.parse(readDefinition(u.unit_json));
  if (hash(spec.source) !== hash(protocolSource(name))) fail('protocol_result_invalid');
  // Exact hour-wide membership uses SQLite scratch space, never an unbounded JS Set.
  // Scratch is discarded, accepted evidence and repair checksums remain untouched.
  const table = 'protocol_members_' + createHash('sha256').update(unitId).digest('hex').slice(0, 16);
  p.db.exec(`CREATE TEMP TABLE ${table}(kind TEXT NOT NULL,address BLOB NOT NULL,PRIMARY KEY(kind,address)) STRICT,WITHOUT ROWID`);
  const insert = p.db.prepare(`INSERT OR IGNORE INTO ${table} VALUES(?,?)`);
  let result = null, memberRows = 0;
  const membershipKeys = new Set();
  try { for (const s of p.summaries(unitId)) {
    const r = s.rows[0];
    if (s.rows.length !== 1 || r?.kind !== 'verified_protocol_range' || r.family !== name
      || r.definitionVersion !== f.version || s.sourceKey !== hash(protocolSource(name))
      || s.anchorHash !== spec.anchorHash || r.historicalStateBlock !== spec.last) fail('protocol_result_invalid');
    validateMetrics(r.metrics, FAMILY_WINDOWS[name]);
    result = sumWindow(FAMILY_WINDOWS[name], result ? [result, r.metrics] : [r.metrics]);
    validateMetrics(result, FAMILY_WINDOWS[name]);
    if (Buffer.byteLength(json(result)) > 8 * 1024 * 1024) fail('protocol_read_budget');
    for (const [key, encoded] of Object.entries(r.membership)) {
      if (!(key.startsWith('unique') || key === 'foreignEmitterCount')
        || !Number.isSafeInteger(r.metrics[key]) || r.metrics[key] < 0) fail('protocol_membership_mismatch');
      membershipKeys.add(key);
      let count = 0;
      for (const a of unpackAddresses(encoded)) {
        count++;
        memberRows += Number(insert.run(key, Buffer.from(a.slice(2), 'hex')).changes);
        // Conservative scratch allowance, checked against the shared volume budget.
        if (memberRows % 1024 === 0) {
          if (memberRows * 128 > 32 * 1024 * 1024) fail('protocol_read_budget');
          p.guard(memberRows * 128);
        }
      }
      if (count !== r.metrics[key]) fail('protocol_membership_mismatch');
    }
    for (const key of Object.keys(r.metrics).filter(k => k.startsWith('unique') || k === 'foreignEmitterCount'))
      if (!Object.hasOwn(r.membership, key)) fail('protocol_membership_mismatch');
  }
  if (!result) fail('protocol_result_missing');
  for (const key of membershipKeys) result[key] = 0;
  for (const row of p.db.prepare(`SELECT kind,COUNT(*) n FROM ${table} GROUP BY kind`).iterate()) result[row.kind] = row.n;
  return result;
  } finally { p.db.exec(`DROP TABLE ${table}`); }
}
