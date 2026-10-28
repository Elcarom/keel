import { describe, expect, it } from "vitest";
import {
  ManualClock,
  createDefaultConfig,
  type Bot,
  type DesignBatch,
  type FleetOverview,
  type Wallet
} from "@keel/core";
import { OkxPublicIngestor, createSqliteDataStore, seedSyntheticMarketSeries } from "@keel/data";
import { createKeelServer } from "../src/index.js";

const PASSWORD = "correct-horse-battery-staple";
const HEADERS = { "cf-connecting-ip": "203.0.113.9", "x-forwarded-proto": "https" };
// 2026-10-25, after the sealed 2026 holdout partition
const NOW_MS = 1_793_000_000_000;

async function setup() {
  const clock = new ManualClock(NOW_MS);
  const config = createDefaultConfig();
  const dataStore = createSqliteDataStore({ dbPath: ":memory:", clock, initialConfig: config });
  // OKX is unreachable in tests: backtests fall back to (and are labelled as) synthetic data
  const marketIngestor = new OkxPublicIngestor({
    marketDataRepo: dataStore.marketDataRepo,
    fetchHistoryCandles: () => Promise.reject(new Error("offline")),
    fetchHistoryFunding: () => Promise.reject(new Error("offline"))
  });
  let bootstrapToken = "";
  const app = await createKeelServer({
    config,
    clock,
    dataStore,
    marketIngestor,
    seaTrial: { randomEntryPaths: 20, monteCarloPaths: 200 },
    onBootstrapToken: (t) => {
      bootstrapToken = t;
    }
  });
  const bootRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/bootstrap",
    headers: HEADERS,
    payload: { bootstrapToken, username: "operator", password: PASSWORD }
  });
  const cookie = String(bootRes.headers["set-cookie"] ?? "").split(";")[0] ?? "";

  const call = async (method: "GET" | "POST" | "DELETE", url: string, payload?: object) => {
    const res = await app.inject({
      method,
      url,
      headers: { ...HEADERS, cookie },
      ...(payload ? { payload } : method === "GET" ? {} : { payload: {} })
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  };
  const overview = async () =>
    (await call("GET", "/api/v1/fleet")).body as unknown as FleetOverview;
  const designAndWait = async (count = 3): Promise<DesignBatch> => {
    const res = await call("POST", "/api/v1/fleet/designs", {
      instruments: ["BTC-USDT-SWAP"],
      styles: [],
      riskAppetite: "balanced",
      direction: "any",
      count,
      notes: ""
    });
    expect(res.status).toBe(200);
    const batchId = (res.body["batch"] as DesignBatch).batchId;
    for (let i = 0; i < 400; i++) {
      const list = (await call("GET", "/api/v1/fleet/designs")).body["batches"] as DesignBatch[];
      const batch = list.find((b) => b.batchId === batchId);
      if (batch?.status === "done") return batch;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Assessment did not finish");
  };
  const launch = async (batch: DesignBatch, allocationUsdt = "2000", name = "Test Vessel") => {
    const wallet = (await overview()).wallets[0] as Wallet;
    const top = batch.propositions[0];
    if (!top) throw new Error("No proposition");
    return call("POST", `/api/v1/fleet/propositions/${top.propositionId}/launch`, {
      name,
      walletId: wallet.walletId,
      allocationUsdt,
      mode: "paper"
    });
  };
  return { app, clock, dataStore, call, overview, designAndWait, launch };
}

describe("Fleet API", () => {
  it("requires a signed-in operator", async () => {
    const { app } = await setup();
    const res = await app.inject({ method: "GET", url: "/api/v1/fleet", headers: HEADERS });
    expect(res.statusCode).toBe(401);
  });

  it("starts with a funded paper treasury, no bots and live trading unavailable", async () => {
    const { overview } = await setup();
    const fleet = await overview();
    expect(fleet.bots).toEqual([]);
    expect(fleet.wallets).toHaveLength(1);
    expect(fleet.wallets[0]?.availableUsdt).toBe("10000.00000000");
    expect(fleet.liveTradingAvailable).toBe(false);
    expect(fleet.designer.source).toBe("sample");
  });

  it("designs, backtests and ranks propositions without a Claude key", async () => {
    const { designAndWait } = await setup();
    const batch = await designAndWait(3);
    expect(batch.source).toBe("sample");
    expect(batch.note).toMatch(/Anthropic API key/);
    expect(batch.propositions).toHaveLength(3);
    const ranks = batch.propositions.map((p) => p.rank);
    expect(ranks).toEqual([1, 2, 3]);
    const scores = batch.propositions.map((p) => p.assessment?.score ?? -1);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    for (const p of batch.propositions) {
      expect(p.status).toBe("ranked");
      expect(p.assessment?.dataSource).toBe("synthetic");
      // In-sample only: two years ending before the sealed holdout (2025-01-01)
      expect(p.assessment?.toTs).toBeLessThanOrEqual(1_735_689_600_000);
      expect(p.assessment?.days).toBe(730);

      // Every proposition goes through the full sea trial
      const trial = p.assessment?.seaTrial;
      expect(trial?.checks).toHaveLength(11);
      expect(trial?.neighbours).toHaveLength(4);
      expect(trial?.sibling?.instrumentId).toBe("ETH-USDT-SWAP");
      expect(trial?.segments).toHaveLength(8);
      expect(trial?.trials).toBeGreaterThanOrEqual(3);
      // A seaworthy verdict is impossible with any critical check failed
      if (p.assessment?.verdict === "seaworthy") {
        expect(trial?.checks.filter((c) => c.critical).every((c) => c.passed)).toBe(true);
      }
    }
    expect(new Set(batch.propositions.map((p) => p.blueprint.name)).size).toBe(3);
  }, 60_000);

  it("designs for any of the ten waters and cross-checks each idea on its sibling market", async () => {
    const { call } = await setup();
    const res = await call("POST", "/api/v1/fleet/designs", {
      instruments: ["SOL-USDT-SWAP"],
      styles: ["squeeze_breakout", "capitulation_fade"],
      riskAppetite: "cautious",
      direction: "any",
      count: 2,
      notes: ""
    });
    expect(res.status).toBe(200);
    const batchId = (res.body["batch"] as DesignBatch).batchId;
    let batch: DesignBatch | undefined;
    for (let i = 0; i < 400 && batch?.status !== "done"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const list = (await call("GET", "/api/v1/fleet/designs")).body["batches"] as DesignBatch[];
      batch = list.find((b) => b.batchId === batchId);
      if (batch?.status === "assessing") expect(batch.progress).toMatch(/Sea trial \d of 2/);
    }
    expect(batch?.progress).toBeNull();
    expect(batch?.propositions.map((p) => p.blueprint.archetype).sort()).toEqual([
      "capitulation_fade",
      "squeeze_breakout"
    ]);
    for (const p of batch?.propositions ?? []) {
      expect(p.status).toBe("ranked");
      expect(p.blueprint.instrumentId).toBe("SOL-USDT-SWAP");
      expect(p.assessment?.seaTrial?.sibling?.instrumentId).toBe("AVAX-USDT-SWAP");
    }
  }, 60_000);

  it("launches a ranked proposition as a paper bot funded from the wallet", async () => {
    const { designAndWait, launch, overview } = await setup();
    const batch = await designAndWait(2);
    const res = await launch(batch, "2500");
    expect(res.status).toBe(200);
    const bot = res.body["bot"] as Bot;
    expect(bot.status).toBe("running");
    expect(bot.mode).toBe("paper");
    expect(bot.equityUsdt).toBe("2500.00");
    expect(bot.backtest?.score).toBe(batch.propositions[0]?.assessment?.score);
    const fleet = await overview();
    expect(fleet.wallets[0]?.availableUsdt).toBe("7500.00000000");
    expect(fleet.wallets[0]?.allocatedUsdt).toBe("2500.00000000");
    expect(fleet.totals.activeBots).toBe(1);

    // The same proposition cannot become two bots
    expect((await launch(batch, "100", "Another")).status).toBe(409);
  }, 60_000);

  it("refuses an allocation larger than the wallet holds", async () => {
    const { designAndWait, launch } = await setup();
    const batch = await designAndWait(2);
    const res = await launch(batch, "10000.01");
    expect(res.status).toBe(400);
    expect(String(res.body["error"])).toMatch(/only has 10000.00 USDT/);
  }, 60_000);

  it("trades only confirmed bars that close after launch, and retiring returns equity to the wallet", async () => {
    const { designAndWait, launch, call, clock, dataStore, overview } = await setup();
    const batch = await designAndWait(2);
    const bot = (await launch(batch, "3000")).body["bot"] as Bot;

    // Ten hours of confirmed bars arrive after launch (bars before it are never traded)
    clock.advanceMs(10 * 3_600_000);
    seedSyntheticMarketSeries({
      marketDataRepo: dataStore.marketDataRepo,
      instrumentId: "BTC-USDT-SWAP",
      endCloseTs: clock.nowMs(),
      barCount1H: 400
    });
    const step = await call("POST", "/api/v1/system/scheduler/step");
    expect(step.status).toBe(200);
    expect(Number(step.body["ticksExecuted"])).toBeGreaterThan(0);

    const stepped = (await overview()).bots[0] as Bot;
    expect(stepped.lastBarAtMs).toBe(Math.floor(clock.nowMs() / 3_600_000) * 3_600_000);
    for (const trade of stepped.recentTrades) {
      expect(trade.openedAtMs).toBeGreaterThanOrEqual(bot.createdAtMs);
    }

    const retired = (await call("POST", `/api/v1/fleet/bots/${bot.botId}/retire`)).body[
      "bot"
    ] as Bot;
    expect(retired.status).toBe("retired");
    expect(retired.openPosition).toBeNull();
    const wallet = (await overview()).wallets[0] as Wallet;
    // 10000 - 3000 allocated + whatever the bot finished with (shown to the cent)
    expect(Math.abs(Number(wallet.availableUsdt) - 7000 - Number(retired.equityUsdt))).toBeLessThan(
      0.01
    );
    expect(wallet.allocatedUsdt).toBe("0.00000000");
  }, 60_000);

  it("pauses, resumes and deletes a bot", async () => {
    const { designAndWait, launch, call, overview } = await setup();
    const batch = await designAndWait(2);
    const bot = (await launch(batch)).body["bot"] as Bot;

    const paused = await call("POST", `/api/v1/fleet/bots/${bot.botId}/pause`);
    expect((paused.body["bot"] as Bot).status).toBe("paused");
    expect((await call("POST", `/api/v1/fleet/bots/${bot.botId}/pause`)).status).toBe(409);

    const resumed = await call("POST", `/api/v1/fleet/bots/${bot.botId}/resume`);
    expect((resumed.body["bot"] as Bot).status).toBe("running");

    const deleted = await call("DELETE", `/api/v1/fleet/bots/${bot.botId}`);
    expect(deleted.status).toBe(200);
    const fleet = await overview();
    expect(fleet.bots).toEqual([]);
    // Deleting retires first, so the allocation is back in the wallet
    expect(fleet.wallets[0]?.availableUsdt).toBe("10000.00000000");
  }, 60_000);

  it("opens and tops up extra paper wallets", async () => {
    const { call } = await setup();
    const created = await call("POST", "/api/v1/fleet/wallets", {
      name: "Experiments",
      startingBalanceUsdt: "500"
    });
    const wallet = created.body["wallet"] as Wallet;
    expect(wallet.availableUsdt).toBe("500.00000000");
    const topped = await call("POST", `/api/v1/fleet/wallets/${wallet.walletId}/deposit`, {
      amountUsdt: "250.5"
    });
    expect((topped.body["wallet"] as Wallet).availableUsdt).toBe("750.50000000");
    const bad = await call("POST", `/api/v1/fleet/wallets/${wallet.walletId}/deposit`, {
      amountUsdt: "0"
    });
    expect(bad.status).toBe(400);
  });
});
