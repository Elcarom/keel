import { type BotBlueprint, type DesignBrief } from "@keel/core";

// ============================================================================
// Inventor mode: Claude writes new entry rules in the Strategy Spec condition language. Keel
// checks every invention (an injected checker from @keel/spec), asks Claude once to repair the
// ones that fail, and drops what still fails. The model never touches stops or sizing.
// ============================================================================

export type InventionCheckResult =
  | { readonly ok: true; readonly blueprint: BotBlueprint }
  | { readonly ok: false; readonly name: string; readonly error: string };

/** Validates one raw invention against the brief; implemented by @keel/spec's checkInvention. */
export type InventionChecker = (raw: unknown, brief: DesignBrief) => InventionCheckResult;

export const INVENTOR_SYSTEM_PROMPT = `You invent trading strategies for Keel, a self-hosted crypto perpetual-futures lab, and you are expected to be original. Keel's theme is the sea: every strategy becomes a boat with a short nautical name (1-3 words) that hints at how it trades. Never use real people, brands or existing products as names.

Each invention trades one USDT perpetual on confirmed 1-hour bars. You write its entry rules as JSON in Keel's condition language. Keel attaches the protective stop (stopAtrMultiple × ATR(14)) and the take-profit (rewardMultiple × the risk) itself, sizes the position and enters at the next bar's open. One position at a time.

THE LANGUAGE
Numbers (NumExpr):
- {"type":"constant","value":1.5}
- {"type":"bar_field","field":"close"} with field one of open, high, low, close, volume, hour (0-23 UTC), weekday (0 = Sunday, UTC); optional "shift": n reads n bars ago (max 48)
- {"type":"indicator","id":"<your id>","output":"<output>"} with optional "shift" (max 48)
- {"type":"binary_op","op":"+"|"-"|"*"|"/","left":NumExpr,"right":NumExpr}
Conditions:
- {"type":"comparison","op":">"|">="|"<"|"<=","left":NumExpr,"right":NumExpr}
- {"type":"crosses_above"|"crosses_below","seriesA":NumExpr,"seriesB":NumExpr} (true on the bar A crosses B)
- {"type":"logical_op","op":"and"|"or","operands":[Condition, ...]}
Indicators you declare (1-6), each {"id","kind","period"} with period 2-200, and the outputs you may read:
- donchian: highest_high, lowest_low (of the previous period bars, excluding the current one)
- sma: mean · ema: ema · rsi: rsi (Wilder, 0-100) · atr: atr · stddev: stddev
- zscore: zscore, mean, stddev (of closes) · momentum: momentum (close change over period, ATR-scaled), atr
- volume_sma: mean (average volume)

HARD LIMITS (Keel rejects anything beyond them)
- longEntry and shortEntry together use at most 32 nodes (every condition and every number counts as one node).
- Keep nesting shallow: at the top, one "and"/"or" (or a single comparison/cross); its operands are comparisons or crosses; each side of a comparison is a simple number or ONE binary_op of two simple numbers. No and/or inside and/or.
- Every indicator id you read must be declared, with an output its kind has.
- If a direction makes no sense for your idea, still give a valid rule for it and set "direction" to long_only or short_only.

OUTPUT
Return only JSON: {"propositions":[ ... ]}, each item:
{"name","tagline" (one playful sentence),"rationale" (why it should work and when it should fail, 2-3 sentences),"instrumentId","direction" ("both"|"long_only"|"short_only"),"indicators":[...],"longEntry":Condition,"shortEntry":Condition,"stopAtrMultiple" (0.5-6),"rewardMultiple" (0.8-6)}

HOW TO INVENT WELL
- Start from a mechanism: who is forced to trade, when, and why price should respond. Examples: session opens and closes, weekend illiquidity, volatility regimes, crowded breakouts, exhaustion after a run of bars, volume shocks.
- Combine signals into ideas a textbook would not list; each proposition must be genuinely different from the others.
- Prefer few, structural conditions over finely tuned thresholds. Every invention faces an automatic sea trial: a two-year backtest, doubled costs, walk-forward, every window and threshold nudged, and a sibling market. Fragile curve-fits sink.
- Trades should happen often enough to judge: roughly 30-300 over two years.
- Never claim performance; Keel measures it.`;

export const INVENTOR_REPAIR_PROMPT = `Some of your inventions failed Keel's checks. For each one below, return a corrected version that keeps the idea but fixes exactly the problem named. Same JSON shape as before: {"propositions":[...]}, one per failed invention, in the same order.`;

/** Starting stop and target for sample inventions, by the brief's risk appetite. */
const SAMPLE_RISK: Readonly<Record<DesignBrief["riskAppetite"], readonly [number, number]>> = {
  cautious: [2.5, 1.5],
  balanced: [2, 2],
  bold: [1.5, 3]
};

const close = { type: "bar_field", field: "close" } as const;
const k = (value: number) => ({ type: "constant", value }) as const;
const ind = (id: string, output: string, shift?: number) =>
  shift ? { type: "indicator", id, output, shift } : { type: "indicator", id, output };
const bar = (field: string, shift?: number) =>
  shift ? { type: "bar_field", field, shift } : { type: "bar_field", field };
const cmp = (left: unknown, op: string, right: unknown) => ({
  type: "comparison",
  op,
  left,
  right
});
const and = (...operands: unknown[]) => ({ type: "logical_op", op: "and", operands });
const times = (left: unknown, right: unknown) => ({ type: "binary_op", op: "*", left, right });

/** Hand-written inventions for when no Anthropic key is set: real ideas, checked like Claude's. */
const SAMPLE_INVENTIONS: readonly Record<string, unknown>[] = [
  {
    name: "Night Watch",
    tagline: "Keeps watch through the Asian night and pounces when a quiet range breaks on volume.",
    rationale:
      "Liquidity is thin before Europe wakes, so a range break backed by a volume surge often marks real repositioning. It fails when a thin-market spike is quickly faded at the London open.",
    indicators: [
      { id: "range", kind: "donchian", period: 12 },
      { id: "vol", kind: "volume_sma", period: 48 }
    ],
    longEntry: and(
      cmp(bar("hour"), "<=", k(7)),
      cmp(close, ">", ind("range", "highest_high")),
      cmp(bar("volume"), ">", times(ind("vol", "mean"), k(1.5)))
    ),
    shortEntry: and(
      cmp(bar("hour"), "<=", k(7)),
      cmp(close, "<", ind("range", "lowest_low")),
      cmp(bar("volume"), ">", times(ind("vol", "mean"), k(1.5)))
    )
  },
  {
    name: "Tidal Snapback",
    tagline: "Waits for a sharp dip inside a long tide, then rides the snap back.",
    rationale:
      "A fast RSI recovering from oversold while price holds above the 200-hour EMA catches panic dips in uptrends. It fails when the dip is the first leg of a trend change.",
    indicators: [
      { id: "fast_rsi", kind: "rsi", period: 7 },
      { id: "tide", kind: "ema", period: 160 }
    ],
    longEntry: and(
      { type: "crosses_above", seriesA: ind("fast_rsi", "rsi"), seriesB: k(25) },
      cmp(close, ">", ind("tide", "ema"))
    ),
    shortEntry: and(
      { type: "crosses_below", seriesA: ind("fast_rsi", "rsi"), seriesB: k(75) },
      cmp(close, "<", ind("tide", "ema"))
    )
  },
  {
    name: "Monday Ebb",
    tagline: "Fades the moves weekend sailors leave behind when the working week begins.",
    rationale:
      "Weekend crypto trades on thin books, and stretched prices early on Monday tend to revert as desks return. It fails when weekend news starts a genuine trend.",
    indicators: [{ id: "stretch", kind: "zscore", period: 24 }],
    longEntry: and(
      cmp(bar("weekday"), ">=", k(1)),
      cmp(bar("weekday"), "<=", k(1)),
      cmp(ind("stretch", "zscore"), "<=", k(-1.5))
    ),
    shortEntry: and(
      cmp(bar("weekday"), ">=", k(1)),
      cmp(bar("weekday"), "<=", k(1)),
      cmp(ind("stretch", "zscore"), ">=", k(1.5))
    )
  },
  {
    name: "Slack Water",
    tagline: "Lets the sea go glassy, then follows the first proper gust.",
    rationale:
      "When short-term volatility collapses well below its longer norm, the next impulse often carries. It fails when a quiet spell ends with a false start in both directions.",
    indicators: [
      { id: "calm", kind: "stddev", period: 12 },
      { id: "norm", kind: "stddev", period: 96 },
      { id: "push", kind: "momentum", period: 6 }
    ],
    longEntry: and(
      cmp(times(ind("calm", "stddev", 1), k(2)), "<", ind("norm", "stddev", 1)),
      cmp(ind("push", "momentum"), ">=", k(1))
    ),
    shortEntry: and(
      cmp(times(ind("calm", "stddev", 1), k(2)), "<", ind("norm", "stddev", 1)),
      cmp(ind("push", "momentum"), "<=", k(-1))
    )
  },
  {
    name: "Second Wind",
    tagline: "Dips a toe below the rising EMA and climbs straight back aboard.",
    rationale:
      "A wick through a rising 20-hour EMA that closes back above it shows dip buyers defending the trend. It fails in ranges, where the EMA is flat and the defence is noise.",
    indicators: [{ id: "guide", kind: "ema", period: 20 }],
    longEntry: and(
      cmp(bar("low"), "<", ind("guide", "ema")),
      cmp(close, ">", ind("guide", "ema")),
      cmp(ind("guide", "ema"), ">", ind("guide", "ema", 10))
    ),
    shortEntry: and(
      cmp(bar("high"), ">", ind("guide", "ema")),
      cmp(close, "<", ind("guide", "ema")),
      cmp(ind("guide", "ema"), "<", ind("guide", "ema", 10))
    )
  },
  {
    name: "Riptide",
    tagline: "Swims against three falling waves once the current is plainly exhausted.",
    rationale:
      "Three straight lower closes into an oversold RSI mark short-term forced selling that tends to pause. It fails when the selling is informed and keeps going.",
    indicators: [{ id: "heat", kind: "rsi", period: 14 }],
    longEntry: and(
      cmp(close, "<", bar("close", 1)),
      cmp(bar("close", 1), "<", bar("close", 2)),
      cmp(bar("close", 2), "<", bar("close", 3)),
      cmp(ind("heat", "rsi"), "<", k(30))
    ),
    shortEntry: and(
      cmp(close, ">", bar("close", 1)),
      cmp(bar("close", 1), ">", bar("close", 2)),
      cmp(bar("close", 2), ">", bar("close", 3)),
      cmp(ind("heat", "rsi"), ">", k(70))
    )
  }
];

/** Sample inventions shaped by the brief: instruments in turn, stops by risk appetite. */
export function sampleInventions(brief: DesignBrief): unknown[] {
  const [stop, reward] = SAMPLE_RISK[brief.riskAppetite];
  return Array.from({ length: brief.count }, (_, i) => {
    const sample = SAMPLE_INVENTIONS[i % SAMPLE_INVENTIONS.length] ?? {};
    return {
      ...sample,
      instrumentId: brief.instruments[i % brief.instruments.length],
      direction: "both",
      stopAtrMultiple: stop,
      rewardMultiple: reward
    };
  });
}
