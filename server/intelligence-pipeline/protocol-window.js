// Isolated read model: strict source/registry selection, exact raw sums, explicit partial financial actions.
// No remote I/O or changes to production APIs. Missing hours/prices remain absent, never zero-filled.
import { FAMILY_WINDOWS } from '../compact/families.js';
import { PROTOCOL_USD } from '../compact/read-model.js';
import { sumWindow } from '../compact/windows.js';
import { anchorDecimals, priceableDecimals, usdMicrosOf } from '../compact/valuation.js';
import { deriveProtocolMetrics, protocolSource } from './protocol-source.js';
import { hash, fail } from './storage.js';

const iso = n => new Date(n * 1000).toISOString();
export function readProtocolWindow(p, { family, hours, endHour, registryDigest } = {}) {
  if (![24, 168, 720].includes(hours) || !Number.isSafeInteger(endHour) || endHour % 3600 !== 0
    || !/^[0-9a-f]{64}$/.test(registryDigest ?? '')) fail('window_definition_invalid');
  const sourceKey = hash(protocolSource(family)), start = endHour - hours * 3600;
  const rows = p.db.prepare(`SELECT unit_id,hour_start,first_block,last_block,anchor_hash FROM arc_pipeline_units
    WHERE source_key=? AND registry_digest=? AND hour_start>=? AND hour_start<? ORDER BY hour_start,unit_id`)
    .all(sourceKey, registryDigest, start, endHour);
  if (rows.length > hours || new Set(rows.map(r => r.hour_start)).size !== rows.length) fail('window_canonical_conflict');
  let total = null, first = null, last = null, verified = 0;
  const days = new Map(), issues = [], actions = new Map();
  for (const row of rows) {
    if (row.hour_start % 3600 !== 0) fail('window_canonical_conflict');
    const coverage = p.coverage(row.unit_id);
    if (coverage.status !== 'complete') { issues.push({ hour: iso(row.hour_start), reason: coverage.reason }); continue; }
    const metrics = deriveProtocolMetrics(p, row.unit_id, family);
    total = sumWindow(FAMILY_WINDOWS[family], total ? [total, metrics] : [metrics]);
    const day = Math.floor(row.hour_start / 86400) * 86400, d = days.get(day) ?? { hours: 0, metrics: null };
    d.hours++; d.metrics = sumWindow(FAMILY_WINDOWS[family], d.metrics ? [d.metrics, metrics] : [metrics]); days.set(day, d);
    first ??= row.hour_start; last = row.hour_start; verified++;
    const spec = PROTOCOL_USD[family];
    if (!spec) continue;
    const value = (token, raw, declared = null) => {
      if (!/^0x[0-9a-f]{40}$/.test(token ?? '') || !/^(0|[1-9][0-9]*)$/.test(raw ?? '')) fail('protocol_amount_invalid');
      const amount = BigInt(raw), decimals = anchorDecimals(token) ?? priceableDecimals(token);
      const reason = amount === 0n ? null : decimals === null ? 'unverified_token'
        : declared !== null && declared !== decimals ? 'decimals_mismatch'
          : anchorDecimals(token) === null ? 'same_hour_verified_price_missing' : null;
      // This module does not accept an arbitrary price map. Non-anchor prices need the verified valuation adapter.
      const usd = reason ? null : amount === 0n ? 0n : usdMicrosOf(token, amount, null);
      return { token, amount, usd, reason };
    };
    for (const [action, entries] of Object.entries(spec.amounts(metrics, value))) {
      const a = actions.get(action) ?? { usd: 0n, hasValue: false, fullyValuedHours: 0, assets: new Map() };
      if (entries.every(e => e.usd !== null)) a.fullyValuedHours++;
      if (!entries.length) a.hasValue = true;
      for (const e of entries) {
        const asset = a.assets.get(e.token) ?? { token: e.token, amount: 0n, valued: 0n, unvalued: 0n, usd: 0n, hasValue: false, reasons: new Set() };
        asset.amount += e.amount;
        if (e.usd !== null) { asset.valued += e.amount; asset.usd += e.usd; asset.hasValue = true; a.usd += e.usd; a.hasValue = true; }
        else { asset.unvalued += e.amount; asset.reasons.add(e.reason); }
        a.assets.set(e.token, asset);
      }
      actions.set(action, a);
    }
  }
  const complete = verified === hours, display = verified > 0 && (complete || hours === 720);
  const actionResults = Object.fromEntries([...actions].map(([name, a]) => [name, {
    status: complete && a.fullyValuedHours === hours ? 'complete' : a.hasValue ? 'partial' : 'unavailable',
    scope: complete && a.fullyValuedHours === hours ? 'all_verified_window_amounts' : 'verified_priced_subset',
    usdMicros: display && a.hasValue ? a.usd.toString() : null,
    coverage: { requiredHours: hours, verifiedHours: verified, fullyValuedHours: a.fullyValuedHours },
    assets: [...a.assets.values()].sort((a, b) => a.token.localeCompare(b.token)).map(a => ({
      token: a.token, amountRaw: a.amount.toString(), valuedAmountRaw: a.valued.toString(),
      unvaluedAmountRaw: a.unvalued.toString(), usdMicros: display && a.hasValue ? a.usd.toString() : null,
      reasons: [...a.reasons].sort(),
    })),
  }]));
  const daily = [];
  for (let day = Math.floor(start / 86400) * 86400; day < endHour; day += 86400) {
    const d = days.get(day), full = day >= start && day + 86400 <= endHour && d?.hours === 24;
    daily.push({ startUtc: iso(day), endUtc: iso(day + 86400), verifiedHours: d?.hours ?? 0,
      requiredHours: 24, status: full ? 'available' : 'incomplete',
      reason: full ? null : 'incomplete_utc_day', metrics: full ? d.metrics : null });
  }
  return { scope: 'isolated_protocol_read_model', family, sourceKey, registryDigest,
    status: complete ? 'available' : verified ? 'partial' : 'unavailable',
    reason: complete ? null : verified ? 'partial_verified_history' : 'verified_history_missing',
    coverage: { verifiedHours: verified, requiredHours: hours, missingHours: hours - verified,
      selectedStartUtc: iso(start), selectedEndUtc: iso(endHour), firstVerifiedUtc: first === null ? null : iso(first),
      lastVerifiedEndUtc: last === null ? null : iso(last + 3600) }, metrics: display ? total : null,
    actions: actionResults, daily, issues };
}

// Integer micro-USD comparisons never pass through IEEE-754; ties are stable by protocol id.
// Different lending/bridge actions deliberately have independent rankings.
export function rankFinancialActions({ dex = [], protocols = [] } = {}) {
  const compare = (a, b) => BigInt(a.usdMicros) > BigInt(b.usdMicros) ? -1
    : BigInt(a.usdMicros) < BigInt(b.usdMicros) ? 1 : a.protocol.localeCompare(b.protocol);
  const eligible = r => /^(0|[1-9][0-9]*)$/.test(r.usdMicros ?? '')
    && ['complete', 'partial'].includes(r.status) && ['all_verified_window_amounts', 'verified_priced_subset'].includes(r.scope);
  const dexRanking = dex.filter(eligible).map(r => ({ ...r })).sort(compare), lending = {}, crossChain = {};
  for (const r of protocols) {
    const section = PROTOCOL_USD[r.family]?.section;
    if (!section) fail('ranking_protocol_unknown');
    const target = section === 'lending' ? lending : crossChain;
    for (const [action, value] of Object.entries(r.actions)) if (eligible(value))
      (target[action] ??= []).push({ protocol: r.family, ...value });
  }
  for (const target of [lending, crossChain]) for (const action of Object.keys(target)) target[action].sort(compare);
  return { dex: dexRanking, lending, crossChain, combinedFinancialTotal: null,
    semantics: 'DEX volume only; lending and cross-chain ranked separately per financial action' };
}
