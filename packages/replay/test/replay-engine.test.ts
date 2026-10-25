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

  it("tracks mark-to-market unrealized drawdown intrabar and interbar (M3)", () => {
    const store = setupTestStore();
    const marketRepo = store.marketDataRepo;
    const baseTs = 1_710_000_000_000;
    const oneHour = 3_600_000;

    // Seed 25 bars:
    // Bar 0: price 100 (strategy generates proposal)
    // Bar 1: enters long at 100
    // Bar 2-5: price plummets to 90 (unrealized loss of ~10%)
    // Bar 6-10: price recovers to 115 (profitable exit at TP or end)
    const candles = [];
    // 21 lookback warmup bars at 100 with ATR ~5 (high 105, low 95)
    for (let i = 0; i < 21; i += 1) {
      candles.push({
        openTs: String(baseTs + i * oneHour),
        open: "100.00",
        high: "105.00",
        low: "95.00",
        close: "100.00",
        volumeContracts: "1000",
        volumeQuote: "100000",
        confirm: "1" as const
      });
    }
    // Bar 21: Breakout upwards to trigger Donchian entry (channelLength 20, highestHigh was 105)
    candles.push({
      openTs: String(baseTs + 21 * oneHour),
      open: "100.00",
      high: "112.00",
      low: "99.50",
      close: "110.00",
      volumeContracts: "1000",
      volumeQuote: "110000",
      confirm: "1" as const
    });
    // Bar 22: Intrabar dip to 102.00 (below entry 110.00, but well above stop ~90.00), closes at 106.00
    candles.push({
      openTs: String(baseTs + 22 * oneHour),
      open: "110.00",
      high: "110.00",
      low: "102.00",
      close: "106.00",
      volumeContracts: "1000",
      volumeQuote: "106000",
      confirm: "1" as const
    });
    // Bar 23: Rebound to 130.00 (profitable exit)
    candles.push({
      openTs: String(baseTs + 23 * oneHour),
      open: "106.00",
      high: "135.00",
      low: "105.00",
      close: "130.00",
      volumeContracts: "1000",
      volumeQuote: "130000",
      confirm: "1" as const
    });

    marketRepo.ingestOkxCandles({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      candles
    });

    const engine = new ReplayEngine({ marketDataRepo: marketRepo });
    const strategy = new DonchianTrendStrategy({ channelLength: 20 });
    const result = engine.run({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      strategy,
      fromTs: baseTs,
      toTs: baseTs + 24 * oneHour
    });

    // Strategy closed in profit
    expect(Number(result.netPnlUsdt)).toBeGreaterThan(0);
    // Realized-only drawdown would have reported 0% because the only trade was a winning trade.
    // Mark-to-market drawdown MUST capture the intrabar/interbar dip on Bar 22!
    expect(result.maxDrawdownPct).toBeGreaterThan(0.5);
  });

  it("computes annualized time-based Sharpe and benchmark baselines (M3, M4)", () => {
    const store = setupTestStore();
    const marketRepo = store.marketDataRepo;
    const seeded = seedSyntheticMarketSeries({
      marketDataRepo: marketRepo,
      instrumentId: "BTC-USDT-SWAP",
      endCloseTs: 1_710_000_000_000,
      barCount1H: 240
    });

    const engine = new ReplayEngine({ marketDataRepo: marketRepo });
    const strategy = new DonchianTrendStrategy({ channelLength: 20 });

    const result = engine.run({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      strategy,
      fromTs: seeded.fromTs,
      toTs: seeded.toTs
    });

    // Replay result must include benchmark baselines
    expect(result.buyAndHoldReturnPct).toBeDefined();
    expect(result.buyAndHoldSharpeRatio).toBeDefined();
    expect(result.randomEntryReturnPct).toBeDefined();
    expect(result.randomEntrySharpeRatio).toBeDefined();
    expect(Number.isFinite(result.buyAndHoldReturnPct)).toBe(true);
    expect(Number.isFinite(result.buyAndHoldSharpeRatio)).toBe(true);
    expect(Number.isFinite(result.randomEntryReturnPct)).toBe(true);
    expect(Number.isFinite(result.randomEntrySharpeRatio)).toBe(true);

    // Periodic time-based Sharpe ratio is finite and annualized
    expect(Number.isFinite(result.sharpeRatio)).toBe(true);
    // Equity curve should be exported on ReplayRunResult
    expect(result.equityCurve).toBeDefined();
    expect(result.equityCurve.length).toBeGreaterThan(0);
  });
});
