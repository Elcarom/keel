import {
  FLEET_INSTRUMENTS,
  rigMarkets,
  LOOKALIKE_CORRELATION,
  ScaledDecimal,
  type Bot,
  type Clock,
  type FleetDuty,
  type FleetDutyStatus,
  type FleetRepository,
  type KeelConfig,
  type NotificationMessage,
  type Proposition
} from "@keel/core";
import { type DesignResearch } from "@keel/ai";
import { weeklyCorrelation } from "./sea-trial.js";

// ============================================================================
// The Fleet's unattended duties (ADR-0030, ADR-0033). The scheduler runs them after every Fleet
// step. Each is deterministic and paper-only: the night shift asks Claude for new ideas and for
// Upgrades of proven boats, but what launches, docks, replaces or moves money is decided by fixed
// rules here, never by a model.
// ============================================================================

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Smallest stake a boat can be launched or rebalanced with. */
const MIN_STAKE_USDT = ScaledDecimal.fromString("100");

/** What the duties need from the Fleet: its public operations, nothing internal. */
export interface FleetDutiesPort {
  overview(): {
    readonly bots: readonly Bot[];
    readonly wallets: readonly {
      readonly walletId: string;
      readonly name: string;
      readonly availableUsdt: string;
      readonly allocatedUsdt: string;
    }[];
    readonly designer: { readonly source: string };
  };
  listDesigns(limit?: number): readonly {
    readonly createdAtMs: number;
    readonly brief: { readonly upgradeOf: string | null };
    readonly propositions: readonly Proposition[];
  }[];
  launch(
    propositionId: string,
    input: { readonly name: string; readonly walletId: string; readonly allocationUsdt: string }
  ): Bot;
  pause(botId: string, reason: string): Bot;
  retire(botId: string, reason: string): Bot;
  design(
    brief: {
      readonly instruments: (typeof FLEET_INSTRUMENTS)[number][];
      readonly direction: "any";
      readonly count: number;
      readonly notes: string;
    },
    research: DesignResearch,
    upgradeOf: string | null
  ): Promise<unknown>;
  rebalanceStakes(walletId: string): readonly string[];
}

export interface FleetDutiesOptions {
  readonly clock: Clock;
  readonly repo: FleetRepository;
  readonly fleet: FleetDutiesPort;
  readonly getConfig: () => KeelConfig;
  readonly notify?: ((message: NotificationMessage) => Promise<unknown>) | undefined;
}

const LABELS: Readonly<Record<FleetDuty, string>> = {
  digest: "Daily digest",
  driftWatch: "Drift watch",
  autopilot: "Autopilot",
  nightShift: "Night shift",
  rebalance: "Stake rebalancing"
};

const startOfUtcDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

function signedPct(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

/**
 * Whether a running boat has drifted clearly outside what its sea trial expected: a worst dip
 * well beyond the trial's 95th-percentile resampled dip, or, after 20 trades, a win rate more
 * than two standard errors below the backtest's. Null when it is on course.
 */
export function driftOf(bot: Bot): string | null {
  const trial = bot.backtest;
  const expectedDip = trial?.seaTrial?.monteCarlo.p95DrawdownPct;
  if (expectedDip !== undefined) {
    const limit = Math.max(5, expectedDip * 1.5);
    if (bot.maxDrawdownPct > limit) {
      return `its worst dip of ${bot.maxDrawdownPct.toFixed(1)}% is beyond the ${limit.toFixed(1)}% its sea trial allows`;
    }
  }
  const n = bot.tradesCount;
  const p = trial?.winRate;
  if (p !== undefined && n >= 20 && p > 0 && p < 1) {
    const floor = p - 2 * Math.sqrt((p * (1 - p)) / n);
    if (bot.winRate < floor) {
      return `it has won ${Math.round(bot.winRate * 100)}% of ${n} trades, below the ${Math.round(floor * 100)}% its sea trial makes plausible`;
    }
  }
  return null;
}

/** Days over which a boat's Standing shifts from its sea trial to its live record. */
const STANDING_BLEND_DAYS = 90;
/** How long the night shift waits before trying to improve the same boat again. */
const UPGRADE_RETRY_MS = 14 * DAY_MS;

/**
 * 0-100 from the boat's live daily equity: 50 for a flat record, rising and falling with its
 * annualised Sharpe ratio (1 is about 73, 2 about 88). Null until it has a week of days.
 */
function liveScoreOf(history: Bot["equityHistory"]): number | null {
  if (history.length < 8) return null;
  const returns: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const before = Number(history[i - 1]?.equityUsdt ?? 0);
    const after = Number(history[i]?.equityUsdt ?? 0);
    if (before > 0) returns.push(after / before - 1);
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const sd = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1));
  if (sd === 0) return 50;
  const first = history[0]?.ts ?? 0;
  const last = history[history.length - 1]?.ts ?? first;
  const stepDays = Math.max(1, (last - first) / DAY_MS / returns.length);
  const sharpe = (mean / sd) * Math.sqrt(365 / stepDays);
  return 50 + 50 * Math.tanh(sharpe / 2);
}

/**
 * How a boat ranks against propositions (ADR-0033). It starts at its sea-trial score and moves
 * towards its live score over its first 90 days at sea. It is proven, and so can be replaced,
 * once it has sailed the set number of days. Null for a boat without a sea trial.
 */
export function standingOf(
  bot: Pick<Bot, "backtest" | "createdAtMs" | "equityHistory">,
  nowMs: number,
  minLiveDays: number
): { readonly score: number; readonly proven: boolean } | null {
  const trial = bot.backtest?.score;
  if (trial === undefined) return null;
  const days = Math.max(0, (nowMs - bot.createdAtMs) / DAY_MS);
  const weight = Math.min(1, days / STANDING_BLEND_DAYS);
  const live = liveScoreOf(bot.equityHistory) ?? trial;
  return {
    score: Math.round((1 - weight) * trial + weight * live),
    proven: days >= minLiveDays
  };
}

/** One line on a boat's sea trial set against its live record, for Claude. */
export function boatRecord(bot: Bot, nowMs: number, minLiveDays: number): string {
  const t = bot.backtest;
  const days = Math.max(0, Math.floor((nowMs - bot.createdAtMs) / DAY_MS));
  const standing = standingOf(bot, nowMs, minLiveDays);
  const trial = t
    ? `sea trial scored ${t.score} (${signedPct(t.returnPct)} over ${t.days} days, ${t.totalTrades} trades, ${Math.round(t.winRate * 100)}% won, worst dip ${t.maxDrawdownPct.toFixed(1)}%)`
    : "no sea trial";
  const coins = rigMarkets(bot.rig)
    .map((m) => m.replace("-USDT-SWAP", ""))
    .join("/");
  const standingText = standing
    ? `, standing ${standing.score}${standing.proven ? "" : " (still proving itself)"}`
    : "";
  const drifting = bot.health === "drifting" ? ", drifting from its sea trial" : "";
  return `${bot.name} (${bot.rig.archetype}, ${coins}, ${bot.status}): ${trial}; at sea ${days} days: ${signedPct(bot.returnPct)}, ${bot.tradesCount} trades, ${Math.round(bot.winRate * 100)}% won, worst dip ${bot.maxDrawdownPct.toFixed(1)}%${standingText}${drifting}.`;
}

/** A boat name no boat has taken yet, retired ones included. */
function freeName(base: string, bots: readonly Bot[]): string {
  const taken = new Set(bots.map((b) => b.name.toLowerCase()));
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base.slice(0, 34)} ${n}`;
  return name;
}

interface Candidate {
  readonly proposition: Proposition;
  readonly score: number;
  /** The boat this proposition was drawn up to improve on, when it is an Upgrade. */
  readonly upgradeOf: string | null;
}

export class FleetDuties {
  private readonly clock: Clock;
  private readonly repo: FleetRepository;
  private readonly fleet: FleetDutiesPort;
  private readonly getConfig: () => KeelConfig;
  private readonly notify: ((message: NotificationMessage) => Promise<unknown>) | null;
  private readonly notes = new Map<FleetDuty, string>();
  private running = false;

  public constructor(options: FleetDutiesOptions) {
    this.clock = options.clock;
    this.repo = options.repo;
    this.fleet = options.fleet;
    this.getConfig = options.getConfig;
    this.notify = options.notify ?? null;
  }

  public status(): FleetDutyStatus[] {
    const cfg = this.getConfig().fleet;
    const enabled: Readonly<Record<FleetDuty, boolean>> = {
      digest: cfg.digestEnabled,
      driftWatch: cfg.driftWatchEnabled,
      autopilot: cfg.autopilotEnabled,
      nightShift: cfg.nightShiftEnabled,
      rebalance: cfg.rebalanceEnabled
    };
    return (Object.keys(LABELS) as FleetDuty[]).map((duty) => ({
      duty,
      label: LABELS[duty],
      enabled: enabled[duty],
      lastRunMs: this.repo.getDutyLastRun(duty),
      note: this.notes.get(duty) ?? null
    }));
  }

  /** Runs every duty that is due. Returns problems for the scheduler to report. */
  public async run(): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    const errors: string[] = [];
    const attempt = async (duty: FleetDuty, work: () => Promise<void> | void) => {
      try {
        await work();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.notes.set(duty, `Failed: ${message}`);
        errors.push(`${LABELS[duty]} failed: ${message}`);
      }
    };
    try {
      const cfg = this.getConfig().fleet;
      if (cfg.driftWatchEnabled) await attempt("driftWatch", () => this.driftWatch());
      if (cfg.autopilotEnabled) await attempt("autopilot", () => this.autopilot());
      if (cfg.rebalanceEnabled) await attempt("rebalance", () => this.rebalance());
      if (cfg.nightShiftEnabled) await attempt("nightShift", () => this.nightShift());
      if (cfg.digestEnabled) await attempt("digest", () => this.digest());
    } finally {
      this.running = false;
    }
    return errors;
  }

  private done(duty: FleetDuty, note: string): void {
    this.repo.setDutyLastRun(duty, this.clock.nowMs());
    this.notes.set(duty, note);
  }

  private send(message: NotificationMessage): void {
    if (this.notify) void this.notify(message).catch(() => undefined);
  }

  private driftWatch(): void {
    const docked: string[] = [];
    for (const bot of this.fleet.overview().bots) {
      if (bot.status !== "running") continue;
      const drift = driftOf(bot);
      if (!drift) continue;
      this.fleet.pause(bot.botId, `Drift watch brought it back to harbour: ${drift}`);
      docked.push(bot.name);
      this.send({
        severity: "WARNING",
        title: `${bot.name} docked by the drift watch`,
        body: `${bot.name} is paper trading clearly worse than its sea trial expected: ${drift}. It is flat and in harbour until you set sail again.`,
        dedupKey: `drift-${bot.botId}`
      });
    }
    this.done(
      "driftWatch",
      docked.length > 0 ? `Docked ${docked.join(", ")}` : "Every running boat is on course"
    );
  }

  /** The wallet's next stake: its set share of the wallet's total, never more than it has. */
  private stakeFor(wallet: {
    readonly availableUsdt: string;
    readonly allocatedUsdt: string;
  }): ScaledDecimal {
    const available = ScaledDecimal.fromString(wallet.availableUsdt);
    const total = available.add(ScaledDecimal.fromString(wallet.allocatedUsdt));
    const share = total
      .mul(ScaledDecimal.fromString(this.getConfig().fleet.autopilotStakePct.toFixed(4)))
      .divFloor(ScaledDecimal.fromString("100"));
    return share.gt(available) ? available : share;
  }

  /** Seaworthy propositions that reach the minimum score, best first. */
  private candidates(): Candidate[] {
    const cfg = this.getConfig().fleet;
    return this.fleet
      .listDesigns(50)
      .flatMap((batch) =>
        batch.propositions.map((proposition) => ({
          proposition,
          score: proposition.assessment?.score ?? 0,
          upgradeOf: batch.brief.upgradeOf
        }))
      )
      .filter(({ proposition: p }) => {
        const a = p.assessment;
        return (
          p.status === "ranked" &&
          a !== null &&
          a.verdict === "seaworthy" &&
          a.score >= cfg.autopilotMinScore
        );
      })
      .sort((x, y) => y.score - x.score);
  }

  /**
   * Whether a proposition is a new bet: not a lookalike of another proposition, nor of any boat
   * sailing except the one it would replace.
   */
  private isOriginal(c: Candidate, sailing: readonly Bot[], replacing: Bot | null): boolean {
    const a = c.proposition.assessment;
    const like = a?.lookalike ?? null;
    if (like && !(replacing && like.kind === "boat" && like.name === replacing.name)) {
      return false;
    }
    const mine = a?.seaTrial?.weeklyEquityPct ?? [];
    return sailing
      .filter((b) => b.botId !== replacing?.botId)
      .every(
        (b) =>
          (weeklyCorrelation(mine, b.backtest?.seaTrial?.weeklyEquityPct ?? []) ?? 0) <
          LOOKALIKE_CORRELATION
      );
  }

  /**
   * Keeps the Autopilot wallet's fleet at its best (ADR-0033). In order: an Upgrade that clearly
   * beats the boat it improves on takes its place; a fleet with room launches the best original
   * proposition; a full fleet swaps its weakest proven boat for a proposition that clearly
   * out-scores it. At most one boat is replaced a day.
   */
  private autopilot(): void {
    const cfg = this.getConfig().fleet;
    const now = this.clock.nowMs();
    const overview = this.fleet.overview();
    const wallet = overview.wallets.find((w) => w.name === cfg.autopilotWalletName);
    if (!wallet) {
      this.notes.set(
        "autopilot",
        `Waiting for a wallet named "${cfg.autopilotWalletName}": open one in the Treasury`
      );
      return;
    }
    const sailing = overview.bots.filter((b) => b.status !== "retired");
    const managed = overview.bots.filter(
      (b) => b.walletId === wallet.walletId && b.status === "running"
    );
    const standing = (b: Bot) => standingOf(b, now, cfg.autopilotMinLiveDays);
    const pool = this.candidates();
    const replacedToday = overview.bots.some(
      (b) =>
        b.walletId === wallet.walletId &&
        b.retiredAtMs !== null &&
        now - b.retiredAtMs < DAY_MS &&
        (b.statusReason ?? "").startsWith("Replaced by")
    );

    // 1. An Upgrade that clearly beats the boat it improves on takes its place
    if (!replacedToday) {
      for (const c of pool) {
        const parent = managed.find((b) => b.botId === c.upgradeOf);
        const st = parent ? standing(parent) : null;
        if (!parent || !st?.proven || c.score < st.score + cfg.autopilotReplaceMargin) continue;
        if (!this.isOriginal(c, sailing, parent)) continue;
        this.replace(wallet.walletId, parent, st.score, c, overview.bots);
        return;
      }
    }

    // An Upgrade whose boat still sails competes only with that boat
    const sailingIds = new Set(sailing.map((b) => b.botId));
    const fresh = pool.filter((c) => !(c.upgradeOf !== null && sailingIds.has(c.upgradeOf)));

    // 2. Room in the fleet: launch the best original proposition
    if (managed.length < cfg.autopilotMaxBoats) {
      const stake = this.stakeFor(wallet);
      if (stake.lt(MIN_STAKE_USDT)) {
        this.notes.set("autopilot", `${wallet.name} is fully at sea: no stake left to launch with`);
        return;
      }
      const candidate = fresh.find((c) => this.isOriginal(c, sailing, null));
      if (!candidate) {
        this.notes.set("autopilot", "No seaworthy, original proposition on the slipway yet");
        return;
      }
      const bot = this.fleet.launch(candidate.proposition.propositionId, {
        name: freeName(candidate.proposition.rig.name, overview.bots),
        walletId: wallet.walletId,
        allocationUsdt: stake.toFixed(2)
      });
      this.done("autopilot", `Launched ${bot.name} with ${stake.toFixed(2)} USDT`);
      this.send({
        severity: "INFO",
        title: `Autopilot launched ${bot.name}`,
        body: `${bot.name} scored ${candidate.score} in its sea trial and is now paper trading with ${stake.toFixed(2)} USDT from ${wallet.name}.`,
        dedupKey: `autopilot-${bot.botId}`
      });
      return;
    }

    // 3. A full fleet: the weakest proven boat makes way for a clearly better proposition
    if (replacedToday) {
      this.notes.set("autopilot", "The fleet is full and a boat was already replaced today");
      return;
    }
    const weakest = managed
      .map((bot) => ({ bot, st: standing(bot) }))
      .filter((x) => x.st?.proven === true)
      .sort((x, y) => (x.st?.score ?? 0) - (y.st?.score ?? 0))[0];
    if (!weakest?.st) {
      this.notes.set(
        "autopilot",
        `The fleet is full (${managed.length} boats) and every boat is still proving itself`
      );
      return;
    }
    const challenger = fresh.find((c) => this.isOriginal(c, sailing, weakest.bot));
    const needed = weakest.st.score + cfg.autopilotReplaceMargin;
    if (!challenger || challenger.score < needed) {
      this.notes.set(
        "autopilot",
        challenger
          ? `The fleet is full: the best proposition, ${challenger.proposition.rig.name} (${challenger.score}), needs ${needed} to replace ${weakest.bot.name} (standing ${weakest.st.score})`
          : `The fleet is full and no original proposition could replace ${weakest.bot.name} (standing ${weakest.st.score})`
      );
      return;
    }
    this.replace(wallet.walletId, weakest.bot, weakest.st.score, challenger, overview.bots);
  }

  /** Retires a boat and launches its replacement with the wallet's usual stake. */
  private replace(
    walletId: string,
    old: Bot,
    oldStanding: number,
    c: Candidate,
    bots: readonly Bot[]
  ): void {
    const name = freeName(c.proposition.rig.name, bots);
    const kind = c.upgradeOf === old.botId ? "its Upgrade" : "a better proposition";
    this.fleet.retire(
      old.botId,
      `Replaced by ${name}, ${kind}: sea-trial score ${c.score} against a standing of ${oldStanding}`
    );
    const wallet = this.fleet.overview().wallets.find((w) => w.walletId === walletId);
    const stake = wallet ? this.stakeFor(wallet) : ScaledDecimal.zero();
    if (!wallet || stake.lt(MIN_STAKE_USDT)) {
      this.done("autopilot", `Retired ${old.name}, but the wallet had no stake left for ${name}`);
      return;
    }
    const bot = this.fleet.launch(c.proposition.propositionId, {
      name,
      walletId,
      allocationUsdt: stake.toFixed(2)
    });
    this.done("autopilot", `Replaced ${old.name} with ${bot.name}`);
    this.send({
      severity: "INFO",
      title: `Autopilot replaced ${old.name} with ${bot.name}`,
      body: `${old.name} had a standing of ${oldStanding}. ${bot.name}, ${kind}, scored ${c.score} in its sea trial and now paper trades with ${stake.toFixed(2)} USDT from ${wallet.name}.`,
      dedupKey: `autopilot-replace-${bot.botId}`
    });
  }

  /** Every Monday, evens out the stakes of each wallet's flat running boats. */
  private rebalance(): void {
    const now = this.clock.nowMs();
    const monday = new Date(now).getUTCDay() === 1;
    const last = this.repo.getDutyLastRun("rebalance") ?? 0;
    if (!monday || last >= startOfUtcDay(now)) return;
    const moved = this.fleet
      .overview()
      .wallets.flatMap((w) => this.fleet.rebalanceStakes(w.walletId));
    this.done("rebalance", moved.length > 0 ? moved.join("; ") : "Stakes were already even");
  }

  /** What the fleet has learned so far, in words Claude can build on. */
  private research(): DesignResearch {
    const cfg = this.getConfig().fleet;
    const now = this.clock.nowMs();
    const { bots } = this.fleet.overview();
    const fleetReport = bots
      .filter((b) => b.status !== "retired")
      .map((b) => boatRecord(b, now, cfg.autopilotMinLiveDays));
    const coin = (p: Proposition) => p.rig.instrumentId.replace("-USDT-SWAP", "");
    const failed = this.fleet
      .listDesigns(30)
      .flatMap((batch) => batch.propositions)
      .filter((p) => p.createdAtMs >= now - 30 * DAY_MS)
      .flatMap((p) => {
        const a = p.assessment;
        if (p.status === "failed") {
          return [
            `${p.rig.name} (${p.rig.archetype}, ${coin(p)}) could not be tested: ${p.error ?? "unknown error"}`
          ];
        }
        if (!a || (a.verdict !== "sinks" && a.verdict !== "choppy")) return [];
        const missed = (a.seaTrial?.checks ?? []).filter((c) => !c.passed).map((c) => c.label);
        const why = missed.length > 0 ? `; failed ${missed.join(", ")}` : "";
        return [`${p.rig.name} (${p.rig.archetype}, ${coin(p)}) ${a.verdict}: ${a.headline}${why}`];
      });
    const left = bots
      .filter((b) => /^(Drift watch|Replaced by)/.test(b.statusReason ?? ""))
      .map((b) => `${b.name} (${b.rig.archetype}) left the fleet: ${b.statusReason ?? ""}`);
    return { fleetReport, lessons: [...left, ...failed].slice(0, 15), improve: null };
  }

  /** Proven running boats, weakest first, that the night shift has not tried to improve lately. */
  private upgradeTargets(): Bot[] {
    const cfg = this.getConfig().fleet;
    const now = this.clock.nowMs();
    const tried = new Set(
      this.fleet
        .listDesigns(50)
        .filter((batch) => now - batch.createdAtMs < UPGRADE_RETRY_MS)
        .flatMap((batch) => (batch.brief.upgradeOf ? [batch.brief.upgradeOf] : []))
    );
    return this.fleet
      .overview()
      .bots.filter((b) => b.status === "running" && !tried.has(b.botId))
      .map((b) => ({ b, st: standingOf(b, now, cfg.autopilotMinLiveDays) }))
      .filter((x) => x.st?.proven === true)
      .sort((x, y) => (x.st?.score ?? 0) - (y.st?.score ?? 0))
      .slice(0, cfg.nightShiftUpgrades)
      .map((x) => x.b);
  }

  /**
   * The research round (ADR-0033), daily or every Monday at the set hour. Claude sees each boat's
   * sea trial against its live record and the ideas that failed lately, drafts new ideas for the
   * fleet's gaps, then an Upgrade of each of the weakest proven boats. Every draft faces a sea
   * trial; the Autopilot's rules decide what, if anything, sails.
   */
  private async nightShift(): Promise<void> {
    const cfg = this.getConfig().fleet;
    const now = this.clock.nowMs();
    const date = new Date(now);
    const last = this.repo.getDutyLastRun("nightShift") ?? 0;
    const dueToday = cfg.nightShiftCadence === "daily" || date.getUTCDay() === 1;
    if (!dueToday || date.getUTCHours() < cfg.nightShiftHourUtc || last >= startOfUtcDay(now)) {
      return;
    }
    if (this.fleet.overview().designer.source !== "claude") {
      this.notes.set("nightShift", "Needs Claude: link your subscription in the Engine Room");
      return;
    }
    const research = this.research();
    const errors: string[] = [];
    const drafted: string[] = [];
    try {
      await this.fleet.design(
        {
          instruments: [...FLEET_INSTRUMENTS],
          direction: "any",
          count: cfg.nightShiftCount,
          notes:
            "Night shift: fill the gaps in the fleet with ideas unlike the boats already sailing, and learn from the ideas that failed."
        },
        research,
        null
      );
      drafted.push(`${cfg.nightShiftCount} new ideas`);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    for (const boat of this.upgradeTargets()) {
      try {
        await this.fleet.design(
          {
            instruments: [...FLEET_INSTRUMENTS],
            direction: "any",
            count: 2,
            notes: `Night shift Upgrade: improve on ${boat.name}.`
          },
          {
            ...research,
            improve: {
              name: boat.name,
              rig: boat.rig,
              record: boatRecord(boat, now, cfg.autopilotMinLiveDays)
            }
          },
          boat.botId
        );
        drafted.push(`Upgrades of ${boat.name}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`Upgrade of ${boat.name}: ${message}`);
      }
    }
    // Recorded even after a failure, so a broken link is not retried every hour
    this.done(
      "nightShift",
      drafted.length > 0 ? `Drafted ${drafted.join("; ")}` : "Drafted nothing"
    );
    if (errors.length > 0) throw new Error(errors.join("; "));
  }

  /** Once a day after the set hour, sends every boat's results to Discord. */
  private digest(): void {
    const cfg = this.getConfig().fleet;
    const now = this.clock.nowMs();
    const last = this.repo.getDutyLastRun("digest") ?? 0;
    if (new Date(now).getUTCHours() < cfg.digestHourUtc || last >= startOfUtcDay(now)) return;
    if (!this.notify) {
      this.notes.set("digest", "Waiting for Discord: add a webhook in the Engine Room");
      return;
    }
    const { bots } = this.fleet.overview();
    const active = bots.filter((b) => b.status !== "retired");
    const lines = active
      .sort((a, b) => b.returnPct - a.returnPct)
      .slice(0, 20)
      .map(
        (b) =>
          `${b.status === "running" ? "⛵" : "⚓"} ${b.name}: ${signedPct(b.returnPct)} (${b.pnlUsdt} USDT), ${b.tradesCount} trades, ${b.openPositions.length} open`
      );
    const pnl = active.reduce(
      (sum, b) => sum.add(ScaledDecimal.fromString(b.pnlUsdt)),
      ScaledDecimal.zero()
    );
    this.send({
      severity: "INFO",
      title: "Keel fleet digest",
      body:
        active.length === 0
          ? "No boats at sea yet."
          : `${active.length} boats, ${pnl.toFixed(2)} USDT paper P&L in all.\n${lines.join("\n")}`,
      dedupKey: `fleet-digest-${startOfUtcDay(now)}`
    });
    this.done("digest", `Sent a summary of ${active.length} boats`);
  }
}
