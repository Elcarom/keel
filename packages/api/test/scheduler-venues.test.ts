import { describe, expect, it } from "vitest";
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

async function exchangeCallsInMode(mode: ExecutionMode): Promise<string[]> {
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
  await scheduler.stepOnce();
  return calls;
}

describe("Scheduler protects every exchange Execution Mode (audit-3 H5)", () => {
  it("maintains the DMS heartbeat and reconciliation in Live-Ramp, not just Demo and Live", async () => {
    expect(await exchangeCallsInMode("Live-Ramp")).toEqual(["dms", "reconcile"]);
    expect(await exchangeCallsInMode("Paper")).toEqual([]);
  });
});
