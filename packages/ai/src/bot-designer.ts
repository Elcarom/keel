import {
  ARCHETYPE_LABELS,
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

const SYSTEM_PROMPT = `You design automated trading boats for Keel, a self-hosted crypto perpetual-futures lab. Keel's theme is the sea: a keel keeps a ship steady, each trading bot is a boat in the operator's fleet, and every boat gets a short nautical name (1-3 words) that hints at how it trades, e.g. "Trade Wind" for a momentum rider or "Undertow" for a mean-reversion fader. Never use real people, brands or existing products as names.

Each boat trades one USDT perpetual on confirmed 1-hour bars and is one of these archetypes. L is lookbackPeriod, F is fastPeriod (always shorter than L) and T is entryThreshold. Every archetype still needs a value for every parameter, even ones it ignores.
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
Every trade has a protective stop stopAtrMultiple ATRs away and a take-profit at rewardMultiple times the risk.

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
  "ma_crossover"
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

/** Drafts propositions without a model: varied, deterministic, shaped by the brief. */
export function sampleBlueprints(brief: DesignBrief): BotBlueprintDraft[] {
  const styles = brief.styles.length > 0 ? brief.styles : SURPRISE_ORDER;
  const shape = RISK_SHAPES[brief.riskAppetite];
  const drafts: BotBlueprintDraft[] = [];
  for (let i = 0; i < brief.count; i++) {
    const archetype = styles[i % styles.length] ?? "breakout";
    const round = Math.floor(i / styles.length);
    const instrumentId = brief.instruments[i % brief.instruments.length] ?? "BTC-USDT-SWAP";
    const sample = SAMPLES[archetype];
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
      rationale: `${sample.rationale} (${ARCHETYPE_LABELS[archetype]}, ${brief.riskAppetite} sizing.)`
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
        note: "No Anthropic API key is set, so these are sample propositions. Add the key under Engine Room → Secrets to have Claude design your boats."
      };
    }

    const userPrompt = JSON.stringify({
      request: `Propose ${brief.count} boats.`,
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
