import { describe, expect, it } from "vitest";
import { ManualClock } from "@keel/core";
import { createSqliteDataStore } from "../src/index.js";

describe("ShadowRepository and Shadow Decision Resolution (T7 / M-H)", () => {
  it("records shadow decisions with deduplication per (strategy, instrument, bar)", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });

    const inserted1 = store.shadowRepo.recordDecision({
      strategyId: "donchian-trend",
      instrumentId: "BTC-USDT-SWAP",
      signalBarOpenTs: 1_700_000_000_000,
      signalBarCloseTs: 1_700_003_600_000,
      proposalId: "prop-1",
      side: "long",
      entryPrice: "50000.00",
      protectiveStopPrice: "49000.00",
      takeProfitPrice: "52000.00",
      createdAtMs: 1_700_003_600_000
    });
    expect(inserted1).toBe(true);

    // Duplicate submission on identical (strategy, instrument, signalBarCloseTs) must be deduplicated
    const inserted2 = store.shadowRepo.recordDecision({
      strategyId: "donchian-trend",
      instrumentId: "BTC-USDT-SWAP",
      signalBarOpenTs: 1_700_000_000_000,
      signalBarCloseTs: 1_700_003_600_000,
      proposalId: "prop-1-dup",
      side: "long",
      entryPrice: "50000.00",
      protectiveStopPrice: "49000.00",
      takeProfitPrice: "52000.00",
      createdAtMs: 1_700_003_600_500
    });
    expect(inserted2).toBe(false);

    const decisions = store.shadowRepo.listDecisions("donchian-trend");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.proposalId).toBe("prop-1");
  });

  it("resolves pending shadow decisions into hypothetical R on subsequent bars", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });

    // Seed signal bar at closeTs = 1_700_003_600_000
    store.shadowRepo.recordDecision({
      strategyId: "donchian-trend",
      instrumentId: "BTC-USDT-SWAP",
      signalBarOpenTs: 1_700_000_000_000,
      signalBarCloseTs: 1_700_003_600_000,
      proposalId: "prop-target-hit",
      side: "long",
      entryPrice: "50000.00",
      protectiveStopPrice: "49000.00", // 1R = 1000
      takeProfitPrice: "52000.00", // target = +2R
      createdAtMs: 1_700_003_600_000
    });

    // Record second decision that will hit stop
    store.shadowRepo.recordDecision({
      strategyId: "donchian-trend",
      instrumentId: "BTC-USDT-SWAP",
      signalBarOpenTs: 1_700_003_600_000,
      signalBarCloseTs: 1_700_007_200_000,
      proposalId: "prop-stop-hit",
      side: "short",
      entryPrice: "50000.00",
      protectiveStopPrice: "51000.00", // 1R = 1000
      takeProfitPrice: "48000.00",
      createdAtMs: 1_700_007_200_000
    });

    const initialStats = store.shadowRepo.getShadowStats("donchian-trend");
    expect(initialStats.totalDecisions).toBe(2);
    expect(initialStats.resolvedCount).toBe(0);
    expect(initialStats.pendingCount).toBe(2);

    // Ingest subsequent bars to resolve decisions
    // For prop-target-hit: next bar opens at 50000, high reaches 52500 (hits TP 52000)
    store.marketDataRepo.ingestOkxCandles({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      candles: [
        {
          openTs: 1_700_003_600_000,
          open: "50000.00",
          high: "52500.00",
          low: "49500.00",
          close: "52200.00",
          volumeContracts: "100.0",
          volumeQuote: "5000000.0",
          confirm: "1"
        },
        // For prop-stop-hit: next bar opens at 52200, high hits 53500 (breaches adjusted stop 53200)
        {
          openTs: 1_700_007_200_000,
          open: "52200.00",
          high: "53500.00",
          low: "51500.00",
          close: "52800.00",
          volumeContracts: "100.0",
          volumeQuote: "5000000.0",
          confirm: "1"
        }
      ]
    });

    store.shadowRepo.resolvePendingDecisions({
      marketDataRepo: store.marketDataRepo,
      slippageBps: 0
    });

    const finalStats = store.shadowRepo.getShadowStats("donchian-trend");
    expect(finalStats.resolvedCount).toBe(2);
    expect(finalStats.pendingCount).toBe(0);
    // prop-target-hit: +2R
    // prop-stop-hit: -1R
    // Average expectancy: (+2 + (-1)) / 2 = +0.5R
    expect(finalStats.expectancyR).toBeCloseTo(0.5, 1);
  });
});
