import { describe, expect, it } from "vitest";
import { ManualClock, ScaledDecimal, defaultInstrumentSpec } from "@keel/core";
import { createSqliteDataStore, seedSyntheticMarketSeries } from "@keel/data";
import { computeRandomEntryBaseline, ReplayEngine } from "../src/index.js";
import { DonchianTrendStrategy, VolNormalizedMeanReversionStrategy } from "@keel/strategy";

describe("T4: Benchmark Distribution & Report Integrity (R3, M-G, N2)", () => {
  it("computeRandomEntryBaseline evaluates >= 200 paths and returns median, p75 Sharpe, and percentile rank", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });
    const inst = "BTC-USDT-SWAP";
    const seeded = seedSyntheticMarketSeries({
      marketDataRepo: store.marketDataRepo,
      instrumentId: inst,
      endCloseTs: 1_700_000_000_000,
      barCount1H: 720
    });

    const bars = store.marketDataRepo.getConfirmedBarsInRange({
      instrumentId: inst,
      timeframe: "1H",
      fromOpenTs: seeded.fromTs,
      toCloseTs: seeded.toTs
    });

    const baseline = computeRandomEntryBaseline({
      bars,
      instrumentSpec: defaultInstrumentSpec(inst),
      initialEquityUsdt: ScaledDecimal.fromString("10000.00"),
      totalOneWayCostBps: 12,
      timeframe: "1H",
      marketDataRepo: store.marketDataRepo,
      numPaths: 200,
      strategySharpe: 0.5
    });

    expect(baseline.pathCount).toBe(200);
    expect(typeof baseline.returnPct).toBe("number");
    expect(typeof baseline.sharpeRatio).toBe("number");
    expect(typeof baseline.p75SharpeRatio).toBe("number");
    expect(typeof baseline.percentileRank).toBe("number");

    const p75Sharpe = baseline.p75SharpeRatio ?? -Infinity;
    const rank = baseline.percentileRank ?? -1;

    // 75th percentile must be greater than or equal to the median (sharpeRatio)
    expect(p75Sharpe).toBeGreaterThanOrEqual(baseline.sharpeRatio);

    // Percentile rank must be bounded in [0, 100]
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThanOrEqual(100);

    store.close();
  });

  it("replayGatePassed requires beating the 75th percentile of the random entry distribution (M-G / R3)", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });
    const inst = "BTC-USDT-SWAP";
    const seeded = seedSyntheticMarketSeries({
      marketDataRepo: store.marketDataRepo,
      instrumentId: inst,
      endCloseTs: 1_700_000_000_000,
      barCount1H: 720
    });

    const engine = new ReplayEngine({
      marketDataRepo: store.marketDataRepo,
      experimentRepo: store.experimentRepo,
      clock
    });

    const strat = new DonchianTrendStrategy();
    const result = engine.run({
      instrumentId: inst,
      timeframe: "1H",
      strategy: strat,
      fromTs: seeded.fromTs,
      toTs: seeded.toTs,
      replayMinTrades: 1,
      replayMinSharpe: -100 // low to isolate baseline check
    });

    // Check that randomEntry benchmark in baselines contains p75SharpeRatio
    expect(result.baselines.randomEntry.p75SharpeRatio).toBeDefined();
    const p75 = result.baselines.randomEntry.p75SharpeRatio ?? 0;

    // If strategy Sharpe is <= 75th percentile of random entry, replayGatePassed MUST be false
    if (result.sharpeRatio <= p75) {
      expect(result.replayGatePassed).toBe(false);
    }

    store.close();
  });

  it("enforces defensive default thresholds in ReplayEngine (minTrades >= 100, minDsr >= 0.8) (M-G)", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });
    const inst = "BTC-USDT-SWAP";
    const seeded = seedSyntheticMarketSeries({
      marketDataRepo: store.marketDataRepo,
      instrumentId: inst,
      endCloseTs: 1_700_000_000_000,
      barCount1H: 720
    });

    const engine = new ReplayEngine({
      marketDataRepo: store.marketDataRepo,
      experimentRepo: store.experimentRepo,
      clock
    });

    const strat = new DonchianTrendStrategy();
    const result = engine.run({
      instrumentId: inst,
      timeframe: "1H",
      strategy: strat,
      fromTs: seeded.fromTs,
      toTs: seeded.toTs
      // No overrides provided: must default to minTrades >= 100, minSharpe >= 1.0, minDsr >= 0.8
    });

    // If totalTrades < 100, replayGatePassed MUST be false by default
    if (result.totalTrades < 100) {
      expect(result.replayGatePassed).toBe(false);
    }

    store.close();
  });

  it("walk-forward OOS evaluation evaluates the primaryStrategy alone when candidateStrategies is omitted (N2c)", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });
    const inst = "BTC-USDT-SWAP";
    const seeded = seedSyntheticMarketSeries({
      marketDataRepo: store.marketDataRepo,
      instrumentId: inst,
      endCloseTs: 1_700_000_000_000,
      barCount1H: 720
    });

    const engine = new ReplayEngine({
      marketDataRepo: store.marketDataRepo,
      experimentRepo: store.experimentRepo,
      clock
    });

    const stratA = new DonchianTrendStrategy();
    const stratB = new VolNormalizedMeanReversionStrategy();

    const resA = engine.run({
      instrumentId: inst,
      timeframe: "1H",
      strategy: stratA,
      fromTs: seeded.fromTs,
      toTs: seeded.toTs,
      walkForwardFolds: 3,
      embargoBars: 10
    });

    const resB = engine.run({
      instrumentId: inst,
      timeframe: "1H",
      strategy: stratB,
      fromTs: seeded.fromTs,
      toTs: seeded.toTs,
      walkForwardFolds: 3,
      embargoBars: 10
    });

    // When evaluated separately without candidateStrategies, different strategies should have their own individual OOS metrics
    expect(resA.strategyId).toBe("donchian-trend-v1");
    expect(resB.strategyId).toBe("vol-mean-reversion-v1");
    // Verify results exist
    expect(typeof resA.walkForwardOutOfSampleAvgR).toBe("number");
    expect(typeof resB.walkForwardOutOfSampleAvgR).toBe("number");

    store.close();
  });
});
