import { describe, expect, it } from "vitest";
import {
  ManualClock,
  createDefaultConfig,
  type CircuitBreakerRecord,
  type ExchangeBroker
} from "@keel/core";
import { createSqliteDataStore, OkxPublicIngestor } from "@keel/data";
import { UnattendedScheduler } from "../src/scheduler.js";
import { PaperBroker } from "../src/paper-broker.js";

describe("Unattended Ingest & Tick Scheduler (M7)", () => {
  it("ingests newly confirmed bars and triggers strategy ticks autonomously", async () => {
    const clock = new ManualClock(1_730_000_000_000);
    const config = createDefaultConfig();
    const dataStore = createSqliteDataStore({
      dbPath: ":memory:",
      clock,
      initialConfig: config
    });

    const paperBroker = new PaperBroker({
      clock,
      dataStore,
      getRiskConfig: () => config.risk,
      getSystemConfig: () => config.system,
      paperAccountRepo: dataStore.paperAccountRepo,
      ledgerRepo: dataStore.ledgerRepo
    });

    // Seed mock confirmed bars returned by OkxPublicIngestor
    let ingestedCount = 0;
    const ingestor = new OkxPublicIngestor({
      marketDataRepo: dataStore.marketDataRepo,
      fetchHistoryCandles: async ({ fromOpenTs }) => {
        ingestedCount++;
        return [
          {
            openTs: fromOpenTs,
            open: "50000.00",
            high: "51000.00",
            low: "49500.00",
            close: "50500.00",
            volumeContracts: "100",
            volumeQuote: "5050000.00",
            confirm: "1" // Confirmed bar only!
          }
        ];
      }
    });

    const scheduler = new UnattendedScheduler({
      clock,
      dataStore,
      paperBroker,
      ingestor,
      getRiskConfig: () => config.risk,
      getSystemConfig: () => config.system,
      instruments: ["BTC-USDT-SWAP"],
      strategies: ["donchian-trend-v1"]
    });

    // Step the scheduler once
    const stepResult = await scheduler.stepOnce();

    expect(stepResult.ok).toBe(true);
    expect(stepResult.barsIngested).toBeGreaterThanOrEqual(1);
    expect(stepResult.ticksExecuted).toBeGreaterThanOrEqual(1);
    expect(ingestedCount).toBeGreaterThanOrEqual(1);

    // Verify bar was recorded in marketDataRepo
    const latestBars = dataStore.marketDataRepo.getConfirmedBarsAsOf({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      asOfMs: clock.nowMs(),
      limit: 1
    });
    const latest = latestBars[0] ?? null;
    expect(latest).not.toBeNull();
    expect(latest?.confirm).toBe("1");

    // Verify tick was audited in auditRepo
    const auditEntries = dataStore.auditRepo.listRecent(50);
    const tickAudit = auditEntries.find((a) => a.action === "scheduler.unattended_tick");
    expect(tickAudit).toBeDefined();
    expect(tickAudit?.details?.["instrumentId"]).toBe("BTC-USDT-SWAP");
  });

  it("handles start and stop lifecycle cleanly without hanging", async () => {
    const clock = new ManualClock(1_730_000_000_000);
    const config = createDefaultConfig();
    const dataStore = createSqliteDataStore({
      dbPath: ":memory:",
      clock,
      initialConfig: config
    });

    const paperBroker = new PaperBroker({
      clock,
      dataStore,
      getRiskConfig: () => config.risk,
      getSystemConfig: () => config.system,
      paperAccountRepo: dataStore.paperAccountRepo,
      ledgerRepo: dataStore.ledgerRepo
    });

    const scheduler = new UnattendedScheduler({
      clock,
      dataStore,
      paperBroker,
      getRiskConfig: () => config.risk,
      getSystemConfig: () => config.system,
      intervalMs: 10_000
    });

    expect(scheduler.isRunning()).toBe(false);
    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });

  it("maintains DMS heartbeats and exchange reconciliation in Demo execution mode", async () => {
    const clock = new ManualClock(1_730_000_000_000);
    const config = createDefaultConfig();
    config.system.executionMode = "Demo";

    const dataStore = createSqliteDataStore({
      dbPath: ":memory:",
      clock,
      initialConfig: config
    });

    const paperBroker = new PaperBroker({
      clock,
      dataStore,
      getRiskConfig: () => config.risk,
      getSystemConfig: () => config.system,
      paperAccountRepo: dataStore.paperAccountRepo,
      ledgerRepo: dataStore.ledgerRepo
    });

    let dmsCalled = false;
    let reconcileCalled = false;

    const mockExchangeBroker: ExchangeBroker = {
      sendDmsHeartbeat: async () => {
        dmsCalled = true;
        return { ok: true, countdownSeconds: 60 };
      },
      reconcilePositions: async () => {
        reconcileCalled = true;
        return {
          asOfMs: clock.nowMs(),
          matched: true,
          localPositionsCount: 0,
          exchangePositionsCount: 0,
          driftDetails: []
        };
      },
      getDmsStatus: () => ({
        enabled: true,
        timeoutSeconds: 60,
        lastHeartbeatAtMs: clock.nowMs(),
        nextHeartbeatDueMs: clock.nowMs() + 15_000,
        healthy: true
      }),
      submitOrder: async () => {
        throw new Error("Not used in test");
      },
      amendAlgoOrder: async () => {
        throw new Error("Not used in test");
      },
      getCircuitBreaker: () => ({
        status: "NORMAL",
        reason: "Initial",
        triggeredAtMs: 0,
        cooldownUntilMs: null,
        updatedBy: "system"
      }),
      setCircuitBreaker: (cb: CircuitBreakerRecord) => cb,
      getOpenPositions: () => [],
      getAllPositions: () => [],
      getOrders: () => [],
      flattenAllPositions: async () => [],
      executeConfirmedBarTick: () => {
        throw new Error("Not used in test");
      }
    };

    const scheduler = new UnattendedScheduler({
      clock,
      dataStore,
      paperBroker,
      exchangeBroker: mockExchangeBroker,
      getRiskConfig: () => config.risk,
      getSystemConfig: () => config.system
    });

    const res = await scheduler.stepOnce();
    expect(res.ok).toBe(true);
    expect(dmsCalled).toBe(true);
    expect(reconcileCalled).toBe(true);
  });

  it("N1: scheduler steps repeatedly on the same confirmed bar idempotently without duplicating ticks", async () => {
    const clock = new ManualClock(1_730_000_000_000);
    const config = createDefaultConfig();
    const dataStore = createSqliteDataStore({
      dbPath: ":memory:",
      clock,
      initialConfig: config
    });

    const paperBroker = new PaperBroker({
      clock,
      dataStore,
      getRiskConfig: () => config.risk,
      getSystemConfig: () => config.system,
      paperAccountRepo: dataStore.paperAccountRepo,
      ledgerRepo: dataStore.ledgerRepo
    });

    const nowMs = clock.nowMs();
    const confirmedOpenTs = Math.floor(nowMs / 3600_000) * 3600_000 - 3600_000;

    const ingestor = new OkxPublicIngestor({
      marketDataRepo: dataStore.marketDataRepo,
      fetchHistoryCandles: async () => [
        {
          openTs: confirmedOpenTs,
          open: "50000.00",
          high: "51000.00",
          low: "49500.00",
          close: "50500.00",
          volumeContracts: "100",
          volumeQuote: "5050000.00",
          confirm: "1"
        }
      ]
    });

    const scheduler = new UnattendedScheduler({
      clock,
      dataStore,
      paperBroker,
      ingestor,
      getRiskConfig: () => config.risk,
      getSystemConfig: () => config.system,
      instruments: ["BTC-USDT-SWAP"],
      strategies: ["donchian-trend-v1"]
    });

    // Step 1: Newly confirmed bar is ingested and ticked
    const step1 = await scheduler.stepOnce();
    expect(step1.ok).toBe(true);
    expect(step1.barsIngested).toBeGreaterThanOrEqual(1);
    expect(step1.ticksExecuted).toBe(1);

    // Step 2-4: Exact same time / bar, must be idempotent no-op
    const step2 = await scheduler.stepOnce();
    expect(step2.ok).toBe(true);
    expect(step2.ticksExecuted).toBe(0);

    const step3 = await scheduler.stepOnce();
    expect(step3.ok).toBe(true);
    expect(step3.ticksExecuted).toBe(0);
  });

  it("R6: default scheduler strategy list is empty (explicit opt-in)", async () => {
    const clock = new ManualClock(1_730_000_000_000);
    const config = createDefaultConfig();
    const dataStore = createSqliteDataStore({
      dbPath: ":memory:",
      clock,
      initialConfig: config
    });

    const paperBroker = new PaperBroker({
      clock,
      dataStore,
      getRiskConfig: () => config.risk,
      getSystemConfig: () => config.system,
      paperAccountRepo: dataStore.paperAccountRepo,
      ledgerRepo: dataStore.ledgerRepo
    });

    const confirmedOpenTs = Math.floor(clock.nowMs() / 3600_000) * 3600_000 - 3600_000;
    dataStore.marketDataRepo.ingestOkxCandles({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      candles: [
        {
          openTs: confirmedOpenTs,
          open: "50000.00",
          high: "51000.00",
          low: "49000.00",
          close: "50500.00",
          volumeContracts: "10",
          volumeQuote: "505000.00",
          confirm: "1"
        }
      ]
    });

    // Do NOT specify strategies; default must be empty []
    const scheduler = new UnattendedScheduler({
      clock,
      dataStore,
      paperBroker,
      getRiskConfig: () => config.risk,
      getSystemConfig: () => config.system,
      instruments: ["BTC-USDT-SWAP"]
    });

    const res = await scheduler.stepOnce();
    expect(res.ok).toBe(true);
    // Explicit opt-in required: zero strategy ticks executed when strategies list is omitted
    expect(res.ticksExecuted).toBe(0);
  });

  it("R6: processes all unprocessed confirmed bars chronologically capped at 500 per step spanning missing bars", async () => {
    const startTs = 1_700_000_000_000;
    const clock = new ManualClock(startTs);
    const config = createDefaultConfig();
    const dataStore = createSqliteDataStore({
      dbPath: ":memory:",
      clock,
      initialConfig: config
    });

    const paperBroker = new PaperBroker({
      clock,
      dataStore,
      getRiskConfig: () => config.risk,
      getSystemConfig: () => config.system,
      paperAccountRepo: dataStore.paperAccountRepo,
      ledgerRepo: dataStore.ledgerRepo
    });

    // Seed 10 consecutive confirmed 1H bars
    const candles = [];
    for (let i = 0; i < 10; i++) {
      const openTs = startTs + i * 3600_000;
      candles.push({
        openTs,
        open: "50000.00",
        high: "51000.00",
        low: "49000.00",
        close: "50500.00",
        volumeContracts: "10",
        volumeQuote: "505000.00",
        confirm: "1" as const
      });
    }
    dataStore.marketDataRepo.ingestOkxCandles({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      candles
    });

    // Advance clock past all 10 bars
    clock.advanceMs(15 * 3600_000);

    const scheduler = new UnattendedScheduler({
      clock,
      dataStore,
      paperBroker,
      getRiskConfig: () => config.risk,
      getSystemConfig: () => config.system,
      instruments: ["BTC-USDT-SWAP"],
      strategies: ["donchian-trend-v1"]
    });

    // Step once: must process all 10 missing/unprocessed bars in chronological order!
    const step1 = await scheduler.stepOnce();
    expect(step1.ok).toBe(true);
    expect(step1.ticksExecuted).toBe(10);

    // Verify last processed bar is the 10th bar's closeTs
    const lastCloseTs = dataStore.paperAccountRepo.getLastProcessedBarCloseTs({
      instrumentId: "BTC-USDT-SWAP",
      strategyId: "donchian-trend-v1"
    });
    const lastCandle = candles[9];
    expect(lastCandle).toBeDefined();
    expect(lastCloseTs).toBe(lastCandle ? lastCandle.openTs + 3600_000 : -1);

    // Subsequent step with no new bars executed must execute 0 ticks
    const step2 = await scheduler.stepOnce();
    expect(step2.ok).toBe(true);
    expect(step2.ticksExecuted).toBe(0);
  });

  it("R6: caps processing at 500 unprocessed bars per step and resumes on subsequent step", async () => {
    const startTs = 1_700_000_000_000;
    const clock = new ManualClock(startTs);
    const config = createDefaultConfig();
    const dataStore = createSqliteDataStore({
      dbPath: ":memory:",
      clock,
      initialConfig: config
    });

    const paperBroker = new PaperBroker({
      clock,
      dataStore,
      getRiskConfig: () => config.risk,
      getSystemConfig: () => config.system,
      paperAccountRepo: dataStore.paperAccountRepo,
      ledgerRepo: dataStore.ledgerRepo
    });

    // Seed 505 consecutive confirmed 1H bars
    const totalBars = 505;
    const candles = [];
    for (let i = 0; i < totalBars; i++) {
      const openTs = startTs + i * 3600_000;
      candles.push({
        openTs,
        open: "50000.00",
        high: "51000.00",
        low: "49000.00",
        close: "50500.00",
        volumeContracts: "10",
        volumeQuote: "505000.00",
        confirm: "1" as const
      });
    }
    dataStore.marketDataRepo.ingestOkxCandles({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      candles
    });

    clock.advanceMs((totalBars + 5) * 3600_000);

    const scheduler = new UnattendedScheduler({
      clock,
      dataStore,
      paperBroker,
      getRiskConfig: () => config.risk,
      getSystemConfig: () => config.system,
      instruments: ["BTC-USDT-SWAP"],
      strategies: ["donchian-trend-v1"]
    });

    // Step 1: Must process exactly 500 bars (capped at 500)
    const step1 = await scheduler.stepOnce();
    expect(step1.ok).toBe(true);
    expect(step1.ticksExecuted).toBe(500);

    const midCloseTs = dataStore.paperAccountRepo.getLastProcessedBarCloseTs({
      instrumentId: "BTC-USDT-SWAP",
      strategyId: "donchian-trend-v1"
    });
    const midCandle = candles[499];
    expect(midCandle).toBeDefined();
    expect(midCloseTs).toBe(midCandle ? midCandle.openTs + 3600_000 : -1);

    // Step 2: Must process the remaining 5 bars (501 to 505)
    const step2 = await scheduler.stepOnce();
    expect(step2.ok).toBe(true);
    expect(step2.ticksExecuted).toBe(5);

    const finalCloseTs = dataStore.paperAccountRepo.getLastProcessedBarCloseTs({
      instrumentId: "BTC-USDT-SWAP",
      strategyId: "donchian-trend-v1"
    });
    const finalCandle = candles[504];
    expect(finalCandle).toBeDefined();
    expect(finalCloseTs).toBe(finalCandle ? finalCandle.openTs + 3600_000 : -1);
  });
});
