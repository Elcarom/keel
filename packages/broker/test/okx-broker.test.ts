import { describe, expect, it } from "vitest";
import {
  ManualClock,
  ScaledDecimal,
  createDefaultConfig,
  type CircuitBreakerRecord,
  type PaperAccountRepository,
  type PaperOrderRecord,
  type PaperPositionRecord
} from "@keel/core";
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
    const mockFetch = async (url: string, init: { body?: string | undefined }) => {
      if (init.body) {
        capturedRequestBody = init.body;
      }
      if (url.includes("/api/v5/trade/orders-algo-pending")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: "0",
            msg: "",
            data: [{ algoId: "algo_test_stop_1", state: "live" }]
          }),
          text: async () => ""
        };
      }
      if (url.includes("/api/v5/trade/order?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: "0",
            data: [{ ordId: "1234567890", state: "filled", avgPx: "50000.00", accFillSz: "2" }]
          }),
          text: async () => ""
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: "0",
          msg: "",
          data: [{ ordId: "1234567890", clOrdId: "cl_test_1", sCode: "0" }]
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
      isDemo: true,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ code: "0", msg: "", data: [] }),
        text: async () => ""
      })
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
      isDemo: true,
      fetchFn: async (url) => {
        if (url.includes("/api/v5/account/positions")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: "0",
              msg: "",
              data: [
                {
                  instId: "BTC-USDT-SWAP",
                  pos: "1",
                  posSide: "net",
                  avgPx: "50000.00"
                }
              ]
            }),
            text: async () => ""
          };
        }
        if (url.includes("/api/v5/trade/orders-algo-pending")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: "0",
              msg: "",
              data: [{ algoId: "algo_1", instId: "BTC-USDT-SWAP", slTriggerPx: "48000.00" }]
            }),
            text: async () => ""
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: "0",
            msg: "",
            data: [{ ordId: "ord_reconcile_1", clOrdId: "cl_1", sCode: "0" }]
          }),
          text: async () => ""
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

    const recon = await broker.reconcilePositions();
    expect(recon.matched).toBe(true);
    expect(recon.localPositionsCount).toBe(1);

    const flattened = await broker.flattenAllPositions("Emergency manual flatten test");
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

  it("throws explicit error on non-200 HTTP response, code !== '0', or item sCode !== '0' (C4)", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();

    // 1. Non-200 HTTP status
    const httpErrorBroker = new OkxBroker({
      clock,
      getRiskConfig: () => config.risk,
      getCredentials: () => credentials,
      fetchFn: async () => ({
        ok: false,
        status: 502,
        json: async () => ({}),
        text: async () => "Bad Gateway"
      })
    });

    await expect(
      httpErrorBroker.submitOrder({
        instrumentId: "BTC-USDT-SWAP",
        side: "long",
        sizeLots: 1,
        entryPrice: "50000.00",
        protectiveStopPrice: "48000.00"
      })
    ).rejects.toThrow(/OKX order HTTP 502: Bad Gateway/);

    // 2. Gateway rejection (code !== '0')
    const gatewayErrorBroker = new OkxBroker({
      clock,
      getRiskConfig: () => config.risk,
      getCredentials: () => credentials,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          code: "50011",
          msg: "Too many requests",
          data: []
        }),
        text: async () => "Too many requests"
      })
    });

    await expect(
      gatewayErrorBroker.submitOrder({
        instrumentId: "BTC-USDT-SWAP",
        side: "long",
        sizeLots: 1,
        entryPrice: "50000.00",
        protectiveStopPrice: "48000.00"
      })
    ).rejects.toThrow(/OKX order rejected: code 50011 - Too many requests/);

    // 3. Order-level rejection (sCode !== '0')
    const orderRejectionBroker = new OkxBroker({
      clock,
      getRiskConfig: () => config.risk,
      getCredentials: () => credentials,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          code: "0",
          msg: "",
          data: [
            {
              clOrdId: "cl_1",
              ordId: "",
              sCode: "51008",
              sMsg: "Order failed. Insufficient balance"
            }
          ]
        }),
        text: async () => ""
      })
    });

    await expect(
      orderRejectionBroker.submitOrder({
        instrumentId: "BTC-USDT-SWAP",
        side: "long",
        sizeLots: 1,
        entryPrice: "50000.00",
        protectiveStopPrice: "48000.00"
      })
    ).rejects.toThrow(/OKX order failed: sCode 51008 - Order failed. Insufficient balance/);
  });

  it("includes take-profit parameters in attachAlgoOrds and validates TP direction (C7)", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();

    let capturedPayload: Record<string, unknown> | null = null;
    const broker = new OkxBroker({
      clock,
      getRiskConfig: () => config.risk,
      getCredentials: () => credentials,
      fetchFn: async (url, init) => {
        if (url.includes("/api/v5/trade/order") && init.method === "POST") {
          capturedPayload = JSON.parse(init.body ?? "{}");
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: "0",
              msg: "",
              data: [
                {
                  clOrdId: "cl_1",
                  ordId: "ord_1001",
                  sCode: "0",
                  sMsg: ""
                }
              ]
            }),
            text: async () => ""
          };
        }
        if (
          url.includes("/api/v5/trade/order-algo") ||
          url.includes("/api/v5/trade/orders-algo-pending")
        ) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: "0",
              msg: "",
              data: [
                {
                  algoId: "algo_exchange_9999",
                  state: "live"
                }
              ]
            }),
            text: async () => ""
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: "0", data: [] }),
          text: async () => ""
        };
      }
    });

    // Valid long order with TP
    const result = await broker.submitOrder({
      instrumentId: "BTC-USDT-SWAP",
      side: "long",
      sizeLots: 1,
      entryPrice: "50000.00",
      protectiveStopPrice: "48000.00",
      takeProfitPrice: "54000.00"
    });

    expect(capturedPayload).not.toBeNull();
    const attachAlgoOrds = capturedPayload?.["attachAlgoOrds"] as Array<Record<string, unknown>>;
    expect(attachAlgoOrds).toBeDefined();
    expect(attachAlgoOrds[0]?.["tpTriggerPx"]).toBe("54000.00");
    expect(attachAlgoOrds[0]?.["tpOrdPx"]).toBe("-1");
    expect(attachAlgoOrds[0]?.["tpTriggerPxType"]).toBe("mark");
    expect(attachAlgoOrds[0]?.["slTriggerPx"]).toBe("48000.00");

    // Confirmed algoOrderId from OKX algo order response
    expect(result.algoOrderId).toBe("algo_exchange_9999");

    // Invalid long order: TP below entry
    await expect(
      broker.submitOrder({
        instrumentId: "BTC-USDT-SWAP",
        side: "long",
        sizeLots: 1,
        entryPrice: "50000.00",
        protectiveStopPrice: "48000.00",
        takeProfitPrice: "49000.00"
      })
    ).rejects.toThrow(/Long take-profit price must be strictly above entry price/);

    // Invalid short order: TP above entry
    await expect(
      broker.submitOrder({
        instrumentId: "BTC-USDT-SWAP",
        side: "short",
        sizeLots: 1,
        entryPrice: "50000.00",
        protectiveStopPrice: "52000.00",
        takeProfitPrice: "51000.00"
      })
    ).rejects.toThrow(/Short take-profit price must be strictly below entry price/);
  });

  it("throws and dispatches CRITICAL alerts on non-zero DMS responses without swallowing errors (C6)", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();
    const alerts: unknown[] = [];

    // Broker with rejecting DMS
    const broker = new OkxBroker({
      clock,
      getRiskConfig: () => config.risk,
      getCredentials: () => credentials,
      isDemo: true,
      notificationChannel: {
        send: async (msg) => {
          alerts.push(msg);
          return { delivered: true };
        }
      },
      fetchFn: async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => "Internal Server Error"
      })
    });

    // sendDmsHeartbeat must THROW, not swallow error and return ok: true!
    await expect(broker.sendDmsHeartbeat()).rejects.toThrow(/OKX DMS API error \(500\)/);

    // CRITICAL alert must have been dispatched
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toMatchObject({
      severity: "CRITICAL",
      title: "DEAD-MAN SWITCH HEARTBEAT REJECTED"
    });

    // DMS status must remain unhealthy (heartbeat not recorded)
    const status = broker.getDmsStatus();
    expect(status.healthy).toBe(false);
    expect(status.lastHeartbeatAtMs).toBeNull();

    // Also test OKX code !== "0"
    const brokerWithCodeErr = new OkxBroker({
      clock,
      getRiskConfig: () => config.risk,
      getCredentials: () => credentials,
      isDemo: true,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ code: "50011", msg: "Too many requests" }),
        text: async () => ""
      })
    });
    await expect(brokerWithCodeErr.sendDmsHeartbeat()).rejects.toThrow(
      /OKX DMS API error \(50011\)/
    );

    // Also test OKX item sCode !== "0"
    const brokerWithSCodeErr = new OkxBroker({
      clock,
      getRiskConfig: () => config.risk,
      getCredentials: () => credentials,
      isDemo: true,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          code: "0",
          msg: "",
          data: [{ sCode: "51008", sMsg: "Countdown error" }]
        }),
        text: async () => ""
      })
    });
    await expect(brokerWithSCodeErr.sendDmsHeartbeat()).rejects.toThrow(
      /OKX DMS API error \(51008\)/
    );
  });

  it("queries OKX exchange positions & algo orders during reconciliation and detects drift (C5)", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();
    const alerts: unknown[] = [];

    let queriedPositions = false;
    let queriedAlgos = false;

    const broker = new OkxBroker({
      clock,
      getRiskConfig: () => config.risk,
      getCredentials: () => credentials,
      isDemo: true,
      notificationChannel: {
        send: async (msg) => {
          alerts.push(msg);
          return { delivered: true };
        }
      },
      fetchFn: async (url) => {
        if (url.includes("/api/v5/account/positions")) {
          queriedPositions = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: "0",
              msg: "",
              data: [
                {
                  instId: "BTC-USDT-SWAP",
                  pos: "1",
                  posSide: "net",
                  avgPx: "50000.00"
                }
              ]
            }),
            text: async () => ""
          };
        }
        if (url.includes("/api/v5/trade/orders-algo-pending")) {
          queriedAlgos = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: "0",
              msg: "",
              data: [] // No active algo orders on exchange!
            }),
            text: async () => ""
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: "0", data: [] }),
          text: async () => ""
        };
      }
    });

    // Reconcile when exchange has an open position but no attached stop
    const recon = await broker.reconcilePositions();
    expect(queriedPositions).toBe(true);
    expect(queriedAlgos).toBe(true);
    expect(recon.matched).toBe(false);
    expect(recon.exchangePositionsCount).toBe(1);
    expect(alerts.length).toBeGreaterThan(0);
  });

  it("flattens positions via exchange cancel-all and market reduceOnly orders (C5)", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();

    const ordersSent: Array<Record<string, unknown>> = [];
    let cancelAllSent = false;

    const broker = new OkxBroker({
      clock,
      getRiskConfig: () => config.risk,
      getCredentials: () => credentials,
      isDemo: true,
      fetchFn: async (url, init) => {
        if (url.includes("/api/v5/trade/cancel-all-after")) {
          cancelAllSent = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({ code: "0", data: [] }),
            text: async () => ""
          };
        }
        if (url.includes("/api/v5/trade/orders-algo-pending")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: "0",
              data: [{ algoId: "algo_flat_stop_1", state: "live" }]
            }),
            text: async () => ""
          };
        }
        if (url.includes("/api/v5/trade/order") && init.method === "POST") {
          const body = JSON.parse(init.body ?? "{}");
          ordersSent.push(body);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: "0",
              msg: "",
              data: [{ ordId: "ord_flat_1", clOrdId: body.clOrdId, sCode: "0" }]
            }),
            text: async () => ""
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: "0", data: [] }),
          text: async () => ""
        };
      }
    });

    // Submit long order
    await broker.submitOrder({
      instrumentId: "BTC-USDT-SWAP",
      side: "long",
      sizeLots: 2,
      entryPrice: "50000.00",
      protectiveStopPrice: "48000.00"
    });

    expect(broker.getOpenPositions().length).toBe(1);

    // Emergency Flatten
    const flattened = await broker.flattenAllPositions("Emergency test flatten");
    expect(flattened.length).toBe(1);
    expect(broker.getOpenPositions().length).toBe(0);

    // Assert cancel-all and reduceOnly market order were dispatched to OKX
    expect(cancelAllSent).toBe(true);
    const reduceOnlyOrder = ordersSent.find((o) => o["reduceOnly"] === true);
    expect(reduceOnlyOrder).toBeDefined();
    expect(reduceOnlyOrder?.["side"]).toBe("sell"); // Opposite of long
    expect(reduceOnlyOrder?.["sz"]).toBe("2");
    expect(reduceOnlyOrder?.["ordType"]).toBe("market");
  });

  it("persists positions, orders, and circuit breaker across restarts via PaperAccountRepository (C5)", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();

    const positionsStore = new Map<string, PaperPositionRecord>();
    const ordersStore: PaperOrderRecord[] = [];
    let cbStore: CircuitBreakerRecord = {
      status: "NORMAL",
      reason: "Initial",
      triggeredAtMs: 0,
      cooldownUntilMs: null,
      updatedBy: "system"
    };

    const mockRepo: PaperAccountRepository = {
      savePosition: (pos: PaperPositionRecord) => {
        positionsStore.set(pos.positionId, pos);
        return pos;
      },
      getPosition: (id: string) => positionsStore.get(id) ?? null,
      listOpenPositions: () =>
        Array.from(positionsStore.values()).filter((p) => p.status === "OPEN"),
      listAllPositions: () => Array.from(positionsStore.values()),
      saveOrder: (ord: PaperOrderRecord) => {
        ordersStore.push(ord);
        return ord;
      },
      listOrders: () => ordersStore,
      countFilledOrdersToday: () => ordersStore.length,
      getCircuitBreaker: () => cbStore,
      setCircuitBreaker: (cb: CircuitBreakerRecord) => {
        cbStore = cb;
        return cb;
      }
    };

    // First broker instance writes state
    const broker1 = new OkxBroker({
      clock,
      getRiskConfig: () => config.risk,
      getCredentials: () => credentials,
      accountRepo: mockRepo,
      fetchFn: async (url) => {
        if (url.includes("/api/v5/trade/orders-algo-pending")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: "0",
              data: [{ algoId: "algo_persist_stop_1", state: "live" }]
            }),
            text: async () => ""
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: "0",
            data: [{ ordId: "ord_persist_1", sCode: "0" }]
          }),
          text: async () => ""
        };
      }
    });

    broker1.setCircuitBreaker({
      status: "TRIPPED",
      reason: "Daily loss limit reached",
      triggeredAtMs: 1_750_000_000_000,
      cooldownUntilMs: 1_750_086_400_000,
      updatedBy: "risk-engine"
    });

    await broker1.submitOrder({
      instrumentId: "BTC-USDT-SWAP",
      side: "long",
      sizeLots: 1,
      entryPrice: "50000.00",
      protectiveStopPrice: "48000.00"
    });

    expect(broker1.getOpenPositions().length).toBe(1);
    expect(broker1.getOrders().length).toBe(1);

    // Simulate restart with new OkxBroker instance sharing the same repository
    const broker2 = new OkxBroker({
      clock,
      getRiskConfig: () => config.risk,
      getCredentials: () => credentials,
      accountRepo: mockRepo,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ code: "0", data: [] }),
        text: async () => ""
      })
    });

    // Verify state was recovered on restart
    expect(broker2.getCircuitBreaker().status).toBe("TRIPPED");
    expect(broker2.getCircuitBreaker().reason).toBe("Daily loss limit reached");
    expect(broker2.getOpenPositions().length).toBe(1);
    expect(broker2.getOpenPositions()[0]?.instrumentId).toBe("BTC-USDT-SWAP");
    expect(broker2.getOrders().length).toBe(1);
    expect(broker2.getOrders()[0]?.orderId).toBe("ord_persist_1");
  });

  it("reproduces M-F defect: unlinked broker does not post to ledger and reports static 0.00000000 unrealized PnL", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const unlinkedBroker = new OkxBroker({
      clock,
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          code: "0",
          data: [{ ordId: "ord_unlinked", clOrdId: "cl_unlinked", sCode: "0" }]
        }),
        text: async () => ""
      })
    });

    await unlinkedBroker.submitOrder({
      instrumentId: "BTC-USDT-SWAP",
      side: "long",
      sizeLots: 1,
      entryPrice: "50000.00",
      protectiveStopPrice: "48000.00"
    });

    const openPositions = unlinkedBroker.getOpenPositions();
    expect(openPositions.length).toBe(1);
    const pos = openPositions[0];
    expect(pos?.unrealizedPnlUsdt).toBe("0.00000000");
  });

  it("remediates M-F: posts entry fee and close PnL to LedgerRepository, and computes dynamic mark-to-market unrealized PnL", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();
    const recordedJournals: Array<{
      txGroupId: string;
      debitAccount: string;
      creditAccount: string;
      amountUsdt: string;
    }> = [];

    const mockLedgerRepo = {
      recordJournal: (input: {
        txGroupId: string;
        ts: number;
        strategyId: string | null;
        instrumentId: string | null;
        debitAccount:
          | "cash:usdt"
          | "equity_capital:usdt"
          | "realized_pnl:usdt"
          | "fees_expense:usdt"
          | "funding_pnl:usdt";
        creditAccount:
          | "cash:usdt"
          | "equity_capital:usdt"
          | "realized_pnl:usdt"
          | "fees_expense:usdt"
          | "funding_pnl:usdt";
        amountUsdt: string;
        description: string;
      }) => {
        recordedJournals.push(input);
        return {
          entryId: `entry-${recordedJournals.length}`,
          ...input
        };
      },
      listEntries: () => [],
      getTrialBalance: () => ({
        totalDebitsUsdt: "0",
        totalCreditsUsdt: "0",
        isBalanced: true,
        cashBalanceUsdt: "10000.00",
        realizedPnlUsdt: "0",
        feesExpenseUsdt: "0",
        fundingPnlUsdt: "0",
        netEquityUsdt: "10000.00",
        entryCount: recordedJournals.length
      }),
      getRiskMetrics: () => ({
        currentEquityUsdt: ScaledDecimal.fromString("10000.00"),
        dayStartEquityUsdt: ScaledDecimal.fromString("10000.00"),
        weekStartEquityUsdt: ScaledDecimal.fromString("10000.00"),
        highWaterMarkEquityUsdt: ScaledDecimal.fromString("10000.00"),
        feesTodayUsdt: ScaledDecimal.zero(),
        drawdownPct: ScaledDecimal.zero()
      })
    };

    const mockMarketDataRepo = {
      ingestOkxCandles: () => ({ insertedCount: 0, skippedUnconfirmedCount: 0 }),
      ingestSettledFunding: () => 0,
      getConfirmedBarsAsOf: () => [
        {
          instrumentId: "BTC-USDT-SWAP",
          timeframe: "1H" as const,
          openTs: 1_750_000_000_000 - 3600_000,
          closeTs: 1_750_000_000_000,
          open: "50000.00",
          high: "56000.00",
          low: "49000.00",
          close: "55000.00", // Price moved up by 5000
          volumeContracts: "100",
          volumeQuote: "5000000",
          confirm: "1" as const
        }
      ],
      getConfirmedBarsInRange: () => [],
      getSettledFundingAsOf: () => [],
      getSettledFundingInRange: () => [],
      detectGaps: () => []
    };

    const broker = new OkxBroker({
      clock,
      getRiskConfig: () => config.risk,
      getCredentials: () => credentials,
      ledgerRepo: mockLedgerRepo,
      marketDataRepo: mockMarketDataRepo,
      isDemo: true,
      fetchFn: async (url) => {
        if (url.includes("/api/v5/trade/orders-algo-pending")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: "0",
              data: [{ algoId: "algo_mf_stop_1", state: "live" }]
            }),
            text: async () => ""
          };
        }
        if (url.includes("/api/v5/trade/order?")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: "0",
              data: [
                {
                  ordId: "ord_mf_1",
                  state: "filled",
                  avgPx: "50000.00",
                  accFillSz: "1",
                  fee: "-0.30000000"
                }
              ]
            }),
            text: async () => ""
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: "0",
            data: [{ ordId: "ord_mf_1", clOrdId: "cl_mf_1", sCode: "0" }]
          }),
          text: async () => ""
        };
      }
    });

    // 1. Submit order: 1 lot BTC long @ 50,000 (contractValue = 0.01 BTC, notional = 500 USDT)
    const order = await broker.submitOrder({
      instrumentId: "BTC-USDT-SWAP",
      side: "long",
      sizeLots: 1,
      entryPrice: "50000.00",
      protectiveStopPrice: "48000.00",
      strategyId: "donchian-breakout"
    });

    expect(order.status).toBe("FILLED");

    // Fee journal must be posted to LedgerRepository
    expect(recordedJournals.length).toBeGreaterThanOrEqual(1);
    const feeJournal = recordedJournals.find((j) => j.debitAccount === "fees_expense:usdt");
    expect(feeJournal).toBeDefined();
    expect(feeJournal?.creditAccount).toBe("cash:usdt");
    if (feeJournal) {
      expect(ScaledDecimal.fromString(feeJournal.amountUsdt).isPositive()).toBe(true);
    }

    // Position and order records must record non-zero fees
    const openPositions = broker.getOpenPositions();
    expect(openPositions.length).toBe(1);
    const pos = openPositions[0];
    expect(pos).toBeDefined();
    if (pos) {
      expect(ScaledDecimal.fromString(pos.feesPaidUsdt).isPositive()).toBe(true);

      // 2. Open positions must reflect dynamic mark-to-market unrealized PnL (close is 55000 vs entry 50000)
      // 1 lot * 0.01 ctVal * (55000 - 50000) = +50.00 USDT
      expect(pos.unrealizedPnlUsdt).not.toBe("0.00");
      const upl = ScaledDecimal.fromString(pos.unrealizedPnlUsdt);
      expect(upl.toFixed(2)).toBe("50.00");
    }

    // 3. Flatten position must post realized PnL and exit fee to LedgerRepository
    await broker.flattenAllPositions("Test flatten");

    const pnlJournal = recordedJournals.find((j) => j.creditAccount === "realized_pnl:usdt");
    expect(pnlJournal).toBeDefined();
    expect(pnlJournal?.debitAccount).toBe("cash:usdt");
    if (pnlJournal) {
      expect(ScaledDecimal.fromString(pnlJournal.amountUsdt).toFixed(2)).toBe("50.00");
    }
  });

  it("M-D: unconfigured credentials DMS heartbeat returns status not_configured and healthy false without calling OKX", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();
    let fetchCalled = false;

    const broker = new OkxBroker({
      clock,
      getRiskConfig: () => config.risk,
      getCredentials: () => null, // No credentials configured
      isDemo: true,
      fetchFn: async () => {
        fetchCalled = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: "0", data: [{ result: true }] }),
          text: async () => ""
        };
      }
    });

    const beatRes = await broker.sendDmsHeartbeat();
    expect(fetchCalled).toBe(false);
    expect(beatRes.ok).toBe(false);
    expect(beatRes.countdownSeconds).toBe(0);
    expect((beatRes as { status?: string }).status).toBe("not_configured");

    const status = broker.getDmsStatus();
    expect(status.healthy).toBe(false);
    expect(status.lastHeartbeatAtMs).toBeNull();
  });

  it("M-B: submitOrder ingests true fill details (avgPx, accFillSz, fee) from OKX instead of signal price", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();

    const mockFetch = async (url: string) => {
      if (url.includes("/api/v5/trade/order") && !url.includes("?")) {
        // POST /api/v5/trade/order placement response
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: "0",
            msg: "",
            data: [{ ordId: "1234567890", clOrdId: "cl_fill_test", sCode: "0" }]
          }),
          text: async () => ""
        };
      }
      if (url.includes("/api/v5/trade/order?")) {
        // GET /api/v5/trade/order fill details query
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: "0",
            msg: "",
            data: [
              {
                ordId: "1234567890",
                state: "filled",
                avgPx: "50125.75",
                accFillSz: "2",
                fee: "-0.06015",
                feeCcy: "USDT"
              }
            ]
          }),
          text: async () => ""
        };
      }
      if (url.includes("/api/v5/trade/orders-algo-pending")) {
        // Stop confirmation
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: "0",
            msg: "",
            data: [{ algoId: "algo_confirmed_999", algoClOrdId: "slcl_fill_test", state: "live" }]
          }),
          text: async () => ""
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: "0", data: [] }),
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
      protectiveStopPrice: "48500.00"
    });

    // Must ingest true fill price from avgPx (50125.75), NOT signal entryPrice (50000.00)
    expect(result.fillPrice).toBe("50125.75");
    expect(result.algoOrderId).toBe("algo_confirmed_999");
    expect(result.status).toBe("FILLED");
  });

  it("M-B: unconfirmed algo stop triggers emergency position flatten and CRITICAL alert", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();
    const alerts: Array<{ severity: string; title: string; body: string }> = [];

    const mockNotificationChannel = {
      send: async (alert: {
        severity: "INFO" | "WARNING" | "CRITICAL";
        title: string;
        body: string;
      }) => {
        alerts.push(alert);
      }
    };

    const mockFetch = async (url: string) => {
      if (url.includes("/api/v5/trade/order") && !url.includes("?")) {
        // Order placed on exchange
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: "0",
            msg: "",
            data: [{ ordId: "999888777", clOrdId: "cl_stop_fail", sCode: "0" }]
          }),
          text: async () => ""
        };
      }
      if (url.includes("/api/v5/trade/order?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: "0",
            msg: "",
            data: [{ ordId: "999888777", state: "filled", avgPx: "50000.00", accFillSz: "1" }]
          }),
          text: async () => ""
        };
      }
      if (url.includes("/api/v5/trade/orders-algo-pending")) {
        // Stop query returns EMPTY array (unconfirmed stop!)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: "0",
            msg: "",
            data: []
          }),
          text: async () => ""
        };
      }
      // Any other call (e.g. flatten reduceOnly order or cancel)
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: "0", data: [] }),
        text: async () => ""
      };
    };

    const broker = new OkxBroker({
      clock,
      getRiskConfig: () => config.risk,
      getCredentials: () => credentials,
      isDemo: true,
      fetchFn: mockFetch,
      notificationChannel: mockNotificationChannel
    });

    // Submitting order must fail and throw because stop is unconfirmed
    await expect(
      broker.submitOrder({
        instrumentId: "BTC-USDT-SWAP",
        side: "long",
        sizeLots: 1,
        entryPrice: "50000.00",
        protectiveStopPrice: "48500.00"
      })
    ).rejects.toThrow(/unconfirmed|protective stop/i);

    // CRITICAL alert must have been emitted
    const criticalAlert = alerts.find((a) => a.severity === "CRITICAL");
    expect(criticalAlert).toBeDefined();
    expect(criticalAlert?.title).toContain("STOP");

    // Local position must NOT remain open without protection
    expect(broker.getOpenPositions().length).toBe(0);
  });

  it("M-C: flattenAllPositions checks OKX responses, keeps position OPEN on failure, and emits CRITICAL alert", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();
    const alerts: Array<{ severity: string; title: string; body: string }> = [];

    const mockNotificationChannel = {
      send: async (alert: {
        severity: "INFO" | "WARNING" | "CRITICAL";
        title: string;
        body: string;
      }) => {
        alerts.push(alert);
      }
    };

    let orderSubmitted = false;
    const mockFetch = async (url: string, init?: { method?: string; body?: string }) => {
      if (url.includes("/api/v5/trade/order") && init?.method === "POST") {
        if (!orderSubmitted) {
          orderSubmitted = true;
          // Initial entry order succeeds
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: "0",
              data: [{ ordId: "ord_init_1", clOrdId: "cl_init_1", sCode: "0" }]
            }),
            text: async () => ""
          };
        }
        // Flatten order FAILS with OKX 51000 error
        return {
          ok: false,
          status: 500,
          text: async () => "Internal Server Error during flatten"
        };
      }
      if (url.includes("/api/v5/trade/orders-algo-pending")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: "0",
            data: [{ algoId: "algo_init_1", state: "live" }]
          }),
          text: async () => ""
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: "0", data: [] }),
        text: async () => ""
      };
    };

    const broker = new OkxBroker({
      clock,
      getRiskConfig: () => config.risk,
      getCredentials: () => credentials,
      isDemo: true,
      fetchFn: mockFetch,
      notificationChannel: mockNotificationChannel
    });

    await broker.submitOrder({
      instrumentId: "BTC-USDT-SWAP",
      side: "long",
      sizeLots: 1,
      entryPrice: "50000.00",
      protectiveStopPrice: "48500.00"
    });

    expect(broker.getOpenPositions().length).toBe(1);

    // Flatten fails on exchange
    await broker.flattenAllPositions("Emergency test flatten");

    // Defect check: position must NOT be fabricated as closed at 0 PnL! It must stay OPEN!
    const openPositions = broker.getOpenPositions();
    expect(openPositions.length).toBe(1);
    expect(openPositions[0]?.status).toBe("OPEN");

    // Must have emitted a CRITICAL alert
    const criticalAlert = alerts.find(
      (a) => a.severity === "CRITICAL" && a.title.includes("FLATTEN")
    );
    expect(criticalAlert).toBeDefined();
  });

  it("M-C: flattenAllPositions queries exchange positions and closes untracked foreign exchange positions", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();
    const sentOrders: Array<{ instId: string; side: string; sz: string; reduceOnly: boolean }> = [];

    const mockFetch = async (url: string, init?: { method?: string; body?: string }) => {
      if (url.includes("/api/v5/account/positions")) {
        // Exchange has an untracked foreign ETH short position (5 contracts)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: "0",
            data: [
              {
                instId: "ETH-USDT-SWAP",
                pos: "-5",
                posSide: "net"
              }
            ]
          }),
          text: async () => ""
        };
      }
      if (url.includes("/api/v5/trade/order") && init?.method === "POST") {
        const body = JSON.parse(init.body ?? "{}");
        sentOrders.push(body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: "0",
            data: [{ ordId: "ord_foreign_flat", sCode: "0" }]
          }),
          text: async () => ""
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: "0", data: [] }),
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

    // Local broker has ZERO positions
    expect(broker.getOpenPositions().length).toBe(0);

    // Call flattenAllPositions
    await broker.flattenAllPositions("Emergency flatten foreign positions");

    // Must have queried exchange positions and submitted a reduceOnly buy order to close the -5 ETH position
    const ethOrder = sentOrders.find((o) => o.instId === "ETH-USDT-SWAP");
    expect(ethOrder).toBeDefined();
    expect(ethOrder?.side).toBe("buy"); // buy to cover short
    expect(ethOrder?.sz).toBe("5");
    expect(ethOrder?.reduceOnly).toBe(true);
  });

  it("M-E: attachAlgoOrds includes confirmed fields and excludes unverified reduceOnly/closeFraction inside attachAlgoOrds", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();

    let capturedPayload: { attachAlgoOrds?: Array<Record<string, unknown>> } | null = null;
    const mockFetch = async (url: string, init?: { body?: string }) => {
      if (url.includes("/api/v5/trade/order") && init?.body) {
        capturedPayload = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: "0",
            data: [{ ordId: "ord_100", sCode: "0" }]
          }),
          text: async () => ""
        };
      }
      if (url.includes("/api/v5/trade/orders-algo-pending")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: "0",
            data: [{ algoId: "algo_100", state: "live" }]
          }),
          text: async () => ""
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: "0",
          data: [{ state: "filled", avgPx: "50100.00", accFillSz: "1", fee: "-0.30" }]
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

    await broker.submitOrder({
      instrumentId: "BTC-USDT-SWAP",
      side: "long",
      sizeLots: 1,
      entryPrice: "50000.00",
      protectiveStopPrice: "48000.00",
      takeProfitPrice: "55000.00"
    });

    expect(capturedPayload).not.toBeNull();
    const algoOrd = capturedPayload?.attachAlgoOrds?.[0];
    expect(algoOrd).toBeDefined();

    // Confirmed OKX V5 fields
    expect(algoOrd?.slTriggerPx).toBe("48000.00");
    expect(algoOrd?.slOrdPx).toBe("-1");
    expect(algoOrd?.slTriggerPxType).toBe("mark");
    expect(algoOrd?.tpTriggerPx).toBe("55000.00");
    expect(algoOrd?.tpOrdPx).toBe("-1");
    expect(algoOrd?.tpTriggerPxType).toBe("mark");

    // Unverified fields inside attachAlgoOrds must NOT be present
    expect(algoOrd?.reduceOnly).toBeUndefined();
    expect(algoOrd?.closeFraction).toBeUndefined();
  });

  it("M-B: submitOrder marks status SUBMITTED when fill details cannot be confirmed rather than FILLED at entryPrice", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();

    const mockFetch = async (url: string) => {
      if (url.includes("/api/v5/trade/order") && !url.includes("?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: "0",
            data: [{ ordId: "ord_unconfirmed_fill", sCode: "0" }]
          }),
          text: async () => ""
        };
      }
      if (url.includes("/api/v5/trade/order?")) {
        // Query order fill details fails or returns empty/unfilled state
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: "0",
            data: [{ state: "live", avgPx: "0", accFillSz: "0" }]
          }),
          text: async () => ""
        };
      }
      if (url.includes("/api/v5/trade/orders-algo-pending")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: "0",
            data: [{ algoId: "algo_valid_stop", state: "live" }]
          }),
          text: async () => ""
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: "0", data: [] }),
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

    const res = await broker.submitOrder({
      instrumentId: "BTC-USDT-SWAP",
      side: "long",
      sizeLots: 1,
      entryPrice: "50000.00",
      protectiveStopPrice: "48000.00"
    });

    // When real fill is not confirmed, status must be SUBMITTED, not FILLED!
    expect(res.status).toBe("SUBMITTED");
  });

  it("M-C: flattenAllPositions explicitly cancels attached algo orders on exchange", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();
    const cancelledAlgos: string[] = [];

    const mockFetch = async (url: string, _init?: { body?: string }) => {
      if (url.includes("/api/v5/trade/cancel-algo-orders")) {
        cancelledAlgos.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: "0", data: [{ sCode: "0" }] }),
          text: async () => ""
        };
      }
      if (url.includes("/api/v5/account/positions")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: "0", data: [] }),
          text: async () => ""
        };
      }
      if (url.includes("/api/v5/trade/order")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: "0", data: [{ ordId: "ord_flat", sCode: "0" }] }),
          text: async () => ""
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: "0", data: [] }),
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

    await broker.flattenAllPositions("Emergency flatten");
    // Must call cancel-algo-orders to explicitly cancel resting stops/TPs!
    expect(cancelledAlgos.length).toBeGreaterThan(0);
  });

  it("Reconciliation: queries both conditional and oco ordTypes and matches long/short and net mode positions", async () => {
    const clock = new ManualClock(1_750_000_000_000);
    const config = createDefaultConfig();
    const algoQueries: string[] = [];

    const mockFetch = async (url: string) => {
      if (url.includes("/api/v5/trade/orders-algo-pending")) {
        algoQueries.push(url);
        if (url.includes("ordType=oco")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              code: "0",
              data: [{ algoId: "algo_oco_1", instId: "ETH-USDT-SWAP", slTriggerPx: "2500.00" }]
            }),
            text: async () => ""
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: "0",
            data: [{ algoId: "algo_cond_1", instId: "BTC-USDT-SWAP", slTriggerPx: "48000.00" }]
          }),
          text: async () => ""
        };
      }
      if (url.includes("/api/v5/account/positions")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: "0",
            data: [
              {
                instId: "BTC-USDT-SWAP",
                pos: "1",
                posSide: "long",
                markPx: "51000.00",
                upl: "100.00"
              },
              {
                instId: "ETH-USDT-SWAP",
                pos: "-2",
                posSide: "net",
                markPx: "2600.00",
                upl: "50.00"
              }
            ]
          }),
          text: async () => ""
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: "0", data: [] }),
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

    const recon = await broker.reconcilePositions();
    expect(recon.exchangePositionsCount).toBe(2);

    // Verifies that both conditional and oco algo queries were executed
    const hasConditional = algoQueries.some((q) => q.includes("ordType=conditional"));
    const hasOco = algoQueries.some((q) => q.includes("ordType=oco"));
    expect(hasConditional).toBe(true);
    expect(hasOco).toBe(true);
  });
});
