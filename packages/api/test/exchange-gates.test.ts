import { describe, expect, it, vi } from "vitest";
import {
  ManualClock,
  createDefaultConfig,
  type ExecutionMode,
  type PromotionStage
} from "@keel/core";
import { OkxBroker } from "@keel/broker";
import { createSqliteDataStore } from "@keel/data";
import { TotpEngine, createKeelServer } from "../src/index.js";
import { createFakeOkx } from "../../broker/test/fake-okx.js";

const PASSWORD = "correct-horse-battery-staple";

async function setup(
  mode: ExecutionMode,
  strategyStage: PromotionStage | null,
  fakeOptions: Parameters<typeof createFakeOkx>[0] = {},
  // Real-money modes need an enrolled authenticator (Gate G3); enrolled by default there
  { totp = mode === "Live-Ramp" || mode === "Live" }: { readonly totp?: boolean } = {}
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
  if (totp) {
    const secret = String(bootRes.json().totpSecretBase32);
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/totp/verify",
      headers: { cookie },
      payload: { code: TotpEngine.generateCode(secret, clock.nowMs()) }
    });
  }

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

describe("Venue Book equity is reconciled to the OKX balance before sizing", () => {
  const rebase = (app: Awaited<ReturnType<typeof setup>>["app"], cookie: string, extra = {}) =>
    app.inject({
      method: "POST",
      url: "/api/v1/broker/venue-capital/rebase",
      headers: { cookie },
      payload: { reason: "Align Venue Book with OKX balance", ...extra }
    });

  it("refuses entry orders while the OKX balance is below the Venue Book equity beyond the drift tolerance", async () => {
    const { app, order, fake } = await setup("Demo", "Demo", { venueEquityUsdt: "5000" });
    try {
      const res = await order({ stepUpPassword: PASSWORD });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/rebase/i);
      expect(placedOrders(fake)).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("refuses entry orders when the OKX balance cannot be read", async () => {
    const { app, order, fake } = await setup("Demo", "Demo", { venueEquityUsdt: null });
    try {
      const res = await order({ stepUpPassword: PASSWORD });
      expect(res.statusCode).toBe(503);
      expect(placedOrders(fake)).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("rebases the flat Venue Book to the OKX balance with step-up, after which entries are sized from it", async () => {
    const { app, order, cookie, dataStore, clock } = await setup("Demo", "Demo", {
      venueEquityUsdt: "5000"
    });
    try {
      expect((await rebase(app, cookie)).statusCode).toBe(403);

      const res = await rebase(app, cookie, { stepUpPassword: PASSWORD });
      expect(res.statusCode).toBe(200);
      expect(res.json().venueEquityUsdt).toBe("5000.00000000");
      expect(
        dataStore.exchangeLedgerRepo
          .getRiskMetrics({ asOfMs: clock.nowMs() })
          .currentEquityUsdt.toFixed(2)
      ).toBe("5000.00");

      expect((await order({ stepUpPassword: PASSWORD })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("refuses a rebase while the Venue Book holds open positions, but still allows reduce-only closes", async () => {
    const { app, order, cookie, fake } = await setup("Demo", "Demo");
    try {
      expect((await order({ stepUpPassword: PASSWORD })).statusCode).toBe(200);
      fake.setVenueEquityUsdt("5000");

      const res = await rebase(app, cookie, { stepUpPassword: PASSWORD });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/open position/i);

      const close = await order({
        side: "short",
        reduceOnly: true,
        protectiveStopPrice: undefined
      });
      expect(close.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe("Venue Book losses are watched between orders (audit-4 H1)", () => {
  it("trips the drawdown Kill Switch from the heartbeat when Venue Book losses breach the limit, with no order attempted", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { app, order, okxBroker, dataStore, clock } = await setup("Demo", "Demo");
    try {
      expect((await order({ stepUpPassword: PASSWORD })).statusCode).toBe(200);
      dataStore.exchangeLedgerRepo.recordJournal({
        txGroupId: "loss-heartbeat",
        ts: clock.nowMs(),
        strategyId: "donchian-trend-v1",
        instrumentId: "BTC-USDT-SWAP",
        debitAccount: "realized_pnl:usdt",
        creditAccount: "cash:usdt",
        amountUsdt: "1500.00000000",
        description: "Realised loss"
      });
      expect(dataStore.paperAccountRepo.getCircuitBreaker().status).toBe("NORMAL");

      await vi.advanceTimersByTimeAsync(15_000);

      expect(dataStore.paperAccountRepo.getCircuitBreaker().status).toBe("DRAWDOWN_KILL_SWITCH");
      expect(okxBroker.getOpenPositions()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });
});

describe("Live-Ramp sizes from the strategy's ramp allocation (audit-4 H2)", () => {
  const maxLotsFrom = (error: string) => Number(/maximum \((\d+)\)/.exec(error)?.[1] ?? NaN);

  it("caps a Live-Ramp entry at the strategy's ramp allocation of its 1R size", async () => {
    const { app, order, dataStore } = await setup("Live-Ramp", "Live-Ramp");
    try {
      const full = await order({ sizeLots: 1_000_000, stepUpPassword: PASSWORD });
      expect(full.statusCode).toBe(403);
      const fullMax = maxLotsFrom(full.json().error);
      expect(fullMax).toBeGreaterThanOrEqual(4);

      const promo = dataStore.promotionRepo.getPromotion("donchian-trend-v1");
      if (!promo) throw new Error("promotion missing");
      dataStore.promotionRepo.upsertPromotion({ ...promo, rampAllocationPct: 25 });

      const ramped = await order({ sizeLots: 1_000_000, stepUpPassword: PASSWORD });
      expect(ramped.statusCode).toBe(403);
      expect(ramped.json().error).toMatch(/Live-Ramp allocation 25%/);
      expect(maxLotsFrom(ramped.json().error)).toBe(Math.floor(fullMax / 4));
    } finally {
      await app.close();
    }
  });
});

describe("Venue stages are promoted on Venue Book evidence (audit-4 H3)", () => {
  const closedPosition = (n: number) => ({
    positionId: `pos_paper_${n}`,
    strategyId: "donchian-trend-v1",
    instrumentId: "BTC-USDT-SWAP",
    side: "long" as const,
    contracts: "1",
    entryPrice: "50000",
    protectiveStopPrice: "49000",
    takeProfitPrice: null,
    initialRiskUsdt: "10.00",
    unrealizedPnlUsdt: "0.00000000",
    realizedPnlUsdt: "5.00000000",
    feesPaidUsdt: "0.30000000",
    fundingPaidUsdt: "0.00000000",
    openedAtMs: 1_730_000_000_000,
    lastFundingSettledTs: 1_730_000_000_000,
    status: "CLOSED" as const,
    closedAtMs: 1_730_000_100_000,
    exitPrice: "50500",
    exitReason: "TAKE_PROFIT"
  });

  it("does not make a Demo strategy eligible for Live-Ramp on paper trades alone", async () => {
    const { app, cookie, dataStore } = await setup("Demo", "Demo");
    try {
      for (let n = 0; n < 60; n += 1) {
        dataStore.paperAccountRepo.savePosition(closedPosition(n));
      }

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/promotion/evaluate",
        headers: { cookie },
        payload: { strategyId: "donchian-trend-v1" }
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().promotion.eligibleNextStage).not.toBe("Live-Ramp");
      expect(res.json().promotion.paperTradesCount).toBe(0);
    } finally {
      await app.close();
    }
  });
});

describe("Gate G3 requires MFA for real money (audit-4 H4)", () => {
  it("refuses real-money orders until a TOTP authenticator is enrolled", async () => {
    const { app, order, fake } = await setup("Live-Ramp", "Live-Ramp", {}, { totp: false });
    try {
      const res = await order({ stepUpPassword: PASSWORD });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/Gate G3: enrol a TOTP authenticator/);
      expect(placedOrders(fake)).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("refuses switching into a real-money Execution Mode without an enrolled authenticator", async () => {
    const { app, cookie, config } = await setup("Demo", "Demo");
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/v1/config",
        headers: { cookie },
        payload: {
          config: { ...config, system: { ...config.system, executionMode: "Live-Ramp" } },
          reason: "Go live",
          stepUpPassword: PASSWORD
        }
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/Gate G3/);
    } finally {
      await app.close();
    }
  });
});
