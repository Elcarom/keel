import { FLEET_INSTRUMENTS, type Rig, type DesignBrief } from "@keel/core";

// ============================================================================
// The Shipwright: Claude writes new entry rules in the Strategy Spec condition language. Keel
// checks every invention (an injected checker from @keel/spec), asks Claude once to repair the
// ones that fail, and drops what still fails. The model never touches stops or sizing.
// ============================================================================

export type InventionCheckResult =
  | { readonly ok: true; readonly rig: Rig }
  | { readonly ok: false; readonly name: string; readonly error: string };

/** Validates one raw invention against the brief; implemented by @keel/spec's checkInvention. */
export type InventionChecker = (raw: unknown, brief: DesignBrief) => InventionCheckResult;

/** The condition language and Keel's limits, shared by the API prompt and the chat prompt. */
const SHIPWRIGHT_LANGUAGE = `Each invention trades USDT perpetuals on confirmed 1-hour bars: its own "instrumentId" and, if you like, a "basket" of up to 4 more coins that run the same rules, one position per coin, all funded from one stake. You write its entry rules, and if you like its exit rules, as JSON in Keel's condition language. Keel attaches the protective stop (stopAtrMultiple × ATR(14)) and the take-profit (rewardMultiple × the risk) itself, sizes each position and enters at the next bar's open.

EXITS (all optional): "longExit" / "shortExit" close an open position at the bar's close when the condition turns true. "trailingAtrMultiple" (0.5-6) ratchets the stop that many ATR(14) behind each close, so winners can run; it never loosens. "maxBarsHeld" (2-240) closes any position after that many hours. Exits are how an idea says when it is over: a reversion trade that has reverted, a trend that has turned, a session that has ended.

Rules may read higher timeframes: "timeframe": "4H" or "1D" builds 4-hour and daily bars from complete hourly ones, so you can trade the hour in the direction of the day. Keel holds OKX's settled funding for the whole two-year trial, so "funding" is a real signal: crowded longs pay, crowded shorts are paid.

Rules may also read other markets. Without "market", prices and indicators read the coin being traded (in a basket, each coin in turn). With "market", they read that market's bar for the same hour, e.g. BTC's, whichever coin is traded. Keel only trades once every market the rules read has posted that hour, so nothing reads the future.

PAIRS: set "pairWith" to a second coin and the boat holds "instrumentId" against it, close to market-neutral. When longEntry fires it buys instrumentId and sells pairWith; when shortEntry fires, the reverse. Keel runs the same rules mirrored on the second leg (every "market": pairWith reads instrumentId there), so the legs always take opposite sides, enter together and leave together: if one leg is stopped out, Keel closes the other at that hour's close. The entry rules must read pairWith, usually through a "spread" indicator. Each leg's stop is stopAtrMultiple × the wider ATR(14) of the two coins as a share of price, so both legs carry the same notional; a pair has no basket, no trailing stop and no real target (it leaves on its exit rules), and maxBarsHeld defaults to three times its longest window.

THE LANGUAGE
Numbers (NumExpr):
- {"type":"constant","value":1.5}
- {"type":"bar_field","field":"close"} with field one of open, high, low, close, volume, hour (0-23 UTC), weekday (0 = Sunday, UTC), funding (the traded coin's latest settled 8-hour funding rate, in basis points); optional "shift": n reads n bars ago (max 48); optional "market": "BTC-USDT-SWAP" reads that market instead; optional "timeframe": "4H" or "1D" reads the last complete 4-hour or daily bar
- {"type":"indicator","id":"<your id>","output":"<output>"} with optional "shift" (max 48)
- {"type":"binary_op","op":"+"|"-"|"*"|"/","left":NumExpr,"right":NumExpr}
Conditions:
- {"type":"comparison","op":">"|">="|"<"|"<=","left":NumExpr,"right":NumExpr}
- {"type":"crosses_above"|"crosses_below","seriesA":NumExpr,"seriesB":NumExpr} (true on the bar A crosses B)
- {"type":"logical_op","op":"and"|"or","operands":[Condition, ...]}
Indicators you declare (1-6), each {"id","kind","period"} with period 2-200, plus an optional "market" to compute it on that market's bars and an optional "timeframe" ("4H" or "1D") to compute it on 4-hour or daily bars (a 4H period may be at most 120 bars, a 1D period at most 20), and the outputs you may read:
- donchian: highest_high, lowest_low (of the previous period bars, excluding the current one)
- sma: mean · ema: ema · rsi: rsi (Wilder, 0-100) · atr: atr · stddev: stddev
- zscore: zscore, mean, stddev (of closes) · momentum: momentum (close change over period, ATR-scaled), atr
- volume_sma: mean (average volume)
- adx: adx (trend strength 0-100), plus_di, minus_di · bollinger (2 standard deviations): percent_b (0 at the lower band, 1 at the upper), upper, lower, bandwidth (band width ÷ mean)
- percentile: percentile (share of the previous period closes below this one, 0-100)
- correlation (needs "market"): correlation (-1..1) and beta of the traded coin's hourly returns against that market's
- spread (needs "market"): zscore (of the log price ratio of the traded coin to that market, over period) and momentum (the ratio's drift over period, divided by its own hourly noise)

HARD LIMITS (Keel rejects anything beyond them)
- longEntry and shortEntry together use at most 32 nodes (every condition and every number counts as one node); longExit and shortExit share a separate 16.
- Nesting: with one "and"/"or" at the top, its operands are comparisons or crosses, and each side of those is a simple number or ONE binary_op of two simple numbers. With a single comparison or cross at the top (no and/or), each side may nest binary_ops two deep, e.g. (high - low) / atr. Never put and/or inside and/or.
- Every indicator id you read must be declared, with an output its kind has.
- If a direction makes no sense for your idea, still give a valid rule for it and set "direction" to long_only or short_only.

OUTPUT SHAPE
{"propositions":[ ... ]}, each item:
{"name","tagline" (one playful sentence),"rationale" (why it should work and when it should fail, 2-3 sentences),"instrumentId","basket" ([] or up to 4 more coins),"pairWith" (null, or the second coin of a pair),"direction" ("both"|"long_only"|"short_only"),"indicators":[...],"longEntry":Condition,"shortEntry":Condition,"stopAtrMultiple" (0.5-6),"rewardMultiple" (0.8-6),"longExit" (Condition or null),"shortExit" (Condition or null),"trailingAtrMultiple" (number or null),"maxBarsHeld" (number or null)}
Markets are written in full, e.g. "SOL-USDT-SWAP". Keel trades and reads: ${FLEET_INSTRUMENTS.join(", ")}.

THE SEA TRIAL
Keel measures every invention itself: a two-year backtest with doubled costs and funding (a basket is judged as one portfolio across all its coins, a pair on both legs together), walk-forward folds, a random-entry baseline, every window and threshold nudged (windows -25% and +33%, thresholds ±10%), and the same rules on a sibling market outside the basket (for a pair, another pair of coins). Fragile curve-fits sink. Trades should happen often enough to judge: roughly 30-300 over two years.`;

export const SHIPWRIGHT_SYSTEM_PROMPT = `You invent trading strategies for Keel, a self-hosted crypto perpetual-futures lab, and you are expected to be original. Keel's theme is the sea: every strategy becomes a boat with a short nautical name (1-3 words) that hints at how it trades. Never use real people, brands or existing products as names.

${SHIPWRIGHT_LANGUAGE}

HOW TO INVENT WELL
- Start from a mechanism: who is forced to trade, when, and why price should respond. Examples: session opens and closes, weekend illiquidity, volatility regimes, crowded breakouts, exhaustion after a run of bars, volume shocks.
- Combine signals into ideas a textbook would not list; each proposition must be genuinely different from the others.
- Design the exit as carefully as the entry: trailing stops for trends, time limits for session and calendar effects, exit rules for reversion that has run its course.
- Think across markets: BTC leading the alts, one coin's strength against another, a basket of coins that should share an edge, a pair that trades the gap between two coins rather than the market. Use a basket when the idea should hold across similar coins, a pair when the idea is about two coins relative to each other, and one coin when it is specific to one market.
- Prefer few, structural conditions over finely tuned thresholds.
- Never claim performance; Keel measures it.

Return only the JSON.`;

export const SHIPWRIGHT_REPAIR_PROMPT = `Some of your inventions failed Keel's checks. For each one below, return a corrected version that keeps the idea but fixes exactly the problem named. Same JSON shape as before: {"propositions":[...]}, one per failed invention, in the same order.`;

const FENCE = "```";

export interface ShipwrightChatPromptOptions {
  readonly count: number;
  readonly instruments: readonly string[];
  readonly direction: DesignBrief["direction"];
  readonly notes: string;
  readonly namesAlreadyInTheFleet: readonly string[];
  /** One line on what the fleet already sails (FleetService.fleetSummary). */
  readonly fleetToday?: string | undefined;
}

/**
 * The Shipwright prompt for a chat with any model the operator chooses. It hands the model the whole
 * language and asks for range, not caution: Keel's checks and the sea trial do the doubting.
 */
export function shipwrightChatPrompt(options: ShipwrightChatPromptOptions): string {
  const n = options.count;
  const direction =
    options.direction === "long_only"
      ? "long only: set every direction to long_only"
      : options.direction === "short_only"
        ? "short only: set every direction to short_only"
        : "your call, per strategy: both, long_only or short_only";
  const hunting = options.notes.trim() || "anything with a real edge; surprise me";
  const fleet =
    options.namesAlreadyInTheFleet.length > 0
      ? options.namesAlreadyInTheFleet.join(", ")
      : "none yet";
  return `You are the shipwright-in-residence at Keel, a self-hosted lab that researches systematic strategies on crypto perpetual futures. I want ${n} brand-new trading ${n === 1 ? "strategy" : "strategies"} from you, as creative, novel and interesting as you can make them. You have full creative freedom inside the language below; its hard limits are the only rules. Keel's theme is the sea: each strategy becomes a boat with a short nautical name (1-3 words) that hints at how it trades. Never use real people, brands or existing products as names.

YOUR BRIEF
- Strategies: ${n}
- Markets the boats may trade (instrumentId and basket); spread your ideas across them: ${options.instruments.join(", ")}
- Markets the rules may read as signals: any of Keel's ten
- Direction: ${direction}
- What I am hunting for: ${hunting}
- Names already in my fleet (do not reuse): ${fleet}
- My fleet today: ${options.fleetToday ?? "unknown"} Prefer what it lacks; an idea that trades like a boat I already have adds nothing.

${SHIPWRIGHT_LANGUAGE}

HOW TO INVENT
Think it through before you write any JSON. Go wide first: sketch two or three times as many ideas as I asked for, then keep the ${n} most original and most plausible.
- Every idea starts from a mechanism: who is forced to buy or sell, when, and why price should respond. Examples are liquidations and stop cascades, funding resets, session handovers between Asia, Europe and the US, thin weekend books, options-expiry Fridays, volatility that compresses then releases, volume that leads price, exhaustion after a run of bars, and failed moves that trap one side. Anything else you can defend counts too.
- Use the whole language. Arithmetic builds new series:
  - ratios and spreads between indicators
  - candle anatomy from open, high, low and close (body, wicks, range)
  - multi-bar shapes with shift
  - volume against its own average
  - volatility against its own longer norm
  - the UTC clock and weekday
  - other markets: BTC or ETH leading the alts, a coin's strength or weakness against another, moves one market has made and another has not yet followed
  - trend strength (ADX), Bollinger bands, percentile ranks, and correlation or beta against another market
  Long and short rules need not mirror each other.
- Design the exits, not just the entries. A trailing stop lets a trend run; a time limit ends a session or calendar trade; an exit rule closes a reversion trade once it has reverted. Many ideas are defined more by how they leave than how they arrive.
- Use baskets and pairs. When an idea should hold across similar coins, trade it on a basket of them: it diversifies the boat and gives the sea trial far more evidence. When an idea is about two coins relative to each other (a stretched gap, a rotation, a laggard catching up), make it a pair: it holds one against the other and takes most of the market's swing out. Keep a single coin when the idea is specific to one market. Aim for a real mix of single-coin boats, basket boats, pairs and cross-market rules across your ${n}.
- Make the ideas genuinely different from each other: different mechanisms, horizons and families (trend, breakout, reversion, calendar, volatility, volume, pattern), never two variations of one theme. Skip what a textbook lists first, such as plain moving-average crosses or plain RSI 30/70, unless you give it a real twist.
- Be bold in the idea and humble in the parameters. Use a few structural conditions and round numbers rather than finely tuned thresholds, because the sea trial nudges every one.
- Fit the stop and target to each idea's horizon: tight and quick for snapbacks, wide and patient for trends.
- In each rationale, say why it should work and exactly when it should fail. Never claim performance; Keel measures it.

BEFORE YOU ANSWER
Check every strategy against the hard limits:
- count the nodes across both entries (32 at most)
- make sure no and/or sits inside another
- make sure every indicator id you read is declared, with an output its kind has
One slip and Keel rejects the whole strategy.

YOUR ANSWER
Write one short line per strategy saying what it hunts. Then put all ${n} in a single ${FENCE}json code block as {"propositions":[ ... ]}, with exactly the fields of the output shape. Use no comments and no trailing commas in the JSON. If you can create files, also offer the JSON as keel-inventions.json.`;
}

/** A message for the same chat, asking it to fix what Keel rejected from its file. */
export function shipwrightChatRepairPrompt(
  rejected: readonly { readonly name: string; readonly error: string }[]
): string {
  const problems = rejected.map((r) => `- ${r.name}: ${r.error}`).join("\n");
  return `Keel rejected ${rejected.length} of your strategies. Fix each one: keep its idea, but remove the problem Keel names. Then check it against the hard limits again. Answer with only the corrected strategies, in one ${FENCE}json code block as {"propositions":[ ... ]}.

${problems}`;
}

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

/** Hand-written inventions for when Claude is not linked: real ideas, checked like Claude's. */
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
    name: "Lighthouse",
    tagline: "Watches BTC's lamp and steers each coin the way it has already swung.",
    rationale:
      "Alts often follow a decisive BTC move with a lag, so a coin that has barely moved after BTC surged tends to catch up. It fails when the coin is lagging for reasons of its own.",
    indicators: [
      { id: "btc_push", kind: "momentum", period: 6, market: "BTC-USDT-SWAP" },
      { id: "push", kind: "momentum", period: 6 }
    ],
    longEntry: and(
      cmp(ind("btc_push", "momentum"), ">=", k(1)),
      cmp(ind("push", "momentum"), "<", k(0.3))
    ),
    shortEntry: and(
      cmp(ind("btc_push", "momentum"), "<=", k(-1)),
      cmp(ind("push", "momentum"), ">", k(-0.3))
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
    tagline:
      "Dips a toe below the rising EMA and climbs straight back aboard, on several coins at once.",
    sailsBasket: true,
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

/**
 * Sample inventions shaped by the brief: instruments in turn, a 2 ATR stop and a 2R target. A
 * sample marked sailsBasket trades every other offered coin too, up to a five-coin boat.
 */
export function sampleInventions(brief: DesignBrief): unknown[] {
  return Array.from({ length: brief.count }, (_, i) => {
    const { sailsBasket, ...sample } = SAMPLE_INVENTIONS[i % SAMPLE_INVENTIONS.length] ?? {};
    const instrumentId = brief.instruments[i % brief.instruments.length];
    return {
      ...sample,
      instrumentId,
      basket: sailsBasket ? brief.instruments.filter((m) => m !== instrumentId).slice(0, 4) : [],
      direction: "both",
      stopAtrMultiple: 2,
      rewardMultiple: 2
    };
  });
}
