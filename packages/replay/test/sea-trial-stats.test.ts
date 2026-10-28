import { describe, expect, it } from "vitest";
import { ManualClock, ScaledDecimal, type FeatureSnapshot, type ProposalMenu } from "@keel/core";
import { createSqliteDataStore, seedSyntheticMarketSeries } from "@keel/data";
import { DonchianTrendStrategy, type Strategy } from "@keel/strategy";
import { ReplayEngine, bootstrapTradeReturns, normalCdf, oneSidedTTest } from "../src/index.js";

const END_TS = 1_733_011_200_000;
const INST = "BTC-USDT-SWAP";

function seededStore(barCount1H = 1_200) {
  const clock = new ManualClock(END_TS);
  const store = createSqliteDataStore({ dbPath: ":memory:", clock });
  const seeded = seedSyntheticMarketSeries({
    marketDataRepo: store.marketDataRepo,
    instrumentId: INST,
    endCloseTs: END_TS,
    barCount1H
  });
  return { clock, store, seeded };
}

/** A strategy that never trades and remembers every snapshot Replay hands it. */
function recordingStrategy(lookback: number): Strategy & { seen: FeatureSnapshot[] } {
  const seen: FeatureSnapshot[] = [];
  return {
    id: "recorder",
    strategyId: "recorder",
    version: "1.0.0",
    name: "recorder",
    description: "records snapshots",
    parameterHash: "recorder",
    lookbacks: { "1H": lookback },
    lookbackRequirements: { "1H": lookback },
    seen,
    evaluate(snapshot): ProposalMenu {
      seen.push(snapshot);
      return {
        instrumentId: snapshot.instrumentId,
        asOfMs: snapshot.asOfMs,
        strategyId: "recorder",
        strategyVersion: "1.0.0",
        proposals: []
      };
    }
  };
}

describe("Sea-trial statistics", () => {
  it("never loses money when every resampled trade is a winner, and always does when none is", () => {
    const wins = bootstrapTradeReturns({ tradeReturns: [0.01, 0.02, 0.005], paths: 300, seed: 1 });
    expect(wins.lossProbabilityPct).toBe(0);
    expect(wins.p95DrawdownPct).toBe(0);
    const losses = bootstrapTradeReturns({ tradeReturns: [-0.01, -0.02], paths: 300, seed: 1 });
    expect(losses.lossProbabilityPct).toBe(100);
  });

  it("gives the same answer for the same seed", () => {
    const mixed = [0.03, -0.02, 0.01, -0.015, 0.02, -0.01];
    const a = bootstrapTradeReturns({ tradeReturns: mixed, paths: 400, seed: 42 });
    const b = bootstrapTradeReturns({ tradeReturns: mixed, paths: 400, seed: 42 });
    expect(a).toEqual(b);
    expect(a.lossProbabilityPct).toBeGreaterThan(0);
    expect(a.lossProbabilityPct).toBeLessThan(100);
  });

  it("t-tests the mean trade against zero (worked example: 2 and 0 give t = 1)", () => {
    const { tStat, pValue } = oneSidedTTest([2, 0], normalCdf);
    expect(tStat).toBeCloseTo(1, 6);
    // 1 - Φ(1) = 0.158655
    expect(pValue).toBeCloseTo(0.158655, 4);
    expect(oneSidedTTest([1], normalCdf)).toEqual({ tStat: 0, pValue: 1 });
  });
});

describe("Replay snapshots and funding", () => {
  it("hands the strategy exactly the snapshot the repository would build, bar by bar", () => {
    const { clock, store, seeded } = seededStore();
    const engine = new ReplayEngine({ marketDataRepo: store.marketDataRepo, clock });
    const strategy = recordingStrategy(60);
    // Start after the first bars so the warm-up history comes from before the window
    engine.run({
      instrumentId: INST,
      timeframe: "1H",
      strategy,
      fromTs: seeded.fromTs + 100 * 3_600_000,
      toTs: seeded.toTs,
      walkForwardFolds: 0,
      randomEntryPaths: 1
    });
    expect(strategy.seen.length).toBeGreaterThan(900);
    for (const snapshot of strategy.seen) {
      const expected = store.marketDataRepo.buildFeatureSnapshot({
        instrumentId: INST,
        asOfMs: snapshot.asOfMs,
        requirements: { "1H": 60 }
      });
      expect(snapshot).toEqual(expected);
    }
  });

  it("charges the assumed funding rate only when the window has no settled funding", () => {
    const { clock, store, seeded } = seededStore();
    const engine = new ReplayEngine({ marketDataRepo: store.marketDataRepo, clock });
    const run = (assumedFundingBpsPer8h: number) =>
      engine.run({
        instrumentId: INST,
        timeframe: "1H",
        strategy: new DonchianTrendStrategy(),
        fromTs: seeded.fromTs,
        toTs: seeded.toTs,
        walkForwardFolds: 0,
        randomEntryPaths: 1,
        assumedFundingBpsPer8h
      });

    // Settled funding exists: the assumption is ignored
    expect(run(5).totalFundingUsdt).toBe(run(0).totalFundingUsdt);

    // Without settled funding, every open position pays the assumed rate
    store.rawDb.exec("DELETE FROM settled_funding_rates");
    const free = run(0);
    const charged = run(5);
    expect(free.totalFundingUsdt).toBe(ScaledDecimal.zero().toString());
    expect(charged.totalTrades).toBe(free.totalTrades);
    expect(Number(charged.totalFundingUsdt)).toBeLessThan(0);
    expect(Number(charged.netPnlUsdt)).toBeLessThan(Number(free.netPnlUsdt));
  });
});
