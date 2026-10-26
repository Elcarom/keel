import { describe, expect, it } from "vitest";
import { ManualClock, createDefaultConfig, type ConfirmedBar } from "@keel/core";
import { createSqliteDataStore } from "@keel/data";
import { DonchianTrendStrategy } from "@keel/strategy";
import { ReplayEngine } from "@keel/replay";
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

    const signalBar = historyBars[historyBars.length - 2];
    const currentBar = historyBars[historyBars.length - 1];
    if (!signalBar || !currentBar) throw new Error("Expected bars");
    // Bar 6 emits breakout proposal
    broker.executeConfirmedBarTick({
      bar: signalBar,
      strategy,
      featureBars: { "1H": historyBars.slice(0, -1) }
    });
    // Bar 7 executes proposal at next-bar open
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

  it("N1: ticks the same confirmed bar 4 times and asserts exactly one open position and zero spurious exits", () => {
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
    const historyBars: ConfirmedBar[] = [];
    for (let i = 0; i < 7; i++) {
      historyBars.push(
        makeBar({
          openTs: 1_700_000_000_000 + i * 3600_000,
          closeTs: 1_700_000_000_000 + (i + 1) * 3600_000,
          high: String(49000 + i * 100),
          low: String(48500 + i * 100),
          close: String(48900 + i * 100)
        })
      );
    }

    // Signal bar with breakout to trigger long, but a deep intra-bar low (40000) far below the stop price
    const signalBar = makeBar({
      openTs: 1_700_000_000_000 + 7 * 3600_000,
      closeTs: 1_700_000_000_000 + 8 * 3600_000,
      open: "49600.00",
      high: "52000.00",
      low: "40000.00",
      close: "51500.00"
    });
    historyBars.push(signalBar);

    // Tick signal bar: emits proposal for next bar
    broker.executeConfirmedBarTick({
      bar: signalBar,
      strategy,
      featureBars: { "1H": historyBars }
    });

    const execBar = makeBar({
      openTs: 1_700_000_000_000 + 8 * 3600_000,
      closeTs: 1_700_000_000_000 + 9 * 3600_000,
      open: "51600.00",
      high: "52000.00",
      low: "51200.00",
      close: "51800.00"
    });
    historyBars.push(execBar);

    // Tick the execution bar 4 times
    let totalOpened = 0;
    let totalClosed = 0;
    for (let tick = 0; tick < 4; tick++) {
      const res = broker.executeConfirmedBarTick({
        bar: execBar,
        strategy,
        featureBars: { "1H": historyBars }
      });
      totalOpened += res.positionsOpened.length;
      totalClosed += res.positionsClosed.length;
    }

    const openPositions = store.paperAccountRepo.listOpenPositions();
    const allPositions = store.paperAccountRepo.listAllPositions();

    // Must be idempotent: exactly 1 position opened, 0 spurious exits, exactly 1 open position
    expect(totalOpened).toBe(1);
    expect(totalClosed).toBe(0);
    expect(openPositions.length).toBe(1);
    expect(allPositions.length).toBe(1);

    store.close();
  });

  it("M-A: paper broker executes entries at next-bar open with slippage and stops with gap-aware fills", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });
    const config = createDefaultConfig();

    const broker = new PaperBroker({
      clock,
      ledgerRepo: store.ledgerRepo,
      paperAccountRepo: store.paperAccountRepo,
      getRiskConfig: () => config.risk,
      slippageBps: 10 // 10 bps slippage
    });

    const strategy = new DonchianTrendStrategy({ channelLength: 5 });
    const historyBars: ConfirmedBar[] = [];
    for (let i = 0; i < 7; i++) {
      historyBars.push(
        makeBar({
          openTs: 1_700_000_000_000 + i * 3600_000,
          closeTs: 1_700_000_000_000 + (i + 1) * 3600_000,
          high: String(49000 + i * 100),
          low: String(48500 + i * 100),
          close: String(48900 + i * 100)
        })
      );
    }

    // Bar 7: Breakout bar generates long proposal at close (51500)
    const signalBar = makeBar({
      openTs: 1_700_000_000_000 + 7 * 3600_000,
      closeTs: 1_700_000_000_000 + 8 * 3600_000,
      open: "49600.00",
      high: "52000.00",
      low: "49500.00",
      close: "51500.00"
    });
    historyBars.push(signalBar);

    // Tick signal bar: proposal is generated for next bar
    broker.executeConfirmedBarTick({
      bar: signalBar,
      strategy,
      featureBars: { "1H": historyBars }
    });

    // Bar 8: Execution bar opens at 52000.00.
    // Next-bar-open entry price with 10 bps slippage: 52000 * 1.0010 = 52052.00
    // Bar also has a normal trading range above stop
    const execBar = makeBar({
      openTs: 1_700_000_000_000 + 8 * 3600_000,
      closeTs: 1_700_000_000_000 + 9 * 3600_000,
      open: "52000.00",
      high: "52500.00",
      low: "51800.00",
      close: "52200.00"
    });
    historyBars.push(execBar);

    const tick2 = broker.executeConfirmedBarTick({
      bar: execBar,
      strategy,
      featureBars: { "1H": historyBars }
    });

    expect(tick2.positionsOpened.length).toBe(1);
    const opened = tick2.positionsOpened[0];
    if (!opened) throw new Error("Expected opened position");

    // Entry price must be next-bar-open with slippage: 52052.00 (not signal close 51500.00)
    expect(Number(opened.entryPrice)).toBeCloseTo(52052.0, 1);

    // Bar 9: Gap-down bar through stop price!
    // If stop was at ~50500, and bar gaps down opening at 48000, gap fill must be 48000 (not stop price 50500)
    const gapBar = makeBar({
      openTs: 1_700_000_000_000 + 9 * 3600_000,
      closeTs: 1_700_000_000_000 + 10 * 3600_000,
      open: "48000.00", // Gapped down far below stop
      high: "48500.00",
      low: "47500.00",
      close: "48200.00"
    });
    historyBars.push(gapBar);

    const tick3 = broker.executeConfirmedBarTick({
      bar: gapBar,
      strategy,
      featureBars: { "1H": historyBars }
    });

    expect(tick3.positionsClosed.length).toBe(1);
    const closed = tick3.positionsClosed[0];
    if (!closed) throw new Error("Expected closed position");

    // Exit price must be the gapped open price with adverse slippage (48000 - 48 = 47952)
    expect(Number(closed.exitPrice)).toBe(47952);
    expect(closed.exitReason).toBe("protective_stop");

    store.close();
  });

  it("M-A: achieves bit-for-bit fill price, contracts, and PnL parity between PaperBroker and ReplayEngine across identical confirmed bars", () => {
    const clock = new ManualClock(1_700_000_000_000);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });
    const config = createDefaultConfig();

    const slippageBps = 10;
    const paperBroker = new PaperBroker({
      clock,
      ledgerRepo: store.ledgerRepo,
      paperAccountRepo: store.paperAccountRepo,
      getRiskConfig: () => config.risk,
      slippageBps
    });

    const strategy = new DonchianTrendStrategy({ channelLength: 5 });
    const bars: ConfirmedBar[] = [];
    for (let i = 0; i < 7; i++) {
      bars.push(
        makeBar({
          openTs: 1_700_000_000_000 + i * 3600_000,
          closeTs: 1_700_000_000_000 + (i + 1) * 3600_000,
          high: String(49000 + i * 100),
          low: String(48500 + i * 100),
          close: String(48900 + i * 100)
        })
      );
    }

    // Bar 7: Breakout bar generates long proposal at close (51500)
    const signalBar = makeBar({
      openTs: 1_700_000_000_000 + 7 * 3600_000,
      closeTs: 1_700_000_000_000 + 8 * 3600_000,
      open: "49600.00",
      high: "52000.00",
      low: "49500.00",
      close: "51500.00"
    });
    bars.push(signalBar);

    // Bar 8: Execution bar opening at 52000.00
    const execBar = makeBar({
      openTs: 1_700_000_000_000 + 8 * 3600_000,
      closeTs: 1_700_000_000_000 + 9 * 3600_000,
      open: "52000.00",
      high: "52500.00",
      low: "51800.00",
      close: "52200.00"
    });
    bars.push(execBar);

    // Bar 9: Gap-down bar through stop price
    const gapBar = makeBar({
      openTs: 1_700_000_000_000 + 9 * 3600_000,
      closeTs: 1_700_000_000_000 + 10 * 3600_000,
      open: "48000.00",
      high: "48500.00",
      low: "47500.00",
      close: "48200.00"
    });
    bars.push(gapBar);

    // 1. Run ReplayEngine across these bars
    store.marketDataRepo.ingestOkxCandles({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      candles: bars.map((b) => ({
        openTs: b.openTs,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volumeContracts: b.volumeContracts,
        volumeQuote: b.volumeQuote,
        confirm: "1"
      }))
    });

    const replayEngine = new ReplayEngine({
      marketDataRepo: store.marketDataRepo,
      experimentRepo: store.experimentRepo
    });

    const replayResult = replayEngine.run({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      strategy,
      fromTs: bars[0]?.openTs ?? 0,
      toTs: bars[bars.length - 1]?.closeTs ?? 0,
      slippageBps
    });

    expect(replayResult.trades.length).toBe(1);
    const replayTrade = replayResult.trades[0];
    if (!replayTrade) throw new Error("Expected replay trade");

    // 2. Step PaperBroker bar-by-bar across the exact same bars
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (!b) continue;
      paperBroker.executeConfirmedBarTick({
        bar: b,
        strategy,
        featureBars: { "1H": bars.slice(0, i + 1) }
      });
    }

    const paperPositions = store.paperAccountRepo.listAllPositions();
    const paperClosed = paperPositions.find((p) => p.status === "CLOSED");
    expect(paperClosed).toBeDefined();
    if (!paperClosed) throw new Error("Expected closed paper position");

    // 3. Parity Assertions: bit-for-bit identical fill price, stop exit, contracts, and gross PnL
    expect(paperClosed.entryPrice).toBe(replayTrade.entryPrice.toFixed(8));
    expect(paperClosed.exitPrice).toBe(replayTrade.exitPrice.toFixed(8));
    expect(paperClosed.contracts).toBe(replayTrade.contracts.toFixed(8));
    expect(paperClosed.realizedPnlUsdt).toBe(replayTrade.grossPnlUsdt.toFixed(8));

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
    expect(closed.exitPrice).toBe("48985.30000000");

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

  it("persists day-start equity and HWM from ledger, tripping daily loss halt when intraday loss exceeds dailyLossStopPct (C2)", () => {
    // UTC timestamp: 1700006400000 is 2023-11-14 24:00:00 (midnight UTC)
    const midnightUtcMs = 1_700_006_400_000;
    const clock = new ManualClock(midnightUtcMs + 3_600_000); // 01:00 UTC
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });
    const config = createDefaultConfig();
    // Daily loss stop = 3%
    config.risk.portfolio.dailyLossStopPct = 5.0;
    config.risk.strategy.dailyLossStopPct = 3.0;

    const broker = new PaperBroker({
      clock,
      ledgerRepo: store.ledgerRepo,
      paperAccountRepo: store.paperAccountRepo,
      getRiskConfig: () => config.risk
    });

    const strategy = new DonchianTrendStrategy({ channelLength: 5 });

    // 1. Initial ledger journal has 10,000 USDT at midnight
    // Now simulate an intraday realized loss of 400 USDT (4% loss vs 10,000 day start)
    store.ledgerRepo.recordJournal({
      txGroupId: "tx-intraday-loss",
      ts: clock.nowMs(),
      strategyId: strategy.strategyId,
      instrumentId: "BTC-USDT-SWAP",
      debitAccount: "realized_pnl:usdt",
      creditAccount: "cash:usdt",
      amountUsdt: "400.00000000",
      description: "Loss from closed trade"
    });
    const historyBars: ConfirmedBar[] = [];
    for (let i = 0; i < 8; i++) {
      historyBars.push(
        makeBar({
          openTs: clock.nowMs() - (8 - i) * 3600_000,
          closeTs: clock.nowMs() - (7 - i) * 3600_000,
          high: String(49000 + i * 200),
          low: String(48500 + i * 200),
          close: String(49100 + i * 200)
        })
      );
    }
    const currentBar = historyBars.at(-1);
    expect(currentBar).toBeDefined();
    if (!currentBar) throw new Error("Bar missing");

    const result = broker.executeConfirmedBarTick({
      bar: currentBar,
      strategy,
      featureBars: { "1H": historyBars }
    });

    // With persistent dayStartEquity = 10,000, 400 loss (4% > 3%) MUST trigger DAILY_LOSS_HALT veto!
    expect(result.positionsOpened).toHaveLength(0);
    expect(result.vetoedProposals.length).toBeGreaterThanOrEqual(1);
    expect(result.vetoedProposals[0]?.reason).toContain("breached daily loss stop");
    expect(broker.getCircuitBreaker().status).toBe("DAILY_LOSS_HALT");

    store.close();
  });
});
