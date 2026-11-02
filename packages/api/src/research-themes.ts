import { type Proposition, type Rig } from "@keel/core";

// ============================================================================
// What the night shift has already explored, and where it should look next (ADR-0037). Plain,
// deterministic bookkeeping over the rigs Claude drew up: no model reads or writes it, and it
// never touches what launches or trades.
// ============================================================================

/** The ingredients a rig is built from, read off its rules. */
export type Ingredient =
  | "pair"
  | "basket"
  | "other market"
  | "higher timeframe"
  | "funding"
  | "calendar"
  | "volume"
  | "volatility regime"
  | "exit rule"
  | "trailing stop"
  | "time limit"
  | "one side only";

/** A direction for one research round: the ingredient it explores and what to ask Claude. */
export interface ResearchTheme {
  readonly ingredient: Ingredient;
  readonly title: string;
  readonly brief: string;
}

export const RESEARCH_THEMES: readonly ResearchTheme[] = [
  {
    ingredient: "funding",
    title: "Funding and crowding",
    brief:
      "Who is paying to hold a position, how crowded it is, and what happens when they give up. Read the funding rate."
  },
  {
    ingredient: "other market",
    title: "Lead and lag between markets",
    brief:
      "One market moving first and others following: BTC or ETH leading the alts, a laggard catching up, a divergence that closes."
  },
  {
    ingredient: "pair",
    title: "Relative value",
    brief:
      "Two coins against each other, close to market-neutral: a stretched spread that snaps back, or one coin persistently outrunning another."
  },
  {
    ingredient: "basket",
    title: "An edge shared across coins",
    brief:
      "One structural effect that should hold across several similar coins, sailed as a basket so it is judged as one portfolio."
  },
  {
    ingredient: "calendar",
    title: "Sessions and the calendar",
    brief:
      "When the world trades: session opens and closes in Asia, Europe and the US, the funding hours, weekends and Mondays. Read hour and weekday."
  },
  {
    ingredient: "volatility regime",
    title: "Volatility regimes",
    brief:
      "Quiet markets that coil and loud ones that exhaust: trade differently by regime, or trade the switch from one to the other."
  },
  {
    ingredient: "volume",
    title: "Volume shocks",
    brief:
      "Unusual volume as the footprint of forced or informed trading: climaxes, absorption, breakouts nobody joined."
  },
  {
    ingredient: "higher timeframe",
    title: "Hour inside the day",
    brief:
      "Let the 4-hour or daily picture set the context and the hourly bar set the timing: pullbacks in a daily trend, hourly fades against a stretched day."
  },
  {
    ingredient: "exit rule",
    title: "Exits that know when it is over",
    brief:
      "Ideas whose edge is in the exit: leave when the reversion has reverted, the spread has closed or the trend has turned, not at a fixed target."
  },
  {
    ingredient: "one side only",
    title: "Asymmetry",
    brief:
      "Markets do not fall the way they rise. An edge that only exists on one side: panics, squeezes, slow grinds up."
  },
  {
    ingredient: "trailing stop",
    title: "Letting winners run",
    brief:
      "Rare, large moves caught early and ridden with a trailing stop; few trades, each with room to run well past the costs."
  },
  {
    ingredient: "time limit",
    title: "Short, timed trades",
    brief:
      "An effect with a known half-life: get in, hold for a set number of hours, get out, whatever happened."
  }
];

/** The ingredients a rig uses, in RESEARCH_THEMES order. */
export function ingredientsOf(rig: Rig): Ingredient[] {
  const rules = JSON.stringify(rig.invention ?? {});
  const kinds = new Set<string>((rig.invention?.indicators ?? []).map((i) => i.kind));
  const has: Record<Ingredient, boolean> = {
    funding: rules.includes('"field":"funding"'),
    "other market": !rig.pairWith && rules.includes('"market":'),
    pair: Boolean(rig.pairWith),
    basket: rig.basket.length > 0,
    calendar: rules.includes('"field":"hour"') || rules.includes('"field":"weekday"'),
    "volatility regime": ["adx", "bollinger", "stddev", "percentile"].some((k) => kinds.has(k)),
    volume: kinds.has("volume_sma") || rules.includes('"field":"volume"'),
    "higher timeframe": rules.includes('"timeframe":'),
    "exit rule": Boolean(rig.invention?.longExit) || Boolean(rig.invention?.shortExit),
    "one side only": rig.direction !== "both",
    "trailing stop": rig.trailingAtrMultiple !== null,
    "time limit": rig.maxBarsHeld !== null && !rig.pairWith
  };
  return RESEARCH_THEMES.map((t) => t.ingredient).filter((i) => has[i]);
}

/**
 * The theme for the next round: the one the recent ideas used least, so the search keeps moving
 * into ground it has not covered. Ties go round in turn, by how many rounds have run.
 */
export function nextTheme(recent: readonly Rig[], roundsSoFar: number): ResearchTheme {
  const used = new Map<Ingredient, number>();
  for (const rig of recent) {
    for (const i of ingredientsOf(rig)) used.set(i, (used.get(i) ?? 0) + 1);
  }
  const fewest = Math.min(...RESEARCH_THEMES.map((t) => used.get(t.ingredient) ?? 0));
  const least = RESEARCH_THEMES.filter((t) => (used.get(t.ingredient) ?? 0) === fewest);
  const pick = least[roundsSoFar % least.length];
  if (!pick) throw new Error("No research theme to pick from");
  return pick;
}

/**
 * One line per idea already drawn up, newest first, so Claude does not offer it again: its name and
 * tagline, what it is built from, and only whether it passed (ADR-0035: never which checks failed).
 */
export function triedIdeas(propositions: readonly Proposition[], limit: number): string[] {
  return [...propositions]
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, limit)
    .map((p) => {
      const coin = p.rig.instrumentId.replace("-USDT-SWAP", "");
      const built = ingredientsOf(p.rig);
      const outcome =
        p.status === "assessing"
          ? "Still in its sea trial"
          : p.assessment === null
            ? "Could not be tested"
            : p.assessment.verdict === "seaworthy"
              ? "Passed its sea trial"
              : "Did not pass its sea trial";
      return `${p.rig.name} (${coin}): ${p.rig.tagline} Built from ${built.length > 0 ? built.join(", ") : "price and indicators alone"}. ${outcome}.`;
    });
}
