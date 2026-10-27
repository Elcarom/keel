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

async function setup(
  mode: ExecutionMode,
  strategyStage: PromotionStage | null,
  fakeOptions: Parameters<typeof createFakeOkx>[0] = {}
) {
  const clock = new ManualClock(1_730_000_000_000);
  const config = createDefaultConfig();
  const configInMode = { ...config, system: { ...config.system, executionMode: mode } };
  const dataStore = createSqliteDataStore({
    dbPath: ":memory:",
    clock,
    initialConfig: configInMode
  });
  const fake = createFakeOkx(fakeOptions);
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

  return { app, order, fake, okxBroker, cookie, config: configInMode, dataStore, clock };
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

describe("Execution Mode changes cannot strand exchange positions (audit-3 H5)", () => {
  it("refuses switching between the Demo and real-money venues while exchange positions are open", async () => {
    const { app, order, cookie, config } = await setup("Demo", "Live");
    try {
      expect((await order({ stepUpPassword: PASSWORD })).statusCode).toBe(200);

      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/config",
        headers: { cookie },
        payload: {
          config: { ...config, system: { ...config.system, executionMode: "Live" } },
          reason: "go live",
          stepUpPassword: PASSWORD
        }
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/open exchange position/i);
    } finally {
      await app.close();
    }
  });
});

describe("Kill Switch flattens both books and locks until a stepped-up reset (audit-3 H9)", () => {
  const paperPosition = {
    positionId: "pos_paper_1",
    strategyId: "donchian-trend-v1",
    instrumentId: "ETH-USDT-SWAP",
    side: "long" as const,
    contracts: "1",
    entryPrice: "3000",
    protectiveStopPrice: "2900",
    takeProfitPrice: null,
    initialRiskUsdt: "1.00",
    unrealizedPnlUsdt: "0.00000000",
    realizedPnlUsdt: "0.00000000",
    feesPaidUsdt: "0.00000000",
    fundingPaidUsdt: "0.00000000",
    openedAtMs: 1_730_000_000_000,
    lastFundingSettledTs: 1_730_000_000_000,
    status: "OPEN" as const,
    closedAtMs: null,
    exitPrice: null,
    exitReason: null
  };

  it("cancels and flattens every paper and exchange position and vetoes new entries", async () => {
    const { app, order, cookie, okxBroker, dataStore } = await setup("Demo", "Demo");
    try {
      expect((await order({ stepUpPassword: PASSWORD })).statusCode).toBe(200);
      dataStore.paperAccountRepo.savePosition(paperPosition);

      const trip = await app.inject({
        method: "POST",
        url: "/api/v1/paper/circuit-breaker",
        headers: { cookie },
        payload: { status: "MANUAL_KILL_SWITCH", reason: "operator drill" }
      });

      expect(trip.statusCode).toBe(200);
      expect(trip.json().killSwitch).toMatchObject({ paperFlat: true, exchangeFlat: true });
      expect(okxBroker.getOpenPositions()).toHaveLength(0);
      expect(dataStore.paperAccountRepo.listOpenPositions()).toHaveLength(0);

      const blocked = await order({ stepUpPassword: PASSWORD });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().error).toMatch(/CIRCUIT_BREAKER_ACTIVE/);
    } finally {
      await app.close();
    }
  });

  it("requires a step-up to re-arm after a kill switch", async () => {
    const { app, cookie, clock } = await setup("Demo", "Demo");
    try {
      const trip = await app.inject({
        method: "POST",
        url: "/api/v1/paper/circuit-breaker",
        headers: { cookie },
        payload: { status: "MANUAL_KILL_SWITCH", reason: "operator drill" }
      });
      expect(trip.statusCode).toBe(200);
      clock.advanceMs(10 * 60 * 1000);

      const rearm = (extra: Record<string, unknown> = {}) =>
        app.inject({
          method: "POST",
          url: "/api/v1/paper/circuit-breaker",
          headers: { cookie },
          payload: { status: "NORMAL", reason: "drill complete", ...extra }
        });

      const denied = await rearm();
      expect(denied.statusCode).toBe(403);
      expect(denied.json().requiresStepUp).toBe(true);

      const ok = await rearm({ stepUpPassword: PASSWORD });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().circuitBreaker.status).toBe("NORMAL");
    } finally {
      await app.close();
    }
  });
});

describe("Kill Switch review follow-ups (audit-3 H9)", () => {
  it("flattens the exchange book when the Risk Engine trips the drawdown Kill Switch on its own", async () => {
    const { app, order, okxBroker, dataStore, clock } = await setup("Demo", "Demo");
    try {
      expect((await order({ stepUpPassword: PASSWORD })).statusCode).toBe(200);
      // A 15% realised loss breaches the default 12% portfolio drawdown kill switch
      dataStore.exchangeLedgerRepo.recordJournal({
        txGroupId: "loss-1",
        ts: clock.nowMs(),
        strategyId: "donchian-trend-v1",
        instrumentId: "ETH-USDT-SWAP",
        debitAccount: "realized_pnl:usdt",
        creditAccount: "cash:usdt",
        amountUsdt: "1500.00000000",
        description: "Realised loss"
      });

      const vetoed = await order({ instrumentId: "ETH-USDT-SWAP", stepUpPassword: PASSWORD });

      expect(vetoed.statusCode).toBe(403);
      expect(dataStore.paperAccountRepo.getCircuitBreaker().status).toBe("DRAWDOWN_KILL_SWITCH");
      expect(okxBroker.getOpenPositions()).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("reports the exchange book as not flat while the venue still holds a position it could not close", async () => {
    const { app, cookie } = await setup("Demo", "Demo", {
      positions: [{ instId: "SOL-USDT-SWAP", pos: "3", posSide: "net" }],
      closeOrdersSucceed: false
    });
    try {
      const trip = await app.inject({
        method: "POST",
        url: "/api/v1/paper/circuit-breaker",
        headers: { cookie },
        payload: { status: "MANUAL_KILL_SWITCH", reason: "operator drill" }
      });
      expect(trip.statusCode).toBe(200);
      expect(trip.json().killSwitch.exchangeFlat).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe("Leaving exchange Execution Modes cannot strand positions (audit-3 H5 review)", () => {
  it("refuses Demo to Paper while exchange positions are open", async () => {
    const { app, order, cookie, config } = await setup("Demo", "Demo");
    try {
      expect((await order({ stepUpPassword: PASSWORD })).statusCode).toBe(200);
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/config",
        headers: { cookie },
        payload: {
          config: { ...config, system: { ...config.system, executionMode: "Paper" } },
          reason: "back to paper",
          stepUpPassword: PASSWORD
        }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/open exchange position/i);
    } finally {
      await app.close();
    }
  });
});
