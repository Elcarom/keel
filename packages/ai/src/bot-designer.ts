import {
  type Rig,
  type Clock,
  type DesignBrief,
  type DesignSource,
  type LlmGateway
} from "@keel/core";
import { z } from "zod";
import {
  SHIPWRIGHT_REPAIR_PROMPT,
  SHIPWRIGHT_SYSTEM_PROMPT,
  sampleInventions,
  type InventionChecker,
  type InventionCheckResult
} from "./shipwright.js";

export interface BotDesignResult {
  readonly source: DesignSource;
  readonly rigs: readonly Rig[];
  /** Shown to the operator when the designs did not come from Claude as asked. */
  readonly note: string | null;
}

/**
 * What the night shift has learned, for Claude to build on (ADR-0033). Each line is plain words
 * Keel wrote from its own numbers.
 */
export interface DesignResearch {
  /** Every boat at sea: its sea trial set against its live paper record. */
  readonly fleetReport: readonly string[];
  /** Recent ideas that failed their sea trial, and why. */
  readonly lessons: readonly string[];
  /** The boat an Upgrade should improve on; null when the brief fills gaps. */
  readonly improve: {
    readonly name: string;
    readonly rig: Rig;
    readonly record: string;
  } | null;
}

/** The research fields of a design request, worded for Claude. */
function researchFields(research: DesignResearch | undefined): Record<string, unknown> {
  if (!research) return {};
  return {
    fleetReport: research.fleetReport.length > 0 ? research.fleetReport : "no boats at sea yet",
    lessonsFromFailedIdeas: research.lessons.length > 0 ? research.lessons : "none yet",
    ...(research.improve
      ? {
          upgrade: {
            task: `Improve on the boat "${research.improve.name}". Keep what its record shows works and fix what it shows does not: tighter or looser entries, a better exit, a filter, a different stop, a basket, or a reference market. Each proposition must still be clearly the same idea, better, and use a new name.`,
            boat: research.improve.rig,
            record: research.improve.record
          }
        }
      : {})
  };
}

export interface BotDesignerOptions {
  readonly clock: Clock;
  readonly gateway: LlmGateway;
  /** True when a real model can be called; otherwise the designer offers sample inventions. */
  readonly isLive: () => boolean;
  /** Checks invented rules (from @keel/spec); without it the Shipwright is unavailable. */
  readonly checkInvention?: InventionChecker | undefined;
}

const InventionResponseSchema = z.object({
  propositions: z.array(z.unknown()).min(1).max(8)
});

function uniqueName(name: string, taken: Set<string>): string {
  const ordinals = ["II", "III", "IV", "V", "VI", "VII"];
  if (!taken.has(name.toLowerCase())) return name;
  for (const ordinal of ordinals) {
    const candidate = `${name.slice(0, 36)} ${ordinal}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${name.slice(0, 30)} ${taken.size + 1}`;
}

/** Renames rigs whose names are already taken, or repeated, with an ordinal: "Riptide II". */
export function withUniqueNames(rigs: readonly Rig[], takenNames: readonly string[]): Rig[] {
  const taken = new Set(takenNames.map((n) => n.toLowerCase()));
  return rigs.map((b) => {
    const name = uniqueName(b.name, taken);
    taken.add(name.toLowerCase());
    return { ...b, name };
  });
}

/**
 * The Shipyard's Shipwright. Claude writes the rules; the brief's hard choices (instruments,
 * direction, count) are enforced by the checker, which also attaches the stop.
 */
export class BotDesigner {
  private readonly clock: Clock;
  private readonly gateway: LlmGateway;
  private readonly isLive: () => boolean;
  private readonly checkInvention: InventionChecker | null;

  public constructor(options: BotDesignerOptions) {
    this.clock = options.clock;
    this.gateway = options.gateway;
    this.isLive = options.isLive;
    this.checkInvention = options.checkInvention ?? null;
  }

  /**
   * Claude writes the rules. Every invention is checked; failures go back to Claude once with
   * Keel's exact complaint, and anything still failing is dropped and named in the note.
   */
  public async design(
    brief: DesignBrief,
    takenNames: readonly string[],
    fleetToday = "",
    research?: DesignResearch
  ): Promise<BotDesignResult> {
    const check = this.checkInvention;
    if (!check) throw new Error("The Shipwright is not available on this server");
    const checkAll = (raws: readonly unknown[]) => raws.map((raw) => check(raw, brief));

    if (!this.isLive()) {
      const results = checkAll(sampleInventions(brief));
      return {
        source: "sample",
        rigs: this.uniqueNames(okRigs(results), takenNames),
        note: "Claude is not linked, so these are Keel's own sample designs. Link your Claude subscription in the Engine Room to have the Shipwright draw up boats for you."
      };
    }

    const request = (systemPrompt: string, userPrompt: string) =>
      this.gateway.completeStructured(
        {
          featureName: "strategyLab",
          systemPrompt,
          userPrompt,
          asOfMs: this.clock.nowMs(),
          reasoning: "deep"
        },
        InventionResponseSchema
      );

    const first = await request(
      SHIPWRIGHT_SYSTEM_PROMPT,
      JSON.stringify({
        request: `Invent ${brief.count} strategies.`,
        instruments: brief.instruments,
        direction: brief.direction,
        operatorNotes: brief.notes || "none",
        namesAlreadyInTheFleet: takenNames,
        fleetToday: fleetToday || "unknown",
        diversity: "Prefer mechanisms, coins and horizons the fleet today lacks.",
        ...researchFields(research)
      })
    );
    let results = checkAll(first.parsed.propositions.slice(0, brief.count));

    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      const repairs = await request(
        SHIPWRIGHT_SYSTEM_PROMPT,
        `${SHIPWRIGHT_REPAIR_PROMPT}\n\n${JSON.stringify(
          results.flatMap((r, i) =>
            r.ok ? [] : [{ invention: first.parsed.propositions[i], problem: r.error }]
          )
        )}`
      );
      const repaired = checkAll(repairs.parsed.propositions.slice(0, failed.length));
      let next = 0;
      results = results.map((r) => (r.ok ? r : (repaired[next++] ?? r)));
    }

    const rigs = okRigs(results);
    const dropped = results.filter((r): r is Extract<InventionCheckResult, { ok: false }> => !r.ok);
    if (rigs.length === 0) {
      throw new Error(
        `None of the Shipwright's designs passed Keel's checks: ${dropped.map((d) => `${d.name} (${d.error})`).join("; ")}`
      );
    }
    return {
      source: "claude",
      rigs: this.uniqueNames(rigs, takenNames),
      note:
        dropped.length > 0
          ? `${dropped.length} design${dropped.length === 1 ? "" : "s"} still broke Keel's rule limits after a repair attempt and ${dropped.length === 1 ? "was" : "were"} dropped: ${dropped.map((d) => d.name).join(", ")}.`
          : null
    };
  }

  private uniqueNames(rigs: readonly Rig[], takenNames: readonly string[]): Rig[] {
    return withUniqueNames(rigs, takenNames);
  }
}

function okRigs(results: readonly InventionCheckResult[]): Rig[] {
  return results.flatMap((r) => (r.ok ? [r.rig] : []));
}
