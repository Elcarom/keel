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
});
