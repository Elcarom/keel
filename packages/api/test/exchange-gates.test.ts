import { describe, expect, it } from "vitest";
import {
  ManualClock,
  createDefaultConfig,
  type ExecutionMode,
  type PromotionStage
} from "@keel/core";
import { OkxBroker } from "@keel/broker";
import { createSqliteDataStore } from "@keel/data";
import { createKeelServer } from "../src/index.js";
import { createFakeOkx } from "../../broker/test/fake-okx.js";

const PASSWORD = "correct-horse-battery-staple";

async function setup(mode: ExecutionMode, strategyStage: PromotionStage | null) {
  const clock = new ManualClock(1_730_000_000_000);
  const config = createDefaultConfig();
  const configInMode = { ...config, system: { ...config.system, executionMode: mode } };
  const dataStore = createSqliteDataStore({
    dbPath: ":memory:",
    clock,
    initialConfig: configInMode
  });
  const fake = createFakeOkx();
  const okxBroker = new OkxBroker({
    clock,
    getCredentials: () => ({
      apiKey: "test-api-key",
      secretKey: "test-secret-key-32-bytes-long-super-secret",
      passphrase: "test-passphrase"
    }),
    fetchFn: fake.fetchFn
  });
  if (strategyStage !== null) {
    dataStore.promotionRepo.upsertPromotion({
      strategyId: "donchian-trend-v1",
      currentStage: strategyStage,
      latestExperimentId: "exp-1",
      replayGatePassed: true,
      paperTradesCount: 50,
      paperDrawdownPct: 1.0,
      rampAllocationPct: 100,
      eligibleNextStage: null,
      demotionReason: null,
      promotedAtMs: clock.nowMs(),
      updatedAtMs: clock.nowMs()
    });
  }

  let bootstrapToken = "";
  const app = await createKeelServer({
    config: configInMode,
    clock,
    dataStore,
    exchangeBroker: okxBroker,
    onBootstrapToken: (t) => {
      bootstrapToken = t;
    }
  });
  const bootRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/bootstrap",
    headers: { "cf-connecting-ip": "203.0.113.9", "x-forwarded-proto": "https" },
    payload: { bootstrapToken, username: "operator", password: PASSWORD }
  });
  const cookie = String(bootRes.headers["set-cookie"] ?? "").split(";")[0] ?? "";
  // Let any login-time step-up lapse so every gate below must be satisfied explicitly
  clock.advanceMs(10 * 60 * 1000);

  const order = (extra: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST",
      url: "/api/v1/broker/orders",
      headers: { cookie },
      payload: {
        instrumentId: "BTC-USDT-SWAP",
        strategyId: "donchian-trend-v1",
        side: "long",
        sizeLots: 1,
        entryPrice: "50000",
        protectiveStopPrice: "49000",
        ...extra
      }
    });

  return { app, order, fake, okxBroker };
}

const placedOrders = (fake: ReturnType<typeof createFakeOkx>) =>
  fake.requests.filter(
    (r) => r.path === "/api/v1/broker/orders" || r.path === "/api/v5/trade/order"
  );

describe("Human gates G2/G3 guard direct exchange orders (audit-3 C3)", () => {
  it("refuses exchange orders while the Execution Mode is Paper", async () => {
    const { app, order, fake } = await setup("Paper", "Live");
    try {
      const res = await order({ stepUpPassword: PASSWORD });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/Execution Mode/);
      expect(placedOrders(fake)).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("requires step-up authentication before any entry order (G2)", async () => {
    const { app, order, fake } = await setup("Demo", "Demo");
    try {
      const res = await order();
      expect(res.statusCode).toBe(403);
      expect(res.json().requiresStepUp).toBe(true);
      expect(placedOrders(fake)).toHaveLength(0);

      const ok = await order({ stepUpPassword: PASSWORD });
      expect(ok.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("refuses a strategy whose Promotion Ladder stage does not authorize the mode", async () => {
    const { app, order, fake } = await setup("Live", "Live-Ramp");
    try {
      const res = await order({ stepUpPassword: PASSWORD });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/Promotion Ladder/);
      expect(placedOrders(fake)).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("allows unpromoted manual orders only on the Demo venue", async () => {
    const demo = await setup("Demo", null);
    try {
      const res = await demo.order({ strategyId: "manual-execution", stepUpPassword: PASSWORD });
      expect(res.statusCode).toBe(200);
    } finally {
      await demo.app.close();
    }

    const live = await setup("Live-Ramp", null);
    try {
      const res = await live.order({ strategyId: "manual-execution", stepUpPassword: PASSWORD });
      expect(res.statusCode).toBe(403);
      expect(placedOrders(live.fake)).toHaveLength(0);
    } finally {
      await live.app.close();
    }
  });
});
