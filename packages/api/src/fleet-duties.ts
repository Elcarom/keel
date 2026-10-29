import {
  FLEET_INSTRUMENTS,
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
import { weeklyCorrelation } from "./sea-trial.js";

// ============================================================================
// The Fleet's unattended duties (ADR-0030). The scheduler runs them after every Fleet step.
// Each is deterministic and paper-only: the night shift asks the Bot Designer for ideas, but
// what launches, docks or moves money is decided by fixed rules here, never by a model.
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
  listDesigns(limit?: number): readonly { readonly propositions: readonly Proposition[] }[];
  launch(
    propositionId: string,
    input: { readonly name: string; readonly walletId: string; readonly allocationUsdt: string }
  ): Bot;
  pause(botId: string, reason: string): Bot;
  design(brief: {
    readonly mode: "blueprint" | "inventor";
    readonly instruments: (typeof FLEET_INSTRUMENTS)[number][];
    readonly styles: [];
    readonly riskAppetite: "balanced";
    readonly direction: "any";
    readonly count: number;
    readonly notes: string;
  }): Promise<unknown>;
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

  /** Launches the best seaworthy proposition that is not a copy of a running boat. */
  private autopilot(): void {
    const cfg = this.getConfig().fleet;
    const overview = this.fleet.overview();
    const wallet = overview.wallets.find((w) => w.name === cfg.autopilotWalletName);
    if (!wallet) {
      this.notes.set(
        "autopilot",
        `Waiting for a wallet named "${cfg.autopilotWalletName}": open one in the Treasury`
      );
      return;
    }
    const available = ScaledDecimal.fromString(wallet.availableUsdt);
    const total = available.add(ScaledDecimal.fromString(wallet.allocatedUsdt));
    const share = total
      .mul(ScaledDecimal.fromString(cfg.autopilotStakePct.toFixed(4)))
      .divFloor(ScaledDecimal.fromString("100"));
    const stake = share.gt(available) ? available : share;
    if (stake.lt(MIN_STAKE_USDT)) {
      this.notes.set("autopilot", `${wallet.name} is fully at sea: no stake left to launch with`);
      return;
    }

    const sailing = overview.bots
      .filter((b) => b.status !== "retired")
      .map((b) => b.backtest?.seaTrial?.weeklyEquityPct ?? []);
    const takenNames = new Set(overview.bots.map((b) => b.name.toLowerCase()));
    const candidate = this.fleet
      .listDesigns(50)
      .flatMap((batch) => batch.propositions)
      .filter((p) => {
        const a = p.assessment;
        if (p.status !== "ranked" || !a) return false;
        if (a.verdict !== "seaworthy" || a.score < cfg.autopilotMinScore) return false;
        if (a.lookalike !== null) return false;
        const mine = a.seaTrial?.weeklyEquityPct ?? [];
        return sailing.every(
          (curve) => (weeklyCorrelation(mine, curve) ?? 0) < LOOKALIKE_CORRELATION
        );
      })
      .sort((x, y) => (y.assessment?.score ?? 0) - (x.assessment?.score ?? 0))[0];
    if (!candidate) {
      this.notes.set("autopilot", "No seaworthy, original proposition on the slipway yet");
      return;
    }

    let name = candidate.blueprint.name;
    for (let n = 2; takenNames.has(name.toLowerCase()); n++) {
      name = `${candidate.blueprint.name.slice(0, 34)} ${n}`;
    }
    const bot = this.fleet.launch(candidate.propositionId, {
      name,
      walletId: wallet.walletId,
      allocationUsdt: stake.toFixed(2)
    });
    this.done("autopilot", `Launched ${bot.name} with ${stake.toFixed(2)} USDT`);
    this.send({
      severity: "INFO",
      title: `Autopilot launched ${bot.name}`,
      body: `${bot.name} scored ${candidate.assessment?.score ?? 0} in its sea trial and is now paper trading with ${stake.toFixed(2)} USDT from ${wallet.name}.`,
      dedupKey: `autopilot-${bot.botId}`
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

  /** Draws up a brief across all ten markets, daily or every Monday, at the set hour. */
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
      this.notes.set(
        "nightShift",
        "Needs an Anthropic key: without one it would only repeat Keel's samples"
      );
      return;
    }
    await this.fleet.design({
      mode: cfg.nightShiftMode,
      instruments: [...FLEET_INSTRUMENTS],
      styles: [],
      riskAppetite: "balanced",
      direction: "any",
      count: cfg.nightShiftCount,
      notes: "Night shift: fill the gaps in the fleet with ideas unlike the boats already sailing."
    });
    this.done("nightShift", `Drafted ${cfg.nightShiftCount} propositions for the sea trial`);
  }

  /** Once a day after the set hour, sends every boat's results to Discord. */
  private digest(): void {
    const cfg = this.getConfig().fleet;
    const now = this.clock.nowMs();
    const last = this.repo.getDutyLastRun("digest") ?? 0;
    if (new Date(now).getUTCHours() < cfg.digestHourUtc || last >= startOfUtcDay(now)) return;
    if (!this.notify) {
      this.notes.set("digest", "Waiting for Discord: add a webhook under Engine Room → Secrets");
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
