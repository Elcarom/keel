import { describe, expect, it } from "vitest";
import { ManualClock, createDefaultConfig } from "@keel/core";
import { OkxBroker, type OkxFetchFn } from "../src/index.js";
import { createFakeOkx } from "./fake-okx.js";

const credentials = {
  apiKey: "test-api-key",
  secretKey: "test-secret-key-32-bytes-long-super-secret",
  passphrase: "test-passphrase"
};

function brokerOn(fetchFn: OkxFetchFn, clock = new ManualClock(1_750_000_000_000)) {
  return new OkxBroker({
    clock,
    getRiskConfig: () => createDefaultConfig().risk,
    getCredentials: () => credentials,
    isDemo: true,
    fetchFn
  });
}

const entry = {
  instrumentId: "BTC-USDT-SWAP",
  side: "long" as const,
  sizeLots: 1,
  entryPrice: "50000",
  protectiveStopPrice: "48500"
};

const foreignCloses = (fake: ReturnType<typeof createFakeOkx>) =>
  fake.requests
    .filter((r) => r.path === "/api/v5/trade/order" && r.method === "POST")
    .map((r) => r.body as Record<string, unknown>)
    .filter((b) => String(b["clOrdId"]).startsWith("kflatEx"));

describe("Emergency flatten closes untracked venue positions on the correct side", () => {
  it("buys back an untracked short reported in long/short mode, where pos is unsigned", async () => {
    const fake = createFakeOkx({
      positions: [{ instId: "ETH-USDT-SWAP", pos: "3", posSide: "short" }]
    });
    const broker = brokerOn(fake.fetchFn);

    await broker.flattenAllPositions("Kill Switch");

    expect(foreignCloses(fake)).toEqual([
      expect.objectContaining({ instId: "ETH-USDT-SWAP", side: "buy", posSide: "short", sz: "3" })
    ]);
  });

  it("sells an untracked long reported in net mode by its signed pos", async () => {
    const fake = createFakeOkx({ positions: [{ instId: "ETH-USDT-SWAP", pos: "2" }] });
    const broker = brokerOn(fake.fetchFn);

    await broker.flattenAllPositions("Kill Switch");

    expect(foreignCloses(fake)).toEqual([
      expect.objectContaining({ instId: "ETH-USDT-SWAP", side: "sell", sz: "2" })
    ]);
  });

  it("does not treat a second tracked position on the same instrument as foreign", async () => {
    const fake = createFakeOkx({ positions: [{ instId: "BTC-USDT-SWAP", pos: "2" }] });
    const broker = brokerOn(fake.fetchFn);
    await broker.submitOrder({ ...entry, strategyId: "strategy-a", clOrdId: "entryA" });
    await broker.submitOrder({ ...entry, strategyId: "strategy-b", clOrdId: "entryB" });

    await broker.flattenAllPositions("Kill Switch");

    expect(foreignCloses(fake)).toHaveLength(0);
    expect(broker.getOpenPositions()).toHaveLength(0);
  });

  it("signs every flatten request with the time it is sent, not the time the flatten began", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const fake = createFakeOkx({
      positions: [
        { instId: "ETH-USDT-SWAP", pos: "1" },
        { instId: "SOL-USDT-SWAP", pos: "1" }
      ]
    });
    const sentAt: Array<{ signed: number; sent: number }> = [];
    const slowFetch: OkxFetchFn = async (url, init) => {
      clock.advanceMs(20_000);
      sentAt.push({
        signed: Date.parse(init.headers["OK-ACCESS-TIMESTAMP"] ?? ""),
        sent: clock.nowMs()
      });
      return fake.fetchFn(url, init);
    };
    const broker = brokerOn(slowFetch, clock);

    await broker.flattenAllPositions("Kill Switch");

    expect(sentAt.length).toBeGreaterThan(2);
    for (const { signed, sent } of sentAt) {
      expect(sent - signed).toBeLessThanOrEqual(20_000);
    }
  });
});
