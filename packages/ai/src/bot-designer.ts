import {
  ARCHETYPE_LABELS,
  BOT_ARCHETYPES,
  BOT_BLUEPRINT_DRAFT_JSON_SCHEMA,
  BotBlueprintDraftSchema,
  normalizeBlueprint,
  type BotArchetype,
  type BotBlueprint,
  type BotBlueprintDraft,
  type Clock,
  type DesignBrief,
  type DesignSource,
  type LlmGateway
} from "@keel/core";
import { z } from "zod";

export interface BotDesignResult {
  readonly source: DesignSource;
  readonly blueprints: readonly BotBlueprint[];
  /** Shown to the operator when the designs did not come from Claude as asked. */
  readonly note: string | null;
}

export interface BotDesignerOptions {
  readonly clock: Clock;
  readonly gateway: LlmGateway;
  /** True when a real model can be called; otherwise the designer drafts sample propositions. */
  readonly isLive: () => boolean;
}

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

const SYSTEM_PROMPT = `You design trading bots for Keel, a self-hosted crypto perpetual-futures lab. Keel's theme is the sea: a keel keeps a ship steady, bots are vessels in a fleet, and every bot gets a short nautical name (1-3 words) that hints at how it trades, e.g. "Trade Wind" for a momentum rider or "Undertow" for a mean-reversion fader. Never use real people, brands or existing products as names.

Each bot trades one instrument on confirmed 1-hour bars and is one of five archetypes. Fill the parameters each archetype uses with sensible values; unused parameters still need a value.
- breakout: enters when the close breaks the highest high (long) or lowest low (short) of the previous lookbackPeriod bars.
- mean_reversion: fades stretched prices; enters when the lookbackPeriod z-score of the close is beyond -entryThreshold (long) or +entryThreshold (short).
- momentum: rides impulses; enters when the lookbackPeriod change in close, scaled by ATR, exceeds entryThreshold (long) or -entryThreshold (short).
- ma_crossover: enters when the fastPeriod average crosses above (long) or below (short) the lookbackPeriod average.
- trend_pullback: buys dips in uptrends (close above the lookbackPeriod average and fastPeriod z-score below -entryThreshold), and the mirror for shorts.
Every trade has a protective stop stopAtrMultiple ATRs away and a take-profit at rewardMultiple times the risk.

Propose genuinely different ideas: vary archetype, horizon and risk, and prefer the styles and instruments the operator asked for. Be honest in the rationale about when the idea should fail. Each proposition will be backtested automatically, so do not invent performance numbers.`;

const SAMPLE_NAMES: Readonly<Record<BotArchetype, readonly string[]>> = {
  breakout: ["Breakwater", "Squall Line", "Bow Wave", "Harbour Gate"],
  mean_reversion: ["Undertow", "Ebb & Flow", "Slack Tide", "Rip Current"],
  momentum: ["Trade Wind", "Spinnaker", "Following Sea", "Gale Runner"],
  ma_crossover: ["Crosscurrent", "Twin Lights", "Turning Tide", "Compass Rose"],
  trend_pullback: ["Kedge Anchor", "Backwash", "Lee Shore", "Second Wave"]
};

const SAMPLE_TAGLINES: Readonly<Record<BotArchetype, string>> = {
  breakout: "Waits behind the harbour wall, then charges through when price breaks the channel.",
  mean_reversion: "Leans against stretched moves and rides the tide back to the mean.",
  momentum: "Hoists the sails when the wind picks up and lets the impulse carry it.",
  ma_crossover: "Changes tack when the fast current crosses the slow one.",
  trend_pullback: "Follows the main current but only boards on the dips."
};

const SAMPLE_RATIONALES: Readonly<Record<BotArchetype, string>> = {
  breakout:
    "Breakouts catch the start of trends after quiet ranges. It suffers in choppy markets where breaks fail and reverse.",
  mean_reversion:
    "Short-term overreactions in perpetuals often snap back. It gets hurt when a stretched move turns into a sustained trend.",
  momentum:
    "Strong hourly impulses tend to persist for a while. It gives back gains when impulses fade straight away.",
  ma_crossover:
    "Crossovers are a slow, steady way to follow trends. They lag at turning points and get whipsawed in ranges.",
  trend_pullback:
    "Buying dips inside a trend gets better entries than chasing. It fails when the dip is the start of a reversal."
};

interface RiskShape {
  readonly entryThreshold: number;
  readonly stopAtrMultiple: number;
  readonly rewardMultiple: number;
}

const RISK_SHAPES: Readonly<Record<DesignBrief["riskAppetite"], RiskShape>> = {
  cautious: { entryThreshold: 2, stopAtrMultiple: 2.5, rewardMultiple: 1.5 },
  balanced: { entryThreshold: 1.5, stopAtrMultiple: 2, rewardMultiple: 2 },
  bold: { entryThreshold: 1, stopAtrMultiple: 1.5, rewardMultiple: 3 }
};

const SAMPLE_LOOKBACKS: Readonly<Record<BotArchetype, { lookback: number; fast: number }>> = {
  breakout: { lookback: 24, fast: 8 },
  mean_reversion: { lookback: 20, fast: 8 },
  momentum: { lookback: 12, fast: 6 },
  ma_crossover: { lookback: 48, fast: 12 },
  trend_pullback: { lookback: 72, fast: 10 }
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

/** Drafts propositions without a model: varied, deterministic, shaped by the brief. */
export function sampleBlueprints(brief: DesignBrief): BotBlueprintDraft[] {
  const styles = brief.styles.length > 0 ? brief.styles : BOT_ARCHETYPES;
  const shape = RISK_SHAPES[brief.riskAppetite];
  const drafts: BotBlueprintDraft[] = [];
  for (let i = 0; i < brief.count; i++) {
    const archetype = styles[i % styles.length] ?? "breakout";
    const round = Math.floor(i / styles.length);
    const instrumentId = brief.instruments[i % brief.instruments.length] ?? "BTC-USDT-SWAP";
    const names = SAMPLE_NAMES[archetype];
    const periods = SAMPLE_LOOKBACKS[archetype];
    // Later rounds of the same archetype sail a slower horizon so they are not duplicates
    const stretch = 1 + round * 0.75;
    drafts.push({
      name: names[round % names.length] ?? archetype,
      tagline: SAMPLE_TAGLINES[archetype],
      archetype,
      instrumentId,
      direction: brief.direction === "any" ? "both" : brief.direction,
      lookbackPeriod: Math.round(periods.lookback * stretch),
      fastPeriod: Math.round(periods.fast * stretch),
      entryThreshold: shape.entryThreshold,
      stopAtrMultiple: shape.stopAtrMultiple,
      rewardMultiple: shape.rewardMultiple,
      rationale: `${SAMPLE_RATIONALES[archetype]} (${ARCHETYPE_LABELS[archetype]}, ${brief.riskAppetite} sizing.)`
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

  public constructor(options: BotDesignerOptions) {
    this.clock = options.clock;
    this.gateway = options.gateway;
    this.isLive = options.isLive;
  }

  public async design(brief: DesignBrief, takenNames: readonly string[]): Promise<BotDesignResult> {
    if (!this.isLive()) {
      return {
        source: "sample",
        blueprints: this.finish(sampleBlueprints(brief), brief, takenNames),
        note: "No Anthropic API key is set, so these are sample propositions. Add the key under Engine Room → Secrets to have Claude design your bots."
      };
    }

    const userPrompt = JSON.stringify({
      request: `Propose ${brief.count} bots.`,
      instruments: brief.instruments,
      preferredStyles: brief.styles.length > 0 ? brief.styles : "any",
      riskAppetite: brief.riskAppetite,
      direction: brief.direction,
      operatorNotes: brief.notes || "none",
      namesAlreadyInTheFleet: takenNames
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

  private finish(
    drafts: readonly BotBlueprintDraft[],
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
        direction: brief.direction === "any" ? draft.direction : brief.direction
      });
      const name = uniqueName(blueprint.name, taken);
      taken.add(name.toLowerCase());
      return { ...blueprint, name };
    });
  }
}
