import { describe, expect, it } from "vitest";
import { ManualClock, ScaledDecimal, type PaperPositionRecord } from "@keel/core";
import { createSqliteDataStore } from "../src/index.js";

const position: PaperPositionRecord = {
  positionId: "pos_exchange_1",
  strategyId: "donchian-trend-v1",
  instrumentId: "BTC-USDT-SWAP",
  side: "long",
  contracts: "1",
  entryPrice: "50000",
  protectiveStopPrice: "48500",
  takeProfitPrice: null,
  initialRiskUsdt: "15.00",
  unrealizedPnlUsdt: "0.00000000",
  realizedPnlUsdt: "0.00000000",
  feesPaidUsdt: "0.30000000",
  fundingPaidUsdt: "0.00000000",
  openedAtMs: 1_750_000_000_000,
  lastFundingSettledTs: 1_750_000_000_000,
  status: "OPEN",
  closedAtMs: null,
  exitPrice: null,
  exitReason: null
};

describe("Exchange and paper books are separate ledgers (audit-3 C2)", () => {
  it("keeps exchange positions out of the paper account and vice versa", () => {
    const store = createSqliteDataStore({ dbPath: ":memory:", clock: new ManualClock(0) });

    store.exchangeAccountRepo.savePosition(position);

    expect(store.paperAccountRepo.listOpenPositions()).toHaveLength(0);
    expect(store.exchangeAccountRepo.listOpenPositions()).toHaveLength(1);
  });

  it("posts exchange journals to the exchange ledger only", () => {
    const store = createSqliteDataStore({ dbPath: ":memory:", clock: new ManualClock(0) });
    const paperBefore = store.ledgerRepo.getTrialBalance();

    store.exchangeLedgerRepo.recordJournal({
      txGroupId: "open-pos_exchange_1",
      ts: 1,
      strategyId: "donchian-trend-v1",
      instrumentId: "BTC-USDT-SWAP",
      debitAccount: "fees_expense:usdt",
      creditAccount: "cash:usdt",
      amountUsdt: "0.30000000",
      description: "Entry execution fee"
    });

    expect(store.ledgerRepo.getTrialBalance()).toEqual(paperBefore);
    expect(store.exchangeLedgerRepo.getTrialBalance().feesExpenseUsdt).toBe("0.30000000");
  });

  it("shares one circuit breaker so a Kill Switch stops both books", () => {
    const store = createSqliteDataStore({ dbPath: ":memory:", clock: new ManualClock(0) });

    store.paperAccountRepo.setCircuitBreaker({
      status: "MANUAL_KILL_SWITCH",
      reason: "drill",
      triggeredAtMs: 1,
      cooldownUntilMs: null,
      updatedBy: "operator"
    });

    expect(store.exchangeAccountRepo.getCircuitBreaker().status).toBe("MANUAL_KILL_SWITCH");
  });
});

describe("Venue capital rebase starts a new equity baseline", () => {
  it("rebases the Venue Book to the venue balance and resets the high-water mark and period starts", () => {
    const clock = new ManualClock(1_750_000_000_000);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });
    const ledger = store.exchangeLedgerRepo;
    const asOfMs = clock.nowMs();

    const rebase = ledger.rebaseCapital({
      ts: asOfMs,
      targetEquityUsdt: ScaledDecimal.fromString("5000"),
      description: "Rebase to OKX balance"
    });

    expect(rebase?.amountUsdt).toBe("5000.00000000");
    const metrics = ledger.getRiskMetrics({ asOfMs });
    expect(metrics.currentEquityUsdt.toFixed(2)).toBe("5000.00");
    expect(metrics.highWaterMarkEquityUsdt.toFixed(2)).toBe("5000.00");
    expect(metrics.dayStartEquityUsdt.toFixed(2)).toBe("5000.00");
    expect(metrics.weekStartEquityUsdt.toFixed(2)).toBe("5000.00");
    expect(metrics.drawdownPct.toFixed(2)).toBe("0.00");
    expect(store.ledgerRepo.getRiskMetrics({ asOfMs }).currentEquityUsdt.toFixed(2)).toBe(
      "10000.00"
    );
  });

  it("posts nothing when the book already matches the target", () => {
    const store = createSqliteDataStore({ dbPath: ":memory:", clock: new ManualClock(0) });

    expect(
      store.exchangeLedgerRepo.rebaseCapital({
        ts: 1,
        targetEquityUsdt: ScaledDecimal.fromString("10000"),
        description: "No-op rebase"
      })
    ).toBeNull();
  });
});
