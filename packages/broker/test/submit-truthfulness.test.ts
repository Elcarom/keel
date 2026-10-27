import { describe, expect, it } from "vitest";
import { ManualClock, createDefaultConfig } from "@keel/core";
import { OkxBroker } from "../src/index.js";
import { createFakeOkx } from "./fake-okx.js";

const credentials = {
  apiKey: "test-api-key",
  secretKey: "test-secret-key-32-bytes-long-super-secret",
  passphrase: "test-passphrase"
};

function brokerOn(fake: ReturnType<typeof createFakeOkx>, withCreds = true) {
  return new OkxBroker({
    clock: new ManualClock(1_750_000_000_000),
    getRiskConfig: () => createDefaultConfig().risk,
    getCredentials: () => (withCreds ? credentials : null),
    isDemo: true,
    fetchFn: fake.fetchFn
  });
}

const entry = {
  instrumentId: "BTC-USDT-SWAP",
  side: "long" as const,
  sizeLots: 1,
  entryPrice: "49990",
  protectiveStopPrice: "48500"
};

const orderPosts = (fake: ReturnType<typeof createFakeOkx>) =>
  fake.requests.filter((r) => r.path === "/api/v5/trade/order" && r.method === "POST");

describe("Reduce-only orders close an existing position (audit-3 H6)", () => {
  it("rejects a reduce-only order when no opposite open position exists, without touching the exchange", async () => {
    const fake = createFakeOkx();
    const broker = brokerOn(fake);

    await expect(
      broker.submitOrder({ ...entry, side: "short", reduceOnly: true, protectiveStopPrice: "" })
    ).rejects.toThrow(/no open long position/i);

    expect(orderPosts(fake)).toHaveLength(0);
    expect(broker.getOpenPositions()).toHaveLength(0);
  });

  it("closes the matching position without a stop, opens no phantom position, and cancels its stop", async () => {
    const fake = createFakeOkx();
    const broker = brokerOn(fake);
    await broker.submitOrder(entry);

    const result = await broker.submitOrder({
      instrumentId: "BTC-USDT-SWAP",
      side: "short",
      sizeLots: 1,
      entryPrice: "49000",
      reduceOnly: true
    });

    expect(result.status).toBe("FILLED");
    expect(broker.getOpenPositions()).toHaveLength(0);
    const closeOrder = orderPosts(fake)[1]?.body as Record<string, unknown>;
    expect(closeOrder["reduceOnly"]).toBe(true);
    expect(closeOrder["attachAlgoOrds"]).toBeUndefined();
    expect(fake.pendingAlgos()).toHaveLength(0);
  });

  it("rejects a partial reduce-only size rather than guessing at stop resizing", async () => {
    const fake = createFakeOkx();
    const broker = brokerOn(fake);
    await broker.submitOrder({ ...entry, sizeLots: 2 });

    await expect(
      broker.submitOrder({ ...entry, side: "short", sizeLots: 1, reduceOnly: true })
    ).rejects.toThrow(/full position/i);
    expect(broker.getOpenPositions()).toHaveLength(1);
  });
});

describe("Exchange broker never fabricates fills (audit-3 H7)", () => {
  it("refuses to submit when exchange credentials are not configured", async () => {
    const fake = createFakeOkx();
    const broker = brokerOn(fake, false);

    await expect(broker.submitOrder(entry)).rejects.toThrow(/credentials/i);
    expect(broker.getOpenPositions()).toHaveLength(0);
    expect(broker.getOrders()).toHaveLength(0);
  });

  it("records the order at the confirmed exchange fill, not the requested price", async () => {
    const fake = createFakeOkx();
    const broker = brokerOn(fake);

    await broker.submitOrder(entry);

    const [order] = broker.getOrders();
    expect(order?.fillPrice).toBe("50000");
    expect(order?.status).toBe("FILLED");
    expect(broker.getOpenPositions()[0]?.entryPrice).toBe("50000");
  });
});
