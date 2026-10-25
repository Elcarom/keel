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

  it("strictly enforces sealed 2025 holdout partition and prevents accidental leakage (M1, ADR-0009)", () => {
    const store = setupTestStore();
    const marketRepo = store.marketDataRepo;
    const engine = new ReplayEngine({ marketDataRepo: marketRepo });
    const strategy = new DonchianTrendStrategy({ channelLength: 20 });

    // Request extending into 2025 sealed holdout without explicit authorization
    expect(() =>
      engine.run({
        instrumentId: "BTC-USDT-SWAP",
        timeframe: "1H",
        strategy,
        fromTs: 1_700_000_000_000,
        toTs: 1_736_000_000_000 // 2025-01-04
      })
    ).toThrow(/sealed holdout violation/i);

    // With explicit allowHoldoutAccess, it does not throw
    expect(() =>
      engine.run({
        instrumentId: "BTC-USDT-SWAP",
        timeframe: "1H",
        strategy,
        fromTs: 1_700_000_000_000,
        toTs: 1_736_000_000_000,
        allowHoldoutAccess: true
      })
    ).not.toThrow();
  });

  it("fails replay gate honestly when bar count is insufficient for purged walk-forward cross-validation (M1)", () => {
    const store = setupTestStore();
    const marketRepo = store.marketDataRepo;
    // Seed only 25 bars (insufficient for lookbacks + walk forward folds)
    const seeded = seedSyntheticMarketSeries({
      marketDataRepo: marketRepo,
      instrumentId: "BTC-USDT-SWAP",
      endCloseTs: 1_710_000_000_000,
      barCount1H: 25
    });

    const engine = new ReplayEngine({ marketDataRepo: marketRepo });
    const strategy = new DonchianTrendStrategy({ channelLength: 20 });

    const result = engine.run({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      strategy,
      fromTs: seeded.fromTs,
      toTs: seeded.toTs,
      walkForwardFolds: 3
    });

    // Insufficient data for honest walk-forward evaluation MUST fail the gate
    expect(result.replayGatePassed).toBe(false);
  });

  it("fits parameter candidates on train folds and evaluates selected strategy on purged out-of-sample validation folds (M1)", () => {
    const store = setupTestStore();
    const marketRepo = store.marketDataRepo;
    const seeded = seedSyntheticMarketSeries({
      marketDataRepo: marketRepo,
      instrumentId: "BTC-USDT-SWAP",
      endCloseTs: 1_710_000_000_000,
      barCount1H: 500
    });

    const engine = new ReplayEngine({ marketDataRepo: marketRepo });
    const primaryStrategy = new DonchianTrendStrategy({ channelLength: 20 });
    const candidates = [
      new DonchianTrendStrategy({ channelLength: 10 }),
      new DonchianTrendStrategy({ channelLength: 16 }),
      new DonchianTrendStrategy({ channelLength: 20 }),
      new DonchianTrendStrategy({ channelLength: 26 })
    ];

    const result = engine.run({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      strategy: primaryStrategy,
      candidateStrategies: candidates,
      fromTs: seeded.fromTs,
      toTs: seeded.toTs,
      walkForwardFolds: 3
    });

    expect(Number.isFinite(result.walkForwardOutOfSampleAvgR)).toBe(true);
  });

  it("executes fills at next-bar open with configurable slippage instead of signal-bar close (M2)", () => {
    const store = setupTestStore();
    const marketRepo = store.marketDataRepo;
    const baseTs = 1_710_000_000_000;
    const oneHour = 3_600_000;

    const candles = [];
    // 21 lookback warmup bars at 100
    for (let i = 0; i < 21; i += 1) {
      candles.push({
        openTs: String(baseTs + i * oneHour),
        open: "100.00",
        high: "102.00",
        low: "98.00",
        close: "100.00",
        volumeContracts: "1000",
        volumeQuote: "100000",
        confirm: "1" as const
      });
    }
    // Bar 21: Breakout triggers Donchian signal at close 105.00
    candles.push({
      openTs: String(baseTs + 21 * oneHour),
      open: "100.00",
      high: "106.00",
      low: "99.00",
      close: "105.00",
      volumeContracts: "1000",
      volumeQuote: "105000",
      confirm: "1" as const
    });
    // Bar 22: Opens at 108.00 (higher than Bar 21 close 105.00)
    candles.push({
      openTs: String(baseTs + 22 * oneHour),
      open: "108.00",
      high: "115.00",
      low: "107.00",
      close: "112.00",
      volumeContracts: "1000",
      volumeQuote: "112000",
      confirm: "1" as const
    });
    // Bar 23: Reaches take-profit or closes
    candles.push({
      openTs: String(baseTs + 23 * oneHour),
      open: "112.00",
      high: "125.00",
      low: "111.00",
      close: "120.00",
      volumeContracts: "1000",
      volumeQuote: "120000",
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
      toTs: baseTs + 24 * oneHour,
      slippageBps: 10 // 10 bps slippage = 0.001
    });

    expect(result.trades.length).toBeGreaterThan(0);
    const firstTrade = result.trades[0];
    expect(firstTrade).toBeDefined();
    if (!firstTrade) throw new Error("Expected trade");
    // Signal was at bar 21 close (105.00). Next bar open was 108.00.
    // Entry price must NOT be 105.00; with 10 bps slippage on 108.00 open:
    // 108.00 * (1 + 0.001) = 108.108
    expect(firstTrade.entryPrice.equals(ScaledDecimal.fromString("108.108"))).toBe(true);
    expect(firstTrade.entryTs).toBe(baseTs + 22 * oneHour);
  });

  it("fills protective stop at the worse gap price when a bar gaps through the stop (M2)", () => {
    const store = setupTestStore();
    const marketRepo = store.marketDataRepo;
    const baseTs = 1_710_000_000_000;
    const oneHour = 3_600_000;

    const candles = [];
    for (let i = 0; i < 21; i += 1) {
      candles.push({
        openTs: String(baseTs + i * oneHour),
        open: "100.00",
        high: "102.00",
        low: "98.00",
        close: "100.00",
        volumeContracts: "1000",
        volumeQuote: "100000",
        confirm: "1" as const
      });
    }
    // Bar 21: Signal at close 105.00
    candles.push({
      openTs: String(baseTs + 21 * oneHour),
      open: "100.00",
      high: "106.00",
      low: "99.00",
      close: "105.00",
      volumeContracts: "1000",
      volumeQuote: "105000",
      confirm: "1" as const
    });
    // Bar 22: Enters at open 105.00. Stop is at ~97.00. Closes at 104.00.
    candles.push({
      openTs: String(baseTs + 22 * oneHour),
      open: "105.00",
      high: "106.00",
      low: "103.00",
      close: "104.00",
      volumeContracts: "1000",
      volumeQuote: "104000",
      confirm: "1" as const
    });
    // Bar 23: Gaps down severely: opens at 80.00 (well below stop ~97.00)
    candles.push({
      openTs: String(baseTs + 23 * oneHour),
      open: "80.00",
      high: "82.00",
      low: "78.00",
      close: "80.00",
      volumeContracts: "1000",
      volumeQuote: "80000",
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
      toTs: baseTs + 24 * oneHour,
      slippageBps: 0
    });

    expect(result.trades.length).toBeGreaterThan(0);
    const stoppedTrade = result.trades[0];
    expect(stoppedTrade).toBeDefined();
    if (!stoppedTrade) throw new Error("Expected trade");
    expect(stoppedTrade.exitReason).toBe("stop");
    // With gap-aware stop fill, it MUST fill at bar open 80.00, NOT at the stop price ~97.00!
    expect(stoppedTrade.exitPrice.equals(ScaledDecimal.fromString("80"))).toBe(true);
  });

  it("fills take-profit at the better gap price when a bar gaps through the target (M2)", () => {
    const store = setupTestStore();
    const marketRepo = store.marketDataRepo;
    const baseTs = 1_710_000_000_000;
    const oneHour = 3_600_000;

    const candles = [];
    for (let i = 0; i < 21; i += 1) {
      candles.push({
        openTs: String(baseTs + i * oneHour),
        open: "100.00",
        high: "102.00",
        low: "98.00",
        close: "100.00",
        volumeContracts: "1000",
        volumeQuote: "100000",
        confirm: "1" as const
      });
    }
    // Bar 21: Signal at close 105.00
    candles.push({
      openTs: String(baseTs + 21 * oneHour),
      open: "100.00",
      high: "106.00",
      low: "99.00",
      close: "105.00",
      volumeContracts: "1000",
      volumeQuote: "105000",
      confirm: "1" as const
    });
    // Bar 22: Enters at open 105.00. TP is at ~125.00. Closes at 108.00.
    candles.push({
      openTs: String(baseTs + 22 * oneHour),
      open: "105.00",
      high: "109.00",
      low: "104.00",
      close: "108.00",
      volumeContracts: "1000",
      volumeQuote: "108000",
      confirm: "1" as const
    });
    // Bar 23: Gaps up massively: opens at 140.00 (well above TP ~125.00)
    candles.push({
      openTs: String(baseTs + 23 * oneHour),
      open: "140.00",
      high: "145.00",
      low: "138.00",
      close: "142.00",
      volumeContracts: "1000",
      volumeQuote: "142000",
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
      toTs: baseTs + 24 * oneHour,
      slippageBps: 0
    });

    expect(result.trades.length).toBeGreaterThan(0);
    const tpTrade = result.trades[0];
    expect(tpTrade).toBeDefined();
    if (!tpTrade) throw new Error("Expected trade");
    expect(tpTrade.exitReason).toBe("take-profit");
    // With gap-aware take-profit fill, it MUST fill at bar open 140.00, NOT at ~125.00!
    expect(tpTrade.exitPrice.equals(ScaledDecimal.fromString("140"))).toBe(true);
  });
});
