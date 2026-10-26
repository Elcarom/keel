import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ManualClock, ScaledDecimal } from "@keel/core";
import { createSqliteDataStore } from "../src/index.js";

describe("Double-Entry LedgerRepository, PaperAccountRepository, & PromotionRepository", () => {
  it("seeds initial paper capital and maintains exact double-entry trial balance across trades, fees, and funding", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });

    const initialBalance = store.ledgerRepo.getTrialBalance();
    expect(initialBalance.isBalanced).toBe(true);
    expect(initialBalance.cashBalanceUsdt).toBe("10000.00000000");
    expect(initialBalance.netEquityUsdt).toBe("10000.00000000");
    expect(initialBalance.entryCount).toBe(1);

    // Record entry fee: debit fees_expense:usdt, credit cash:usdt
    store.ledgerRepo.recordJournal({
      txGroupId: "tx-open-1",
      ts: 1_700_000_001_000,
      strategyId: "donchian-trend",
      instrumentId: "BTC-USDT-SWAP",
      debitAccount: "fees_expense:usdt",
      creditAccount: "cash:usdt",
      amountUsdt: "3.75000000",
      description: "Entry taker + spread/slippage cost"
    });

    // Record positive settled funding received: debit cash:usdt, credit funding_pnl:usdt
    store.ledgerRepo.recordJournal({
      txGroupId: "tx-fund-1",
      ts: 1_700_000_028_800,
      strategyId: "donchian-trend",
      instrumentId: "BTC-USDT-SWAP",
      debitAccount: "cash:usdt",
      creditAccount: "funding_pnl:usdt",
      amountUsdt: "1.25000000",
      description: "8h settled funding credit"
    });

    // Record winning trade gross PnL: debit cash:usdt, credit realized_pnl:usdt
    store.ledgerRepo.recordJournal({
      txGroupId: "tx-close-1",
      ts: 1_700_000_036_000,
      strategyId: "donchian-trend",
      instrumentId: "BTC-USDT-SWAP",
      debitAccount: "cash:usdt",
      creditAccount: "realized_pnl:usdt",
      amountUsdt: "150.00000000",
      description: "Realized gross profit on position close"
    });

    const afterBalance = store.ledgerRepo.getTrialBalance();
    expect(afterBalance.isBalanced).toBe(true);
    expect(afterBalance.totalDebitsUsdt).toBe(afterBalance.totalCreditsUsdt);
    // Cash = 10000 - 3.75 + 1.25 + 150 = 10147.50
    expect(afterBalance.cashBalanceUsdt).toBe("10147.50000000");
    expect(afterBalance.realizedPnlUsdt).toBe("150.00000000");
    expect(afterBalance.feesExpenseUsdt).toBe("3.75000000");
    expect(afterBalance.fundingPnlUsdt).toBe("1.25000000");
    expect(afterBalance.netEquityUsdt).toBe("10147.50000000");

    store.close();
  });

  it("property: getTrialBalance().isBalanced is always true across arbitrary trade, fee, and funding journals", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom("win", "loss", "fee", "funding_in", "funding_out"),
            cents: fc.integer({ min: 1, max: 50_000 })
          }),
          { minLength: 1, maxLength: 30 }
        ),
        (events) => {
          const clock = new ManualClock(1_700_000_000_000);
          const store = createSqliteDataStore({ dbPath: ":memory:", clock });

          events.forEach((ev, idx) => {
            const amount = ScaledDecimal.fromString((ev.cents / 100).toFixed(2)).toString();
            const txGroupId = `tx-${idx}`;
            if (ev.kind === "win") {
              store.ledgerRepo.recordJournal({
                txGroupId,
                ts: 1_700_000_000_000 + idx,
                strategyId: "donchian-trend",
                instrumentId: "BTC-USDT-SWAP",
                debitAccount: "cash:usdt",
                creditAccount: "realized_pnl:usdt",
                amountUsdt: amount,
                description: "Win"
              });
            } else if (ev.kind === "loss") {
              store.ledgerRepo.recordJournal({
                txGroupId,
                ts: 1_700_000_000_000 + idx,
                strategyId: "donchian-trend",
                instrumentId: "BTC-USDT-SWAP",
                debitAccount: "realized_pnl:usdt",
                creditAccount: "cash:usdt",
                amountUsdt: amount,
                description: "Loss"
              });
            } else if (ev.kind === "fee") {
              store.ledgerRepo.recordJournal({
                txGroupId,
                ts: 1_700_000_000_000 + idx,
                strategyId: "donchian-trend",
                instrumentId: "BTC-USDT-SWAP",
                debitAccount: "fees_expense:usdt",
                creditAccount: "cash:usdt",
                amountUsdt: amount,
                description: "Fee"
              });
            } else if (ev.kind === "funding_in") {
              store.ledgerRepo.recordJournal({
                txGroupId,
                ts: 1_700_000_000_000 + idx,
                strategyId: "donchian-trend",
                instrumentId: "BTC-USDT-SWAP",
                debitAccount: "cash:usdt",
                creditAccount: "funding_pnl:usdt",
                amountUsdt: amount,
                description: "Funding in"
              });
            } else {
              store.ledgerRepo.recordJournal({
                txGroupId,
                ts: 1_700_000_000_000 + idx,
                strategyId: "donchian-trend",
                instrumentId: "BTC-USDT-SWAP",
                debitAccount: "funding_pnl:usdt",
                creditAccount: "cash:usdt",
                amountUsdt: amount,
                description: "Funding out"
              });
            }
          });

          const tb = store.ledgerRepo.getTrialBalance();
          expect(tb.isBalanced).toBe(true);
          expect(tb.totalDebitsUsdt).toBe(tb.totalCreditsUsdt);
          expect(tb.cashBalanceUsdt).toBe(tb.netEquityUsdt);

          store.close();
        }
      ),
      { numRuns: 40 }
    );
  });

  it("persists paper positions, orders, circuit breaker state, and strategy promotions", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });

    const savedPos = store.paperAccountRepo.savePosition({
      positionId: "pos-1",
      strategyId: "donchian-trend",
      instrumentId: "BTC-USDT-SWAP",
      side: "long",
      contracts: "7.50000000",
      entryPrice: "50000.00000000",
      protectiveStopPrice: "49000.00000000",
      takeProfitPrice: "52500.00000000",
      initialRiskUsdt: "75.00000000",
      unrealizedPnlUsdt: "0.00000000",
      realizedPnlUsdt: "0.00000000",
      feesPaidUsdt: "3.75000000",
      fundingPaidUsdt: "0.00000000",
      openedAtMs: 1_700_000_000_000,
      lastFundingSettledTs: 1_700_000_000_000,
      status: "OPEN",
      closedAtMs: null,
      exitPrice: null,
      exitReason: null
    });

    expect(savedPos.positionId).toBe("pos-1");
    expect(store.paperAccountRepo.listOpenPositions()).toHaveLength(1);

    store.paperAccountRepo.saveOrder({
      orderId: "ord-1",
      positionId: "pos-1",
      proposalId: "prop-1",
      strategyId: "donchian-trend",
      instrumentId: "BTC-USDT-SWAP",
      side: "long",
      orderRole: "ENTRY",
      contracts: "7.50000000",
      fillPrice: "50000.00000000",
      protectiveStopPrice: "49000.00000000",
      feeUsdt: "3.75000000",
      status: "FILLED",
      createdAtMs: 1_700_000_000_000
    });

    expect(store.paperAccountRepo.listOrders()).toHaveLength(1);

    const cb = store.paperAccountRepo.setCircuitBreaker({
      status: "MANUAL_KILL_SWITCH",
      reason: "Operator test halt",
      triggeredAtMs: 1_700_000_010_000,
      cooldownUntilMs: null,
      updatedBy: "admin"
    });
    expect(cb.status).toBe("MANUAL_KILL_SWITCH");
    expect(store.paperAccountRepo.getCircuitBreaker().status).toBe("MANUAL_KILL_SWITCH");

    const promo = store.promotionRepo.upsertPromotion({
      strategyId: "donchian-trend",
      currentStage: "Paper",
      latestExperimentId: "exp-1",
      replayGatePassed: true,
      paperTradesCount: 5,
      paperDrawdownPct: 1.2,
      eligibleNextStage: "Demo",
      demotionReason: null,
      updatedAtMs: 1_700_000_020_000
    });
    expect(promo.currentStage).toBe("Paper");
    expect(store.promotionRepo.getPromotion("donchian-trend")?.currentStage).toBe("Paper");

    store.close();
  });

  it("derives persistent risk metrics, HWM, and daily/weekly resets at UTC midnight (C2)", () => {
    // 2023-11-20 00:00:00 UTC is Monday midnight (1700438400000)
    const mondayMidnightMs = 1_700_438_400_000;
    const clock = new ManualClock(mondayMidnightMs);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });

    // Seed at ts 0 gives 10,000 USDT
    let metrics = store.ledgerRepo.getRiskMetrics({ asOfMs: mondayMidnightMs });
    expect(metrics.currentEquityUsdt.toFixed(2)).toBe("10000.00");
    expect(metrics.dayStartEquityUsdt.toFixed(2)).toBe("10000.00");
    expect(metrics.weekStartEquityUsdt.toFixed(2)).toBe("10000.00");
    expect(metrics.highWaterMarkEquityUsdt.toFixed(2)).toBe("10000.00");
    expect(metrics.feesTodayUsdt.toFixed(2)).toBe("0.00");
    expect(metrics.drawdownPct.toFixed(2)).toBe("0.00");

    // Monday 10:00 UTC: Record profit 1,000 USDT and fee 20 USDT
    const monday10am = mondayMidnightMs + 10 * 3_600_000;
    store.ledgerRepo.recordJournal({
      txGroupId: "tx-win-1",
      ts: monday10am,
      strategyId: "donchian-trend",
      instrumentId: "BTC-USDT-SWAP",
      debitAccount: "cash:usdt",
      creditAccount: "realized_pnl:usdt",
      amountUsdt: "1000.00000000",
      description: "Profit on trade"
    });
    store.ledgerRepo.recordJournal({
      txGroupId: "tx-fee-1",
      ts: monday10am,
      strategyId: "donchian-trend",
      instrumentId: "BTC-USDT-SWAP",
      debitAccount: "fees_expense:usdt",
      creditAccount: "cash:usdt",
      amountUsdt: "20.00000000",
      description: "Trade fee"
    });

    metrics = store.ledgerRepo.getRiskMetrics({ asOfMs: monday10am, strategyId: "donchian-trend" });
    // Cash = 10000 + 1000 - 20 = 10980
    expect(metrics.currentEquityUsdt.toFixed(2)).toBe("10980.00");
    expect(metrics.dayStartEquityUsdt.toFixed(2)).toBe("10000.00");
    expect(metrics.weekStartEquityUsdt.toFixed(2)).toBe("10000.00");
    // HWM touched 11000 before the fee journal
    expect(metrics.highWaterMarkEquityUsdt.toFixed(2)).toBe("11000.00");
    expect(metrics.feesTodayUsdt.toFixed(2)).toBe("20.00");
    // Drawdown = (11000 - 10980) / 11000 * 100 = 0.18%
    expect(metrics.drawdownPct.toFixed(2)).toBe("0.18");

    // Tuesday 00:00:00 UTC (1 day later)
    const tuesdayMidnight = mondayMidnightMs + 86_400_000;
    // Tuesday 04:00 UTC: Record loss 500 USDT
    const tuesday4am = tuesdayMidnight + 4 * 3_600_000;
    store.ledgerRepo.recordJournal({
      txGroupId: "tx-loss-1",
      ts: tuesday4am,
      strategyId: "donchian-trend",
      instrumentId: "BTC-USDT-SWAP",
      debitAccount: "realized_pnl:usdt",
      creditAccount: "cash:usdt",
      amountUsdt: "500.00000000",
      description: "Loss on trade"
    });

    metrics = store.ledgerRepo.getRiskMetrics({ asOfMs: tuesday4am, strategyId: "donchian-trend" });
    // Cash = 10980 - 500 = 10480
    expect(metrics.currentEquityUsdt.toFixed(2)).toBe("10480.00");
    // Day start resets to Tuesday 00:00 UTC cash: 10980
    expect(metrics.dayStartEquityUsdt.toFixed(2)).toBe("10980.00");
    // Week start remains Monday 00:00 UTC cash: 10000
    expect(metrics.weekStartEquityUsdt.toFixed(2)).toBe("10000.00");
    // HWM persists from Monday peak: 11000
    expect(metrics.highWaterMarkEquityUsdt.toFixed(2)).toBe("11000.00");
    // Fees today reset on Tuesday midnight: 0
    expect(metrics.feesTodayUsdt.toFixed(2)).toBe("0.00");
    // Drawdown = (11000 - 10480) / 11000 * 100 = 4.72%
    expect(metrics.drawdownPct.toFixed(2)).toBe("4.72");

    // Next Monday 00:00:00 UTC (week reset)
    const nextMondayMidnight = mondayMidnightMs + 7 * 86_400_000;
    metrics = store.ledgerRepo.getRiskMetrics({
      asOfMs: nextMondayMidnight,
      strategyId: "donchian-trend"
    });
    // Week start resets to 10480 at next Monday midnight
    expect(metrics.weekStartEquityUsdt.toFixed(2)).toBe("10480.00");
    expect(metrics.dayStartEquityUsdt.toFixed(2)).toBe("10480.00");
    expect(metrics.highWaterMarkEquityUsdt.toFixed(2)).toBe("11000.00");

    store.close();
  });

  it("remediates HWM minor: captures intra-period mark-to-market peaks in highWaterMarkEquityUsdt across evaluations", () => {
    const mondayMidnightMs = 1_700_438_400_000;
    const clock = new ManualClock(mondayMidnightMs);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });

    // Initial equity = 10,000 cash
    const t1 = mondayMidnightMs + 1000;
    // At t1, open position has +2000 MTM unrealized PnL -> MTM Equity = 12,000
    const m1 = store.ledgerRepo.getRiskMetrics({
      asOfMs: t1,
      strategyId: "donchian-trend",
      openUnrealizedPnlUsdt: ScaledDecimal.fromString("2000.00")
    });
    expect(m1.currentEquityUsdt.toFixed(2)).toBe("12000.00");
    expect(m1.highWaterMarkEquityUsdt.toFixed(2)).toBe("12000.00");
    expect(m1.drawdownPct.toFixed(2)).toBe("0.00");

    // At t2, market pulls back and unrealized PnL drops to +500 -> MTM Equity = 10,500
    const t2 = mondayMidnightMs + 2000;
    const m2 = store.ledgerRepo.getRiskMetrics({
      asOfMs: t2,
      strategyId: "donchian-trend",
      openUnrealizedPnlUsdt: ScaledDecimal.fromString("500.00")
    });
    expect(m2.currentEquityUsdt.toFixed(2)).toBe("10500.00");
    // HWM must NOT be reset to current equity 10,500; it must preserve the intra-period peak of 12,000!
    expect(m2.highWaterMarkEquityUsdt.toFixed(2)).toBe("12000.00");
    // Drawdown = (12000 - 10500) / 12000 = 12.50%
    expect(m2.drawdownPct.toFixed(2)).toBe("12.50");

    store.close();
  });

  it("strictly segregates strategy-level and portfolio-level HWM snapshots without cross-contamination", () => {
    const mondayMidnightMs = 1_700_438_400_000;
    const clock = new ManualClock(mondayMidnightMs);
    const store = createSqliteDataStore({
      dbPath: ":memory:",
      clock,
      initialPaperCapitalUsdt: "100000.00000000"
    });

    // Portfolio level has 100,000 cash
    const t1 = mondayMidnightMs + 1000;
    const portfolioMetrics = store.ledgerRepo.getRiskMetrics({
      asOfMs: t1,
      strategyId: null
    });
    expect(portfolioMetrics.currentEquityUsdt.toFixed(2)).toBe("100000.00");
    expect(portfolioMetrics.highWaterMarkEquityUsdt.toFixed(2)).toBe("100000.00");

    // Strategy A has 1,000 unrealized PnL
    const stratMetrics = store.ledgerRepo.getRiskMetrics({
      asOfMs: t1 + 500,
      strategyId: "strategy-A",
      openUnrealizedPnlUsdt: ScaledDecimal.fromString("1000.00")
    });
    expect(stratMetrics.currentEquityUsdt.toFixed(2)).toBe("101000.00");

    // Strategy A equity is 101,000 (100k cash + 1k upl), but if strategyId is specified,
    // its snapshots must NOT pull portfolio snapshots and vice versa.
    // Specifically, if Strategy A's own equity pulls back:
    const stratPullback = store.ledgerRepo.getRiskMetrics({
      asOfMs: t1 + 1000,
      strategyId: "strategy-A",
      openUnrealizedPnlUsdt: ScaledDecimal.zero()
    });
    // Strategy A HWM is 101,000 (its own peak at t1+500), NOT portfolio's snapshot
    expect(stratPullback.highWaterMarkEquityUsdt.toFixed(2)).toBe("101000.00");
    expect(stratPullback.currentEquityUsdt.toFixed(2)).toBe("100000.00");
    // Drawdown = (101000 - 100000) / 101000 = 0.99% (NOT ~90%!)
    expect(stratPullback.drawdownPct.toFixed(2)).toBe("0.99");

    store.close();
  });
});
