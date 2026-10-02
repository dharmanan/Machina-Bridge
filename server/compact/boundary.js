// Compact engine: exact UTC-hour block boundaries. Pure and dependency free; the only input is a header reader
// header(n) -> { number, hash, parentHash, timestamp }. Deterministic for a fixed safe head, so recorded probes
// replay exactly. Hour membership matches the A2 reducer: timestamp >= hourStart && timestamp < hourEnd.
export const BOUNDARY_RATE_SAMPLE_BLOCKS = 50000;
export const BOUNDARY_MARGIN_BLOCKS = 2000;
export const BOUNDARY_MAX_PROBES = 64;

export async function locateHourBlocks({ header, safeHead, hourStart, hourEnd,
  rateSample = BOUNDARY_RATE_SAMPLE_BLOCKS, margin = BOUNDARY_MARGIN_BLOCKS, maxProbes = BOUNDARY_MAX_PROBES }) {
  if (!Number.isSafeInteger(safeHead) || safeHead < 1 || !Number.isSafeInteger(hourStart) || hourEnd !== hourStart + 3600
    || hourStart % 3600 !== 0) throw new Error('invalid_hour_request');
  let probes = 0;
  const read = async (number) => {
    if (++probes > maxProbes * 4) throw new Error('boundary_search_exhausted');
    const block = await header(number);
    if (!block || block.number !== number || !Number.isSafeInteger(block.timestamp)) throw new Error('boundary_header_invalid');
    return block;
  };
  const top = await read(safeHead);
  // A complete hour needs a finalized block at or after its end: the right boundary must exist.
  if (top.timestamp < hourEnd) throw new Error('hour_not_finalized');
  const sample = await read(Math.max(0, safeHead - rateSample));
  const secondsPerBlock = (top.timestamp - sample.timestamp) / Math.max(1, top.number - sample.number);
  if (!(secondsPerBlock > 0)) throw new Error('boundary_rate_unavailable');
  const estimate = (target) => Math.min(safeHead, Math.max(0, Math.round(top.number - (top.timestamp - target) / secondsPerBlock)));

  async function firstAtOrAfter(target) {
    let step = margin;
    let lowNumber = Math.max(0, estimate(target) - margin);
    let highNumber = Math.min(safeHead, estimate(target) + margin);
    let lo = await read(lowNumber), hi = await read(highNumber);
    for (let i = 0; lo.timestamp >= target; i++) {
      if (lowNumber === 0 || i > 20) throw new Error('boundary_bracket_failed');
      step *= 2; lowNumber = Math.max(0, lowNumber - step); lo = await read(lowNumber);
    }
    for (let i = 0; hi.timestamp < target; i++) {
      if (highNumber === safeHead || i > 20) throw new Error('boundary_bracket_failed');
      step *= 2; highNumber = Math.min(safeHead, highNumber + step); hi = await read(highNumber);
    }
    // Invariant: lo.timestamp < target <= hi.timestamp. Interpolate on timestamps, bisecting every fourth step
    // so equal per-second timestamps can never stall progress.
    for (let i = 1; hi.number - lo.number > 1; i++) {
      if (i > maxProbes) throw new Error('boundary_search_exhausted');
      const span = hi.number - lo.number;
      let guess = i % 4 === 0 ? lo.number + Math.floor(span / 2)
        : lo.number + Math.floor(span * (target - lo.timestamp) / Math.max(1, hi.timestamp - lo.timestamp));
      guess = Math.min(hi.number - 1, Math.max(lo.number + 1, guess));
      const middle = await read(guess);
      if (middle.timestamp < target) lo = middle; else hi = middle;
    }
    return { before: lo, first: hi };
  }

  const start = await firstAtOrAfter(hourStart);
  const end = await firstAtOrAfter(hourEnd);
  if (end.first.number <= start.first.number) throw new Error('hour_has_no_blocks');
  return { before: start.before, first: start.first, last: end.before, after: end.first, probes };
}
