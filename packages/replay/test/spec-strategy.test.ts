import { describe, expect, it } from "vitest";
import { ManualClock } from "@keel/core";
import { createSqliteDataStore, seedSyntheticMarketSeries } from "@keel/data";
import {
  DONCHIAN_TREND_V1_SPEC,
  VOL_MEAN_REVERSION_V1_SPEC,
  VOL_MOMENTUM_V1_SPEC,
  SpecStrategy
} from "@keel/spec";
import {
  DonchianTrendStrategy,
  VolNormalizedMeanReversionStrategy,
  VolNormalizedMomentumStrategy
} from "@keel/strategy";
import { ReplayEngine } from "../src/index.js";

describe("T5: SpecStrategy Integration with ReplayEngine (ADR-0020)", () => {
  it("executes SpecStrategy seamlessly in ReplayEngine and matches hardcoded Donchian metrics", () => {
    const store = createSqliteDataStore({
      dbPath: ":memory:",
      clock: new ManualClock(1_710_000_000_000)
    });

    seedSyntheticMarketSeries({
      marketDataRepo: store.marketDataRepo,
      instrumentId: "BTC-USDT-SWAP",
      endCloseTs: 1_710_000_000_000,
      barCount1H: 240
    });

    const engine = new ReplayEngine({
      marketDataRepo: store.marketDataRepo
    });

    const hardcodedStrategy = new DonchianTrendStrategy({ channelLength: 20 });
    const specStrategy = new SpecStrategy(DONCHIAN_TREND_V1_SPEC);

    const fromTs = 1_710_000_000_000 - 240 * 3600_000;
    const toTs = 1_710_000_000_000;

    const hardcodedRun = engine.run({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      strategy: hardcodedStrategy,
      fromTs,
      toTs,
      walkForwardFolds: 1,
      randomEntryPaths: 5
    });

    const specRun = engine.run({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      strategy: specStrategy,
      fromTs,
      toTs,
      walkForwardFolds: 1,
      randomEntryPaths: 5
    });

    expect(specRun.totalTrades).toBe(hardcodedRun.totalTrades);
    expect(specRun.netPnlUsdt).toBe(hardcodedRun.netPnlUsdt);
    expect(specRun.avgR).toBeCloseTo(hardcodedRun.avgR, 4);

    store.close();
  });

  it("executes SpecStrategy for Vol-Normalized Mean Reversion and matches hardcoded metrics", () => {
    const store = createSqliteDataStore({
      dbPath: ":memory:",
      clock: new ManualClock(1_710_000_000_000)
    });

    seedSyntheticMarketSeries({
      marketDataRepo: store.marketDataRepo,
      instrumentId: "BTC-USDT-SWAP",
      endCloseTs: 1_710_000_000_000,
      barCount1H: 240
    });

    const engine = new ReplayEngine({
      marketDataRepo: store.marketDataRepo
    });

    const hardcoded = new VolNormalizedMeanReversionStrategy();
    const spec = new SpecStrategy(VOL_MEAN_REVERSION_V1_SPEC);

    const fromTs = 1_710_000_000_000 - 240 * 3600_000;
    const toTs = 1_710_000_000_000;

    const hardcodedRun = engine.run({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      strategy: hardcoded,
      fromTs,
      toTs,
      walkForwardFolds: 1,
      randomEntryPaths: 5
    });

    const specRun = engine.run({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      strategy: spec,
      fromTs,
      toTs,
      walkForwardFolds: 1,
      randomEntryPaths: 5
    });

    expect(specRun.totalTrades).toBe(hardcodedRun.totalTrades);
    expect(specRun.netPnlUsdt).toBe(hardcodedRun.netPnlUsdt);
    expect(specRun.avgR).toBeCloseTo(hardcodedRun.avgR, 4);

    store.close();
  });

  it("executes SpecStrategy for Vol-Normalized Momentum and matches hardcoded metrics", () => {
    const store = createSqliteDataStore({
      dbPath: ":memory:",
      clock: new ManualClock(1_710_000_000_000)
    });

    seedSyntheticMarketSeries({
      marketDataRepo: store.marketDataRepo,
      instrumentId: "BTC-USDT-SWAP",
      endCloseTs: 1_710_000_000_000,
      barCount1H: 240
    });

    const engine = new ReplayEngine({
      marketDataRepo: store.marketDataRepo
    });

    const hardcoded = new VolNormalizedMomentumStrategy();
    const spec = new SpecStrategy(VOL_MOMENTUM_V1_SPEC);

    const fromTs = 1_710_000_000_000 - 240 * 3600_000;
    const toTs = 1_710_000_000_000;

    const hardcodedRun = engine.run({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      strategy: hardcoded,
      fromTs,
      toTs,
      walkForwardFolds: 1,
      randomEntryPaths: 5
    });

    const specRun = engine.run({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      strategy: spec,
      fromTs,
      toTs,
      walkForwardFolds: 1,
      randomEntryPaths: 5
    });

    expect(specRun.totalTrades).toBe(hardcodedRun.totalTrades);
    expect(specRun.netPnlUsdt).toBe(hardcodedRun.netPnlUsdt);
    expect(specRun.avgR).toBeCloseTo(hardcodedRun.avgR, 4);

    store.close();
  });
});
