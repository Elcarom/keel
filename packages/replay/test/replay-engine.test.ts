import { afterEach, describe, expect, it } from "vitest";
import { ManualClock, ScaledDecimal } from "@keel/core";
import { createSqliteDataStore, seedSyntheticMarketSeries, type SqliteDataStore } from "@keel/data";
import {
  DonchianTrendStrategy,
  VolNormalizedMeanReversionStrategy,
  VolNormalizedMomentumStrategy
} from "@keel/strategy";
import { ReplayEngine, computeDeflatedSharpeRatio, inverseNormalCdf } from "../src/index.js";

describe("M2-3: Event-Driven ReplayEngine, 8h Funding/Cost Model, Purged Walk-Forward, & DSR", () => {
  const openStores: SqliteDataStore[] = [];

  function setupTestStore(): SqliteDataStore {
    const store = createSqliteDataStore({
      dbPath: ":memory:",
      clock: new ManualClock(1_710_000_000_000)
    });
    openStores.push(store);
    return store;
  }

  afterEach(() => {
    while (openStores.length > 0) {
      const s = openStores.pop();
      s?.close();
    }
  });

  it("produces bit-for-bit identical replay results, enforces 2x cost stress, and persists immutable ExperimentRecords", () => {
    const store = setupTestStore();
    const marketRepo = store.marketDataRepo;
    const experimentRepo = store.experimentRepo;

    const seeded = seedSyntheticMarketSeries({
      marketDataRepo: marketRepo,
      instrumentId: "BTC-USDT-SWAP",
      endCloseTs: 1_710_000_000_000,
      barCount1H: 240
    });

    const engine = new ReplayEngine({
      marketDataRepo: marketRepo,
      experimentRepo
    });

    const strategy = new DonchianTrendStrategy({ channelLength: 20 });

    const run1 = engine.run({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      strategy,
      fromTs: seeded.fromTs,
      toTs: seeded.toTs,
      initialEquityUsdt: ScaledDecimal.fromString("10000.00000000"),
      riskFractionPerTrade: 0.0075,
      takerFeeBps: 5,
      halfSpreadBps: 2,
      slippageBps: 3
    });

    const run2 = engine.run({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      strategy,
      fromTs: seeded.fromTs,
      toTs: seeded.toTs,
      initialEquityUsdt: ScaledDecimal.fromString("10000.00000000"),
      riskFractionPerTrade: 0.0075,
      takerFeeBps: 5,
      halfSpreadBps: 2,
      slippageBps: 3
    });

    // Bit-for-bit identical accounting & hashes
    expect(run1.dataSnapshotId).toBe(run2.dataSnapshotId);
    expect(run1.configHash).toBe(run2.configHash);
    expect(run1.totalTrades).toBeGreaterThan(0);
    expect(run1.totalTrades).toBe(run2.totalTrades);
    expect(run1.netPnlUsdt).toBe(run2.netPnlUsdt);
    expect(run1.totalFeesUsdt).toBe(run2.totalFeesUsdt);
    expect(run1.totalFundingUsdt).toBe(run2.totalFundingUsdt);
    expect(run1.avgR).toBe(run2.avgR);
    expect(run1.stressNetExpectancyR).toBe(run2.stressNetExpectancyR);

    // 2x cost stress expectancy must be strictly lower than baseline net expectancy when trades occur
    expect(run1.stressNetExpectancyR).toBeLessThan(run1.avgR);

    // Deflated Sharpe Ratio is bounded in [0, 1]
    expect(run1.deflatedSharpeRatio).toBeGreaterThanOrEqual(0);
    expect(run1.deflatedSharpeRatio).toBeLessThanOrEqual(1);

    // Experiment repository persisted both runs
    const stored = experimentRepo.listExperiments(10);
    expect(stored.length).toBe(2);
    expect(stored[0]?.dataSnapshotId).toBe(run1.dataSnapshotId);
  });

  it("evaluates all three baseline strategies and computes Deflated Sharpe Ratio cleanly", () => {
    const store = setupTestStore();
    const marketRepo = store.marketDataRepo;
    const seeded = seedSyntheticMarketSeries({
      marketDataRepo: marketRepo,
      instrumentId: "ETH-USDT-SWAP",
      endCloseTs: 1_710_000_000_000,
      barCount1H: 240
    });

    const engine = new ReplayEngine({ marketDataRepo: marketRepo });
    const strategies = [
      new DonchianTrendStrategy({ channelLength: 16 }),
      new VolNormalizedMeanReversionStrategy({
        lookbackBars: 16,
        entryZScore: 1.5
      }),
      new VolNormalizedMomentumStrategy({
        lookbackBars: 16,
        momentumThresholdAtr: 0.9
      })
    ];

    for (const strategy of strategies) {
      const result = engine.run({
        instrumentId: "ETH-USDT-SWAP",
        timeframe: "1H",
        strategy,
        fromTs: seeded.fromTs,
        toTs: seeded.toTs
      });
      expect(result.strategyId).toBe(strategy.strategyId);
      expect(result.dataSnapshotId).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isFinite(result.avgR)).toBe(true);
      expect(Number.isFinite(result.walkForwardOutOfSampleAvgR)).toBe(true);
    }

    const highDsr = computeDeflatedSharpeRatio({
      returnsR: [1.5, 1.2, -0.5, 2.1, 0.9, 1.4, -0.3, 1.8, 1.1, 1.6],
      numTrials: 3
    });
    const lowDsr = computeDeflatedSharpeRatio({
      returnsR: [-1.0, -0.8, 0.2, -1.1, -0.5, -0.9, 0.1, -0.7],
      numTrials: 20
    });
    expect(highDsr.deflatedSharpeRatio).toBeGreaterThan(lowDsr.deflatedSharpeRatio);
  });

  it("calculates accurate inverse normal CDF quantiles per Peter J. Acklam algorithm (C1)", () => {
    // Known standard normal quantiles:
    expect(inverseNormalCdf(0.5)).toBeCloseTo(0.0, 5);
    expect(inverseNormalCdf(0.9)).toBeCloseTo(1.28155, 4);
    expect(inverseNormalCdf(0.95)).toBeCloseTo(1.64485, 4);
    expect(inverseNormalCdf(0.975)).toBeCloseTo(1.95996, 4);
    expect(inverseNormalCdf(0.99)).toBeCloseTo(2.32635, 4);
    expect(inverseNormalCdf(0.025)).toBeCloseTo(-1.95996, 4);
  });
});
