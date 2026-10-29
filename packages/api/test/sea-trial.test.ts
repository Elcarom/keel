import { describe, expect, it } from "vitest";
import { ScaledDecimal, type ConfirmedBar, type SeaTrialVariant } from "@keel/core";
import { type ReplayRunResult, type ReplayTradeRecord } from "@keel/replay";
import {
  BACKTEST_DAYS,
  BACKTEST_FROM_TS,
  BACKTEST_TO_TS,
  assessSeaTrial,
  basketIndexBars,
  combineRuns,
  neighbourBlueprints,
  type SeaTrialInput
} from "../src/index.js";

const HOUR_MS = 3_600_000;
const SPAN = BACKTEST_TO_TS - BACKTEST_FROM_TS;
const d = (v: number) => ScaledDecimal.fromString(v.toFixed(8));

/** Daily bars drifting from 100 to 150 across the window. */
const BARS: ConfirmedBar[] = Array.from({ length: BACKTEST_DAYS }, (_, i) => {
  const close = 100 + (50 * (i + 1)) / BACKTEST_DAYS;
  const openTs = BACKTEST_FROM_TS + i * 24 * HOUR_MS;
  return {
    instrumentId: "BTC-USDT-SWAP",
    timeframe: "1H",
    openTs,
    closeTs: openTs + HOUR_MS,
    open: String(close),
    high: String(close),
    low: String(close),
    close: String(close),
    volumeContracts: "1",
    volumeQuote: String(close),
    confirm: "1"
  };
});

/** `count` trades spread evenly over the window, each making `pnl` USDT for `netR`. */
function trades(count: number, pnl: (i: number) => number, netR: (i: number) => number) {
  const list: ReplayTradeRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    const entryTs = BACKTEST_FROM_TS + Math.floor(((i + 0.5) * SPAN) / count);
    list.push({
      proposalId: `p${i}`,
      strategyId: "s",
      side: "long",
      entryTs,
      exitTs: entryTs + HOUR_MS,
      entryPrice: d(100),
      exitPrice: d(101),
      protectiveStopPrice: d(99),
      contracts: d(1),
      initialRiskUsdt: d(75),
      grossPnlUsdt: d(pnl(i)),
      feesUsdt: d(0),
      fundingUsdt: d(0),
      netPnlUsdt: d(pnl(i)),
      netR: netR(i),
      stressNetR: netR(i) - 0.05,
      exitReason: "take-profit"
    });
  }
  return list;
}

/** A replay result whose equity grows trade by trade. */
function result(overrides: Partial<ReplayRunResult> & { trades: ReplayTradeRecord[] }) {
  let equity = 10_000;
  const equityCurve = overrides.trades.map((t) => {
    equity += Number(t.netPnlUsdt.toString());
    return { ts: t.exitTs, equityUsdt: equity.toFixed(2), drawdownPct: 0 };
  });
  const base: ReplayRunResult = {
    experimentId: "e",
    strategyId: "s",
    strategyVersion: "1.0.0",
    instrumentId: "BTC-USDT-SWAP",
    timeframe: "1H",
    dataSnapshotId: "a".repeat(64),
    configHash: "b".repeat(64),
    fromTs: BACKTEST_FROM_TS,
    toTs: BACKTEST_TO_TS,
    totalTrades: overrides.trades.length,
    winRate: 0.6,
    avgR: 0.3,
    netPnlUsdt: (equity - 10_000).toFixed(2),
    totalFeesUsdt: "0",
    totalFundingUsdt: "0",
    maxDrawdownPct: 8,
    sharpeRatio: 1.6,
    deflatedSharpeRatio: 0.8,
    stressNetExpectancyR: 0.2,
    walkForwardOutOfSampleAvgR: 0.15,
    replayGatePassed: false,
    createdAtMs: 0,
    numTrials: 4,
    buyAndHoldReturnPct: 50,
    buyAndHoldSharpeRatio: 0.9,
    randomEntryReturnPct: -5,
    randomEntrySharpeRatio: -0.4,
    randomEntryPercentile: 97,
    equityCurve,
    baselines: {
      buyAndHold: { returnPct: 50, sharpeRatio: 0.9, maxDrawdownPct: 20 },
      randomEntry: { returnPct: -5, sharpeRatio: -0.4, maxDrawdownPct: 10 }
    },
    ...overrides
  };
  return base;
}

const ROBUST: SeaTrialVariant[] = [
  { label: "Window −25%", returnPct: 18, sharpeRatio: 1.3, trades: 70 },
  { label: "Window +33%", returnPct: 15, sharpeRatio: 1.1, trades: 55 },
  { label: "Trigger −20%", returnPct: 21, sharpeRatio: 1.4, trades: 80 },
  { label: "Trigger +25%", returnPct: 12, sharpeRatio: 1.0, trades: 45 }
];

function trial(input: Partial<SeaTrialInput> & { main: ReplayRunResult }) {
  return assessSeaTrial({
    bars: BARS,
    neighbours: ROBUST,
    sibling: {
      label: "ETH",
      instrumentId: "ETH-USDT-SWAP",
      returnPct: 9,
      sharpeRatio: 0.8,
      trades: 50
    },
    initialEquityUsdt: "10000.00",
    dataSource: "okx",
    funding: "assumed",
    trials: 4,
    days: BACKTEST_DAYS,
    seed: 7,
    settings: { randomEntryPaths: 200, monteCarloPaths: 500, periods: 8 },
    ...input
  });
}

// 64 trades, mostly winners spread across the whole window
const STEADY = trades(
  64,
  (i) => (i % 4 === 3 ? -60 : 80),
  (i) => (i % 4 === 3 ? -0.8 : 1.07)
);

describe("Basket sea trials", () => {
  it("adds a basket's coins up into one portfolio and measures its worst dip on the whole", () => {
    // Coin A wins early and gives some back late; coin B loses early and wins late
    const a = result({
      trades: trades(
        4,
        (i) => (i < 2 ? 300 : -200),
        () => 1
      )
    });
    const b = result({
      trades: trades(
        4,
        (i) => (i < 2 ? -100 : 250),
        () => 0.5
      ),
      stressNetExpectancyR: -0.1,
      randomEntryPercentile: 50
    });
    const combined = combineRuns([a, b], 10_000, 4);

    expect(combined.netPnlUsdt).toBe("500.00000000"); // 200 + 300
    expect(combined.totalTrades).toBe(8);
    expect(combined.trades.map((t) => t.exitTs)).toEqual(
      [...combined.trades.map((t) => t.exitTs)].sort((x, y) => x - y)
    );
    // Both coins trade at the same hours, so each point is the sum of their gains
    expect(combined.equityCurve.map((p) => Number(p.equityUsdt))).toEqual([
      10_200, 10_400, 10_450, 10_500
    ]);
    // Each coin alone dips (A from 10,600 to 10,200); together the curve never falls
    expect(combined.maxDrawdownPct).toBe(0);
    // Statistics each replay measured on its own are averaged, weighted by trades
    expect(combined.stressNetExpectancyR).toBeCloseTo(0.05);
    expect(combined.randomEntryPercentile).toBeCloseTo(73.5);
    expect(combined.avgR).toBeCloseTo(0.75);
  });

  it("leaves a single coin's run exactly as the replay measured it", () => {
    const run = result({ trades: STEADY });
    expect(combineRuns([run], 10_000, 4)).toBe(run);
  });

  it("compares a basket's seasons with an equal-weight index of its coins", () => {
    const doubles = BARS.map((bar, i) => ({
      ...bar,
      close: String(100 * (1 + (i + 1) / BARS.length))
    }));
    const index = basketIndexBars([BARS, doubles]);
    expect(index).toHaveLength(BARS.length);
    const first = Number(index[0]?.close);
    const last = Number(index[index.length - 1]?.close);
    // BTC goes 100.07 → 150 (+49.9%), the other 100.14 → 200 (+99.7%): the index lands between
    expect(last / first).toBeGreaterThan(1.7);
    expect(last / first).toBeLessThan(1.8);
  });
});

describe("Sea trial", () => {
  it("rates a steady, robust edge seaworthy and passes every check", () => {
    const a = trial({ main: result({ trades: STEADY }) });
    expect(a.seaTrial?.checks.filter((c) => !c.passed).map((c) => c.key)).toEqual([]);
    expect(a.verdict).toBe("seaworthy");
    expect(a.score).toBeGreaterThanOrEqual(65);
    expect(a.seaTrial?.monteCarlo.lossProbabilityPct).toBe(0);
  });

  it("never calls an idea seaworthy when nudged settings sink it, however good it looks", () => {
    const fragile = ROBUST.map((n) => ({ ...n, returnPct: -10, sharpeRatio: -0.6 }));
    const a = trial({ main: result({ trades: STEADY }), neighbours: fragile });
    const robust = a.seaTrial?.checks.find((c) => c.key === "robust_parameters");
    expect(robust?.passed).toBe(false);
    expect(robust?.detail).toMatch(/0 of 4 nudged versions profitable/);
    expect(a.verdict).not.toBe("seaworthy");
  });

  it("needs enough trades before trusting the statistics", () => {
    const few = trades(
      12,
      () => 90,
      () => 1.2
    );
    const a = trial({ main: result({ trades: few }) });
    const failed = a.seaTrial?.checks.filter((c) => !c.passed).map((c) => c.key);
    expect(failed).toContain("enough_trades");
    expect(failed).toContain("out_of_sample");
    expect(failed).toContain("survives_resampling");
    expect(a.verdict).not.toBe("seaworthy");
  });

  it("fails the cost check when doubled costs turn the average trade negative", () => {
    const a = trial({ main: result({ trades: STEADY, stressNetExpectancyR: -0.02 }) });
    expect(a.seaTrial?.checks.find((c) => c.key === "survives_costs")?.passed).toBe(false);
    expect(a.verdict).not.toBe("seaworthy");
  });

  it("splits the window into equal seasons with the market's move beside the boat's", () => {
    const a = trial({ main: result({ trades: STEADY }) });
    const segments = a.seaTrial?.segments ?? [];
    expect(segments).toHaveLength(8);
    expect(segments[0]?.fromTs).toBe(BACKTEST_FROM_TS);
    expect(segments[7]?.toTs).toBe(BACKTEST_TO_TS);
    expect(segments.reduce((n, s) => n + s.trades, 0)).toBe(64);
    // The market drifts up about 50% overall, so every season shows it rising
    for (const s of segments) expect(s.marketReturnPct).toBeGreaterThan(0);
  });

  it("flags a result carried by one lucky stretch as unsteady", () => {
    // Every winner lands in the first season; the other seasons lose a little each
    const lucky = trades(
      64,
      (i) => (i < 8 ? 400 : -20),
      (i) => (i < 8 ? 5 : -0.3)
    );
    const a = trial({ main: result({ trades: lucky }) });
    const steady = a.seaTrial?.checks.find((c) => c.key === "steady_quarters");
    expect(steady?.passed).toBe(false);
    expect(steady?.detail).toBe("Profitable in 1 of 8 active quarters");
  });

  it("nudges the trigger, or the stop when the archetype has no trigger", () => {
    const base = {
      name: "Test",
      tagline: "t",
      instrumentId: "BTC-USDT-SWAP" as const,
      direction: "both" as const,
      lookbackPeriod: 40,
      fastPeriod: 10,
      entryThreshold: 2,
      stopAtrMultiple: 2,
      rewardMultiple: 2,
      rationale: ""
    };
    const withTrigger = neighbourBlueprints({ ...base, archetype: "mean_reversion" });
    expect(withTrigger.map((n) => n.label)).toEqual([
      "Window −25%",
      "Window +33%",
      "Trigger −20%",
      "Trigger +25%"
    ]);
    expect(withTrigger[2]?.blueprint.entryThreshold).toBe(1.6);
    expect(withTrigger[0]?.blueprint.lookbackPeriod).toBe(30);
    const noTrigger = neighbourBlueprints({ ...base, archetype: "breakout" });
    expect(noTrigger[3]?.label).toBe("Stop +33%");
    expect(noTrigger[3]?.blueprint.stopAtrMultiple).toBe(2.66);
  });
});
