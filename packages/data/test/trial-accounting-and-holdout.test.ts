import { describe, expect, it } from "vitest";
import {
  ManualClock,
  SEALED_2026_HOLDOUT_START_TS,
  SEALED_2026_HOLDOUT_END_TS,
  type ExperimentRecord
} from "@keel/core";
import { createSqliteDataStore } from "../src/index.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

describe("T3: Trial Accounting & Holdout Seal (R2, R4)", () => {
  it("R2: persists distinct research trials, monotonic counter never decreases across restarts", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "keel-t3-test-"));
    const dbPath = join(tempDir, "trials.sqlite");
    const clock = new ManualClock(1_700_000_000_000);

    let store = createSqliteDataStore({ dbPath, clock });
    try {
      expect(store.experimentRepo.getTrialCount()).toBe(0);

      // Record first trial
      const count1 = store.experimentRepo.recordTrial({
        strategyId: "donchian-trend",
        parameterHash: "param-hash-1",
        instrumentId: "BTC-USDT-SWAP",
        timeframe: "1H"
      });
      expect(count1).toBe(1);
      expect(store.experimentRepo.getTrialCount()).toBe(1);

      // Record duplicate trial (same parameters) -> count remains 1
      const countDup = store.experimentRepo.recordTrial({
        strategyId: "donchian-trend",
        parameterHash: "param-hash-1",
        instrumentId: "BTC-USDT-SWAP",
        timeframe: "1H"
      });
      expect(countDup).toBe(1);
      expect(store.experimentRepo.getTrialCount()).toBe(1);

      // Record distinct trial -> count increments to 2
      const count2 = store.experimentRepo.recordTrial({
        strategyId: "donchian-trend",
        parameterHash: "param-hash-2",
        instrumentId: "BTC-USDT-SWAP",
        timeframe: "1H"
      });
      expect(count2).toBe(2);
      expect(store.experimentRepo.getTrialCount()).toBe(2);

      // Simulate server restart: close and re-open SQLite store
      store.close();
      store = createSqliteDataStore({ dbPath, clock });

      // Count is durably preserved across restart!
      expect(store.experimentRepo.getTrialCount()).toBe(2);
    } finally {
      store.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("R2: experiments table enforces immutable plain INSERT semantics (throws on duplicate ID)", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });

    try {
      const exp: ExperimentRecord = {
        experimentId: "exp-immutable-1",
        strategyId: "donchian-trend",
        strategyVersion: "1.0.0",
        instrumentId: "BTC-USDT-SWAP",
        timeframe: "1H",
        dataSnapshotId: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        configHash: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
        fromTs: 1_700_000_000_000,
        toTs: 1_710_000_000_000,
        totalTrades: 50,
        winRate: 0.55,
        avgR: 0.42,
        netPnlUsdt: "1250.00000000",
        totalFeesUsdt: "150.00000000",
        totalFundingUsdt: "25.00000000",
        maxDrawdownPct: 4.5,
        sharpeRatio: 1.45,
        deflatedSharpeRatio: 0.92,
        stressNetExpectancyR: 0.35,
        walkForwardOutOfSampleAvgR: 0.28,
        replayGatePassed: true,
        createdAtMs: clock.nowMs(),
        numTrials: 5,
        buyAndHoldReturnPct: 10.2,
        buyAndHoldSharpeRatio: 0.85,
        randomEntryReturnPct: -2.1,
        randomEntrySharpeRatio: -0.15
      };

      // 1. Initial insert succeeds
      const saved = store.experimentRepo.saveExperiment(exp);
      expect(saved.experimentId).toBe("exp-immutable-1");

      // 2. Attempt to overwrite with altered data MUST throw PRIMARY KEY constraint violation!
      const alteredExp: ExperimentRecord = {
        ...exp,
        sharpeRatio: 9.99,
        netPnlUsdt: "999999.00"
      };

      expect(() => store.experimentRepo.saveExperiment(alteredExp)).toThrow(
        /UNIQUE constraint failed|PRIMARY KEY/i
      );

      // Verify original record is unchanged
      const retrieved = store.experimentRepo.getExperiment("exp-immutable-1");
      expect(retrieved?.sharpeRatio).toBe(1.45);
    } finally {
      store.close();
    }
  });

  it("R4: manages single-use holdout authorization tokens in database", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });

    try {
      expect(store.experimentRepo.hasUnusedHoldoutToken("2026_holdout")).toBe(false);

      // Create token
      store.experimentRepo.createHoldoutToken({
        token: "auth-token-12345",
        partition: "2026_holdout"
      });
      expect(store.experimentRepo.hasUnusedHoldoutToken("2026_holdout")).toBe(true);

      // Consume token (single use)
      const consumed = store.experimentRepo.consumeHoldoutToken({
        token: "auth-token-12345",
        partition: "2026_holdout",
        nowMs: clock.nowMs()
      });
      expect(consumed).toBe(true);

      // Second consumption fails!
      const consumedAgain = store.experimentRepo.consumeHoldoutToken({
        token: "auth-token-12345",
        partition: "2026_holdout",
        nowMs: clock.nowMs()
      });
      expect(consumedAgain).toBe(false);
      expect(store.experimentRepo.hasUnusedHoldoutToken("2026_holdout")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("R4: exports exact SEALED_2026_HOLDOUT constants per ADR-0011", () => {
    expect(SEALED_2026_HOLDOUT_START_TS).toBe(1_767_225_600_000); // 2026-01-01 00:00:00 UTC
    expect(SEALED_2026_HOLDOUT_END_TS).toBe(1_782_863_999_000); // 2026-06-30 23:59:59 UTC
  });
});
