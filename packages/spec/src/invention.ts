import { type BotBlueprint, type IndicatorKind, type Invention } from "@keel/core";
import {
  ConditionSchema,
  IndicatorDefSchema,
  type Condition,
  type IndicatorDef,
  type NumExpr
} from "./index.js";

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
  volume_sma: ["mean"]
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
  volume_sma: "average volume"
};

const OUTPUT_NAMES: Readonly<Record<string, string>> = {
  highest_high: "high",
  lowest_low: "low",
  mean: "mean",
  stddev: "volatility"
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

function ago(shift: number | undefined): string {
  if (!shift) return "";
  return shift === 1 ? " 1 bar ago" : ` ${shift} bars ago`;
}

function describeExpr(expr: NumExpr, defs: ReadonlyMap<string, IndicatorDef>): string {
  switch (expr.type) {
    case "constant":
      return formatNumber(expr.value);
    case "bar_field":
      if (expr.field === "hour") return `the UTC hour${ago(expr.shift)}`;
      if (expr.field === "weekday") return `the weekday${ago(expr.shift)}`;
      return `${expr.field}${ago(expr.shift)}`;
    case "indicator": {
      const def = defs.get(expr.id);
      if (!def) return expr.id;
      const base = `${KIND_NAMES[def.kind]}(${def.period})`;
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
} {
  return {
    indicators: invention.indicators.map((i) => IndicatorDefSchema.parse(i)),
    longEntry: ConditionSchema.parse(invention.longEntry),
    shortEntry: ConditionSchema.parse(invention.shortEntry)
  };
}

function exprShift(expr: NumExpr): number {
  switch (expr.type) {
    case "constant":
      return 0;
    case "bar_field":
    case "indicator":
      return expr.shift ?? 0;
    case "binary_op":
      return Math.max(exprShift(expr.left), exprShift(expr.right));
  }
}

/** The furthest back a condition reads; crossings also read the bar before. */
export function conditionShift(cond: Condition): number {
  switch (cond.type) {
    case "comparison":
      return Math.max(exprShift(cond.left), exprShift(cond.right));
    case "crosses_above":
    case "crosses_below":
      return Math.max(exprShift(cond.seriesA), exprShift(cond.seriesB)) + 1;
    case "logical_op":
      return Math.max(0, ...cond.operands.map(conditionShift));
  }
}

/** Plain-English rules for a blueprint's invention, honouring its direction. */
export function describeInvention(
  b: Pick<BotBlueprint, "direction" | "stopAtrMultiple" | "rewardMultiple">,
  invention: Invention
): string[] {
  const rules = parseInventionRules(invention);
  const defs = new Map(rules.indicators.map((d) => [d.id, d]));
  return [
    b.direction === "short_only"
      ? "Never goes long"
      : `Long when ${describeCondition(rules.longEntry, defs)}`,
    b.direction === "long_only"
      ? "Never goes short"
      : `Short when ${describeCondition(rules.shortEntry, defs)}`,
    `Stop ${b.stopAtrMultiple}× ATR(14) away, target ${b.rewardMultiple}× the risk`
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
    rules: []
  };
  return { ...b, invention: { ...invention, rules: describeInvention(b, invention) } };
}
