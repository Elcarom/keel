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
import { type DesignResearch } from "@keel/ai";
import { FleetDuties, driftOf, standingOf, type FleetDutiesPort } from "../src/fleet-duties.js";

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
    rig: {
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
    standing: null,
    ...overrides
  };
}

const DAY = 24 * 3_600_000;

/** A boat launched `days` ago whose equity has moved by `daily` (repeating) each day since. */
function sailed(days: number, daily: readonly number[], overrides: Partial<Bot> = {}): Bot {
  const createdAtMs = MONDAY_8AM - days * DAY;
  let equity = 1000;
  const equityHistory = Array.from({ length: days }, (_, i) => {
    equity *= 1 + (daily[i % daily.length] ?? 0);
    return { ts: createdAtMs + (i + 1) * DAY, equityUsdt: equity.toFixed(2) };
  });
  return bot({ createdAtMs, equityHistory, ...overrides });
}

function proposition(id: string, overrides: Partial<Assessment> = {}): Proposition {
  return {
    propositionId: id,
    batchId: "d1",
    createdAtMs: 0,
    source: "claude",
    rig: { ...bot().rig, name: `Idea ${id}` },
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
  /** Upgrade batches: the boat each improves on, its propositions, and when it was drawn up. */
  upgrades?: { upgradeOf: string; propositions: Proposition[]; createdAtMs?: number }[];
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
    retired: [] as { botId: string; reason: string }[],
    designed: 0,
    briefs: [] as { notes: string; research: DesignResearch; upgradeOf: string | null }[],
    rebalanced: [] as string[]
  };
  const port: FleetDutiesPort = {
    overview: () => ({
      bots: options.bots ?? [],
      wallets: options.wallets ?? [],
      designer: { source: options.designer ?? "claude" }
    }),
    listDesigns: () => [
      { createdAtMs: 0, brief: { upgradeOf: null }, propositions: options.propositions ?? [] },
      ...(options.upgrades ?? []).map((u) => ({
        createdAtMs: u.createdAtMs ?? 0,
        brief: { upgradeOf: u.upgradeOf },
        propositions: u.propositions
      }))
    ],
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
    retire: (botId, reason) => {
      calls.retired.push({ botId, reason });
      return bot({ status: "retired" });
    },
    design: (brief, research, upgradeOf) => {
      calls.designed += 1;
      calls.briefs.push({ notes: brief.notes, research, upgradeOf });
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

    const tuesday = harness({
      configure: (c) => {
        const n = nightly(c);
        return { ...n, fleet: { ...n.fleet, nightShiftCadence: "weekly" } };
      },
      nowMs: MONDAY_8AM + 24 * 3_600_000
    });
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

// Loses 1% then makes 0.5%, day after day: a clearly losing live record
const LOSING = [-0.01, 0.005];
// Makes 1% then gives back 0.5%: a clearly winning one
const WINNING = [0.01, -0.005];

describe("Standing", () => {
  it("starts at the sea-trial score and moves towards the live record", () => {
    expect(standingOf(sailed(0, LOSING), MONDAY_8AM, 14)).toEqual({ score: 80, proven: false });
    const loser = standingOf(sailed(30, LOSING), MONDAY_8AM, 14);
    const winner = standingOf(sailed(30, WINNING), MONDAY_8AM, 14);
    expect(loser?.proven).toBe(true);
    expect(loser?.score ?? 0).toBeLessThan(60);
    expect(winner?.score ?? 0).toBeGreaterThan(80);
    // After 90 days the live record is all that counts
    expect(standingOf(sailed(120, LOSING), MONDAY_8AM, 14)?.score ?? 99).toBeLessThan(5);
  });

  it("is still proving itself until it has sailed the set number of days", () => {
    expect(standingOf(sailed(10, LOSING), MONDAY_8AM, 14)?.proven).toBe(false);
    expect(standingOf(bot({ backtest: null }), MONDAY_8AM, 14)).toBeNull();
  });
});

const FULL = (c: KeelConfig): KeelConfig => ({
  ...AUTOPILOT(c),
  fleet: { ...AUTOPILOT(c).fleet, autopilotMaxBoats: 2, autopilotMinScore: 45 }
});
/** A different bet from every boat's sea trial, so it is never a lookalike. */
const DIFFERENT = {
  ...ASSESSMENT.seaTrial,
  weeklyEquityPct: Array.from({ length: 40 }, (_, i) => Math.cos(i * 1.7) * 4)
} as Assessment["seaTrial"];

describe("A full fleet", () => {
  const fleet = () => [
    sailed(30, LOSING, { botId: "weak", name: "Leaky Hull", walletId: "wa" }),
    sailed(30, WINNING, { botId: "strong", name: "Fair Wind", walletId: "wa" })
  ];

  it("replaces its weakest proven boat with a proposition that clearly out-scores it", async () => {
    const { duties, calls, sent } = harness({
      configure: FULL,
      wallets: [AUTOPILOT_WALLET],
      bots: fleet(),
      propositions: [proposition("p1", { score: 70, seaTrial: DIFFERENT })]
    });
    await duties.run();
    expect(calls.retired.map((r) => r.botId)).toEqual(["weak"]);
    expect(calls.retired[0]?.reason).toMatch(
      /^Replaced by Idea p1, a better proposition: sea-trial score 70/
    );
    expect(calls.launched.map((l) => l.propositionId)).toEqual(["p1"]);
    expect(sent.map((m) => m.title)).toContain("Autopilot replaced Leaky Hull with Idea p1");
  });

  it("keeps its boats when no proposition beats the weakest by the margin", async () => {
    const weakStanding = standingOf(fleet()[0] ?? bot(), MONDAY_8AM, 14)?.score ?? 0;
    const { duties, calls } = harness({
      configure: FULL,
      wallets: [AUTOPILOT_WALLET],
      bots: fleet(),
      propositions: [proposition("p1", { score: weakStanding + 9, seaTrial: DIFFERENT })]
    });
    await duties.run();
    expect(calls.retired).toEqual([]);
    expect(calls.launched).toEqual([]);
    expect(duties.status().find((d) => d.duty === "autopilot")?.note).toMatch(
      new RegExp(`needs ${weakStanding + 10} to replace Leaky Hull`)
    );
  });

  it("never judges a boat that is still proving itself, nor replaces more than one a day", async () => {
    const young = harness({
      configure: FULL,
      wallets: [AUTOPILOT_WALLET],
      bots: [
        sailed(5, LOSING, { botId: "a", name: "A", walletId: "wa" }),
        sailed(5, LOSING, { botId: "b", name: "B", walletId: "wa" })
      ],
      propositions: [proposition("p1", { score: 99, seaTrial: DIFFERENT })]
    });
    await young.duties.run();
    expect(young.calls.retired).toEqual([]);

    const busy = harness({
      configure: FULL,
      wallets: [AUTOPILOT_WALLET],
      bots: [
        ...fleet(),
        bot({
          botId: "gone",
          name: "Gone",
          walletId: "wa",
          status: "retired",
          retiredAtMs: MONDAY_8AM - 3_600_000,
          statusReason: "Replaced by Fair Wind, a better proposition"
        })
      ],
      propositions: [proposition("p1", { score: 99, seaTrial: DIFFERENT })]
    });
    await busy.duties.run();
    expect(busy.calls.retired).toEqual([]);
  });

  it("leaves boats in other wallets alone", async () => {
    const { duties, calls } = harness({
      configure: FULL,
      wallets: [AUTOPILOT_WALLET],
      bots: [
        ...fleet(),
        sailed(60, LOSING, { botId: "mine", name: "Operator's Own", walletId: "w1" })
      ],
      propositions: [proposition("p1", { score: 70, seaTrial: DIFFERENT })]
    });
    await duties.run();
    expect(calls.retired.map((r) => r.botId)).toEqual(["weak"]);
  });
});

describe("Upgrades", () => {
  it("an Upgrade that clearly beats its boat takes its place, though it trades much like it", async () => {
    const parent = sailed(30, LOSING, { botId: "weak", name: "Leaky Hull", walletId: "wa" });
    const upgrade = proposition("u1", {
      score: 75,
      lookalike: { name: "Leaky Hull", kind: "boat", correlation: 0.9 }
    });
    const { duties, calls } = harness({
      configure: AUTOPILOT,
      wallets: [AUTOPILOT_WALLET],
      bots: [parent],
      upgrades: [{ upgradeOf: "weak", propositions: [upgrade] }]
    });
    await duties.run();
    expect(calls.retired.map((r) => r.botId)).toEqual(["weak"]);
    expect(calls.retired[0]?.reason).toMatch(/its Upgrade/);
    expect(calls.launched.map((l) => l.propositionId)).toEqual(["u1"]);
  });

  it("an Upgrade that does not beat its boat never sails beside it", async () => {
    const parent = sailed(30, WINNING, { botId: "good", name: "Fair Wind", walletId: "wa" });
    const { duties, calls } = harness({
      configure: AUTOPILOT,
      wallets: [AUTOPILOT_WALLET],
      bots: [parent],
      upgrades: [
        { upgradeOf: "good", propositions: [proposition("u1", { score: 80, seaTrial: DIFFERENT })] }
      ]
    });
    await duties.run();
    expect(calls.retired).toEqual([]);
    expect(calls.launched).toEqual([]);
  });
});

describe("The night shift's research round", () => {
  const nightly = (c: KeelConfig): KeelConfig => ({
    ...c,
    fleet: { ...c.fleet, nightShiftEnabled: true, digestEnabled: false }
  });

  it("shows Claude the fleet's record and failures, then asks for an Upgrade of the weakest proven boat", async () => {
    const sunk = proposition("s1", {
      verdict: "sinks",
      headline: "Lost 12% after costs",
      score: 20
    });
    const { duties, calls } = harness({
      configure: nightly,
      bots: [
        sailed(30, LOSING, { botId: "weak", name: "Leaky Hull" }),
        sailed(30, WINNING, { botId: "strong", name: "Fair Wind" }),
        sailed(3, LOSING, { botId: "young", name: "Newcomer" })
      ],
      propositions: [{ ...sunk, createdAtMs: MONDAY_8AM - DAY }]
    });
    await duties.run();

    expect(calls.briefs.map((b) => b.upgradeOf)).toEqual([null, "weak"]);
    const [gaps, upgrade] = calls.briefs;
    expect(gaps?.research.fleetReport).toHaveLength(3);
    expect(gaps?.research.fleetReport[0]).toMatch(
      /^Leaky Hull \(momentum, BTC, running\): sea trial scored 80 .*; at sea 30 days: .*standing \d+\.$/
    );
    expect(gaps?.research.lessons).toEqual(["Idea s1 (momentum, BTC) sinks: Lost 12% after costs"]);
    expect(upgrade?.research.improve?.name).toBe("Leaky Hull");
    expect(duties.status().find((d) => d.duty === "nightShift")?.note).toBe(
      "Drafted 4 new ideas; Upgrades of Leaky Hull"
    );
  });

  it("does not try to improve the same boat again within two weeks", async () => {
    const { duties, calls } = harness({
      configure: nightly,
      bots: [sailed(30, LOSING, { botId: "weak", name: "Leaky Hull" })],
      upgrades: [{ upgradeOf: "weak", propositions: [], createdAtMs: MONDAY_8AM - 5 * DAY }]
    });
    await duties.run();
    expect(calls.briefs.map((b) => b.upgradeOf)).toEqual([null]);
  });
});
