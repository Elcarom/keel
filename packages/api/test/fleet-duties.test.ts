import { describe, expect, it } from "vitest";
import {
  ManualClock,
  createDefaultConfig,
  type Assessment,
  type Bot,
  type KeelConfig,
  type NotificationMessage,
  type Proposition
} from "@keel/core";
import { createSqliteDataStore } from "@keel/data";
import { FleetDuties, driftOf, type FleetDutiesPort } from "../src/fleet-duties.js";

// Monday 2026-10-26, 08:00 UTC
const MONDAY_8AM = Date.UTC(2026, 9, 26, 8);

const ASSESSMENT: Assessment = {
  score: 80,
  verdict: "seaworthy",
  headline: "+20% over 730 days",
  gatePassed: true,
  dataSource: "okx",
  fromTs: 0,
  toTs: 1,
  totalTrades: 120,
  winRate: 0.55,
  returnPct: 20,
  maxDrawdownPct: 8,
  sharpeRatio: 1.4,
  deflatedSharpeRatio: 0.9,
  avgR: 0.2,
  buyAndHoldReturnPct: 10,
  equityCurvePct: [],
  days: 730,
  seaTrial: {
    checks: [],
    segments: [],
    neighbours: [],
    sibling: null,
    monteCarlo: {
      paths: 1000,
      lossProbabilityPct: 5,
      p5ReturnPct: 2,
      medianReturnPct: 18,
      p95DrawdownPct: 10
    },
    tStat: 2.5,
    pValue: 0.01,
    stressAvgR: 0.1,
    outOfSampleAvgR: 0.12,
    randomEntryPercentile: 95,
    trials: 4,
    funding: "assumed",
    weeklyEquityPct: Array.from({ length: 40 }, (_, i) => Math.sin(i / 2) * 3 + i * 0.4),
    avgHoldHours: 12
  },
  lookalike: null
};

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    botId: "b1",
    name: "Trade Wind",
    tagline: "Rides the wind.",
    blueprint: {
      name: "Trade Wind",
      tagline: "Rides the wind.",
      archetype: "momentum",
      instrumentId: "BTC-USDT-SWAP",
      direction: "both",
      lookbackPeriod: 24,
      fastPeriod: 8,
      entryThreshold: 1,
      stopAtrMultiple: 2,
      rewardMultiple: 2,
      rationale: "",
      basket: [],
      trailingAtrMultiple: null,
      maxBarsHeld: null,
      invention: null
    },
    mode: "paper",
    status: "running",
    statusReason: null,
    walletId: "w1",
    walletName: "Main",
    allocationUsdt: "1000.00",
    createdAtMs: 0,
    retiredAtMs: null,
    backtest: ASSESSMENT,
    equityUsdt: "1000.00",
    pnlUsdt: "0.00",
    returnPct: 0,
    maxDrawdownPct: 3,
    tradesCount: 10,
    winRate: 0.5,
    openPosition: null,
    openPositions: [],
    lastBarAtMs: null,
    equityCurve: [],
    recentTrades: [],
    equityHistory: [],
    health: "on_course",
    coins: [],
    ...overrides
  };
}

function proposition(id: string, overrides: Partial<Assessment> = {}): Proposition {
  return {
    propositionId: id,
    batchId: "d1",
    createdAtMs: 0,
    source: "claude",
    blueprint: { ...bot().blueprint, name: `Idea ${id}` },
    status: "ranked",
    assessment: { ...ASSESSMENT, ...overrides },
    rank: 1,
    error: null,
    botId: null
  };
}

function harness(options: {
  bots?: Bot[];
  propositions?: Proposition[];
  wallets?: { walletId: string; name: string; availableUsdt: string; allocatedUsdt: string }[];
  configure?: (config: KeelConfig) => KeelConfig;
  designer?: string;
  nowMs?: number;
}) {
  const clock = new ManualClock(options.nowMs ?? MONDAY_8AM);
  const store = createSqliteDataStore({ dbPath: ":memory:", clock });
  const config = (options.configure ?? ((c) => c))(createDefaultConfig());
  const sent: NotificationMessage[] = [];
  const calls = {
    launched: [] as { propositionId: string; name: string; allocationUsdt: string }[],
    paused: [] as { botId: string; reason: string }[],
    designed: 0,
    rebalanced: [] as string[]
  };
  const port: FleetDutiesPort = {
    overview: () => ({
      bots: options.bots ?? [],
      wallets: options.wallets ?? [],
      designer: { source: options.designer ?? "claude" }
    }),
    listDesigns: () => [{ propositions: options.propositions ?? [] }],
    launch: (propositionId, input) => {
      calls.launched.push({
        propositionId,
        name: input.name,
        allocationUsdt: input.allocationUsdt
      });
      return bot({ name: input.name });
    },
    pause: (botId, reason) => {
      calls.paused.push({ botId, reason });
      return bot({ status: "paused" });
    },
    design: () => {
      calls.designed += 1;
      return Promise.resolve();
    },
    rebalanceStakes: (walletId) => {
      calls.rebalanced.push(walletId);
      return [];
    }
  };
  const duties = new FleetDuties({
    clock,
    repo: store.fleetRepo,
    fleet: port,
    getConfig: () => config,
    notify: (message) => {
      sent.push(message);
      return Promise.resolve();
    }
  });
  return { duties, calls, sent, clock };
}

const AUTOPILOT = (c: KeelConfig): KeelConfig => ({
  ...c,
  fleet: { ...c.fleet, autopilotEnabled: true, digestEnabled: false, driftWatchEnabled: false }
});
const AUTOPILOT_WALLET = {
  walletId: "wa",
  name: "Autopilot",
  availableUsdt: "4000.00000000",
  allocatedUsdt: "1000.00000000"
};

describe("Drift watch", () => {
  it("leaves a boat alone while it sails within its sea trial", () => {
    expect(driftOf(bot({ maxDrawdownPct: 12, tradesCount: 30, winRate: 0.45 }))).toBeNull();
  });

  it("docks a boat whose worst dip goes well beyond its sea trial's", () => {
    // The trial's 95th-percentile dip is 10%, so the limit is 15%
    expect(driftOf(bot({ maxDrawdownPct: 16 }))).toBe(
      "its worst dip of 16.0% is beyond the 15.0% its sea trial allows"
    );
  });

  it("docks a boat losing far more often than its sea trial, once there are trades enough to tell", () => {
    // Backtest wins 55%; two standard errors below that after 40 trades is about 39%
    expect(driftOf(bot({ tradesCount: 40, winRate: 0.3 }))).toMatch(/won 30% of 40 trades/);
    expect(driftOf(bot({ tradesCount: 15, winRate: 0.2 }))).toBeNull();
  });

  it("pauses drifting boats and says why", async () => {
    const { duties, calls, sent } = harness({
      bots: [bot({ botId: "b1", maxDrawdownPct: 20 }), bot({ botId: "b2", name: "Calm" })],
      configure: (c) => ({ ...c, fleet: { ...c.fleet, digestEnabled: false } })
    });
    await duties.run();
    expect(calls.paused.map((p) => p.botId)).toEqual(["b1"]);
    expect(calls.paused[0]?.reason).toMatch(/^Drift watch brought it back to harbour/);
    expect(sent.map((m) => m.severity)).toEqual(["WARNING"]);
  });
});

describe("Autopilot", () => {
  it("launches the best seaworthy, original proposition with its share of the wallet", async () => {
    const { duties, calls } = harness({
      configure: AUTOPILOT,
      wallets: [AUTOPILOT_WALLET],
      propositions: [
        proposition("p1", { score: 70 }),
        proposition("p2", { score: 90 }),
        proposition("p3", { score: 99, verdict: "promising" }),
        proposition("p4", { score: 95, lookalike: { name: "X", kind: "boat", correlation: 0.9 } })
      ]
    });
    await duties.run();
    // 10% of the wallet's 5,000 total
    expect(calls.launched).toEqual([
      { propositionId: "p2", name: "Idea p2", allocationUsdt: "500.00" }
    ]);
  });

  it("never launches a copy of a boat already sailing", async () => {
    const twin = bot({ name: "Twin" });
    const { duties, calls } = harness({
      configure: AUTOPILOT,
      wallets: [AUTOPILOT_WALLET],
      bots: [twin],
      propositions: [proposition("p1")]
    });
    await duties.run();
    expect(calls.launched).toEqual([]);
    expect(duties.status().find((d) => d.duty === "autopilot")?.note).toBe(
      "No seaworthy, original proposition on the slipway yet"
    );
  });

  it("spends no more than the wallet holds, and waits for a wallet to draw from", async () => {
    const low = harness({
      configure: AUTOPILOT,
      wallets: [
        { ...AUTOPILOT_WALLET, availableUsdt: "50.00000000", allocatedUsdt: "4950.00000000" }
      ],
      propositions: [proposition("p1")]
    });
    await low.duties.run();
    expect(low.calls.launched).toEqual([]);

    const none = harness({ configure: AUTOPILOT, propositions: [proposition("p1")] });
    await none.duties.run();
    expect(none.duties.status().find((d) => d.duty === "autopilot")?.note).toMatch(
      /^Waiting for a wallet named "Autopilot"/
    );
  });
});

describe("Scheduled duties", () => {
  it("sends one digest a day, after the set hour", async () => {
    const early = harness({ nowMs: Date.UTC(2026, 9, 26, 5) });
    await early.duties.run();
    expect(early.sent).toEqual([]);

    const { duties, sent, clock } = harness({ bots: [bot()] });
    await duties.run();
    await duties.run();
    expect(sent.map((m) => m.title)).toEqual(["Keel fleet digest"]);
    clock.advanceMs(24 * 3_600_000);
    await duties.run();
    expect(sent).toHaveLength(2);
  });

  it("runs the night shift once on its day, and only with Claude to ask", async () => {
    const nightly = (c: KeelConfig): KeelConfig => ({
      ...c,
      fleet: { ...c.fleet, nightShiftEnabled: true, digestEnabled: false }
    });
    const monday = harness({ configure: nightly });
    await monday.duties.run();
    await monday.duties.run();
    expect(monday.calls.designed).toBe(1);

    const tuesday = harness({ configure: nightly, nowMs: MONDAY_8AM + 24 * 3_600_000 });
    await tuesday.duties.run();
    expect(tuesday.calls.designed).toBe(0);

    const keyless = harness({ configure: nightly, designer: "sample" });
    await keyless.duties.run();
    expect(keyless.calls.designed).toBe(0);
  });

  it("rebalances each wallet once on Mondays", async () => {
    const weekly = (c: KeelConfig): KeelConfig => ({
      ...c,
      fleet: { ...c.fleet, rebalanceEnabled: true, digestEnabled: false }
    });
    const { duties, calls } = harness({
      configure: weekly,
      wallets: [AUTOPILOT_WALLET, { ...AUTOPILOT_WALLET, walletId: "wb", name: "Main" }]
    });
    await duties.run();
    await duties.run();
    expect(calls.rebalanced).toEqual(["wa", "wb"]);
  });
});
