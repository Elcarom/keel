import { type BotBlueprint, type IndicatorKind, type Invention } from "@keel/core";
import {
  ConditionSchema,
  IndicatorDefSchema,
  type Condition,
  type IndicatorDef,
  type NumExpr
} from "./index.js";
import { TIMEFRAME_HOURS, type HigherTimeframe } from "./timeframes.js";

// ============================================================================
// Inventions: entry rules Claude wrote itself in the Strategy Spec condition language. They are
// data until validated here; compiled, they trade exactly like any other spec (ATR stop attached,
// confirmed bars only).
// ============================================================================

/** The outputs each indicator kind computes; any other output name is an invention error. */
export const INDICATOR_OUTPUTS: Readonly<Record<IndicatorKind, readonly string[]>> = {
  donchian: ["highest_high", "lowest_low"],
  atr: ["atr"],
  sma: ["mean"],
  stddev: ["stddev"],
  zscore: ["zscore", "mean", "stddev"],
  momentum: ["momentum", "atr"],
  ema: ["ema"],
  rsi: ["rsi"],
  volume_sma: ["mean"],
  adx: ["adx", "plus_di", "minus_di"],
  bollinger: ["percent_b", "upper", "lower", "bandwidth"],
  percentile: ["percentile"],
  correlation: ["correlation", "beta"],
  spread: ["zscore", "momentum"]
};

/** The furthest an invention may look back with `shift`, in bars. */
export const MAX_INVENTION_SHIFT = 48;

const KIND_NAMES: Readonly<Record<IndicatorKind, string>> = {
  donchian: "channel",
  atr: "ATR",
  sma: "SMA",
  stddev: "volatility",
  zscore: "z-score",
  momentum: "momentum",
  ema: "EMA",
  rsi: "RSI",
  volume_sma: "average volume",
  adx: "ADX",
  bollinger: "Bollinger %B",
  percentile: "percentile rank",
  correlation: "correlation",
  spread: "spread"
};

const OUTPUT_NAMES: Readonly<Record<string, string>> = {
  highest_high: "high",
  lowest_low: "low",
  mean: "mean",
  stddev: "volatility",
  plus_di: "+DI",
  minus_di: "−DI",
  upper: "upper band",
  lower: "lower band",
  bandwidth: "width",
  beta: "beta"
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Hour and weekday compare against clock values, which nudging must never scale. */
function isCalendar(expr: NumExpr): boolean {
  return expr.type === "bar_field" && (expr.field === "hour" || expr.field === "weekday");
}

function calendarValue(field: NumExpr, value: number): string {
  if (field.type === "bar_field" && field.field === "weekday") {
    return WEEKDAYS[Math.round(value)] ?? String(value);
  }
  return `${String(Math.round(value)).padStart(2, "0")}:00`;
}

function symbol(op: ">" | ">=" | "<" | "<="): string {
  return op === ">=" ? "≥" : op === "<=" ? "≤" : op;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

const TIMEFRAME_WORDS: Readonly<Record<HigherTimeframe, string>> = {
  "4H": "4-hour",
  "1D": "daily"
};

/** "BTC-USDT-SWAP" reads as "BTC". */
function coinOf(market: string): string {
  return market.replace("-USDT-SWAP", "");
}

function ago(shift: number | undefined): string {
  if (!shift) return "";
  return shift === 1 ? " 1 bar ago" : ` ${shift} bars ago`;
}

function describeExpr(expr: NumExpr, defs: ReadonlyMap<string, IndicatorDef>): string {
  switch (expr.type) {
    case "constant":
      return formatNumber(expr.value);
    case "bar_field": {
      if (expr.field === "hour") return `the UTC hour${ago(expr.shift)}`;
      if (expr.field === "weekday") return `the weekday${ago(expr.shift)}`;
      if (expr.field === "funding") return `funding (bps)${ago(expr.shift)}`;
      const tf = expr.timeframe ? `${TIMEFRAME_WORDS[expr.timeframe]} ` : "";
      return `${expr.market ? `${coinOf(expr.market)} ` : ""}${tf}${expr.field}${ago(expr.shift)}`;
    }
    case "indicator": {
      const def = defs.get(expr.id);
      if (!def) return expr.id;
      const coin = def.market ? `${coinOf(def.market)} ` : "";
      const tf = def.timeframe ? `${TIMEFRAME_WORDS[def.timeframe]} ` : "";
      // A spread is the traded coin measured against its market, not the market itself
      if (def.kind === "spread") {
        const what = expr.output === "momentum" ? "drift" : "z-score";
        return `${what} of the ${tf}spread to ${coinOf(def.market ?? "")} (${def.period})${ago(expr.shift)}`;
      }
      const base = `${coin}${tf}${KIND_NAMES[def.kind]}(${def.period})`;
      // A kind's main output reads as the indicator itself; secondary outputs are named
      const main = INDICATOR_OUTPUTS[def.kind][0];
      const output =
        expr.output && expr.output !== main ? ` ${OUTPUT_NAMES[expr.output] ?? expr.output}` : "";
      const label =
        def.kind === "donchian"
          ? `${base} ${OUTPUT_NAMES[expr.output ?? "highest_high"] ?? ""}`
          : `${base}${output}`;
      return `${label.trim()}${ago(expr.shift)}`;
    }
    case "binary_op":
      return `(${describeExpr(expr.left, defs)} ${expr.op === "*" ? "×" : expr.op === "/" ? "÷" : expr.op} ${describeExpr(expr.right, defs)})`;
  }
}

/** Renders a condition as one readable clause, e.g. "RSI(14) crosses above 30 and close > EMA(50)". */
export function describeCondition(
  cond: Condition,
  defs: ReadonlyMap<string, IndicatorDef>
): string {
  switch (cond.type) {
    case "comparison": {
      const right =
        isCalendar(cond.left) && cond.right.type === "constant"
          ? calendarValue(cond.left, cond.right.value)
          : describeExpr(cond.right, defs);
      return `${describeExpr(cond.left, defs)} ${symbol(cond.op)} ${right}`;
    }
    case "crosses_above":
      return `${describeExpr(cond.seriesA, defs)} crosses above ${describeExpr(cond.seriesB, defs)}`;
    case "crosses_below":
      return `${describeExpr(cond.seriesA, defs)} crosses below ${describeExpr(cond.seriesB, defs)}`;
    case "logical_op": {
      const parts = cond.operands.map((o) => describeCondition(o, defs));
      if (cond.op === "not") return `not (${parts[0] ?? ""})`;
      return parts.length <= 1
        ? (parts[0] ?? "")
        : parts.map((p, i) => (i === 0 ? p : `${cond.op} ${p}`)).join(" ");
    }
  }
}

/** The invention's rules, parsed by the Spec schemas (they are stored as plain data). */
export function parseInventionRules(invention: Invention): {
  readonly indicators: readonly IndicatorDef[];
  readonly longEntry: Condition;
  readonly shortEntry: Condition;
  readonly longExit?: Condition | undefined;
  readonly shortExit?: Condition | undefined;
} {
  return {
    indicators: invention.indicators.map((i) => IndicatorDefSchema.parse(i)),
    longEntry: ConditionSchema.parse(invention.longEntry),
    shortEntry: ConditionSchema.parse(invention.shortEntry),
    ...(invention.longExit !== undefined
      ? { longExit: ConditionSchema.parse(invention.longExit) }
      : {}),
    ...(invention.shortExit !== undefined
      ? { shortExit: ConditionSchema.parse(invention.shortExit) }
      : {})
  };
}

/** How many hourly bars back an expression reads: shifts count bars of their own timeframe. */
function exprShift(expr: NumExpr, defs?: ReadonlyMap<string, IndicatorDef>): number {
  switch (expr.type) {
    case "constant":
      return 0;
    case "bar_field": {
      const hours = expr.timeframe ? TIMEFRAME_HOURS[expr.timeframe] : 1;
      return (expr.shift ?? 0) * hours + (hours > 1 ? hours : 0);
    }
    case "indicator": {
      const tf = defs?.get(expr.id)?.timeframe;
      return (expr.shift ?? 0) * (tf ? TIMEFRAME_HOURS[tf] : 1);
    }
    case "binary_op":
      return Math.max(exprShift(expr.left, defs), exprShift(expr.right, defs));
  }
}

/** The furthest back a condition reads; crossings also read the bar before. */
export function conditionShift(cond: Condition, defs?: ReadonlyMap<string, IndicatorDef>): number {
  switch (cond.type) {
    case "comparison":
      return Math.max(exprShift(cond.left, defs), exprShift(cond.right, defs));
    case "crosses_above":
    case "crosses_below":
      return Math.max(exprShift(cond.seriesA, defs), exprShift(cond.seriesB, defs)) + 1;
    case "logical_op":
      return Math.max(0, ...cond.operands.map((o) => conditionShift(o, defs)));
  }
}

/** Plain-English rules for a blueprint's invention, honouring its direction and basket. */
export function describeInvention(
  b: Pick<BotBlueprint, "direction" | "stopAtrMultiple" | "rewardMultiple"> & {
    readonly basket?: readonly string[] | undefined;
    readonly instrumentId?: string | undefined;
    readonly trailingAtrMultiple?: number | null | undefined;
    readonly maxBarsHeld?: number | null | undefined;
    readonly pairWith?: string | null | undefined;
  },
  invention: Invention
): string[] {
  const rules = parseInventionRules(invention);
  const defs = new Map(rules.indicators.map((d) => [d.id, d]));
  const basket =
    b.basket && b.basket.length > 0 && b.instrumentId
      ? [
          `Trades ${[b.instrumentId, ...b.basket].map(coinOf).join(", ")} with the same rules, one position per coin`
        ]
      : [];
  if (b.pairWith && b.instrumentId) {
    const own = coinOf(b.instrumentId);
    const other = coinOf(b.pairWith);
    return [
      `A pair: ${own} against ${other}, one long and one short, entering and leaving together`,
      b.direction === "short_only"
        ? `Never buys ${own} against ${other}`
        : `Buys ${own} and sells ${other} when ${describeCondition(rules.longEntry, defs)}`,
      b.direction === "long_only"
        ? `Never sells ${own} against ${other}`
        : `Sells ${own} and buys ${other} when ${describeCondition(rules.shortEntry, defs)}`,
      `Each leg's stop ${b.stopAtrMultiple}× the wider ATR(14) of the two coins away`,
      ...(rules.longExit
        ? [`Closes a bought pair when ${describeCondition(rules.longExit, defs)}`]
        : []),
      ...(rules.shortExit
        ? [`Closes a sold pair when ${describeCondition(rules.shortExit, defs)}`]
        : []),
      ...(b.maxBarsHeld ? [`Closes both legs after ${b.maxBarsHeld} hours`] : [])
    ];
  }
  return [
    b.direction === "short_only"
      ? "Never goes long"
      : `Long when ${describeCondition(rules.longEntry, defs)}`,
    b.direction === "long_only"
      ? "Never goes short"
      : `Short when ${describeCondition(rules.shortEntry, defs)}`,
    `Stop ${b.stopAtrMultiple}× ATR(14) away, target ${b.rewardMultiple}× the risk`,
    ...(rules.longExit && b.direction !== "short_only"
      ? [`Exit longs when ${describeCondition(rules.longExit, defs)}`]
      : []),
    ...(rules.shortExit && b.direction !== "long_only"
      ? [`Exit shorts when ${describeCondition(rules.shortExit, defs)}`]
      : []),
    ...(b.trailingAtrMultiple
      ? [`Trail the stop ${b.trailingAtrMultiple}× ATR(14) behind each close`]
      : []),
    ...(b.maxBarsHeld ? [`Close any position after ${b.maxBarsHeld} hours`] : []),
    ...basket
  ];
}

function scaleExpr(expr: NumExpr, factor: number): NumExpr {
  switch (expr.type) {
    case "constant":
      return { ...expr, value: Math.round(expr.value * factor * 1000) / 1000 };
    case "binary_op":
      return { ...expr, left: scaleExpr(expr.left, factor), right: scaleExpr(expr.right, factor) };
    default:
      return expr;
  }
}

function scaleCondition(cond: Condition, factor: number): Condition {
  switch (cond.type) {
    case "comparison":
      if (isCalendar(cond.left) || isCalendar(cond.right)) return cond;
      return { ...cond, left: scaleExpr(cond.left, factor), right: scaleExpr(cond.right, factor) };
    case "crosses_above":
    case "crosses_below":
      return {
        ...cond,
        seriesA: scaleExpr(cond.seriesA, factor),
        seriesB: scaleExpr(cond.seriesB, factor)
      };
    case "logical_op":
      return { ...cond, operands: cond.operands.map((o) => scaleCondition(o, factor)) };
  }
}

/**
 * The same invention with every indicator window scaled by `periodScale` and every number in its
 * rules by `constantScale`: the nudges a sea trial checks an invention survives.
 */
export function nudgeInvention(
  b: BotBlueprint,
  periodScale: number,
  constantScale: number
): BotBlueprint {
  if (!b.invention) return b;
  const rules = parseInventionRules(b.invention);
  const invention: Invention = {
    indicators: b.invention.indicators.map((i) => ({
      ...i,
      period: Math.min(200, Math.max(2, Math.round(i.period * periodScale)))
    })),
    longEntry: scaleCondition(rules.longEntry, constantScale),
    shortEntry: scaleCondition(rules.shortEntry, constantScale),
    ...(rules.longExit ? { longExit: scaleCondition(rules.longExit, constantScale) } : {}),
    ...(rules.shortExit ? { shortExit: scaleCondition(rules.shortExit, constantScale) } : {}),
    rules: []
  };
  return { ...b, invention: { ...invention, rules: describeInvention(b, invention) } };
}
