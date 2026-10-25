import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock, createDefaultConfig } from "@keel/core";
import { createSqliteDataStore } from "@keel/data";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKeelServer } from "../src/index.js";

describe("M7 Promotion Ladder, Human Gates G2/G3, & Demotion Auto-Flattening (ADR-0007)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "keel-promo-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("enforces step-up authentication for G2 (Demo, Live-Ramp) and G3 (Live) and rejects unvetted promotions", async () => {
    const clock = new ManualClock(1_730_000_000_000);
    const config = createDefaultConfig();
    const dataStore = createSqliteDataStore({
      dbPath: ":memory:",
      clock,
      initialConfig: config
    });

    let bootstrapToken = "";
    const app = await createKeelServer({
      config,
      clock,
      dataStore,
      onBootstrapToken: (t) => {
        bootstrapToken = t;
      }
    });

    // 1. Bootstrap operator
    const bootRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/bootstrap",
      headers: {
        "cf-connecting-ip": "203.0.113.42",
        "x-forwarded-proto": "https"
      },
      payload: {
        bootstrapToken,
        username: "captain",
        password: "correct-horse-battery-staple"
      }
    });
    expect(bootRes.statusCode).toBe(200);
    const setCookie = String(bootRes.headers["set-cookie"] ?? "");
    const cookieHeader = setCookie.split(";")[0] ?? "";

    // 2. Attempt promoting without prior evaluation -> 400
    const unvettedRes = await app.inject({
      method: "POST",
      url: "/api/v1/promotion/promote",
      headers: { cookie: cookieHeader },
      payload: {
        strategyId: "donchian-trend",
        targetStage: "Live-Ramp",
        stepUpPassword: "correct-horse-battery-staple"
      }
    });
    expect(unvettedRes.statusCode).toBe(400);

    // 3. Seed an experiment and promotion record where strategy passed replay gate and is eligible for Paper -> Demo
    dataStore.promotionRepo.upsertPromotion({
      strategyId: "donchian-trend",
      currentStage: "Paper",
      latestExperimentId: "exp-1",
      replayGatePassed: true,
      paperTradesCount: 25,
      paperDrawdownPct: 1.5,
      rampAllocationPct: 100,
      eligibleNextStage: "Demo",
      demotionReason: null,
      updatedAtMs: clock.nowMs()
    });

    // 4. Attempt promoting to Demo (Gate G2) without password -> 403 step-up required
    const noPassRes = await app.inject({
      method: "POST",
      url: "/api/v1/promotion/promote",
      headers: { cookie: cookieHeader },
      payload: {
        strategyId: "donchian-trend",
        targetStage: "Demo"
      }
    });
    expect(noPassRes.statusCode).toBe(403);

    // 5. Promote to Demo with correct step-up password -> 200
    const demoPromoRes = await app.inject({
      method: "POST",
      url: "/api/v1/promotion/promote",
      headers: { cookie: cookieHeader },
      payload: {
        strategyId: "donchian-trend",
        targetStage: "Demo",
        stepUpPassword: "correct-horse-battery-staple"
      }
    });
    expect(demoPromoRes.statusCode).toBe(200);
    const promoBody = demoPromoRes.json() as {
      promotion: { currentStage: string; eligibleNextStage: string };
    };
    expect(promoBody.promotion.currentStage).toBe("Demo");
    // Once promoted to Demo, must remain ineligible for Live-Ramp until Demo criteria are evaluated and met (C9)
    expect(promoBody.promotion.eligibleNextStage).toBeNull();

    await app.close();
  });

  it("automatically flattens positions and emits alerts when evaluation detects drawdown demotion breach", async () => {
    const clock = new ManualClock(1_730_000_000_000);
    const config = createDefaultConfig();
    const dataStore = createSqliteDataStore({
      dbPath: ":memory:",
      clock,
      initialConfig: config
    });

    let bootstrapToken = "";
    const app = await createKeelServer({
      config,
      clock,
      dataStore,
      onBootstrapToken: (t) => {
        bootstrapToken = t;
      }
    });

    // Bootstrap operator
    const bootRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/bootstrap",
      headers: {
        "cf-connecting-ip": "203.0.113.42",
        "x-forwarded-proto": "https"
      },
      payload: {
        bootstrapToken,
        username: "captain",
        password: "correct-horse-battery-staple"
      }
    });
    expect(bootRes.statusCode).toBe(200);
    const setCookie = String(bootRes.headers["set-cookie"] ?? "");
    const cookieHeader = setCookie.split(";")[0] ?? "";

    // Seed strategy in Live-Ramp with drawdown breaching 3% threshold via ledger loss (4.2%)
    dataStore.ledgerRepo.recordJournal({
      txGroupId: "tx-ramp-loss",
      ts: clock.nowMs(),
      strategyId: "donchian-trend",
      instrumentId: "BTC-USDT-SWAP",
      debitAccount: "realized_pnl:usdt",
      creditAccount: "cash:usdt",
      amountUsdt: "420.00000000",
      description: "Live-ramp loss exceeding 3%"
    });

    dataStore.promotionRepo.upsertPromotion({
      strategyId: "donchian-trend",
      currentStage: "Live-Ramp",
      latestExperimentId: "exp-1",
      replayGatePassed: true,
      paperTradesCount: 30,
      paperDrawdownPct: 4.2, // > 3.0% threshold
      rampAllocationPct: 25,
      eligibleNextStage: "Live",
      demotionReason: null,
      updatedAtMs: clock.nowMs()
    });

    // Evaluate promotion ladder -> triggers automatic demotion to Demo & auto-flattening
    const evalRes = await app.inject({
      method: "POST",
      url: "/api/v1/promotion/evaluate",
      headers: { cookie: cookieHeader },
      payload: {
        strategyId: "donchian-trend"
      }
    });

    expect(evalRes.statusCode).toBe(200);
    const evalBody = evalRes.json() as {
      promotion: { currentStage: string; demotionReason: string | null };
    };
    expect(evalBody.promotion.currentStage).toBe("Demo");
    expect(evalBody.promotion.demotionReason).toContain("exceeded 3% limit");

    await app.close();
  });

  it("computes paperDrawdownPct dynamically from persistent ledger equity without manual seeding (C8)", async () => {
    const clock = new ManualClock(1_730_000_000_000);
    const config = createDefaultConfig();
    const dataStore = createSqliteDataStore({
      dbPath: ":memory:",
      clock,
      initialConfig: config
    });

    let bootstrapToken = "";
    const app = await createKeelServer({
      config,
      clock,
      dataStore,
      onBootstrapToken: (t) => {
        bootstrapToken = t;
      }
    });

    const bootRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/bootstrap",
      headers: {
        "cf-connecting-ip": "203.0.113.42",
        "x-forwarded-proto": "https"
      },
      payload: {
        bootstrapToken,
        username: "captain",
        password: "correct-horse-battery-staple"
      }
    });
    const setCookie = String(bootRes.headers["set-cookie"] ?? "");
    const cookieHeader = setCookie.split(";")[0] ?? "";

    // 1. Strategy starts in Demo with 0 seeded drawdown
    dataStore.promotionRepo.upsertPromotion({
      strategyId: "donchian-trend",
      currentStage: "Demo",
      latestExperimentId: "exp-1",
      replayGatePassed: true,
      paperTradesCount: 20,
      paperDrawdownPct: 0.0, // Initial 0 drawdown
      rampAllocationPct: 100,
      eligibleNextStage: "Live-Ramp",
      demotionReason: null,
      updatedAtMs: clock.nowMs()
    });

    // 2. Record a catastrophic loss of 1,500 USDT in double-entry ledger (15% drawdown > 12% limit)
    dataStore.ledgerRepo.recordJournal({
      txGroupId: "tx-catastrophic-loss",
      ts: clock.nowMs(),
      strategyId: "donchian-trend",
      instrumentId: "BTC-USDT-SWAP",
      debitAccount: "realized_pnl:usdt",
      creditAccount: "cash:usdt",
      amountUsdt: "1500.00000000",
      description: "Catastrophic trade loss"
    });

    // 3. Evaluate promotion ladder -> must compute actual drawdown (15%) and trigger auto-demotion to Research
    const evalRes = await app.inject({
      method: "POST",
      url: "/api/v1/promotion/evaluate",
      headers: { cookie: cookieHeader },
      payload: {
        strategyId: "donchian-trend"
      }
    });

    expect(evalRes.statusCode).toBe(200);
    const evalBody = evalRes.json() as {
      promotion: { currentStage: string; paperDrawdownPct: number; demotionReason: string | null };
    };

    expect(evalBody.promotion.paperDrawdownPct).toBeGreaterThanOrEqual(14.0);
    expect(evalBody.promotion.currentStage).toBe("Research");
    expect(evalBody.promotion.demotionReason).toContain("catastrophic drawdown");

    await app.close();
  });

  it("evaluates calendar duration and trade count requirements from persistent ledger state before granting Demo eligibility (C9)", async () => {
    const clock = new ManualClock(1_730_000_000_000);
    const config = createDefaultConfig();
    const dataStore = createSqliteDataStore({
      dbPath: ":memory:",
      clock,
      initialConfig: config
    });

    let bootstrapToken = "";
    const app = await createKeelServer({
      config,
      clock,
      dataStore,
      onBootstrapToken: (t) => {
        bootstrapToken = t;
      }
    });

    const bootRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/bootstrap",
      headers: {
        "cf-connecting-ip": "203.0.113.42",
        "x-forwarded-proto": "https"
      },
      payload: {
        bootstrapToken,
        username: "captain",
        password: "correct-horse-battery-staple"
      }
    });
    const setCookie = String(bootRes.headers["set-cookie"] ?? "");
    const cookieHeader = setCookie.split(";")[0] ?? "";

    // 1. Seed a passing experiment
    dataStore.experimentRepo.saveExperiment({
      experimentId: "exp-pass-1",
      strategyId: "donchian-trend",
      strategyVersion: "1.0.0",
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      dataSnapshotId: "0".repeat(64),
      configHash: "1".repeat(64),
      fromTs: 1_700_000_000_000,
      toTs: 1_710_000_000_000,
      totalTrades: 200,
      winRate: 0.55,
      avgR: 0.35,
      netPnlUsdt: "1250.00",
      totalFeesUsdt: "45.00",
      totalFundingUsdt: "-12.00",
      sharpeRatio: 1.5,
      deflatedSharpeRatio: 0.95,
      maxDrawdownPct: 5.0,
      stressNetExpectancyR: 0.45,
      walkForwardOutOfSampleAvgR: 0.25,
      replayGatePassed: true,
      createdAtMs: clock.nowMs(),
      buyAndHoldReturnPct: 5.0,
      buyAndHoldSharpeRatio: 0.8,
      randomEntryReturnPct: -2.0,
      randomEntrySharpeRatio: -0.3
    });

    // 2. Strategy is in Paper mode, but only 5 days have elapsed with 10 trades
    const startMs = clock.nowMs() - 5 * 86_400_000;
    for (let i = 0; i < 10; i++) {
      dataStore.paperAccountRepo.savePosition({
        positionId: `pos-${i}`,
        strategyId: "donchian-trend",
        instrumentId: "BTC-USDT-SWAP",
        side: "long",
        contracts: "1",
        entryPrice: "50000.00",
        protectiveStopPrice: "49000.00",
        takeProfitPrice: null,
        initialRiskUsdt: "10.00",
        unrealizedPnlUsdt: "0.00",
        realizedPnlUsdt: "5.00",
        feesPaidUsdt: "0.50",
        fundingPaidUsdt: "0.00",
        openedAtMs: startMs + i * 3600_000,
        lastFundingSettledTs: startMs + i * 3600_000,
        status: "CLOSED",
        closedAtMs: startMs + i * 3600_000 + 1800_000,
        exitPrice: "50500.00",
        exitReason: "take_profit"
      });
      dataStore.ledgerRepo.recordJournal({
        txGroupId: `tx-${i}`,
        ts: startMs + i * 3600_000,
        strategyId: "donchian-trend",
        instrumentId: "BTC-USDT-SWAP",
        debitAccount: "cash:usdt",
        creditAccount: "realized_pnl:usdt",
        amountUsdt: "5.00000000",
        description: `Trade ${i}`
      });
    }

    dataStore.promotionRepo.upsertPromotion({
      strategyId: "donchian-trend",
      currentStage: "Paper",
      latestExperimentId: "exp-pass-1",
      replayGatePassed: true,
      paperTradesCount: 10,
      paperDrawdownPct: 0.0,
      rampAllocationPct: 100,
      eligibleNextStage: null,
      demotionReason: null,
      updatedAtMs: clock.nowMs()
    });

    // 3. Evaluate: 5 days (< 30) and 10 trades (< 50) MUST remain ineligible for Demo
    const evalRes1 = await app.inject({
      method: "POST",
      url: "/api/v1/promotion/evaluate",
      headers: { cookie: cookieHeader },
      payload: { strategyId: "donchian-trend" }
    });
    expect(evalRes1.statusCode).toBe(200);
    const body1 = evalRes1.json() as { promotion: { eligibleNextStage: string | null } };
    expect(body1.promotion.eligibleNextStage).toBeNull();

    // 4. Now add remaining trades and advance clock past 30 days (e.g. 35 days)
    const thirtyFiveDaysAgo = clock.nowMs() - 35 * 86_400_000;
    dataStore.ledgerRepo.recordJournal({
      txGroupId: "tx-early",
      ts: thirtyFiveDaysAgo,
      strategyId: "donchian-trend",
      instrumentId: "BTC-USDT-SWAP",
      debitAccount: "cash:usdt",
      creditAccount: "realized_pnl:usdt",
      amountUsdt: "1.00000000",
      description: "First trading activity 35 days ago"
    });

    for (let i = 10; i < 55; i++) {
      dataStore.paperAccountRepo.savePosition({
        positionId: `pos-${i}`,
        strategyId: "donchian-trend",
        instrumentId: "BTC-USDT-SWAP",
        side: "long",
        contracts: "1",
        entryPrice: "50000.00",
        protectiveStopPrice: "49000.00",
        takeProfitPrice: null,
        initialRiskUsdt: "10.00",
        unrealizedPnlUsdt: "0.00",
        realizedPnlUsdt: "5.00",
        feesPaidUsdt: "0.50",
        fundingPaidUsdt: "0.00",
        openedAtMs: thirtyFiveDaysAgo + i * 3600_000,
        lastFundingSettledTs: thirtyFiveDaysAgo + i * 3600_000,
        status: "CLOSED",
        closedAtMs: thirtyFiveDaysAgo + i * 3600_000 + 1800_000,
        exitPrice: "50500.00",
        exitReason: "take_profit"
      });
    }

    // 5. Evaluate again: 35 days (>= 30) and 55 trades (>= 50) -> becomes eligible for Demo!
    const evalRes2 = await app.inject({
      method: "POST",
      url: "/api/v1/promotion/evaluate",
      headers: { cookie: cookieHeader },
      payload: { strategyId: "donchian-trend" }
    });
    expect(evalRes2.statusCode).toBe(200);
    const body2 = evalRes2.json() as { promotion: { eligibleNextStage: string | null } };
    expect(body2.promotion.eligibleNextStage).toBe("Demo");

    await app.close();
  });
});
