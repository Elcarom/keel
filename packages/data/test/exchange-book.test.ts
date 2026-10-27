import { describe, expect, it } from "vitest";
import { ManualClock, type PaperPositionRecord } from "@keel/core";
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
