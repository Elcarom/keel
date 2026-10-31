import {
  SEALED_HOLDOUT_END_TS,
  SEALED_HOLDOUT_START_TS,
  ScaledDecimal,
  normalizeRig,
  type Assessment,
  type BlindTrial,
  type BotArchetype,
  type Rig,
  type ConfirmedBar,
  type SeaTrial,
  type SeaTrialCheck,
  type SeaTrialCheckKey,
  type SeaTrialSegment,
  type SeaTrialVariant,
  type Verdict
} from "@keel/core";
import {
  bootstrapTradeReturns,
  computeDeflatedSharpeRatio,
  getTimeframeAnnualizationPeriods,
  normalCdf,
  oneSidedTTest,
  splitIntoPeriods,
  type ReplayEquityPoint,
  type ReplayRunResult,
  type ReplayTradeRecord
} from "@keel/replay";
import { nudgeInvention } from "@keel/spec";

// ============================================================================
// Sea trials: how a Proposition is judged before it may launch. One full backtest plus re-runs
// with nudged parameters and on a sibling market, then statistics over the trades. Everything
// here is research arithmetic over finished replays; no money moves.
// ============================================================================

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Correlation of two weekly equity curves' week-on-week changes, or null when either is too
 * flat or too short to say (ADR-0030).
 */
export function weeklyCorrelation(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 12) return null;
  const da: number[] = [];
  const db: number[] = [];
  for (let i = 1; i < n; i++) {
    da.push((a[i] ?? 0) - (a[i - 1] ?? 0));
    db.push((b[i] ?? 0) - (b[i - 1] ?? 0));
  }
  const ma = da.reduce((s, v) => s + v, 0) / da.length;
  const mb = db.reduce((s, v) => s + v, 0) / db.length;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < da.length; i++) {
    const x = (da[i] ?? 0) - ma;
    const y = (db[i] ?? 0) - mb;
    cov += x * y;
    va += x * x;
    vb += y * y;
  }
  if (va < 1e-9 || vb < 1e-9) return null;
  return round(cov / Math.sqrt(va * vb), 3);
}

/**
 * The backtest window: the two years before 2024-12-01. In-sample data, clear of the sealed
 * holdout (2025 onward).
 */
export const BACKTEST_TO_TS = 1_733_011_200_000; // 2024-12-01 00:00:00 UTC
export const BACKTEST_DAYS = 730;
export const BACKTEST_FROM_TS = BACKTEST_TO_TS - BACKTEST_DAYS * DAY_MS;

/**
 * The Blind Trial's year: 2025, the sealed holdout, which no sea trial and no Shipwright prompt
 * ever sees (ADR-0035). It ends a millisecond before the sealed 2026 partition.
 */
export const BLIND_FROM_TS = SEALED_HOLDOUT_START_TS;
export const BLIND_TO_TS = SEALED_HOLDOUT_END_TS - 1;
export const BLIND_DAYS = 365;

/**
 * Backtests behind every sea trial: the main run, four nudged versions and the sibling market.
 * Each one is a look at the same history, so each counts towards the luck adjustment.
 */
export const REPLAYS_PER_SEA_TRIAL = 6;

/**
 * OKX's public API keeps only recent funding history, so most of the window has none. Every open
 * position then pays OKX's base rate of 0.01% per 8h, long or short: deliberately pessimistic.
 */
export const ASSUMED_FUNDING_BPS_PER_8H = 1;

export interface SeaTrialSettings {
  /** Random-entry paths behind the main run's "beats random" percentile. */
  readonly randomEntryPaths: number;
  /** Resampled trade sequences behind the Monte Carlo check. */
  readonly monteCarloPaths: number;
  /** Equal periods the window is split into for the consistency check. */
  readonly periods: number;
}

export const DEFAULT_SEA_TRIAL_SETTINGS: SeaTrialSettings = {
  randomEntryPaths: 200,
  monteCarloPaths: 1000,
  periods: 8
};

/** Archetypes whose rules never read entryThreshold: nudging it would change nothing. */
const IGNORES_THRESHOLD: ReadonlySet<BotArchetype> = new Set([
  "breakout",
  "ma_crossover",
  "inside_bar_breakout",
  "failed_breakout"
]);

/**
 * The parameter nudges a robust idea should survive: the main window shorter and longer, then
 * the trigger (or, where there is none, the stop) tighter and looser.
 */
export function neighbourRigs(b: Rig): readonly { readonly label: string; readonly rig: Rig }[] {
  // Inventions have no fixed parameters: nudge every window, then every threshold in the rules
  const archetype = b.archetype;
  if (archetype === "invented") {
    return [
      { label: "Windows −25%", rig: nudgeInvention(b, 0.75, 1) },
      { label: "Windows +33%", rig: nudgeInvention(b, 1.33, 1) },
      { label: "Thresholds −10%", rig: nudgeInvention(b, 1, 0.9) },
      { label: "Thresholds +10%", rig: nudgeInvention(b, 1, 1.1) }
    ];
  }
  const nudge = (changes: Partial<Rig>) => normalizeRig({ ...b, ...changes, archetype });
  const windows = [
    {
      label: "Window −25%",
      rig: nudge({
        lookbackPeriod: b.lookbackPeriod * 0.75,
        fastPeriod: b.fastPeriod * 0.75
      })
    },
    {
      label: "Window +33%",
      rig: nudge({
        lookbackPeriod: b.lookbackPeriod * 1.33,
        fastPeriod: b.fastPeriod * 1.33
      })
    }
  ];
  if (IGNORES_THRESHOLD.has(archetype)) {
    return [
      ...windows,
      { label: "Stop −25%", rig: nudge({ stopAtrMultiple: b.stopAtrMultiple * 0.75 }) },
      { label: "Stop +33%", rig: nudge({ stopAtrMultiple: b.stopAtrMultiple * 1.33 }) }
    ];
  }
  return [
    ...windows,
    { label: "Trigger −20%", rig: nudge({ entryThreshold: b.entryThreshold * 0.8 }) },
    { label: "Trigger +25%", rig: nudge({ entryThreshold: b.entryThreshold * 1.25 }) }
  ];
}

function round(value: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

function signed(value: number, suffix = "%"): string {
  return `${value > 0 ? "+" : ""}${round(value)}${suffix}`;
}

/**
 * What the sea trial reads from a backtest: one replay, or a basket's replays combined into one
 * portfolio by combineRuns.
 */
export type TrialRun = Pick<
  ReplayRunResult,
  | "netPnlUsdt"
  | "sharpeRatio"
  | "deflatedSharpeRatio"
  | "totalTrades"
  | "winRate"
  | "avgR"
  | "maxDrawdownPct"
  | "fromTs"
  | "toTs"
  | "stressNetExpectancyR"
  | "walkForwardOutOfSampleAvgR"
  | "replayGatePassed"
  | "randomEntryPercentile"
  | "buyAndHoldReturnPct"
  | "buyAndHoldSharpeRatio"
> & {
  readonly trades: readonly Pick<ReplayTradeRecord, "entryTs" | "exitTs" | "netPnlUsdt" | "netR">[];
  readonly equityCurve: readonly Pick<ReplayEquityPoint, "ts" | "equityUsdt">[];
};

/**
 * A basket boat's backtest: each coin replayed on the full stake, as the live boat sizes every
 * position off its whole equity, then summed into one portfolio. Equity adds up hour by hour;
 * Sharpe, luck adjustment and worst dip are measured on the combined curve. Per-coin statistics
 * the replays measured on their own (cost stress, walk-forward, random entries, holding) are
 * averaged, weighted by trades where trades drive them. See ADR-0028.
 */
export function combineRuns(runs: readonly TrialRun[], initial: number, trials: number): TrialRun {
  const [first] = runs;
  if (!first) throw new Error("A sea trial needs at least one run");
  if (runs.length === 1) return first;

  const totalTrades = runs.reduce((n, r) => n + r.totalTrades, 0);
  const mean = (f: (r: TrialRun) => number) => runs.reduce((a, r) => a + f(r), 0) / runs.length;
  const byTrades = (f: (r: TrialRun) => number) =>
    totalTrades > 0 ? runs.reduce((a, r) => a + f(r) * r.totalTrades, 0) / totalTrades : mean(f);

  // Portfolio equity: each run's last known equity at every timestamp any run marked
  const times = [...new Set(runs.flatMap((r) => r.equityCurve.map((p) => p.ts)))].sort(
    (a, b) => a - b
  );
  const cursor = runs.map(() => 0);
  const lastEquity = runs.map(() => initial);
  const equityCurve: { ts: number; equityUsdt: string }[] = [];
  const periodicReturns: number[] = [];
  let peak = initial;
  let maxDrawdownPct = 0;
  let prev = initial;
  for (const ts of times) {
    runs.forEach((r, i) => {
      let c = cursor[i] ?? 0;
      while (c < r.equityCurve.length && (r.equityCurve[c]?.ts ?? Infinity) <= ts) {
        lastEquity[i] = Number(r.equityCurve[c]?.equityUsdt ?? initial);
        c++;
      }
      cursor[i] = c;
    });
    const equity = lastEquity.reduce((a, e) => a + (e - initial), initial);
    equityCurve.push({ ts, equityUsdt: equity.toFixed(8) });
    periodicReturns.push(prev > 0 ? (equity - prev) / prev : 0);
    prev = equity;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
  }
  const dsr = computeDeflatedSharpeRatio({
    periodicReturns,
    annualizationFactor: Math.sqrt(getTimeframeAnnualizationPeriods("1H")),
    numTrials: Math.max(1, trials)
  });

  const trades = runs.flatMap((r) => r.trades).sort((a, b) => a.exitTs - b.exitTs);
  const netPnl = runs.reduce(
    (sum, r) => sum.add(ScaledDecimal.fromString(r.netPnlUsdt)),
    ScaledDecimal.zero()
  );
  return {
    netPnlUsdt: netPnl.toFixed(8),
    sharpeRatio: dsr.sharpeRatio,
    deflatedSharpeRatio: dsr.deflatedSharpeRatio,
    totalTrades,
    winRate: byTrades((r) => r.winRate),
    avgR: trades.length > 0 ? trades.reduce((a, t) => a + t.netR, 0) / trades.length : 0,
    maxDrawdownPct,
    fromTs: Math.min(...runs.map((r) => r.fromTs)),
    toTs: Math.max(...runs.map((r) => r.toTs)),
    stressNetExpectancyR: byTrades((r) => r.stressNetExpectancyR),
    walkForwardOutOfSampleAvgR: byTrades((r) => r.walkForwardOutOfSampleAvgR),
    replayGatePassed: runs.every((r) => r.replayGatePassed),
    // An average of percentiles is no percentile: the basket beats random only as far as its
    // weakest coin does
    randomEntryPercentile: Math.min(...runs.map((r) => r.randomEntryPercentile ?? 0)),
    buyAndHoldReturnPct: mean((r) => r.buyAndHoldReturnPct ?? 0),
    buyAndHoldSharpeRatio: mean((r) => r.buyAndHoldSharpeRatio ?? 0),
    trades,
    equityCurve
  };
}

/**
 * An equal-weight index of several markets' closes on the first market's hours, so a basket's
 * seasons compare with the basket's own market.
 */
export function basketIndexBars(
  barsByMarket: readonly (readonly ConfirmedBar[])[]
): { closeTs: number; close: string }[] {
  const [lead] = barsByMarket;
  if (!lead || barsByMarket.length === 1) return lead ? [...lead] : [];
  const cursors = barsByMarket.map(() => 0);
  const firsts = barsByMarket.map((bars) => Number(bars[0]?.close ?? 0));
  const lasts = [...firsts];
  return lead.map((bar) => {
    let sum = 0;
    barsByMarket.forEach((bars, i) => {
      let c = cursors[i] ?? 0;
      while (c < bars.length && (bars[c]?.closeTs ?? Infinity) <= bar.closeTs) {
        lasts[i] = Number(bars[c]?.close ?? 0);
        c++;
      }
      cursors[i] = c;
      sum += (firsts[i] ?? 0) > 0 ? (lasts[i] ?? 0) / (firsts[i] ?? 1) : 1;
    });
    return { closeTs: bar.closeTs, close: ((sum / barsByMarket.length) * 100).toFixed(8) };
  });
}

/** A finished backtest reduced to what the sea trial compares. */
export function variantOf(
  label: string,
  result: Pick<TrialRun, "netPnlUsdt" | "sharpeRatio" | "totalTrades">,
  initial: number
): SeaTrialVariant {
  return {
    label,
    returnPct: round((Number(result.netPnlUsdt) / initial) * 100),
    sharpeRatio: round(Number.isFinite(result.sharpeRatio) ? result.sharpeRatio : 0),
    trades: result.totalTrades
  };
}

/**
 * Each trade's net P&L as a fraction of the equity it was taken with (one position at a time).
 * A basket's trades overlap, so for a basket this is an approximation.
 */
function tradeReturns(result: TrialRun, initial: number): number[] {
  let equity = initial;
  const returns: number[] = [];
  for (const t of result.trades) {
    const pnl = Number(t.netPnlUsdt.toString());
    returns.push(equity > 0 ? pnl / equity : 0);
    equity += pnl;
  }
  return returns;
}

interface CheckSpec {
  readonly label: string;
  readonly weight: number;
  readonly critical: boolean;
}

/**
 * Weights sum to 60; the other 40 points come from the headline performance. The critical checks
 * together are Keel's research gate (ADR-0009, ADR-0035): a design must pass them all, and then
 * its Blind Trial, to be seaworthy.
 */
const CHECKS: Readonly<Record<SeaTrialCheckKey, CheckSpec>> = {
  enough_trades: { label: "Enough trades to judge", weight: 3, critical: true },
  survives_costs: { label: "Survives doubled costs", weight: 8, critical: true },
  out_of_sample: { label: "Holds up on later folds", weight: 8, critical: true },
  robust_parameters: { label: "Robust to nudged settings", weight: 8, critical: true },
  steady_quarters: { label: "Steady across the seasons", weight: 7, critical: false },
  travels_well: { label: "Works on a sibling market", weight: 6, critical: false },
  luck_adjusted: { label: "More skill than luck", weight: 6, critical: true },
  research_gate: { label: "Clears the research gate", weight: 4, critical: true },
  survives_resampling: { label: "Survives reshuffled trades", weight: 5, critical: false },
  beats_holding: { label: "Beats holding, risk-adjusted", weight: 2, critical: false },
  beats_random: { label: "Beats random entries", weight: 1, critical: false },
  shallow_drawdown: { label: "Shallow worst dip", weight: 2, critical: false }
};

/** The research gate's bars (promotionLadder in the config), shared with the replay engine. */
export interface ResearchGate {
  readonly minTrades: number;
  readonly minSharpe: number;
  readonly minDeflatedSharpe: number;
}

/** The worst dip the research gate allows, as in the replay engine's gate. */
export const GATE_MAX_DRAWDOWN_PCT = 25;
/** The gate's random-entry bar: the boat's Sharpe above the 75th percentile of random entries. */
export const GATE_RANDOM_PERCENTILE = 75;

export interface SeaTrialInput {
  readonly main: TrialRun;
  /** The market (or, for a basket, the equal-weight index) the seasons compare with. */
  readonly bars: readonly Pick<ConfirmedBar, "closeTs" | "close">[];
  readonly neighbours: readonly SeaTrialVariant[];
  readonly sibling: (SeaTrialVariant & { readonly instrumentId: string }) | null;
  readonly initialEquityUsdt: string;
  readonly funding: "settled" | "assumed";
  readonly gate: ResearchGate;
  readonly trials: number;
  readonly days: number;
  readonly seed: number;
  readonly settings: SeaTrialSettings;
}

/**
 * Turns a sea trial into a 0-100 score, a verdict and a checklist. "Seaworthy" needs every
 * critical check; a high score alone cannot launch an overfitted idea to the top.
 */
export function assessSeaTrial(input: SeaTrialInput): Assessment {
  const { main } = input;
  const initial = Number(input.initialEquityUsdt);
  const returnPct = round((Number(main.netPnlUsdt) / initial) * 100);
  const sharpe = Number.isFinite(main.sharpeRatio) ? main.sharpeRatio : 0;
  const trades = main.totalTrades;
  const years = input.days / 365;

  const curve = main.equityCurve.map((p) => ({ ts: p.ts, equity: Number(p.equityUsdt) }));
  const segments: SeaTrialSegment[] = splitIntoPeriods({
    fromTs: main.fromTs,
    toTs: main.toTs,
    periods: input.settings.periods,
    initialEquity: initial,
    equityCurve: curve,
    bars: input.bars,
    tradeEntryTimes: main.trades.map((t) => t.entryTs)
  }).map((s) => ({
    ...s,
    returnPct: round(s.returnPct),
    marketReturnPct: round(s.marketReturnPct)
  }));
  const active = segments.filter((s) => s.trades > 0);
  const winningSeasons = active.filter((s) => s.returnPct > 0).length;

  const mc = bootstrapTradeReturns({
    tradeReturns: tradeReturns(main, initial),
    paths: input.settings.monteCarloPaths,
    seed: input.seed
  });
  const significance = oneSidedTTest(
    main.trades.map((t) => t.netR),
    normalCdf
  );

  const profitableNeighbours = input.neighbours.filter((n) => n.returnPct > 0).length;
  const neighbourSharpes = input.neighbours.map((n) => n.sharpeRatio).sort((a, b) => a - b);
  const medianNeighbourSharpe =
    neighbourSharpes.length === 0
      ? 0
      : ((neighbourSharpes[Math.floor((neighbourSharpes.length - 1) / 2)] ?? 0) +
          (neighbourSharpes[Math.ceil((neighbourSharpes.length - 1) / 2)] ?? 0)) /
        2;
  const randomPercentile = main.randomEntryPercentile ?? 0;
  const holdSharpe = main.buyAndHoldSharpeRatio ?? 0;
  const oosR = main.walkForwardOutOfSampleAvgR;
  const { gate } = input;
  const gateMisses = [
    sharpe < gate.minSharpe ? `Sharpe ${round(sharpe)} below ${gate.minSharpe}` : null,
    sharpe <= holdSharpe
      ? `Sharpe ${round(sharpe)} not above holding's ${round(holdSharpe)}`
      : null,
    randomPercentile < GATE_RANDOM_PERCENTILE
      ? `below the ${GATE_RANDOM_PERCENTILE}th percentile of random entries`
      : null,
    main.maxDrawdownPct > GATE_MAX_DRAWDOWN_PCT
      ? `worst dip ${round(main.maxDrawdownPct, 1)}% over ${GATE_MAX_DRAWDOWN_PCT}%`
      : null
  ].filter((m): m is string => m !== null);

  const results: Record<SeaTrialCheckKey, { passed: boolean; detail: string }> = {
    enough_trades: {
      passed: trades >= gate.minTrades,
      detail: `${trades} trades in ${input.days} days (needs ${gate.minTrades})`
    },
    survives_costs: {
      passed: main.stressNetExpectancyR > 0,
      detail: `Average trade ${signed(main.stressNetExpectancyR, "R")} with fees and slippage doubled`
    },
    out_of_sample: {
      passed: oosR > 0 && trades >= gate.minTrades,
      // Later folds of the same window: a check on stability, not unseen data (the Blind Trial is)
      detail: `Average trade ${signed(oosR, "R")} on the window's later walk-forward folds`
    },
    robust_parameters: {
      passed:
        returnPct > 0 &&
        profitableNeighbours >= Math.ceil(input.neighbours.length * 0.75) &&
        medianNeighbourSharpe >= sharpe * 0.5,
      detail: `${profitableNeighbours} of ${input.neighbours.length} nudged versions profitable, median Sharpe ${round(medianNeighbourSharpe)} vs ${round(sharpe)}`
    },
    steady_quarters: {
      passed: active.length >= 4 && winningSeasons / active.length >= 0.6,
      detail: `Profitable in ${winningSeasons} of ${active.length} active quarters`
    },
    travels_well: {
      passed: input.sibling !== null && input.sibling.returnPct > 0,
      detail: input.sibling
        ? `${signed(input.sibling.returnPct)} on ${input.sibling.instrumentId.replace("-USDT-SWAP", "")} with the same settings`
        : "No sibling market to compare"
    },
    luck_adjusted: {
      passed: main.deflatedSharpeRatio >= gate.minDeflatedSharpe,
      detail: `${Math.round(main.deflatedSharpeRatio * 100)}% confidence after ${input.trials} backtests (needs ${Math.round(gate.minDeflatedSharpe * 100)}%)`
    },
    research_gate: {
      passed: gateMisses.length === 0,
      detail:
        gateMisses.length === 0
          ? `Sharpe ${round(sharpe)} of at least ${gate.minSharpe}, above holding and ${GATE_RANDOM_PERCENTILE}% of random entries, worst dip within ${GATE_MAX_DRAWDOWN_PCT}%`
          : `Short of the gate: ${gateMisses.join("; ")}`
    },
    survives_resampling: {
      passed: trades >= gate.minTrades && mc.lossProbabilityPct <= 20,
      detail: `${round(mc.lossProbabilityPct, 1)}% of ${mc.paths} reshuffled histories lose money`
    },
    beats_holding: {
      passed: sharpe > holdSharpe,
      detail: `Sharpe ${round(sharpe)} vs ${round(holdSharpe)} for holding`
    },
    // Random entries pay the same costs, so even a losing idea can outrank most of them: only a
    // profitable boat earns this check
    beats_random: {
      passed: returnPct > 0 && randomPercentile >= 90,
      detail: `Better than ${Math.round(randomPercentile)}% of random-entry runs (needs 90% and a profit)`
    },
    shallow_drawdown: {
      passed: main.maxDrawdownPct <= 20,
      detail: `Worst dip ${round(main.maxDrawdownPct, 1)}% (limit 20%)`
    }
  };

  const checks: SeaTrialCheck[] = (Object.keys(CHECKS) as SeaTrialCheckKey[]).map((key) => ({
    key,
    label: CHECKS[key].label,
    critical: CHECKS[key].critical,
    passed: results[key].passed,
    detail: results[key].detail
  }));

  // Headline performance, up to 40 points: risk-adjusted return, annual return, drawdown
  const annualReturnPct = years > 0 ? returnPct / years : returnPct;
  let score = (25 * (Math.min(2.5, Math.max(-1, sharpe)) + 1)) / 3.5;
  score += Math.max(-5, Math.min(10, annualReturnPct / 2));
  score += 5 * (1 - Math.min(1, main.maxDrawdownPct / 30));
  for (const c of checks) {
    if (c.passed) score += CHECKS[c.key].weight;
  }
  score = round(Math.max(0, Math.min(100, score)), 0);

  // Clearing every in-sample check earns a Blind Trial; only passing that makes a boat seaworthy
  const criticalFailures = checks.filter((c) => c.critical && !c.passed).length;
  const verdict: Verdict =
    criticalFailures === 0 && score >= BLIND_TRIAL_MIN_SCORE
      ? "promising"
      : criticalFailures <= 1 && score >= 45
        ? "promising"
        : returnPct < 0 && score < 30
          ? "sinks"
          : "choppy";

  // A fixed weekly grid over the window, so any two trials can be compared week by week
  const weeklyEquityPct: number[] = [];
  let cursor = 0;
  let equityNow = initial;
  for (let ts = main.fromTs; ts <= main.toTs; ts += WEEK_MS) {
    while (cursor < curve.length && (curve[cursor]?.ts ?? Infinity) <= ts) {
      equityNow = curve[cursor]?.equity ?? equityNow;
      cursor++;
    }
    weeklyEquityPct.push(round((equityNow / initial - 1) * 100, 3));
  }
  const avgHoldHours =
    main.trades.length > 0
      ? round(
          main.trades.reduce((a, t) => a + (t.exitTs - t.entryTs), 0) /
            main.trades.length /
            HOUR_MS,
          1
        )
      : 0;

  const step = Math.max(1, Math.floor(curve.length / 60));
  const equityCurvePct: number[] = [];
  for (let i = 0; i < curve.length; i += step) {
    const point = curve[i];
    if (point) equityCurvePct.push(round((point.equity / initial - 1) * 100));
  }
  const last = curve[curve.length - 1];
  if (last) equityCurvePct.push(round((last.equity / initial - 1) * 100));

  const passedCount = checks.filter((c) => c.passed).length;
  const headline =
    trades === 0
      ? `Never left harbour: no trades in ${input.days} days of data`
      : `${signed(returnPct)} over ${input.days} days, ${trades} trades · passed ${passedCount} of ${checks.length} sea-trial checks`;

  const seaTrial: SeaTrial = {
    checks,
    segments,
    neighbours: [...input.neighbours],
    sibling: input.sibling,
    monteCarlo: {
      paths: mc.paths,
      lossProbabilityPct: round(mc.lossProbabilityPct, 1),
      p5ReturnPct: round(mc.p5ReturnPct),
      medianReturnPct: round(mc.medianReturnPct),
      p95DrawdownPct: round(mc.p95DrawdownPct)
    },
    tStat: round(significance.tStat),
    pValue: round(significance.pValue, 4),
    stressAvgR: round(main.stressNetExpectancyR, 3),
    outOfSampleAvgR: round(oosR, 3),
    randomEntryPercentile: round(randomPercentile, 1),
    trials: Math.max(1, input.trials),
    funding: input.funding,
    weeklyEquityPct,
    avgHoldHours
  };

  return {
    score,
    verdict,
    headline,
    gatePassed: checks.every((c) => !c.critical || c.passed),
    dataSource: "okx",
    fromTs: main.fromTs,
    toTs: main.toTs,
    totalTrades: trades,
    winRate: round(main.winRate, 4),
    returnPct,
    maxDrawdownPct: round(main.maxDrawdownPct),
    sharpeRatio: round(sharpe),
    deflatedSharpeRatio: round(main.deflatedSharpeRatio, 4),
    avgR: round(main.avgR),
    buyAndHoldReturnPct: round(main.buyAndHoldReturnPct ?? 0),
    equityCurvePct,
    days: input.days,
    seaTrial,
    lookalike: null,
    blindTrial: null
  };
}

/** The in-sample score a design needs, with every critical check passed, to earn a Blind Trial. */
export const BLIND_TRIAL_MIN_SCORE = 65;

/** Whether an in-sample assessment has earned its Blind Trial: the research gate and the score. */
export function earnsBlindTrial(a: Pick<Assessment, "score" | "seaTrial">): boolean {
  const checks = a.seaTrial?.checks ?? [];
  return (
    checks.length > 0 &&
    checks.every((c) => !c.critical || c.passed) &&
    a.score >= BLIND_TRIAL_MIN_SCORE
  );
}

/**
 * The Blind Trial's rule, fixed before any design sees 2025 (ADR-0035): over the unseen year the
 * design trades at least half the gate's two-year minimum, its average trade stays positive with
 * every cost doubled, and its worst dip stays within the gate's limit.
 */
export function passesBlindTrial(
  run: Pick<TrialRun, "totalTrades" | "stressNetExpectancyR" | "maxDrawdownPct">,
  gate: ResearchGate
): boolean {
  return (
    run.totalTrades >= Math.ceil(gate.minTrades / 2) &&
    run.stressNetExpectancyR > 0 &&
    run.maxDrawdownPct <= GATE_MAX_DRAWDOWN_PCT
  );
}

/**
 * Settles the verdict once the Blind Trial is known: a design that earned it is seaworthy only if
 * it passed, and choppy if it failed. Only the outcome is kept, never the year's numbers.
 */
export function withBlindTrial(a: Assessment, blind: BlindTrial): Assessment {
  if (!earnsBlindTrial(a)) return { ...a, blindTrial: blind };
  const verdict: Verdict =
    blind.outcome === "passed" ? "seaworthy" : blind.outcome === "failed" ? "choppy" : "promising";
  const said =
    blind.outcome === "passed"
      ? "passed its Blind Trial"
      : blind.outcome === "failed"
        ? "failed its Blind Trial"
        : "no Blind Trial left in the budget";
  return { ...a, verdict, headline: `${a.headline} · ${said}`, blindTrial: blind };
}
