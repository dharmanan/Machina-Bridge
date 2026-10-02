// Compact engine: multi-hour sums of a family's stored hourly metrics (1H / 6H / 24H windows and their predecessors),
// computed from the compact rows alone, with no raw history. Only what adds up is summed: counts, raw amounts and keyed
// tallies of them (by domain, chain, token, reserve, market or vault). Per-hour unique counts, pools-with-activity and
// foreign-emitter counts are left out: an actor or pool active in two hours would be counted twice. Constant metadata of a
// key (its token, decimals, market params) must agree across hours; a disagreement fails the window rather than guessing.

export class WindowError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function addInto(target, source, { counts = [], amounts = [], constants = [] }) {
  for (const field of counts) target[field] = (target[field] ?? 0) + source[field];
  for (const field of amounts) target[field] = ((BigInt(target[field] ?? 0) + BigInt(source[field])).toString(10));
  for (const field of constants) {
    if (field in target && target[field] !== source[field]) throw new WindowError('window_constant_mismatch');
    target[field] = source[field];
  }
}

// spec: FAMILY_WINDOWS entry; hours: that family's available metrics, one object per hour, in hour order.
export function sumWindow(spec, hours) {
  const out = {};
  for (const hour of hours) {
    addInto(out, hour, spec);
    for (const [field, tally] of Object.entries(spec.tallies ?? {})) {
      out[field] ??= {};
      for (const [key, entry] of Object.entries(hour[field])) addInto(out[field][key] ??= {}, entry, tally);
    }
    for (const [field, list] of Object.entries(spec.lists ?? {})) {
      out[field] ??= {};
      for (const entry of hour[field]) addInto(out[field][entry[list.key]] ??= {}, entry, list);
    }
  }
  for (const field of Object.keys(spec.tallies ?? {})) {
    out[field] = Object.fromEntries(Object.keys(out[field] ?? {}).sort().map((key) => [key, out[field][key]]));
  }
  for (const field of Object.keys(spec.lists ?? {})) {
    out[field] = Object.keys(out[field] ?? {}).sort().map((key) => out[field][key]);
  }
  return out;
}
