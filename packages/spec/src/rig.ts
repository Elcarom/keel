import { ARCHETYPE_LABELS, pairLegs, type Rig } from "@keel/core";
import {
  StrategySpecV1Schema,
  type Condition,
  type IndicatorDef,
  type NumExpr,
  type StrategySpecV1
} from "./index.js";
import { TIMEFRAME_HOURS } from "./timeframes.js";
import { conditionShift, parseInventionRules } from "./invention.js";

// ============================================================================
// Boat Rigs: the flat, bounded shape an LLM fills in. Deterministic code (never the model)
// compiles a rig into a Strategy Spec, so every rule a boat trades on is one of a few
// reviewed archetypes with clamped parameters.
// ============================================================================

const NEVER: Condition = {
  type: "comparison",
  op: "<",
  left: { type: "constant", value: 1 },
  right: { type: "constant", value: 0 }
};

type BarField = "open" | "high" | "low" | "close" | "volume";

function bar(field: BarField, shift = 0): NumExpr {
  return shift > 0 ? { type: "bar_field", field, shift } : { type: "bar_field", field };
}

function ind(id: string, output: string, shift = 0): NumExpr {
  return shift > 0 ? { type: "indicator", id, output, shift } : { type: "indicator", id, output };
}

function k(value: number): NumExpr {
  return { type: "constant", value };
}

function op(left: NumExpr, o: "+" | "-" | "*" | "/", right: NumExpr): NumExpr {
  return { type: "binary_op", op: o, left, right };
}

function cmp(left: NumExpr, o: ">" | ">=" | "<" | "<=", right: NumExpr): Condition {
  return { type: "comparison", op: o, left, right };
}

function and(...operands: Condition[]): Condition {
  return { type: "logical_op", op: "and", operands };
}

interface ArchetypeRules {
  readonly indicators: readonly IndicatorDef[];
  readonly longEntry: Condition;
  readonly shortEntry: Condition;
  readonly longExit?: Condition | undefined;
  readonly shortExit?: Condition | undefined;
  /** Bars needed beyond the indicator windows: shifted reads and crossings look further back. */
  readonly extraBars: number;
}

function rulesFor(b: Rig): ArchetypeRules {
  const close = bar("close");
  const L = b.lookbackPeriod;
  const F = b.fastPeriod;
  const T = b.entryThreshold;
  switch (b.archetype) {
    case "invented": {
      if (!b.invention) throw new Error("An invented rig needs its invention");
      const rules = parseInventionRules(b.invention);
      return {
        ...rules,
        extraBars: Math.max(
          ...[rules.longEntry, rules.shortEntry, rules.longExit, rules.shortExit].map((c) =>
            c ? conditionShift(c, new Map(rules.indicators.map((d) => [d.id, d]))) : 0
          )
        )
      };
    }
    case "breakout":
      return {
        indicators: [{ id: "channel", kind: "donchian", period: L }],
        longEntry: cmp(close, ">", ind("channel", "highest_high")),
        shortEntry: cmp(close, "<", ind("channel", "lowest_low")),
        extraBars: 0
      };
    case "mean_reversion":
      return {
        indicators: [{ id: "z", kind: "zscore", period: L }],
        longEntry: cmp(ind("z", "zscore"), "<=", k(-T)),
        shortEntry: cmp(ind("z", "zscore"), ">=", k(T)),
        extraBars: 0
      };
    case "momentum":
      return {
        indicators: [{ id: "impulse", kind: "momentum", period: L }],
        longEntry: cmp(ind("impulse", "momentum"), ">=", k(T)),
        shortEntry: cmp(ind("impulse", "momentum"), "<=", k(-T)),
        extraBars: 0
      };
    case "ma_crossover":
      return {
        indicators: [
          { id: "fast", kind: "sma", period: F },
          { id: "slow", kind: "sma", period: L }
        ],
        longEntry: {
          type: "crosses_above",
          seriesA: ind("fast", "mean"),
          seriesB: ind("slow", "mean")
        },
        shortEntry: {
          type: "crosses_below",
          seriesA: ind("fast", "mean"),
          seriesB: ind("slow", "mean")
        },
        extraBars: 0
      };
    case "trend_pullback":
      return {
        indicators: [
          { id: "slow", kind: "sma", period: L },
          { id: "z", kind: "zscore", period: F }
        ],
        longEntry: and(cmp(close, ">", ind("slow", "mean")), cmp(ind("z", "zscore"), "<=", k(-T))),
        shortEntry: and(cmp(close, "<", ind("slow", "mean")), cmp(ind("z", "zscore"), ">=", k(T))),
        extraBars: 0
      };
    case "squeeze_breakout": {
      // Calm first: the short window's volatility (before this bar) is T times below the long one's
      const squeezed = cmp(
        op(ind("fastVol", "stddev", 1), "*", k(T)),
        "<",
        ind("slowVol", "stddev", 1)
      );
      return {
        indicators: [
          { id: "channel", kind: "donchian", period: F },
          { id: "fastVol", kind: "stddev", period: F },
          { id: "slowVol", kind: "stddev", period: L }
        ],
        longEntry: and(squeezed, cmp(close, ">", ind("channel", "highest_high"))),
        shortEntry: and(squeezed, cmp(close, "<", ind("channel", "lowest_low"))),
        extraBars: 1
      };
    }
    case "volume_breakout": {
      const surge = cmp(bar("volume"), ">", op(ind("volume", "mean"), "*", k(T)));
      return {
        indicators: [
          { id: "channel", kind: "donchian", period: L },
          { id: "volume", kind: "volume_sma", period: L }
        ],
        longEntry: and(surge, cmp(close, ">", ind("channel", "highest_high"))),
        shortEntry: and(surge, cmp(close, "<", ind("channel", "lowest_low"))),
        extraBars: 0
      };
    }
    case "inside_bar_breakout": {
      // The previous bar sat inside the one before it; this bar breaks out with the trend
      const insideHigh = cmp(bar("high", 1), "<", bar("high", 2));
      const insideLow = cmp(bar("low", 1), ">", bar("low", 2));
      return {
        indicators: [{ id: "trend", kind: "sma", period: L }],
        longEntry: and(
          insideHigh,
          insideLow,
          cmp(close, ">", bar("high", 1)),
          cmp(close, ">", ind("trend", "mean"))
        ),
        shortEntry: and(
          insideHigh,
          insideLow,
          cmp(close, "<", bar("low", 1)),
          cmp(close, "<", ind("trend", "mean"))
        ),
        extraBars: 2
      };
    }
    case "keltner_ride": {
      const band = op(ind("atr", "atr"), "*", k(T));
      return {
        indicators: [
          { id: "mid", kind: "ema", period: L },
          { id: "atr", kind: "atr", period: L }
        ],
        longEntry: {
          type: "crosses_above",
          seriesA: close,
          seriesB: op(ind("mid", "ema"), "+", band)
        },
        shortEntry: {
          type: "crosses_below",
          seriesA: close,
          seriesB: op(ind("mid", "ema"), "-", band)
        },
        extraBars: 1
      };
    }
    case "regime_momentum":
      // Momentum only in the direction of a rising (or falling) long average
      return {
        indicators: [
          { id: "impulse", kind: "momentum", period: F },
          { id: "trend", kind: "ema", period: L }
        ],
        longEntry: and(
          cmp(ind("impulse", "momentum"), ">=", k(T)),
          cmp(close, ">", ind("trend", "ema")),
          cmp(ind("trend", "ema"), ">", ind("trend", "ema", F))
        ),
        shortEntry: and(
          cmp(ind("impulse", "momentum"), "<=", k(-T)),
          cmp(close, "<", ind("trend", "ema")),
          cmp(ind("trend", "ema"), "<", ind("trend", "ema", F))
        ),
        extraBars: F
      };
    case "rsi_reversal":
      // Enters as RSI climbs back out of oversold (or falls back out of overbought)
      return {
        indicators: [{ id: "rsi", kind: "rsi", period: L }],
        longEntry: {
          type: "crosses_above",
          seriesA: ind("rsi", "rsi"),
          seriesB: k(50 - 10 * T)
        },
        shortEntry: {
          type: "crosses_below",
          seriesA: ind("rsi", "rsi"),
          seriesB: k(50 + 10 * T)
        },
        extraBars: 1
      };
    case "failed_breakout":
      // The previous bar poked through the channel, and this one closed back inside it
      return {
        indicators: [{ id: "channel", kind: "donchian", period: L }],
        longEntry: and(
          cmp(bar("low", 1), "<", ind("channel", "lowest_low", 1)),
          cmp(close, ">", ind("channel", "lowest_low", 1))
        ),
        shortEntry: and(
          cmp(bar("high", 1), ">", ind("channel", "highest_high", 1)),
          cmp(close, "<", ind("channel", "highest_high", 1))
        ),
        extraBars: 1
      };
    case "pair_reversion": {
      // The spread between the two coins stretched T deviations from its mean: bet on it closing
      const partner = b.pairWith ?? b.instrumentId;
      return {
        indicators: [{ id: "spread", kind: "spread", period: L, market: partner }],
        longEntry: cmp(ind("spread", "zscore"), "<=", k(-T)),
        shortEntry: cmp(ind("spread", "zscore"), ">=", k(T)),
        longExit: cmp(ind("spread", "zscore"), ">=", k(0)),
        shortExit: cmp(ind("spread", "zscore"), "<=", k(0)),
        extraBars: 1
      };
    }
    case "pair_momentum": {
      // One coin has been steadily outrunning the other: ride the gap until the drift fades
      const partner = b.pairWith ?? b.instrumentId;
      return {
        indicators: [{ id: "spread", kind: "spread", period: L, market: partner }],
        longEntry: cmp(ind("spread", "momentum"), ">=", k(T)),
        shortEntry: cmp(ind("spread", "momentum"), "<=", k(-T)),
        longExit: cmp(ind("spread", "momentum"), "<=", k(0)),
        shortExit: cmp(ind("spread", "momentum"), ">=", k(0)),
        extraBars: 1
      };
    }
    case "capitulation_fade": {
      // An outsized bar against the trend that still closes up (or down): the panic was absorbed
      const outsized = cmp(
        op(bar("high"), "-", bar("low")),
        ">",
        op(ind("atr", "atr", 1), "*", k(T))
      );
      return {
        indicators: [
          { id: "atr", kind: "atr", period: L },
          { id: "trend", kind: "sma", period: L }
        ],
        longEntry: and(
          outsized,
          cmp(close, ">", bar("open")),
          cmp(close, "<", ind("trend", "mean"))
        ),
        shortEntry: and(
          outsized,
          cmp(close, "<", bar("open")),
          cmp(close, ">", ind("trend", "mean"))
        ),
        extraBars: 1
      };
    }
  }
}

const ATR_PERIOD = 14;
const MAX_LOOKBACK_BARS = 500;

/** Bars an indicator needs before its value settles: recursive averages need several periods. */
function warmupBars(def: IndicatorDef): number {
  const hours = def.timeframe ? TIMEFRAME_HOURS[def.timeframe] : 1;
  if (def.kind === "ema" || def.kind === "rsi" || def.kind === "adx") return def.period * 3 * hours;
  // These read the bar before their window too; a higher timeframe also needs its first bucket
  const bars =
    def.kind === "percentile" || def.kind === "correlation" || def.kind === "spread"
      ? def.period + 1
      : def.period;
  return hours > 1 ? (bars + 1) * hours : bars;
}

/** Which leg of a pair a spec trades: 0 is the rig's own market, 1 its `pairWith`. */
export type PairLeg = 0 | 1;

/** Swaps two market ids everywhere they appear as a `market`, so a pair's rules mirror. */
function swapMarkets<T>(value: T, a: string, b: string): T {
  return JSON.parse(JSON.stringify(value), (key: string, v: unknown) =>
    key === "market" ? (v === a ? b : v === b ? a : v) : v
  ) as T;
}

/**
 * Compiles a rig into a validated Strategy Spec. `specName` becomes the strategy id, so
 * each boat (and each proposition) trades and backtests under an id of its own.
 *
 * A pair compiles once per leg (ADR-0032). Each leg runs the same rules with the other coin as
 * its reference market, so a spread stretched one way for the first leg is stretched the other
 * way for the second: one leg buys exactly when the other sells. Both legs carry the same
 * percentage stop, and exits come from the rules and the time limit rather than a target.
 */
export function compileRig(rig: Rig, specName: string, leg: PairLeg = 0): StrategySpecV1 {
  const legs = pairLegs(rig);
  const base = rulesFor(rig);
  const rules = legs && leg === 1 ? swapMarkets(base, legs[0], legs[1]) : base;
  const longest = Math.max(ATR_PERIOD, ...rules.indicators.map(warmupBars));
  // The second leg trades the mirror image, so "long only" (buy the first coin) means it sells
  const direction =
    legs && leg === 1
      ? rig.direction === "long_only"
        ? "short_only"
        : rig.direction === "short_only"
          ? "long_only"
          : "both"
      : rig.direction;
  const traded = legs ? legs[leg] : rig.instrumentId;
  const partner = legs ? legs[leg === 0 ? 1 : 0] : null;
  return StrategySpecV1Schema.parse({
    name: specName,
    version: 1,
    description: (partner
      ? `${ARCHETYPE_LABELS[rig.archetype]}, ${traded} leg against ${partner}: ${rig.tagline}`
      : `${ARCHETYPE_LABELS[rig.archetype]} on ${traded}: ${rig.tagline}`
    ).slice(0, 2000),
    timeframe: "1H",
    lookbacks: { "1H": Math.min(MAX_LOOKBACK_BARS, longest + rules.extraBars + 2) },
    indicators: rules.indicators,
    rules: {
      longEntry: direction === "short_only" ? NEVER : rules.longEntry,
      shortEntry: direction === "long_only" ? NEVER : rules.shortEntry,
      ...(rules.longExit ? { longExit: rules.longExit } : {}),
      ...(rules.shortExit ? { shortExit: rules.shortExit } : {})
    },
    risk: {
      stopModel: partner
        ? {
            kind: "pair_atr",
            multiplier: rig.stopAtrMultiple,
            atrPeriod: ATR_PERIOD,
            market: partner
          }
        : {
            kind: "atr_multiple",
            multiplier: rig.stopAtrMultiple,
            atrPeriod: ATR_PERIOD
          },
      // A pair leaves on its rules or its time limit; the far target only guards a runaway leg
      takeProfit: { rewardMultiple: partner ? 10 : rig.rewardMultiple },
      ...(rig.maxBarsHeld ? { timeStopBars: rig.maxBarsHeld } : {}),
      ...(rig.trailingAtrMultiple && !partner
        ? { trailingStop: { atrMultiple: rig.trailingAtrMultiple, atrPeriod: ATR_PERIOD } }
        : {})
    },
    cooldownBars: 0
  });
}
