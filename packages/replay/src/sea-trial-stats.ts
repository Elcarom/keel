import { type ConfirmedBar } from "@keel/core";

// ============================================================================
// Statistics for a Proposition's sea trial. Pure functions over a finished replay: they never
// re-run a strategy, so they cost almost nothing next to the backtests themselves.
// ============================================================================

/** A deterministic PRNG (mulberry32), so a sea trial gives the same answer every time. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A stable 32-bit seed from a string, e.g. a proposition id. */
export function seedFromString(text: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16_777_619);
  }
  return hash >>> 0;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

export interface BootstrapSummary {
  readonly paths: number;
  readonly lossProbabilityPct: number;
  readonly p5ReturnPct: number;
  readonly medianReturnPct: number;
  readonly p95DrawdownPct: number;
}

/**
 * Resamples the trade sequence with replacement: each path draws as many trades as the backtest
 * made and compounds them. Shows how much of the result was the lucky order of a few trades.
 *
 * @param tradeReturns each trade's net P&L as a fraction of the equity it was taken with
 */
export function bootstrapTradeReturns(params: {
  readonly tradeReturns: readonly number[];
  readonly paths: number;
  readonly seed: number;
}): BootstrapSummary {
  const n = params.tradeReturns.length;
  const paths = Math.max(1, Math.round(params.paths));
  if (n === 0) {
    return { paths, lossProbabilityPct: 0, p5ReturnPct: 0, medianReturnPct: 0, p95DrawdownPct: 0 };
  }
  const random = seededRandom(params.seed);
  const finals: number[] = [];
  const drawdowns: number[] = [];
  for (let p = 0; p < paths; p += 1) {
    let equity = 1;
    let peak = 1;
    let worst = 0;
    for (let i = 0; i < n; i += 1) {
      const r = params.tradeReturns[Math.floor(random() * n)] ?? 0;
      equity *= Math.max(0, 1 + r);
      peak = Math.max(peak, equity);
      worst = Math.max(worst, peak > 0 ? (peak - equity) / peak : 0);
    }
    finals.push((equity - 1) * 100);
    drawdowns.push(worst * 100);
  }
  finals.sort((a, b) => a - b);
  drawdowns.sort((a, b) => a - b);
  return {
    paths,
    lossProbabilityPct: (finals.filter((f) => f < 0).length / paths) * 100,
    p5ReturnPct: quantile(finals, 0.05),
    medianReturnPct: quantile(finals, 0.5),
    p95DrawdownPct: quantile(drawdowns, 0.95)
  };
}

/**
 * One-sided t-test that the mean of `values` is above zero, with a normal approximation for the
 * p-value (fine from about 30 trades; below that, treat it as indicative only).
 */
export function oneSidedTTest(
  values: readonly number[],
  normalCdf: (z: number) => number
): { readonly tStat: number; readonly pValue: number } {
  const n = values.length;
  if (n < 2) return { tStat: 0, pValue: 1 };
  const mean = values.reduce((a, v) => a + v, 0) / n;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1);
  if (variance === 0) return mean > 0 ? { tStat: 99, pValue: 0 } : { tStat: 0, pValue: 1 };
  const tStat = mean / Math.sqrt(variance / n);
  return { tStat, pValue: 1 - normalCdf(tStat) };
}

export interface PeriodSegment {
  readonly fromTs: number;
  readonly toTs: number;
  readonly returnPct: number;
  readonly marketReturnPct: number;
  readonly trades: number;
}

/** The last value at or before `ts` in a series sorted by time, or `fallback`. */
function valueAsOf<T>(
  items: readonly T[],
  tsOf: (item: T) => number,
  ts: number,
  valueOf: (item: T) => number,
  fallback: number
): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const item = items[mid];
    if (item !== undefined && tsOf(item) <= ts) lo = mid + 1;
    else hi = mid;
  }
  const found = items[lo - 1];
  return found === undefined ? fallback : valueOf(found);
}

/**
 * Splits a backtest into equal periods and reports the strategy's and the market's return in each,
 * so a result carried by one lucky stretch is easy to see.
 */
export function splitIntoPeriods(params: {
  readonly fromTs: number;
  readonly toTs: number;
  readonly periods: number;
  readonly initialEquity: number;
  readonly equityCurve: readonly { readonly ts: number; readonly equity: number }[];
  readonly bars: readonly Pick<ConfirmedBar, "closeTs" | "close">[];
  readonly tradeEntryTimes: readonly number[];
}): PeriodSegment[] {
  const span = (params.toTs - params.fromTs) / params.periods;
  const firstClose = params.bars[0] ? Number(params.bars[0].close) : 0;
  const segments: PeriodSegment[] = [];
  for (let i = 0; i < params.periods; i += 1) {
    const fromTs = Math.round(params.fromTs + i * span);
    const toTs =
      i === params.periods - 1 ? params.toTs : Math.round(params.fromTs + (i + 1) * span);
    const equityAt = (ts: number) =>
      valueAsOf(
        params.equityCurve,
        (p) => p.ts,
        ts,
        (p) => p.equity,
        params.initialEquity
      );
    const closeAt = (ts: number) =>
      valueAsOf(
        params.bars,
        (b) => b.closeTs,
        ts,
        (b) => Number(b.close),
        firstClose
      );
    const startEquity = equityAt(fromTs);
    const startClose = closeAt(fromTs);
    segments.push({
      fromTs,
      toTs,
      returnPct: startEquity > 0 ? (equityAt(toTs) / startEquity - 1) * 100 : 0,
      marketReturnPct: startClose > 0 ? (closeAt(toTs) / startClose - 1) * 100 : 0,
      trades: params.tradeEntryTimes.filter((t) => t >= fromTs && t < toTs).length
    });
  }
  return segments;
}
