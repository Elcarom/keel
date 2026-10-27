import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ManualClock,
  createDefaultConfig,
  type ExchangeBroker,
  type ExecutionMode
} from "@keel/core";
import { createSqliteDataStore } from "@keel/data";
import { UnattendedScheduler } from "../src/scheduler.js";
import { PaperBroker } from "../src/paper-broker.js";

function recordingExchangeBroker(calls: string[], nowMs: () => number): ExchangeBroker {
  const unused = () => {
    throw new Error("Not used in test");
  };
  return {
    sendDmsHeartbeat: async () => {
      calls.push("dms");
      return { ok: true, countdownSeconds: 60 };
    },
    reconcilePositions: async () => {
      calls.push("reconcile");
      return {
        asOfMs: nowMs(),
        matched: true,
        localPositionsCount: 0,
        exchangePositionsCount: 0,
        driftDetails: []
      };
    },
    getDmsStatus: () => ({
      enabled: true,
      timeoutSeconds: 60,
      lastHeartbeatAtMs: null,
      nextHeartbeatDueMs: null,
      healthy: false
    }),
    submitOrder: unused,
    amendAlgoOrder: unused,
    getCircuitBreaker: unused,
    setCircuitBreaker: unused,
    getOpenPositions: () => [],
    getAllPositions: () => [],
    getOrders: () => [],
    flattenAllPositions: async () => [],
    executeConfirmedBarTick: unused
  };
}

function buildScheduler(mode: ExecutionMode) {
  const clock = new ManualClock(1_730_000_000_000);
  const config = createDefaultConfig();
  config.system.executionMode = mode;
  const dataStore = createSqliteDataStore({ dbPath: ":memory:", clock, initialConfig: config });
  const paperBroker = new PaperBroker({
    clock,
    dataStore,
    getRiskConfig: () => config.risk,
    getSystemConfig: () => config.system,
    paperAccountRepo: dataStore.paperAccountRepo,
    ledgerRepo: dataStore.ledgerRepo
  });
  const calls: string[] = [];
  const scheduler = new UnattendedScheduler({
    clock,
    dataStore,
    paperBroker,
    exchangeBroker: recordingExchangeBroker(calls, () => clock.nowMs()),
    getRiskConfig: () => config.risk,
    getSystemConfig: () => config.system
  });
  return { scheduler, calls };
}

async function exchangeCallsInMode(mode: ExecutionMode): Promise<string[]> {
  const { scheduler, calls } = buildScheduler(mode);
  await scheduler.stepOnce();
  return calls;
}

describe("Scheduler protects every exchange Execution Mode (audit-3 H5)", () => {
  it("maintains the DMS heartbeat and reconciliation in Live-Ramp, not just Demo and Live", async () => {
    expect(await exchangeCallsInMode("Live-Ramp")).toEqual(["dms", "reconcile"]);
    expect(await exchangeCallsInMode("Paper")).toEqual([]);
  });
});

describe("Dead-Man's Switch heartbeat cadence (audit-3 H8)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("beats at least every 15s, independent of the 60s bar step, well inside the 60s countdown", async () => {
    vi.useFakeTimers();
    const { scheduler, calls } = buildScheduler("Demo");
    scheduler.start();
    try {
      // 45s elapse before the first 60s step tick would ever run
      await vi.advanceTimersByTimeAsync(45_000);
      expect(calls.filter((c) => c === "dms").length).toBeGreaterThanOrEqual(3);
    } finally {
      scheduler.stop();
    }
  });

  it("can beat without the bar-step scheduler running", async () => {
    vi.useFakeTimers();
    const { scheduler, calls } = buildScheduler("Live");
    scheduler.startHeartbeat();
    try {
      await vi.advanceTimersByTimeAsync(45_000);
      expect(scheduler.isRunning()).toBe(false);
      expect(calls.filter((c) => c === "dms").length).toBeGreaterThanOrEqual(3);
    } finally {
      scheduler.stop();
    }
  });

  it("does not beat in non-exchange Execution Modes", async () => {
    vi.useFakeTimers();
    const { scheduler, calls } = buildScheduler("Paper");
    scheduler.start();
    try {
      await vi.advanceTimersByTimeAsync(45_000);
      expect(calls).toEqual([]);
    } finally {
      scheduler.stop();
    }
  });
});
