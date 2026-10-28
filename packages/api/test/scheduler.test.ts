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

    // Strategy was enabled prior to the new confirmed bar
    dataStore.paperAccountRepo.setSchedulerAnchor({
      instrumentId: "BTC-USDT-SWAP",
      strategyId: "donchian-trend-v1",
      anchorCloseTs: 1_730_000_000_000 - 3600_000
    });

    // Seed mock confirmed bars returned by OkxPublicIngestor
    let ingestedCount = 0;
    const ingestor = new OkxPublicIngestor({
      marketDataRepo: dataStore.marketDataRepo,
      fetchHistoryCandles: async () => {
        ingestedCount++;
        return [
          {
            openTs: 1_730_000_000_000 - 3600_000,
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
      getVenueEquityUsdt: async () => {
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

    // Strategy was enabled prior to the confirmed bar
    dataStore.paperAccountRepo.setSchedulerAnchor({
      instrumentId: "BTC-USDT-SWAP",
      strategyId: "donchian-trend-v1",
      anchorCloseTs: confirmedOpenTs
    });

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

    // Strategy was enabled at startTs, accumulating a 10-bar backlog (C2)
    dataStore.paperAccountRepo.setSchedulerAnchor({
      instrumentId: "BTC-USDT-SWAP",
      strategyId: "donchian-trend-v1",
      anchorCloseTs: startTs
    });

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

    // Strategy was enabled at startTs, accumulating a 505-bar backlog (C2)
    dataStore.paperAccountRepo.setSchedulerAnchor({
      instrumentId: "BTC-USDT-SWAP",
      strategyId: "donchian-trend-v1",
      anchorCloseTs: startTs
    });

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

  it("C2: newly enabled (instrument, strategy) anchors at latest confirmed bar and excludes quarantined 2026 bars (zero ticks on 20,000 history bars)", async () => {
    // 20,000 hours is ~833 days (~2.28 years). Starting from 2024-01-01 (1_704_067_200_000)
    // spans well past 2026-01-01 (SEALED_2026_HOLDOUT_START_TS = 1_767_225_600_000)
    const startTs = 1_704_067_200_000;
    const totalBars = 20_000;
    const latestBarCloseTs = startTs + totalBars * 3600_000;

    // Clock is set after all 20,000 bars have been stored, but 10 days ahead so none are "live present"
    const clock = new ManualClock(latestBarCloseTs + 10 * 86_400_000);
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

    // Seed 20,000 confirmed bars in chunks using raw DB / bulk ingestion
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

    // Ingest in chunks of 5000
    for (let i = 0; i < totalBars; i += 5000) {
      dataStore.marketDataRepo.ingestOkxCandles({
        instrumentId: "BTC-USDT-SWAP",
        timeframe: "1H",
        candles: candles.slice(i, i + 5000)
      });
    }

    const scheduler = new UnattendedScheduler({
      clock,
      dataStore,
      paperBroker,
      getRiskConfig: () => config.risk,
      getSystemConfig: () => config.system,
      instruments: ["BTC-USDT-SWAP"],
      strategies: ["donchian-trend-v1"]
    });

    // On first step with a newly enabled strategy, it must anchor at the latest confirmed bar (latestBarCloseTs)
    // and execute ZERO ticks on the 20,000 historical bars
    const step1 = await scheduler.stepOnce();
    expect(step1.ok).toBe(true);
    expect(step1.ticksExecuted).toBe(0);

    // Verify anchor was stored in the scheduler_anchors table at floor(clock.nowMs()/1h)*1h (A1)
    const anchorCloseTs = dataStore.paperAccountRepo.getSchedulerAnchor({
      instrumentId: "BTC-USDT-SWAP",
      strategyId: "donchian-trend-v1"
    });
    expect(anchorCloseTs).toBe(Math.floor(clock.nowMs() / 3600_000) * 3600_000);

    // No paper trades or positions were opened on ancient history
    const allPositions = dataStore.paperAccountRepo.listAllPositions();
    expect(allPositions).toHaveLength(0);
  });

  it("A1: newly enabled strategy anchors to floor(clock.nowMs()/1h)*1h and never ticks 30-day stale gap bars", async () => {
    // Current time is 2025-01-31 12:34:56 UTC
    const nowMs = 1_738_326_896_000;
    const expectedAnchorCloseTs = Math.floor(nowMs / 3600_000) * 3600_000; // 2025-01-31 12:00:00 UTC
    const clock = new ManualClock(nowMs);
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

    // DB has stale stored bars ending 30 days ago (2025-01-01 12:00:00 UTC)
    const staleEndTs = expectedAnchorCloseTs - 30 * 24 * 3600_000;
    const staleCandles = [];
    for (let i = 0; i < 20; i++) {
      const openTs = staleEndTs - (20 - i) * 3600_000;
      staleCandles.push({
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
      candles: staleCandles
    });

    // Fake ingestor returns all 720 gap bars up to the bar before now
    const ingestor = new OkxPublicIngestor({
      marketDataRepo: dataStore.marketDataRepo,
      fetchHistoryCandles: async ({ fromOpenTs, toOpenTs }) => {
        const gapCandles = [];
        let cur = fromOpenTs;
        while (cur <= toOpenTs) {
          gapCandles.push({
            openTs: cur,
            open: "50000.00",
            high: "52000.00",
            low: "48000.00",
            close: "51000.00",
            volumeContracts: "10",
            volumeQuote: "510000.00",
            confirm: "1" as const
          });
          cur += 3600_000;
        }
        return gapCandles;
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

    // Step once on newly enabled strategy:
    // It must anchor to expectedAnchorCloseTs and execute 0 ticks on the 720 gap bars!
    const step1 = await scheduler.stepOnce();
    expect(step1.ok).toBe(true);
    expect(step1.barsIngested).toBeGreaterThanOrEqual(700);
    expect(step1.ticksExecuted).toBe(0);

    const anchor = dataStore.paperAccountRepo.getSchedulerAnchor({
      instrumentId: "BTC-USDT-SWAP",
      strategyId: "donchian-trend-v1"
    });
    expect(anchor).toBe(expectedAnchorCloseTs);

    const positionsAfterGap = dataStore.paperAccountRepo.listAllPositions();
    expect(positionsAfterGap).toHaveLength(0);

    // Now advance clock past the next bar close (2025-01-31 13:00:00 UTC)
    clock.advanceMs(3600_000);
    // Ingestor returns 1 newly closed bar closing at expectedAnchorCloseTs + 3600_000
    const step2 = await scheduler.stepOnce();
    expect(step2.ok).toBe(true);
    expect(step2.ticksExecuted).toBe(1);
  });
});
