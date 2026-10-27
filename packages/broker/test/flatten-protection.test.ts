import { describe, expect, it } from "vitest";
import { ManualClock, createDefaultConfig } from "@keel/core";
import { OkxBroker } from "../src/index.js";
import { createFakeOkx } from "./fake-okx.js";

const credentials = {
  apiKey: "test-api-key",
  secretKey: "test-secret-key-32-bytes-long-super-secret",
  passphrase: "test-passphrase"
};

function brokerOn(fake: ReturnType<typeof createFakeOkx>) {
  return new OkxBroker({
    clock: new ManualClock(1_750_000_000_000),
    getRiskConfig: () => createDefaultConfig().risk,
    getCredentials: () => credentials,
    isDemo: true,
    fetchFn: fake.fetchFn
  });
}

const entry = {
  instrumentId: "BTC-USDT-SWAP",
  side: "long" as const,
  sizeLots: 1,
  entryPrice: "50000",
  protectiveStopPrice: "48500"
};

describe("Emergency flatten never leaves a position without its Protective Stop (audit-3 C1)", () => {
  it("keeps the Protective Stop resting when the market close is rejected", async () => {
    const fake = createFakeOkx({ closeOrdersSucceed: false });
    const broker = brokerOn(fake);
    await broker.submitOrder(entry);
    expect(fake.pendingAlgos()).toHaveLength(1);

    await broker.flattenAllPositions("drill");

    expect(broker.getOpenPositions()).toHaveLength(1);
    expect(fake.pendingAlgos()).toHaveLength(1);
    expect(fake.calls("/api/v5/trade/cancel-algo-orders")).toHaveLength(0);
  });

  it("keeps the dead-man's switch armed while any position failed to close", async () => {
    const fake = createFakeOkx({ closeOrdersSucceed: false });
    const broker = brokerOn(fake);
    await broker.submitOrder(entry);

    await broker.flattenAllPositions("drill");

    const disarms = fake
      .calls("/api/v5/trade/cancel-all-after")
      .filter((r) => (r.body as { timeOut?: string }).timeOut === "0");
    expect(disarms).toHaveLength(0);
  });

  it("cancels the stop only after the close fill is confirmed, and only for that instrument", async () => {
    const fake = createFakeOkx();
    const broker = brokerOn(fake);
    await broker.submitOrder(entry);
    await broker.submitOrder({
      ...entry,
      instrumentId: "ETH-USDT-SWAP",
      entryPrice: "50000",
      protectiveStopPrice: "48500"
    });
    expect(fake.pendingAlgos()).toHaveLength(2);

    await broker.flattenAllPositions("drill");

    expect(broker.getOpenPositions()).toHaveLength(0);
    expect(fake.pendingAlgos()).toHaveLength(0);
    const paths = fake.requests.map((r) => r.path);
    const firstClose = fake.requests.findIndex(
      (r) => r.path === "/api/v5/trade/order" && (r.body as { reduceOnly?: boolean }).reduceOnly
    );
    const firstCancel = paths.indexOf("/api/v5/trade/cancel-algo-orders");
    expect(firstClose).toBeGreaterThanOrEqual(0);
    expect(firstCancel).toBeGreaterThan(firstClose);
    for (const cancel of fake.calls("/api/v5/trade/cancel-algo-orders")) {
      const instIds = new Set((cancel.body as Array<{ instId: string }>).map((c) => c.instId));
      expect(instIds.size).toBe(1);
    }
  });
});

describe("Closing one position never removes another position's Protective Stop (audit-3 review)", () => {
  it("keeps the stop of a second open position on the same instrument after a reduce-only close", async () => {
    const fake = createFakeOkx();
    const broker = brokerOn(fake);
    await broker.submitOrder({ ...entry, strategyId: "strategy-a", clOrdId: "entryA" });
    await broker.submitOrder({ ...entry, strategyId: "strategy-b", clOrdId: "entryB" });
    expect(fake.pendingAlgos()).toHaveLength(2);

    await broker.submitOrder({
      ...entry,
      side: "short",
      reduceOnly: true,
      strategyId: "strategy-a"
    });

    expect(broker.getOpenPositions()).toHaveLength(1);
    expect(fake.pendingAlgos().length).toBeGreaterThanOrEqual(1);
  });
});
