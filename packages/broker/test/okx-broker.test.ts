import { describe, expect, it } from "vitest";
import { ManualClock, createDefaultConfig } from "@keel/core";
import { OkxBroker, buildOkxHeaders } from "../src/index.js";

describe("OkxBroker & Attached Protective Stops (M5)", () => {
  const credentials = {
    apiKey: "test-api-key",
    secretKey: "test-secret-key-32-bytes-long-super-secret",
    passphrase: "test-passphrase"
  };

  it("builds valid HMAC-SHA256 signature headers for OKX V5 REST requests", () => {
    const headers = buildOkxHeaders({
      method: "POST",
      path: "/api/v5/trade/order",
      body: JSON.stringify({ instId: "BTC-USDT-SWAP" }),
      credentials,
      timestampIso: "2026-10-24T12:00:00.000Z",
      isDemo: true
    });

    expect(headers["OK-ACCESS-KEY"]).toBe("test-api-key");
    expect(headers["OK-ACCESS-PASSPHRASE"]).toBe("test-passphrase");
    expect(headers["OK-ACCESS-TIMESTAMP"]).toBe("2026-10-24T12:00:00.000Z");
    expect(headers["OK-ACCESS-SIGN"]).toBeDefined();
    expect(headers["OK-ACCESS-SIGN"]?.length).toBeGreaterThan(20);
    expect(headers["x-simulated-trading"]).toBe("1");
  });

  it("strictly rejects entry orders missing protective stop per ADR-0006", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();
    const broker = new OkxBroker({
      clock,
      getRiskConfig: () => config.risk,
      getCredentials: () => credentials,
      isDemo: true
    });

    // Attempt to submit order without protective stop
    await expect(
      broker.submitOrder({
        instrumentId: "BTC-USDT-SWAP",
        side: "long",
        sizeLots: 1,
        entryPrice: "50000.00",
        protectiveStopPrice: "" // missing!
      })
    ).rejects.toThrow(/Orders without mandatory attached protective stop are prohibited/);
  });

  it("strictly rejects long order with protective stop above entry price", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();
    const broker = new OkxBroker({
      clock,
      getRiskConfig: () => config.risk,
      getCredentials: () => credentials,
      isDemo: true
    });

    await expect(
      broker.submitOrder({
        instrumentId: "BTC-USDT-SWAP",
        side: "long",
        sizeLots: 1,
        entryPrice: "50000.00",
        protectiveStopPrice: "51000.00" // Invalid: long stop above entry
      })
    ).rejects.toThrow(/Long protective stop price must be strictly below entry price/);
  });

  it("submits order with atomic attached algo mark-price protective stop", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();

    let capturedRequestBody = "";
    const mockFetch = async (_url: string, init: { body?: string | undefined }) => {
      capturedRequestBody = init.body ?? "";
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: "0",
          msg: "",
          data: [{ ordId: "1234567890", clOrdId: "cl_test_1" }]
        }),
        text: async () => ""
      };
    };

    const broker = new OkxBroker({
      clock,
      getRiskConfig: () => config.risk,
      getCredentials: () => credentials,
      isDemo: true,
      fetchFn: mockFetch
    });

    const result = await broker.submitOrder({
      instrumentId: "BTC-USDT-SWAP",
      side: "long",
      sizeLots: 2,
      entryPrice: "50000.00",
      protectiveStopPrice: "48500.00",
      takeProfitPrice: "53000.00"
    });

    expect(result.orderId).toBe("1234567890");
    expect(result.status).toBe("FILLED");
    expect(result.protectiveStopPrice).toBe("48500.00");
    expect(result.algoOrderId).toBeDefined();

    // Verify OKX request body has attachAlgoOrds with mark price
    expect(capturedRequestBody).toContain("attachAlgoOrds");
    expect(capturedRequestBody).toContain("48500.00");
    expect(capturedRequestBody).toContain("mark");

    // Verify open position was created locally
    const openPositions = broker.getOpenPositions();
    expect(openPositions.length).toBe(1);
    expect(openPositions[0]?.protectiveStopPrice).toBe("48500.00");
  });

  it("manages 60-second Dead-Man's Switch (cancel-all-after) heartbeat", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();
    const broker = new OkxBroker({
      clock,
      getRiskConfig: () => config.risk,
      getCredentials: () => credentials,
      isDemo: true
    });

    let status = broker.getDmsStatus();
    expect(status.healthy).toBe(false); // No heartbeat yet

    const beatRes = await broker.sendDmsHeartbeat();
    expect(beatRes.ok).toBe(true);
    expect(beatRes.countdownSeconds).toBe(60);

    status = broker.getDmsStatus();
    expect(status.healthy).toBe(true);
    expect(status.lastHeartbeatAtMs).toBe(1_750_000_000_000);
  });

  it("reconciles positions and flattens all open positions on demand", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();
    const broker = new OkxBroker({
      clock,
      getRiskConfig: () => config.risk,
      getCredentials: () => credentials,
      isDemo: true
    });

    await broker.submitOrder({
      instrumentId: "BTC-USDT-SWAP",
      side: "long",
      sizeLots: 1,
      entryPrice: "50000.00",
      protectiveStopPrice: "48000.00"
    });

    const recon = await broker.reconcilePositions();
    expect(recon.matched).toBe(true);
    expect(recon.localPositionsCount).toBe(1);

    const flattened = broker.flattenAllPositions("Emergency manual flatten test");
    expect(flattened.length).toBe(1);
    expect(broker.getOpenPositions().length).toBe(0);
  });

  it("amends existing algo protective stop for ratcheting (ADR-0006)", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();
    let capturedBody = "";
    const broker = new OkxBroker({
      clock,
      getRiskConfig: () => config.risk,
      getCredentials: () => credentials,
      fetchFn: async (_url, init) => {
        capturedBody = init.body ?? "";
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: "0", data: [{ algoId: "algo_test1" }] }),
          text: async () => "ok"
        };
      }
    });

    await broker.submitOrder({
      instrumentId: "BTC-USDT-SWAP",
      side: "long",
      sizeLots: 1,
      entryPrice: "50000.00",
      protectiveStopPrice: "48000.00"
    });

    const amendResult = await broker.amendAlgoOrder({
      algoOrderId: "algo_test1",
      instrumentId: "BTC-USDT-SWAP",
      newStopPrice: "49200.00"
    });

    expect(amendResult.ok).toBe(true);
    expect(amendResult.newStopPrice).toBe("49200.00");
    expect(capturedBody).toContain("49200.00");

    const openPositions = broker.getOpenPositions();
    expect(openPositions[0]?.protectiveStopPrice).toBe("49200.00");
  });

  it("detects missing protective stops during reconciliation, sends CRITICAL alert, and auto-flattens (ADR-0006)", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();
    const alerts: unknown[] = [];

    const broker = new OkxBroker({
      clock,
      getRiskConfig: () => config.risk,
      notificationChannel: {
        send: async (msg) => {
          alerts.push(msg);
          return { delivered: true };
        }
      }
    });

    // Place normal order
    await broker.submitOrder({
      instrumentId: "BTC-USDT-SWAP",
      side: "long",
      sizeLots: 1,
      entryPrice: "50000.00",
      protectiveStopPrice: "48000.00"
    });

    // Artificially corrupt protective stop on position to simulate exchange drift
    const pos = broker.getOpenPositions()[0];
    if (pos) {
      // @ts-expect-error test simulation of corrupted stop
      pos.protectiveStopPrice = "0";
    }

    const recon = await broker.reconcilePositions();
    expect(recon.matched).toBe(false);
    expect(recon.driftDetails.length).toBe(1);
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toMatchObject({ severity: "CRITICAL" });
    // Verify auto-flatten was triggered
    expect(broker.getOpenPositions().length).toBe(0);
  });
});
