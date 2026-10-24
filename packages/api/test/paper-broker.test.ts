import { describe, expect, it } from "vitest";
import { ManualClock, createDefaultConfig, type ConfirmedBar } from "@keel/core";
import { createSqliteDataStore } from "@keel/data";
import { DonchianTrendStrategy } from "@keel/strategy";
import { PaperBroker } from "../src/paper-broker.js";

function makeBar(overrides?: Partial<ConfirmedBar>): ConfirmedBar {
  return {
    instrumentId: "BTC-USDT-SWAP",
    timeframe: "1H",
    openTs: 1_700_000_000_000,
    closeTs: 1_700_003_600_000,
    open: "50000.00",
    high: "50500.00",
    low: "49800.00",
    close: "50200.00",
    volumeContracts: "100.00",
    volumeQuote: "5000000.00",
    confirm: "1",
    ...overrides
  };
}

describe("PaperBroker (ADR-0006)", () => {
  it("enforces attached protectiveStopPrice on open orders and executes entries into double-entry ledger", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });
    const config = createDefaultConfig();

    const broker = new PaperBroker({
      clock,
      ledgerRepo: store.ledgerRepo,
      paperAccountRepo: store.paperAccountRepo,
      getRiskConfig: () => config.risk
    });

    const strategy = new DonchianTrendStrategy({ channelLength: 5 });
    // Seed 8 prior bars to satisfy Donchian lookback
    const historyBars: ConfirmedBar[] = [];
    for (let i = 0; i < 8; i++) {
      historyBars.push(
        makeBar({
          openTs: 1_700_000_000_000 + i * 3600_000,
          closeTs: 1_700_000_000_000 + (i + 1) * 3600_000,
          high: String(49000 + i * 200),
          low: String(48500 + i * 200),
          close: String(49100 + i * 200)
        })
      );
    }

    const currentBar = historyBars[historyBars.length - 1];
    if (!currentBar) throw new Error("Expected currentBar");
    const result = broker.executeConfirmedBarTick({
      bar: currentBar,
      strategy,
      featureBars: { "1H": historyBars }
    });

    expect(result.positionsOpened.length).toBeGreaterThanOrEqual(1);
    const opened = result.positionsOpened[0];
    if (!opened) throw new Error("Expected opened position");
    expect(opened.protectiveStopPrice).toBeDefined();
    expect(Number(opened.protectiveStopPrice)).toBeLessThan(Number(opened.entryPrice));

    // Ledger balance must remain balanced after entry fee
    const tb = store.ledgerRepo.getTrialBalance();
    expect(tb.isBalanced).toBe(true);
    expect(Number(tb.feesExpenseUsdt)).toBeGreaterThan(0);

    store.close();
  });

  it("conservatively executes protective stop when intrabar low hits stopPrice", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });
    const config = createDefaultConfig();

    const broker = new PaperBroker({
      clock,
      ledgerRepo: store.ledgerRepo,
      paperAccountRepo: store.paperAccountRepo,
      getRiskConfig: () => config.risk
    });

    // Manually plant an open long position
    store.paperAccountRepo.savePosition({
      positionId: "pos-test-1",
      strategyId: "donchian-trend",
      instrumentId: "BTC-USDT-SWAP",
      side: "long",
      contracts: "1.00000000",
      entryPrice: "50000.00000000",
      protectiveStopPrice: "49000.00000000",
      takeProfitPrice: "53000.00000000",
      initialRiskUsdt: "10.00000000",
      unrealizedPnlUsdt: "0.00000000",
      realizedPnlUsdt: "0.00000000",
      feesPaidUsdt: "0.50000000",
      fundingPaidUsdt: "0.00000000",
      openedAtMs: 1_700_000_000_000,
      lastFundingSettledTs: 1_700_000_000_000,
      status: "OPEN",
      closedAtMs: null,
      exitPrice: null,
      exitReason: null
    });

    // Confirmed bar whose low breaches 49000
    const breachBar = makeBar({
      open: "49500.00",
      high: "49800.00",
      low: "48900.00",
      close: "49200.00"
    });

    const tickResult = broker.executeConfirmedBarTick({ bar: breachBar });
    expect(tickResult.positionsClosed).toHaveLength(1);
    const closed = tickResult.positionsClosed[0];
    if (!closed) throw new Error("Expected closed position");
    expect(closed.status).toBe("CLOSED");
    expect(closed.exitReason).toBe("protective_stop");
    expect(closed.exitPrice).toBe("49000.00000000");

    const tb = store.ledgerRepo.getTrialBalance();
    expect(tb.isBalanced).toBe(true);

    store.close();
  });

  it("supports flattenAllPositions and circuit breaker updates", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });
    const config = createDefaultConfig();

    const broker = new PaperBroker({
      clock,
      ledgerRepo: store.ledgerRepo,
      paperAccountRepo: store.paperAccountRepo,
      getRiskConfig: () => config.risk
    });

    store.paperAccountRepo.savePosition({
      positionId: "pos-emergency",
      strategyId: "donchian-trend",
      instrumentId: "BTC-USDT-SWAP",
      side: "long",
      contracts: "2.00000000",
      entryPrice: "50000.00000000",
      protectiveStopPrice: "48500.00000000",
      takeProfitPrice: null,
      initialRiskUsdt: "30.00000000",
      unrealizedPnlUsdt: "0.00000000",
      realizedPnlUsdt: "0.00000000",
      feesPaidUsdt: "1.00000000",
      fundingPaidUsdt: "0.00000000",
      openedAtMs: 1_700_000_000_000,
      lastFundingSettledTs: 1_700_000_000_000,
      status: "OPEN",
      closedAtMs: null,
      exitPrice: null,
      exitReason: null
    });

    const flattened = broker.flattenAllPositions("manual emergency flatten");
    expect(flattened).toHaveLength(1);
    expect(broker.getOpenPositions()).toHaveLength(0);

    const cb = broker.setCircuitBreaker({
      status: "MANUAL_KILL_SWITCH",
      reason: "Emergency kill switch engaged by operator",
      triggeredAtMs: 1_700_000_005_000,
      cooldownUntilMs: null,
      updatedBy: "admin"
    });
    expect(cb.status).toBe("MANUAL_KILL_SWITCH");
    expect(broker.getCircuitBreaker().status).toBe("MANUAL_KILL_SWITCH");

    store.close();
  });
});
