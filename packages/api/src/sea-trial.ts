import {
  normalizeBlueprint,
  type Assessment,
  type BotArchetype,
  type BotBlueprint,
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
  normalCdf,
  oneSidedTTest,
  splitIntoPeriods,
  type ReplayRunResult
} from "@keel/replay";
import { nudgeInvention } from "@keel/spec";

// ============================================================================
// Sea trials: how a Proposition is judged before it may launch. One full backtest plus re-runs
// with nudged parameters and on a sibling market, then statistics over the trades. Everything
// here is research arithmetic over finished replays; no money moves.
// ============================================================================

const DAY_MS = 86_400_000;

/**
 * The backtest window: the two years before 2024-12-01. In-sample data, clear of the sealed
 * holdout (2025 onward).
 */
export const BACKTEST_TO_TS = 1_733_011_200_000; // 2024-12-01 00:00:00 UTC
export const BACKTEST_DAYS = 730;
export const BACKTEST_FROM_TS = BACKTEST_TO_TS - BACKTEST_DAYS * DAY_MS;

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
export function neighbourBlueprints(
  b: BotBlueprint
): readonly { readonly label: string; readonly blueprint: BotBlueprint }[] {
  // Inventions have no fixed parameters: nudge every window, then every threshold in the rules
  const archetype = b.archetype;
  if (archetype === "invented") {
    return [
      { label: "Windows −25%", blueprint: nudgeInvention(b, 0.75, 1) },
      { label: "Windows +33%", blueprint: nudgeInvention(b, 1.33, 1) },
      { label: "Thresholds −10%", blueprint: nudgeInvention(b, 1, 0.9) },
      { label: "Thresholds +10%", blueprint: nudgeInvention(b, 1, 1.1) }
    ];
  }
  const nudge = (changes: Partial<BotBlueprint>) =>
    normalizeBlueprint({ ...b, ...changes, archetype });
  const windows = [
    {
      label: "Window −25%",
      blueprint: nudge({
        lookbackPeriod: b.lookbackPeriod * 0.75,
        fastPeriod: b.fastPeriod * 0.75
      })
    },
    {
      label: "Window +33%",
      blueprint: nudge({
        lookbackPeriod: b.lookbackPeriod * 1.33,
        fastPeriod: b.fastPeriod * 1.33
      })
    }
  ];
  if (IGNORES_THRESHOLD.has(archetype)) {
    return [
      ...windows,
      { label: "Stop −25%", blueprint: nudge({ stopAtrMultiple: b.stopAtrMultiple * 0.75 }) },
      { label: "Stop +33%", blueprint: nudge({ stopAtrMultiple: b.stopAtrMultiple * 1.33 }) }
    ];
  }
  return [
    ...windows,
    { label: "Trigger −20%", blueprint: nudge({ entryThreshold: b.entryThreshold * 0.8 }) },
    { label: "Trigger +25%", blueprint: nudge({ entryThreshold: b.entryThreshold * 1.25 }) }
  ];
}

function round(value: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

function signed(value: number, suffix = "%"): string {
  return `${value > 0 ? "+" : ""}${round(value)}${suffix}`;
}

/** A finished replay reduced to what the sea trial compares. */
export function variantOf(
  label: string,
  result: ReplayRunResult,
  initial: number
): SeaTrialVariant {
  return {
    label,
    returnPct: round((Number(result.netPnlUsdt) / initial) * 100),
    sharpeRatio: round(Number.isFinite(result.sharpeRatio) ? result.sharpeRatio : 0),
    trades: result.totalTrades
  };
}

/** Each trade's net P&L as a fraction of the equity it was taken with (one position at a time). */
function tradeReturns(result: ReplayRunResult, initial: number): number[] {
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

/** Weights sum to 60; the other 40 points come from the headline performance. */
const CHECKS: Readonly<Record<SeaTrialCheckKey, CheckSpec>> = {
  enough_trades: { label: "Enough trades to judge", weight: 3, critical: true },
  survives_costs: { label: "Survives doubled costs", weight: 8, critical: true },
  out_of_sample: { label: "Holds up out of sample", weight: 8, critical: true },
  robust_parameters: { label: "Robust to nudged settings", weight: 8, critical: true },
  steady_quarters: { label: "Steady across the seasons", weight: 7, critical: false },
  travels_well: { label: "Works on a sibling market", weight: 6, critical: false },
  luck_adjusted: { label: "More skill than luck", weight: 6, critical: false },
  survives_resampling: { label: "Survives reshuffled trades", weight: 5, critical: false },
  beats_holding: { label: "Beats holding, risk-adjusted", weight: 4, critical: false },
  beats_random: { label: "Beats random entries", weight: 3, critical: false },
  shallow_drawdown: { label: "Shallow worst dip", weight: 2, critical: false }
};

export const MIN_TRADES = 30;

export interface SeaTrialInput {
  readonly main: ReplayRunResult;
  readonly bars: readonly ConfirmedBar[];
  readonly neighbours: readonly SeaTrialVariant[];
  readonly sibling: (SeaTrialVariant & { readonly instrumentId: string }) | null;
  readonly initialEquityUsdt: string;
  readonly dataSource: "okx" | "synthetic";
  readonly funding: "settled" | "assumed";
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

  const results: Record<SeaTrialCheckKey, { passed: boolean; detail: string }> = {
    enough_trades: {
      passed: trades >= MIN_TRADES,
      detail: `${trades} trades in ${input.days} days (needs ${MIN_TRADES})`
    },
    survives_costs: {
      passed: main.stressNetExpectancyR > 0,
      detail: `Average trade ${signed(main.stressNetExpectancyR, "R")} with fees and slippage doubled`
    },
    out_of_sample: {
      passed: oosR > 0 && trades >= MIN_TRADES,
      detail: `Average trade ${signed(oosR, "R")} on walk-forward folds it was not judged on`
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
      passed: main.deflatedSharpeRatio >= 0.5,
      detail: `${Math.round(main.deflatedSharpeRatio * 100)}% confidence after ${input.trials} ideas tried`
    },
    survives_resampling: {
      passed: trades >= MIN_TRADES && mc.lossProbabilityPct <= 20,
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

  const criticalFailures = checks.filter((c) => c.critical && !c.passed).length;
  const verdict: Verdict =
    criticalFailures === 0 && score >= 65
      ? "seaworthy"
      : criticalFailures <= 1 && score >= 45
        ? "promising"
        : returnPct < 0 && score < 30
          ? "sinks"
          : "choppy";

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
    funding: input.funding
  };

  return {
    score,
    verdict,
    headline,
    gatePassed: main.replayGatePassed,
    dataSource: input.dataSource,
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
    seaTrial
  };
}
