import { describe, expect, it } from "vitest";
import { ManualClock, SEALED_2026_HOLDOUT_START_TS } from "@keel/core";
import { createSqliteDataStore, seedSyntheticMarketSeries } from "@keel/data";
import { DonchianTrendStrategy } from "@keel/strategy";
import { ReplayEngine } from "../src/index.js";

describe("T3: Sealed 2026 Holdout Enforcement in ReplayEngine (R4)", () => {
  it("rejects access at or after SEALED_2026_HOLDOUT_START_TS without allowHoldoutAccess", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });

    try {
      const strategy = new DonchianTrendStrategy();
      const engine = new ReplayEngine({
        marketDataRepo: store.marketDataRepo,
        experimentRepo: store.experimentRepo,
        clock
      });

      expect(() =>
        engine.run({
          instrumentId: "BTC-USDT-SWAP",
          timeframe: "1H",
          strategy,
          fromTs: 1_700_000_000_000,
          toTs: SEALED_2026_HOLDOUT_START_TS,
          allowHoldoutAccess: false
        })
      ).toThrow(/Sealed 2026 holdout violation.*allowHoldoutAccess/i);
    } finally {
      store.close();
    }
  });

  it("rejects access when allowHoldoutAccess is true but no token exists in database", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });

    try {
      const strategy = new DonchianTrendStrategy();
      const engine = new ReplayEngine({
        marketDataRepo: store.marketDataRepo,
        experimentRepo: store.experimentRepo,
        clock
      });

      expect(() =>
        engine.run({
          instrumentId: "BTC-USDT-SWAP",
          timeframe: "1H",
          strategy,
          fromTs: 1_700_000_000_000,
          toTs: SEALED_2026_HOLDOUT_START_TS,
          allowHoldoutAccess: true
        })
      ).toThrow(/No unused single-use authorization token found for partition '2026_holdout'/i);
    } finally {
      store.close();
    }
  });

  it("consumes single-use token on authorization; subsequent attempt is rejected", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });

    try {
      const strategy = new DonchianTrendStrategy();
      const engine = new ReplayEngine({
        marketDataRepo: store.marketDataRepo,
        experimentRepo: store.experimentRepo,
        clock
      });

      // Insert single-use token
      store.experimentRepo.createHoldoutToken({
        token: "auth-token-test",
        partition: "2026_holdout",
        createdAtMs: clock.nowMs()
      });
      expect(store.experimentRepo.hasUnusedHoldoutToken("2026_holdout")).toBe(true);

      // First run consumes the token (even if data lookup fails afterward)
      try {
        engine.run({
          instrumentId: "BTC-USDT-SWAP",
          timeframe: "1H",
          strategy,
          fromTs: 1_700_000_000_000,
          toTs: SEALED_2026_HOLDOUT_START_TS,
          allowHoldoutAccess: true
        });
      } catch (err) {
        // Did not fail due to holdout rejection!
        expect((err as Error).message).not.toMatch(/Sealed 2026 holdout violation/i);
      }

      // Token is now consumed
      expect(store.experimentRepo.hasUnusedHoldoutToken("2026_holdout")).toBe(false);

      // Second attempt MUST be rejected because token was single-use
      expect(() =>
        engine.run({
          instrumentId: "BTC-USDT-SWAP",
          timeframe: "1H",
          strategy,
          fromTs: 1_700_000_000_000,
          toTs: SEALED_2026_HOLDOUT_START_TS,
          allowHoldoutAccess: true
        })
      ).toThrow(/No unused single-use authorization token found for partition '2026_holdout'/i);
    } finally {
      store.close();
    }
  });

  it("R4: Walk-forward folds reject confirmed bars at or after SEALED_2026_HOLDOUT_START_TS", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });

    try {
      const strategy = new DonchianTrendStrategy();
      const engine = new ReplayEngine({
        marketDataRepo: store.marketDataRepo,
        experimentRepo: store.experimentRepo,
        clock
      });

      // Insert token to pass initial gate
      store.experimentRepo.createHoldoutToken({
        token: "auth-wf-token",
        partition: "2026_holdout",
        createdAtMs: clock.nowMs()
      });

      // Seed bars extending into 2026 holdout
      const endCloseTs = SEALED_2026_HOLDOUT_START_TS + 10 * 3_600_000;
      const seeded = seedSyntheticMarketSeries({
        marketDataRepo: store.marketDataRepo,
        instrumentId: "BTC-USDT-SWAP",
        endCloseTs,
        barCount1H: 150
      });

      // Running walk-forward evaluation across these bars must throw sealed holdout violation
      expect(() =>
        engine.run({
          instrumentId: "BTC-USDT-SWAP",
          timeframe: "1H",
          strategy,
          fromTs: seeded.fromTs,
          toTs: endCloseTs,
          allowHoldoutAccess: true,
          walkForwardFolds: 2
        })
      ).toThrow(/Sealed 2026 holdout violation: Walk-forward fold contains bars at or after/i);
    } finally {
      store.close();
    }
  });
});
