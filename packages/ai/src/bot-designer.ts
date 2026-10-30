import {
  ARCHETYPE_FAMILY,
  ARCHETYPE_LABELS,
  BOT_BLUEPRINT_DRAFT_JSON_SCHEMA,
  BotBlueprintDraftSchema,
  normalizeBlueprint,
  type BotArchetype,
  type BotBlueprint,
  type BotBlueprintDraftInput,
  type Clock,
  type DesignBrief,
  type DesignSource,
  type LlmGateway
} from "@keel/core";
import { z } from "zod";
import {
  INVENTOR_REPAIR_PROMPT,
  INVENTOR_SYSTEM_PROMPT,
  sampleInventions,
  type InventionChecker,
  type InventionCheckResult
} from "./inventor.js";

export interface BotDesignResult {
  readonly source: DesignSource;
  readonly blueprints: readonly BotBlueprint[];
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
    readonly blueprint: BotBlueprint;
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
            boat: research.improve.blueprint,
            record: research.improve.record
          }
        }
      : {})
  };
}

export interface BotDesignerOptions {
  readonly clock: Clock;
  readonly gateway: LlmGateway;
  /** True when a real model can be called; otherwise the designer drafts sample propositions. */
  readonly isLive: () => boolean;
  /** Checks Inventor-mode rules (from @keel/spec); without it Inventor mode is unavailable. */
  readonly checkInvention?: InventionChecker | undefined;
}

const InventionResponseSchema = z.object({
  propositions: z.array(z.unknown()).min(1).max(8)
});

const DesignResponseSchema = z.object({
  propositions: z.array(BotBlueprintDraftSchema).min(1).max(8)
});

const DESIGN_RESPONSE_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  additionalProperties: false,
  required: ["propositions"],
  properties: {
    propositions: { type: "array", items: BOT_BLUEPRINT_DRAFT_JSON_SCHEMA }
  }
};

const SYSTEM_PROMPT = `You design automated trading boats for Keel, a self-hosted crypto perpetual-futures lab. Keel's theme is the sea: a keel keeps a ship steady, each trading bot is a boat in the operator's fleet, and every boat gets a short nautical name (1-3 words) that hints at how it trades, e.g. "Trade Wind" for a momentum rider or "Undertow" for a mean-reversion fader. Never use real people, brands or existing products as names.

Each boat trades USDT perpetuals on confirmed 1-hour bars: its own instrumentId plus, optionally, a "basket" of up to 4 more of the offered instruments, where it runs the same rules on each coin, one position per coin, all funded from one stake. A basket diversifies an idea that should hold across similar coins, and its sea trial judges every coin together; leave the basket empty for an idea specific to one market. Each boat is one of these archetypes. L is lookbackPeriod, F is fastPeriod (always shorter than L) and T is entryThreshold. Every archetype still needs a value for every parameter, even ones it ignores.
Trend followers:
- momentum: enters when the L-bar change in close, scaled by ATR, is at least T (long) or at most -T (short). T 0.8-2.
- ma_crossover: enters when the F-bar average crosses above (long) or below (short) the L-bar average. T unused.
- trend_pullback: buys dips in uptrends: close above the L-bar average and the F-bar z-score at or below -T; the mirror for shorts. T 1-2.5.
- keltner_ride: enters when the close crosses above the L-bar EMA plus T times the L-bar ATR (long) or below the EMA minus T ATRs (short). T 1-3.
- regime_momentum: momentum over F bars of at least T, but only when the close is above an L-bar EMA that has risen over the last F bars (mirror for shorts). Fewer, cleaner trend trades. T 0.8-2.
Breakouts:
- breakout: enters when the close breaks the highest high (long) or lowest low (short) of the previous L bars. T unused.
- squeeze_breakout: waits for calm, then trades the break: the F-bar volatility must be at least T times lower than the L-bar volatility, and the close breaks the F-bar channel. T 1.2-2.5.
- volume_breakout: an L-bar channel breakout that only counts when this bar's volume is at least T times the L-bar average volume. T 1.5-3.
- inside_bar_breakout: the previous bar sat inside the one before it, and this bar closes beyond it in the direction of the L-bar average. T unused.
Reversion:
- mean_reversion: fades stretched prices: the L-bar z-score of the close at or below -T (long) or at or above T (short). T 1.5-3.
- rsi_reversal: enters as the L-bar RSI climbs back above 50-10T (long) or falls back below 50+10T (short); T 2 means 30/70. T 1.5-3.5.
- failed_breakout: the previous bar poked beyond the L-bar channel and this bar closed back inside it; trades back into the range. T unused.
- capitulation_fade: a bar whose range exceeds T times the L-bar ATR, against the trend (below the L-bar average for longs), that still closes up, above its open (down for shorts): the panic was absorbed. T 1.5-3.
Pairs (set pairWith to the second coin; the boat holds instrumentId against it, one leg long and one short, so it is close to market-neutral):
- pair_reversion: the L-bar z-score of the log price ratio of instrumentId to pairWith at or below -T buys instrumentId and sells pairWith (the mirror at or above T), and closes both legs when the ratio is back at its mean. Pick two coins that usually move together. T 1.5-3.
- pair_momentum: when instrumentId has steadily outrun pairWith over L bars (the ratio's drift is at least T times its own noise) it buys instrumentId and sells pairWith (the mirror for -T), and closes when the drift has faded. T 1-2.5.
A pair's legs share one stop distance, stopAtrMultiple times the wider ATR of the two coins, and leave together; rewardMultiple and trailingAtrMultiple are ignored, and maxBarsHeld defaults to three lookbacks. Leave pairWith null for every other archetype.
Every trade has a protective stop stopAtrMultiple ATRs away and a take-profit at rewardMultiple times the risk. Two optional exits change a boat's character: trailingAtrMultiple (0.5-6) ratchets the stop that many ATRs behind each close so trends can run (pair it with a high rewardMultiple), and maxBarsHeld (2-240) closes a position after that many hours (good for reversion). Use null for either to leave it off.

Propose genuinely different ideas: vary archetype, family, horizon and risk, prefer the styles and instruments the operator asked for, and spread propositions across the instruments offered. Be honest in the rationale about when the idea should fail. Each proposition goes through an automatic sea trial: a two-year backtest, cost stress, walk-forward, parameter nudges and a sibling market. So favour ideas with a structural reason to work over finely tuned numbers, and do not invent performance numbers.`;

interface SampleArchetype {
  readonly names: readonly string[];
  readonly tagline: string;
  readonly rationale: string;
  readonly lookback: number;
  readonly fast: number;
  /** Balanced trigger strength; cautious briefs ask for more, bold briefs for less. */
  readonly threshold: number;
}

const SAMPLES: Readonly<Record<BotArchetype, SampleArchetype>> = {
  pair_reversion: {
    names: ["Catamaran", "Twin Hulls", "Outrigger", "Tandem"],
    tagline: "Sails two hulls lashed together, leaning on whichever one has drifted too far ahead.",
    rationale:
      "Coins that share a story usually move together, so a stretched gap between them tends to close while the market's own swings cancel out. It fails when the gap opens for a reason, such as news on one coin, and keeps widening.",
    lookback: 72,
    fast: 24,
    threshold: 2
  },
  pair_momentum: {
    names: ["Slipstream", "Wake Rider", "Tow Line", "Drafting"],
    tagline: "Tucks in behind the faster of two boats and rides its wake until it slows.",
    rationale:
      "Relative strength between related coins tends to persist for days as money rotates from one to the other, and holding both sides takes most of the market's swing out. It suffers when leadership flips back and forth.",
    lookback: 96,
    fast: 24,
    threshold: 1.5
  },
  breakout: {
    names: ["Breakwater", "Squall Line", "Bow Wave", "Harbour Gate"],
    tagline: "Waits behind the harbour wall, then charges through when price breaks the channel.",
    rationale:
      "Breakouts catch the start of trends after quiet ranges. It suffers in choppy markets where breaks fail and reverse.",
    lookback: 24,
    fast: 8,
    threshold: 1.5
  },
  mean_reversion: {
    names: ["Undertow", "Ebb & Flow", "Slack Tide", "Rip Current"],
    tagline: "Leans against stretched moves and rides the tide back to the mean.",
    rationale:
      "Short-term overreactions in perpetuals often snap back. It gets hurt when a stretched move turns into a sustained trend.",
    lookback: 20,
    fast: 8,
    threshold: 2
  },
  momentum: {
    names: ["Trade Wind", "Spinnaker", "Following Sea", "Gale Runner"],
    tagline: "Hoists the sails when the wind picks up and lets the impulse carry it.",
    rationale:
      "Strong hourly impulses tend to persist for a while. It gives back gains when impulses fade straight away.",
    lookback: 12,
    fast: 6,
    threshold: 1.2
  },
  ma_crossover: {
    names: ["Crosscurrent", "Twin Lights", "Turning Tide", "Compass Rose"],
    tagline: "Changes tack when the fast current crosses the slow one.",
    rationale:
      "Crossovers are a slow, steady way to follow trends. They lag at turning points and get whipsawed in ranges.",
    lookback: 48,
    fast: 12,
    threshold: 1.5
  },
  trend_pullback: {
    names: ["Kedge Anchor", "Backwash", "Lee Shore", "Second Wave"],
    tagline: "Follows the main current but only boards on the dips.",
    rationale:
      "Buying dips inside a trend gets better entries than chasing. It fails when the dip is the start of a reversal.",
    lookback: 72,
    fast: 10,
    threshold: 1.5
  },
  squeeze_breakout: {
    names: ["Doldrums", "Becalmed", "Coiled Rope", "Calm Before"],
    tagline: "Sits patiently through the doldrums and sails off when the wind finally fills in.",
    rationale:
      "Quiet spells in crypto tend to end in sharp expansions, and waiting for calm filters out noisy breaks. It loses when the squeeze resolves in a fake-out.",
    lookback: 96,
    fast: 16,
    threshold: 1.5
  },
  volume_breakout: {
    names: ["Bow Thruster", "Full Steam", "Thunderhead", "Surge Tide"],
    tagline: "Only charges a breakout when the whole harbour is rowing the same way.",
    rationale:
      "Breaks backed by heavy volume are more often real participation than stop runs. It struggles when volume spikes come from liquidations that reverse.",
    lookback: 36,
    fast: 8,
    threshold: 2
  },
  inside_bar_breakout: {
    names: ["Narrows", "Bottle Neck", "Lock Gate", "Strait Run"],
    tagline: "Threads the narrows: a quiet inside bar, then a push out with the current.",
    rationale:
      "An inside bar marks a brief pause; breaking it in the trend's direction often restarts the move. Ranges with no trend produce false starts.",
    lookback: 48,
    fast: 8,
    threshold: 1
  },
  keltner_ride: {
    names: ["Outrigger", "Bow Spray", "Clipper Run", "High Water"],
    tagline: "Rides the swell once price climbs clear of its usual banks.",
    rationale:
      "A close beyond the volatility band says the trend has real force behind it. It gets caught by blow-off tops that reverse inside the band.",
    lookback: 30,
    fast: 8,
    threshold: 2
  },
  regime_momentum: {
    names: ["Gulf Stream", "Jet Stream", "Main Current", "Westerlies"],
    tagline: "Only hoists sail when the big current agrees with the gust.",
    rationale:
      "Momentum works best with the longer trend behind it, so the filter skips counter-trend impulses. It sits out sharp V-shaped reversals and is late to new trends.",
    lookback: 120,
    fast: 12,
    threshold: 1.2
  },
  rsi_reversal: {
    names: ["Rogue Wave", "Spring Tide", "Rebound Reef", "Turning Buoy"],
    tagline: "Waits for an overstretched sea to turn, then catches the rebound.",
    rationale:
      "Waiting for RSI to come back out of an extreme avoids catching the falling knife. It still fades the wrong moves in strong, persistent trends.",
    lookback: 14,
    fast: 6,
    threshold: 2
  },
  failed_breakout: {
    names: ["False Dawn", "Mirage", "Sandbar", "Siren Song"],
    tagline: "Watches others charge the channel wall and bets they bounce off it.",
    rationale:
      "Many breakouts in crypto are stop runs that snap back into the range. It is run over when a breakout is real and keeps going.",
    lookback: 24,
    fast: 8,
    threshold: 1
  },
  capitulation_fade: {
    names: ["Storm Petrel", "Lifeboat", "Breaker Rock", "Last Gasp"],
    tagline: "Rows out after the storm wave breaks and buys what the panic left behind.",
    rationale:
      "Outsized bars that close away from their extreme often mark forced selling or buying that has run its course. A trend that keeps going after the bar runs it over.",
    lookback: 48,
    fast: 8,
    threshold: 2.2
  }
};

/** "Surprise me" deals archetypes across families, the less common ideas first. */
const SURPRISE_ORDER: readonly BotArchetype[] = [
  "squeeze_breakout",
  "pair_reversion",
  "regime_momentum",
  "failed_breakout",
  "keltner_ride",
  "rsi_reversal",
  "volume_breakout",
  "capitulation_fade",
  "inside_bar_breakout",
  "trend_pullback",
  "breakout",
  "mean_reversion",
  "momentum",
  "ma_crossover",
  "pair_momentum"
];

interface RiskShape {
  /** Multiplies the archetype's trigger: cautious boats wait for stronger signals. */
  readonly thresholdScale: number;
  readonly stopAtrMultiple: number;
  readonly rewardMultiple: number;
}

const RISK_SHAPES: Readonly<Record<DesignBrief["riskAppetite"], RiskShape>> = {
  cautious: { thresholdScale: 1.25, stopAtrMultiple: 2.5, rewardMultiple: 1.5 },
  balanced: { thresholdScale: 1, stopAtrMultiple: 2, rewardMultiple: 2 },
  bold: { thresholdScale: 0.8, stopAtrMultiple: 1.5, rewardMultiple: 3 }
};

function uniqueName(name: string, taken: Set<string>): string {
  const ordinals = ["II", "III", "IV", "V", "VI", "VII"];
  if (!taken.has(name.toLowerCase())) return name;
  for (const ordinal of ordinals) {
    const candidate = `${name.slice(0, 36)} ${ordinal}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${name.slice(0, 30)} ${taken.size + 1}`;
}

/** Renames blueprints whose names are already taken, or repeated, with an ordinal: "Riptide II". */
export function withUniqueNames(
  blueprints: readonly BotBlueprint[],
  takenNames: readonly string[]
): BotBlueprint[] {
  const taken = new Set(takenNames.map((n) => n.toLowerCase()));
  return blueprints.map((b) => {
    const name = uniqueName(b.name, taken);
    taken.add(name.toLowerCase());
    return { ...b, name };
  });
}

/** Drafts propositions without a model: varied, deterministic, shaped by the brief. */
export function sampleBlueprints(brief: DesignBrief): BotBlueprintDraftInput[] {
  // A surprise pair needs two of the brief's coins; asked for by name, it borrows a sibling
  const styles =
    brief.styles.length > 0
      ? brief.styles
      : SURPRISE_ORDER.filter(
          (a) => brief.instruments.length >= 2 || ARCHETYPE_FAMILY[a] !== "pairs"
        );
  const shape = RISK_SHAPES[brief.riskAppetite];
  const drafts: BotBlueprintDraftInput[] = [];
  for (let i = 0; i < brief.count; i++) {
    const archetype = styles[i % styles.length] ?? "breakout";
    const round = Math.floor(i / styles.length);
    const instrumentId = brief.instruments[i % brief.instruments.length] ?? "BTC-USDT-SWAP";
    // With three or more waters, every other sample sails a basket of the next two coins
    const basket =
      brief.instruments.length >= 3 && i % 2 === 1
        ? [1, 2].flatMap((k) => {
            const m = brief.instruments[(i + k) % brief.instruments.length];
            return m && m !== instrumentId ? [m] : [];
          })
        : [];
    const sample = SAMPLES[archetype];
    // A pair holds its coin against the brief's next coin
    const pairWith =
      ARCHETYPE_FAMILY[archetype] === "pairs"
        ? (brief.instruments.find(
            (m, k) => m !== instrumentId && k > i % brief.instruments.length
          ) ??
          brief.instruments.find((m) => m !== instrumentId) ??
          null)
        : null;
    // Later rounds of the same archetype sail a slower horizon so they are not duplicates
    const stretch = 1 + round * 0.75;
    drafts.push({
      name: sample.names[round % sample.names.length] ?? archetype,
      tagline: sample.tagline,
      archetype,
      instrumentId,
      direction: brief.direction === "any" ? "both" : brief.direction,
      lookbackPeriod: Math.round(sample.lookback * stretch),
      fastPeriod: Math.round(sample.fast * stretch),
      entryThreshold: Math.round(sample.threshold * shape.thresholdScale * 100) / 100,
      stopAtrMultiple: shape.stopAtrMultiple,
      rewardMultiple: shape.rewardMultiple,
      rationale: `${sample.rationale} (${ARCHETYPE_LABELS[archetype]}, ${brief.riskAppetite} sizing.)`,
      basket: pairWith ? [] : basket,
      pairWith,
      // Trend followers let winners run on a trailing stop; reversion trades are given a day
      trailingAtrMultiple: ARCHETYPE_FAMILY[archetype] === "trend" ? 3 : null,
      maxBarsHeld: ARCHETYPE_FAMILY[archetype] === "reversion" ? 24 : null
    });
  }
  return drafts;
}

/**
 * The Shipyard's designer. The model only drafts blueprints; the brief's hard choices
 * (instruments, direction, count) are enforced here, and parameters are clamped on normalize.
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

  public async design(
    brief: DesignBrief,
    takenNames: readonly string[],
    fleetToday = "",
    research?: DesignResearch
  ): Promise<BotDesignResult> {
    if (brief.mode === "inventor") return this.invent(brief, takenNames, fleetToday, research);
    if (!this.isLive()) {
      return {
        source: "sample",
        blueprints: this.finish(sampleBlueprints(brief), brief, takenNames),
        note: "Claude is not linked, so these are sample propositions. Add a Claude subscription token (claudeCodeToken) or an Anthropic API key under Engine Room → Secrets to have Claude design your boats."
      };
    }

    const userPrompt = JSON.stringify({
      request: `Propose ${brief.count} boats.`,
      instruments: brief.instruments,
      preferredStyles: brief.styles.length > 0 ? brief.styles : "any",
      riskAppetite: brief.riskAppetite,
      direction: brief.direction,
      operatorNotes: brief.notes || "none",
      namesAlreadyInTheFleet: takenNames,
      fleetToday: fleetToday || "unknown",
      diversity: "Prefer styles, coins and horizons the fleet today lacks.",
      ...researchFields(research)
    });

    const response = await this.gateway.completeStructured(
      {
        featureName: "strategyLab",
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        asOfMs: this.clock.nowMs(),
        outputJsonSchema: DESIGN_RESPONSE_JSON_SCHEMA
      },
      DesignResponseSchema
    );
    return {
      source: "claude",
      blueprints: this.finish(response.parsed.propositions, brief, takenNames),
      note: null
    };
  }

  /**
   * Inventor mode: Claude writes the rules. Every invention is checked; failures go back to Claude
   * once with Keel's exact complaint, and anything still failing is dropped and named in the note.
   */
  private async invent(
    brief: DesignBrief,
    takenNames: readonly string[],
    fleetToday: string,
    research: DesignResearch | undefined
  ): Promise<BotDesignResult> {
    const check = this.checkInvention;
    if (!check) throw new Error("Inventor mode is not available on this server");
    const checkAll = (raws: readonly unknown[]) => raws.map((raw) => check(raw, brief));

    if (!this.isLive()) {
      const results = checkAll(sampleInventions(brief));
      return {
        source: "sample",
        blueprints: this.uniqueNames(okBlueprints(results), takenNames),
        note: "Claude is not linked, so these are Keel's own sample inventions. Add a Claude subscription token (claudeCodeToken) or an Anthropic API key under Engine Room → Secrets to have Claude invent strategies for you."
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
      INVENTOR_SYSTEM_PROMPT,
      JSON.stringify({
        request: `Invent ${brief.count} strategies.`,
        instruments: brief.instruments,
        riskAppetite: brief.riskAppetite,
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
        INVENTOR_SYSTEM_PROMPT,
        `${INVENTOR_REPAIR_PROMPT}\n\n${JSON.stringify(
          results.flatMap((r, i) =>
            r.ok ? [] : [{ invention: first.parsed.propositions[i], problem: r.error }]
          )
        )}`
      );
      const repaired = checkAll(repairs.parsed.propositions.slice(0, failed.length));
      let next = 0;
      results = results.map((r) => (r.ok ? r : (repaired[next++] ?? r)));
    }

    const blueprints = okBlueprints(results);
    const dropped = results.filter((r): r is Extract<InventionCheckResult, { ok: false }> => !r.ok);
    if (blueprints.length === 0) {
      throw new Error(
        `None of Claude's inventions passed Keel's checks: ${dropped.map((d) => `${d.name} (${d.error})`).join("; ")}`
      );
    }
    return {
      source: "claude",
      blueprints: this.uniqueNames(blueprints, takenNames),
      note:
        dropped.length > 0
          ? `${dropped.length} invention${dropped.length === 1 ? "" : "s"} still broke Keel's rule limits after a repair attempt and ${dropped.length === 1 ? "was" : "were"} dropped: ${dropped.map((d) => d.name).join(", ")}.`
          : null
    };
  }

  private uniqueNames(
    blueprints: readonly BotBlueprint[],
    takenNames: readonly string[]
  ): BotBlueprint[] {
    return withUniqueNames(blueprints, takenNames);
  }

  private finish(
    drafts: readonly z.input<typeof BotBlueprintDraftSchema>[],
    brief: DesignBrief,
    takenNames: readonly string[]
  ): BotBlueprint[] {
    const taken = new Set(takenNames.map((n) => n.toLowerCase()));
    return drafts.slice(0, brief.count).map((draft) => {
      const blueprint = normalizeBlueprint({
        ...draft,
        instrumentId: brief.instruments.includes(draft.instrumentId)
          ? draft.instrumentId
          : (brief.instruments[0] ?? draft.instrumentId),
        direction: brief.direction === "any" ? draft.direction : brief.direction,
        // A basket only holds coins the brief allows
        basket: (draft.basket ?? []).filter((m) => brief.instruments.includes(m)),
        // So does a pair, when the brief has a second coin to offer
        pairWith:
          draft.pairWith && brief.instruments.includes(draft.pairWith)
            ? draft.pairWith
            : (brief.instruments.find((m) => m !== draft.instrumentId) ?? null)
      });
      const name = uniqueName(blueprint.name, taken);
      taken.add(name.toLowerCase());
      return { ...blueprint, name };
    });
  }
}

function okBlueprints(results: readonly InventionCheckResult[]): BotBlueprint[] {
  return results.flatMap((r) => (r.ok ? [r.blueprint] : []));
}
