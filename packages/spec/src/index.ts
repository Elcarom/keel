import { z } from "zod";
import {
  BarTimeframeSchema,
  ScaledDecimal,
  sha256Hex,
  type ConfirmedBar,
  type FeatureSnapshot,
  type LookbackRequirement,
  type Proposal,
  type ProposalMenu
} from "@keel/core";
import type { Strategy } from "@keel/strategy";

// ============================================================================
// 1. AST Expressions & Zod Schema
// ============================================================================

export type NumExpr =
  | { readonly type: "constant"; readonly value: number }
  | {
      readonly type: "bar_field";
      readonly field: "open" | "high" | "low" | "close" | "volume";
      readonly shift?: number | undefined;
    }
  | {
      readonly type: "indicator";
      readonly id: string;
      readonly output?: string | undefined;
      readonly shift?: number | undefined;
    }
  | {
      readonly type: "binary_op";
      readonly op: "+" | "-" | "*" | "/";
      readonly left: NumExpr;
      readonly right: NumExpr;
    };

export const NumExprSchema: z.ZodType<NumExpr> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("constant"),
      value: z.number()
    }),
    z.object({
      type: z.literal("bar_field"),
      field: z.enum(["open", "high", "low", "close", "volume"]),
      shift: z.number().int().min(0).optional()
    }),
    z.object({
      type: z.literal("indicator"),
      id: z.string().min(1),
      output: z.string().optional(),
      shift: z.number().int().min(0).optional()
    }),
    z.object({
      type: z.literal("binary_op"),
      op: z.enum(["+", "-", "*", "/"]),
      left: NumExprSchema,
      right: NumExprSchema
    })
  ])
);

export type Condition =
  | {
      readonly type: "comparison";
      readonly op: ">" | ">=" | "<" | "<=" | "==" | "!=";
      readonly left: NumExpr;
      readonly right: NumExpr;
    }
  | {
      readonly type: "logical_op";
      readonly op: "and" | "or" | "not";
      readonly operands: readonly Condition[];
    }
  | {
      readonly type: "crosses_above";
      readonly seriesA: NumExpr;
      readonly seriesB: NumExpr;
    }
  | {
      readonly type: "crosses_below";
      readonly seriesA: NumExpr;
      readonly seriesB: NumExpr;
    };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("comparison"),
      op: z.enum([">", ">=", "<", "<=", "==", "!="]),
      left: NumExprSchema,
      right: NumExprSchema
    }),
    z.object({
      type: z.literal("logical_op"),
      op: z.enum(["and", "or", "not"]),
      operands: z.array(ConditionSchema)
    }),
    z.object({
      type: z.literal("crosses_above"),
      seriesA: NumExprSchema,
      seriesB: NumExprSchema
    }),
    z.object({
      type: z.literal("crosses_below"),
      seriesA: NumExprSchema,
      seriesB: NumExprSchema
    })
  ])
);

export const IndicatorDefSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["donchian", "atr", "sma", "stddev", "zscore", "momentum"]),
  period: z.number().int().positive(),
  params: z.record(z.string(), z.union([z.number(), z.string()])).optional()
});
export type IndicatorDef = z.infer<typeof IndicatorDefSchema>;

export const RiskRulesSchema = z.object({
  stopModel: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("atr_multiple"),
      multiplier: z.number().positive(),
      atrPeriod: z.number().int().positive()
    }),
    z.object({
      kind: z.literal("channel_bound"),
      period: z.number().int().positive()
    }),
    z.object({
      kind: z.literal("fixed_points"),
      points: z.number().positive()
    })
  ]),
  takeProfit: z.object({
    rewardMultiple: z.number().positive()
  })
});
export type RiskRules = z.infer<typeof RiskRulesSchema>;

export const StrategySpecV1Schema = z.object({
  name: z.string().min(1),
  version: z.literal(1),
  description: z.string(),
  timeframe: BarTimeframeSchema,
  lookbacks: z.record(BarTimeframeSchema, z.number().int().positive()),
  indicators: z.array(IndicatorDefSchema),
  rules: z.object({
    longEntry: ConditionSchema,
    shortEntry: ConditionSchema
  }),
  risk: RiskRulesSchema,
  synthetic: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});
export type StrategySpecV1 = z.infer<typeof StrategySpecV1Schema>;

// ============================================================================
// 2. Canonical JSON Serialization & Parameter Hashing (ADR-0020)
// ============================================================================

export function sortObjectKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const result: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    if (obj[k] !== undefined) {
      result[k] = sortObjectKeys(obj[k]);
    }
  }
  return result;
}

export function computeSpecHash(spec: StrategySpecV1): string {
  const canonical = JSON.stringify(sortObjectKeys(spec));
  return sha256Hex(canonical);
}

// ============================================================================
// 3. Deterministic Plain English Generator
// ============================================================================

function describeNumExpr(expr: NumExpr): string {
  switch (expr.type) {
    case "constant":
      return `${expr.value}`;
    case "bar_field":
      return expr.shift ? `${expr.field}[t-${expr.shift}]` : expr.field;
    case "indicator":
      return expr.output
        ? `${expr.id}.${expr.output}${expr.shift ? `[t-${expr.shift}]` : ""}`
        : `${expr.id}${expr.shift ? `[t-${expr.shift}]` : ""}`;
    case "binary_op":
      return `(${describeNumExpr(expr.left)} ${expr.op} ${describeNumExpr(expr.right)})`;
  }
}

function describeCondition(cond: Condition): string {
  switch (cond.type) {
    case "comparison":
      return `${describeNumExpr(cond.left)} ${cond.op} ${describeNumExpr(cond.right)}`;
    case "logical_op": {
      if (cond.op === "not") {
        return `NOT (${cond.operands[0] ? describeCondition(cond.operands[0]) : "false"})`;
      }
      return cond.operands.map(describeCondition).join(` ${cond.op.toUpperCase()} `);
    }
    case "crosses_above":
      return `${describeNumExpr(cond.seriesA)} crosses above ${describeNumExpr(cond.seriesB)}`;
    case "crosses_below":
      return `${describeNumExpr(cond.seriesA)} crosses below ${describeNumExpr(cond.seriesB)}`;
  }
}

export function describeSpec(spec: StrategySpecV1): string {
  const lines: string[] = [
    `Strategy Spec: ${spec.name} (v${spec.version})`,
    `Description: ${spec.description}`,
    `Timeframe: ${spec.timeframe}`,
    `Lookbacks: ${JSON.stringify(spec.lookbacks)}`,
    "",
    "Indicators:"
  ];

  for (const ind of spec.indicators) {
    lines.push(`  - [${ind.id}] ${ind.kind.toUpperCase()} (period: ${ind.period})`);
  }

  lines.push("");
  lines.push("Rules:");
  lines.push(`  - Long Entry:  ${describeCondition(spec.rules.longEntry)}`);
  lines.push(`  - Short Entry: ${describeCondition(spec.rules.shortEntry)}`);
  lines.push("");
  lines.push("Risk:");
  if (spec.risk.stopModel.kind === "atr_multiple") {
    lines.push(
      `  - Stop Model:  ${spec.risk.stopModel.multiplier}x ATR (${spec.risk.stopModel.atrPeriod}p)`
    );
  } else if (spec.risk.stopModel.kind === "channel_bound") {
    lines.push(`  - Stop Model:  Channel Bound (${spec.risk.stopModel.period}p)`);
  } else {
    lines.push(`  - Stop Model:  Fixed Points (${spec.risk.stopModel.points})`);
  }
  lines.push(`  - Take Profit: ${spec.risk.takeProfit.rewardMultiple}x Risk Multiple (Limit Exit)`);

  if (spec.synthetic) {
    lines.push("");
    lines.push("Synthetic Flag: TRUE (Quarantined from Demo and Live)");
  }

  return lines.join("\n");
}

// ============================================================================
// 4. Indicator Computation Engine (Pure Causal)
// ============================================================================

function toFixedDecimalString(value: number, decimals = 8): string {
  const clamped = Math.max(1e-8, value);
  return ScaledDecimal.fromString(clamped.toFixed(decimals)).toString();
}

function computeTrueRange(bar: ConfirmedBar, prevClose: string): number {
  const high = Number(bar.high);
  const low = Number(bar.low);
  const prev = Number(prevClose);
  return Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev));
}

function computeAtr(bars: readonly ConfirmedBar[], length: number): number {
  const latest = bars[bars.length - 1];
  const refPrice = latest ? Math.abs(Number(latest.close)) : 1;
  const minVol = Math.max(1e-8, refPrice * 1e-4);
  if (bars.length < 2) {
    if (!latest) return minVol;
    return Math.max(minVol, Number(latest.high) - Number(latest.low));
  }
  const slice = bars.slice(-Math.min(bars.length, length + 1));
  let sumTr = 0;
  let count = 0;
  for (let i = 1; i < slice.length; i += 1) {
    const cur = slice[i];
    const prev = slice[i - 1];
    if (cur && prev) {
      sumTr += computeTrueRange(cur, prev.close);
      count += 1;
    }
  }
  const avgTr = count > 0 ? sumTr / count : minVol;
  return Math.max(minVol, avgTr);
}

function buildProtectiveLevels(params: {
  side: "long" | "short";
  entryPriceStr: string;
  stopDistancePoints: number;
  rewardMultiple: number;
}): {
  protectiveStopPrice: string;
  takeProfitPrice: string;
} {
  const entry = Number(params.entryPriceStr);
  const minDistance = Math.max(1e-8, entry * 1e-4);
  const safeDist = Math.max(minDistance, Math.min(entry * 0.25, params.stopDistancePoints));
  const rewardDist = safeDist * Math.max(1, params.rewardMultiple);

  if (params.side === "long") {
    const stopVal = Math.max(minDistance, entry - safeDist);
    const tpVal = entry + rewardDist;
    return {
      protectiveStopPrice: toFixedDecimalString(stopVal),
      takeProfitPrice: toFixedDecimalString(tpVal)
    };
  }
  const stopVal = entry + safeDist;
  const tpVal = Math.max(minDistance, entry - rewardDist);
  return {
    protectiveStopPrice: toFixedDecimalString(stopVal),
    takeProfitPrice: toFixedDecimalString(tpVal)
  };
}

interface EvaluatedIndicators {
  readonly [id: string]: Record<string, number>;
}

function computeIndicators(
  defs: readonly IndicatorDef[],
  bars: readonly ConfirmedBar[]
): EvaluatedIndicators {
  const result: Record<string, Record<string, number>> = {};
  const latest = bars[bars.length - 1];
  const closeNum = latest ? Number(latest.close) : 0;
  const minVol = Math.max(1e-8, closeNum * 1e-4);

  for (const def of defs) {
    const res: Record<string, number> = {};
    switch (def.kind) {
      case "donchian": {
        // Look back over prior window of length `period`, excluding latest bar (exact baseline match)
        const priorWindow = bars.slice(-(def.period + 1), -1);
        let highestHigh = -Infinity;
        let lowestLow = Infinity;
        for (const b of priorWindow) {
          const h = Number(b.high);
          const l = Number(b.low);
          if (h > highestHigh) highestHigh = h;
          if (l < lowestLow) lowestLow = l;
        }
        res["highest_high"] = highestHigh;
        res["lowest_low"] = lowestLow;
        break;
      }
      case "atr": {
        res["atr"] = computeAtr(bars, def.period);
        break;
      }
      case "sma": {
        const window = bars.slice(-def.period);
        const closes = window.map((b) => Number(b.close));
        const mean = closes.reduce((acc, v) => acc + v, 0) / (closes.length || 1);
        res["mean"] = mean;
        break;
      }
      case "stddev": {
        const window = bars.slice(-def.period);
        const closes = window.map((b) => Number(b.close));
        const mean = closes.reduce((acc, v) => acc + v, 0) / (closes.length || 1);
        const variance = closes.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (closes.length || 1);
        res["stddev"] = Math.max(minVol, Math.sqrt(variance));
        break;
      }
      case "zscore": {
        const window = bars.slice(-def.period);
        const closes = window.map((b) => Number(b.close));
        const mean = closes.reduce((acc, v) => acc + v, 0) / (closes.length || 1);
        const variance = closes.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (closes.length || 1);
        const stdDev = Math.max(minVol, Math.sqrt(variance));
        res["zscore"] = (closeNum - mean) / stdDev;
        res["mean"] = mean;
        res["stddev"] = stdDev;
        break;
      }
      case "momentum": {
        const anchor = bars[bars.length - 1 - def.period];
        const anchorClose = anchor ? Number(anchor.close) : closeNum;
        const atr = computeAtr(bars, def.period);
        const safeVol = Math.max(minVol, atr * Math.sqrt(def.period));
        res["momentum"] = (closeNum - anchorClose) / safeVol;
        res["atr"] = atr;
        break;
      }
    }
    result[def.id] = res;
  }

  return result;
}

function evaluateNumExpr(
  expr: NumExpr,
  bars: readonly ConfirmedBar[],
  indicators: EvaluatedIndicators,
  indicatorDefs?: readonly IndicatorDef[]
): number {
  switch (expr.type) {
    case "constant":
      return expr.value;
    case "bar_field": {
      const shift = expr.shift ?? 0;
      const idx = bars.length - 1 - shift;
      const bar = bars[idx];
      if (!bar) return 0;
      switch (expr.field) {
        case "open":
          return Number(bar.open);
        case "high":
          return Number(bar.high);
        case "low":
          return Number(bar.low);
        case "close":
          return Number(bar.close);
        case "volume":
          return Number(bar.volumeContracts);
      }
      return 0;
    }
    case "indicator": {
      let targetIndicators = indicators;
      if (expr.shift && expr.shift > 0) {
        if (bars.length <= expr.shift) return 0;
        const shiftedBars = bars.slice(0, -expr.shift);
        targetIndicators = indicatorDefs ? computeIndicators(indicatorDefs, shiftedBars) : indicators;
      }
      const ind = targetIndicators[expr.id];
      if (!ind) return 0;
      const outputKey = expr.output ?? Object.keys(ind)[0] ?? "val";
      return ind[outputKey] ?? 0;
    }
    case "binary_op": {
      const l = evaluateNumExpr(expr.left, bars, indicators, indicatorDefs);
      const r = evaluateNumExpr(expr.right, bars, indicators, indicatorDefs);
      switch (expr.op) {
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "/":
          return r !== 0 ? l / r : 0;
      }
      return 0;
    }
  }
}

function evaluateCondition(
  cond: Condition,
  bars: readonly ConfirmedBar[],
  indicators: EvaluatedIndicators,
  indicatorDefs?: readonly IndicatorDef[]
): boolean {
  switch (cond.type) {
    case "comparison": {
      const l = evaluateNumExpr(cond.left, bars, indicators, indicatorDefs);
      const r = evaluateNumExpr(cond.right, bars, indicators, indicatorDefs);
      switch (cond.op) {
        case ">":
          return l > r;
        case ">=":
          return l >= r;
        case "<":
          return l < r;
        case "<=":
          return l <= r;
        case "==":
          return l === r;
        case "!=":
          return l !== r;
      }
      return false;
    }
    case "logical_op": {
      switch (cond.op) {
        case "and":
          return cond.operands.every((op) => evaluateCondition(op, bars, indicators, indicatorDefs));
        case "or":
          return cond.operands.some((op) => evaluateCondition(op, bars, indicators, indicatorDefs));
        case "not":
          return cond.operands[0]
            ? !evaluateCondition(cond.operands[0], bars, indicators, indicatorDefs)
            : false;
      }
      return false;
    }
    case "crosses_above": {
      if (bars.length < 2) return false;
      const priorBars = bars.slice(0, -1);
      const priorIndicators = indicatorDefs
        ? computeIndicators(indicatorDefs, priorBars)
        : indicators;
      const currA = evaluateNumExpr(cond.seriesA, bars, indicators, indicatorDefs);
      const currB = evaluateNumExpr(cond.seriesB, bars, indicators, indicatorDefs);
      const prevA = evaluateNumExpr(cond.seriesA, priorBars, priorIndicators, indicatorDefs);
      const prevB = evaluateNumExpr(cond.seriesB, priorBars, priorIndicators, indicatorDefs);
      return prevA <= prevB && currA > currB;
    }
    case "crosses_below": {
      if (bars.length < 2) return false;
      const priorBars = bars.slice(0, -1);
      const priorIndicators = indicatorDefs
        ? computeIndicators(indicatorDefs, priorBars)
        : indicators;
      const currA = evaluateNumExpr(cond.seriesA, bars, indicators, indicatorDefs);
      const currB = evaluateNumExpr(cond.seriesB, bars, indicators, indicatorDefs);
      const prevA = evaluateNumExpr(cond.seriesA, priorBars, priorIndicators, indicatorDefs);
      const prevB = evaluateNumExpr(cond.seriesB, priorBars, priorIndicators, indicatorDefs);
      return prevA >= prevB && currA < currB;
    }
  }
}

// ============================================================================
// 5. SpecStrategy (Port Adapter implementing Strategy)
// ============================================================================

export class SpecStrategy implements Strategy {
  public readonly id: string;
  public readonly strategyId: string;
  public readonly version: string;
  public readonly name: string;
  public readonly description: string;
  public readonly parameterHash: string;
  public readonly lookbacks: LookbackRequirement;
  public readonly lookbackRequirements: LookbackRequirement;
  public readonly isSynthetic: boolean;
  private readonly spec: StrategySpecV1;

  public constructor(spec: StrategySpecV1) {
    this.spec = StrategySpecV1Schema.parse(spec);
    this.id = this.spec.name;
    this.strategyId = this.spec.name;
    this.version = `${this.spec.version}.0.0`;
    this.name = this.spec.name;
    this.description = this.spec.description;
    this.parameterHash = computeSpecHash(this.spec);
    this.lookbacks = this.spec.lookbacks;
    this.lookbackRequirements = this.lookbacks;
    this.isSynthetic = Boolean(this.spec.synthetic);
  }

  public evaluate(snapshot: FeatureSnapshot): ProposalMenu {
    const bars = snapshot.barsByTimeframe[this.spec.timeframe] ?? [];
    const minBars =
      this.spec.indicators.length > 0
        ? Math.max(...this.spec.indicators.map((i) => i.period)) + 1
        : 2;

    if (bars.length < minBars) {
      return {
        instrumentId: snapshot.instrumentId,
        asOfMs: snapshot.asOfMs,
        strategyId: this.strategyId,
        strategyVersion: this.version,
        proposals: [],
        standDownReason: `insufficient_lookback_${this.spec.timeframe}`
      };
    }

    const latest = bars[bars.length - 1];
    if (!latest) {
      return {
        instrumentId: snapshot.instrumentId,
        asOfMs: snapshot.asOfMs,
        strategyId: this.strategyId,
        strategyVersion: this.version,
        proposals: [],
        standDownReason: `insufficient_lookback_${this.spec.timeframe}`
      };
    }

    const closeNum = Number(latest.close);
    const minVol = Math.max(1e-8, closeNum * 1e-4);

    // Compute indicators
    const indicatorDefs = this.spec.indicators;
    const indicators = computeIndicators(this.spec.indicators, bars);

    // Stop distance computation
    const computeStopDistance = (side: "long" | "short"): number => {
      if (this.spec.risk.stopModel.kind === "atr_multiple") {
        const atr = computeAtr(bars, this.spec.risk.stopModel.atrPeriod);
        return Math.max(minVol, atr * this.spec.risk.stopModel.multiplier);
      }
      if (this.spec.risk.stopModel.kind === "fixed_points") {
        return Math.max(minVol, this.spec.risk.stopModel.points);
      }
      if (this.spec.risk.stopModel.kind === "channel_bound") {
        const period = this.spec.risk.stopModel.period;
        const windowBars = bars.slice(-period - 1, -1);
        const firstBar = windowBars[0];
        if (!firstBar) return minVol;
        if (side === "long") {
          let lowest = Number(firstBar.low);
          for (let i = 1; i < windowBars.length; i++) {
            const b = windowBars[i];
            if (b) {
              const l = Number(b.low);
              if (l < lowest) lowest = l;
            }
          }
          return Math.max(minVol, closeNum - lowest);
        } else {
          let highest = Number(firstBar.high);
          for (let i = 1; i < windowBars.length; i++) {
            const b = windowBars[i];
            if (b) {
              const h = Number(b.high);
              if (h > highest) highest = h;
            }
          }
          return Math.max(minVol, highest - closeNum);
        }
      }
      return minVol;
    };

    const longMatched = evaluateCondition(
      this.spec.rules.longEntry,
      bars,
      indicators,
      indicatorDefs
    );
    const shortMatched = evaluateCondition(
      this.spec.rules.shortEntry,
      bars,
      indicators,
      indicatorDefs
    );

    const proposals: Proposal[] = [];

    if (longMatched) {
      const stopDistancePoints = computeStopDistance("long");
      const levels = buildProtectiveLevels({
        side: "long",
        entryPriceStr: latest.close,
        stopDistancePoints,
        rewardMultiple: this.spec.risk.takeProfit.rewardMultiple
      });

      // Calculate conviction score
      let convictionScore = 0.65;
      if (indicators["donchian"]?.["highest_high"] !== undefined) {
        const hh = indicators["donchian"]["highest_high"];
        const atr = indicators["atr"]?.["atr"] ?? minVol;
        const breakoutMagnitude = (closeNum - hh) / atr;
        convictionScore = Number(
          Math.min(0.95, 0.55 + Math.min(0.35, breakoutMagnitude * 0.15)).toFixed(4)
        );
      } else if (indicators["zscore"]?.["zscore"] !== undefined) {
        const z = Math.abs(indicators["zscore"]["zscore"]);
        convictionScore = Number(Math.min(0.92, 0.5 + Math.min(0.35, (z - 1.6) * 0.12)).toFixed(4));
      } else if (indicators["momentum"]?.["momentum"] !== undefined) {
        const mom = indicators["momentum"]["momentum"];
        convictionScore = Number(
          Math.min(0.94, 0.52 + Math.min(0.35, (mom - 0.9) * 0.15)).toFixed(4)
        );
      }

      proposals.push({
        proposalId: sha256Hex(
          `${this.strategyId}:${snapshot.instrumentId}:${snapshot.asOfMs}:long`
        ).slice(0, 16),
        strategyId: this.strategyId,
        strategyVersion: this.version,
        instrumentId: snapshot.instrumentId,
        side: "long",
        entryPrice: latest.close,
        protectiveStopPrice: levels.protectiveStopPrice,
        takeProfitPrice: levels.takeProfitPrice,
        convictionScore,
        rationale: `${this.spec.name} Long Signal confirmed at ${latest.close}`,
        tags: [this.spec.name, this.spec.timeframe]
      });
    } else if (shortMatched) {
      const stopDistancePoints = computeStopDistance("short");
      const levels = buildProtectiveLevels({
        side: "short",
        entryPriceStr: latest.close,
        stopDistancePoints,
        rewardMultiple: this.spec.risk.takeProfit.rewardMultiple
      });

      let convictionScore = 0.65;
      if (indicators["donchian"]?.["lowest_low"] !== undefined) {
        const ll = indicators["donchian"]["lowest_low"];
        const atr = indicators["atr"]?.["atr"] ?? minVol;
        const breakdownMagnitude = (ll - closeNum) / atr;
        convictionScore = Number(
          Math.min(0.95, 0.55 + Math.min(0.35, breakdownMagnitude * 0.15)).toFixed(4)
        );
      } else if (indicators["zscore"]?.["zscore"] !== undefined) {
        const z = indicators["zscore"]["zscore"];
        convictionScore = Number(Math.min(0.92, 0.5 + Math.min(0.35, (z - 1.6) * 0.12)).toFixed(4));
      } else if (indicators["momentum"]?.["momentum"] !== undefined) {
        const mom = Math.abs(indicators["momentum"]["momentum"]);
        convictionScore = Number(
          Math.min(0.94, 0.52 + Math.min(0.35, (mom - 0.9) * 0.15)).toFixed(4)
        );
      }

      proposals.push({
        proposalId: sha256Hex(
          `${this.strategyId}:${snapshot.instrumentId}:${snapshot.asOfMs}:short`
        ).slice(0, 16),
        strategyId: this.strategyId,
        strategyVersion: this.version,
        instrumentId: snapshot.instrumentId,
        side: "short",
        entryPrice: latest.close,
        protectiveStopPrice: levels.protectiveStopPrice,
        takeProfitPrice: levels.takeProfitPrice,
        convictionScore,
        rationale: `${this.spec.name} Short Signal confirmed at ${latest.close}`,
        tags: [this.spec.name, this.spec.timeframe]
      });
    }

    return {
      instrumentId: snapshot.instrumentId,
      asOfMs: snapshot.asOfMs,
      strategyId: this.strategyId,
      strategyVersion: this.version,
      proposals,
      ...(proposals.length === 0 ? { standDownReason: "no_spec_signals" } : {})
    };
  }
}

// ============================================================================
// 6. Built-in Strategy Spec Definitions (Golden Parity Specs)
// ============================================================================

export const DONCHIAN_TREND_V1_SPEC: StrategySpecV1 = {
  name: "donchian-trend-v1",
  version: 1,
  description: "20-bar Donchian channel breakout with 2x ATR protective stops.",
  timeframe: "1H",
  lookbacks: {
    "1H": 22
  },
  indicators: [
    { id: "donchian", kind: "donchian", period: 20 },
    { id: "atr", kind: "atr", period: 20 }
  ],
  rules: {
    longEntry: {
      type: "comparison",
      op: ">",
      left: { type: "bar_field", field: "close" },
      right: { type: "indicator", id: "donchian", output: "highest_high" }
    },
    shortEntry: {
      type: "comparison",
      op: "<",
      left: { type: "bar_field", field: "close" },
      right: { type: "indicator", id: "donchian", output: "lowest_low" }
    }
  },
  risk: {
    stopModel: {
      kind: "atr_multiple",
      multiplier: 2.0,
      atrPeriod: 20
    },
    takeProfit: {
      rewardMultiple: 2.5
    }
  }
};

export const VOL_MEAN_REVERSION_V1_SPEC: StrategySpecV1 = {
  name: "vol-mean-reversion-v1",
  version: 1,
  description: "Z-score mean-reversion fade with volatility-normalized stops.",
  timeframe: "1H",
  lookbacks: {
    "1H": 22
  },
  indicators: [
    { id: "zscore", kind: "zscore", period: 20 },
    { id: "atr", kind: "atr", period: 20 }
  ],
  rules: {
    longEntry: {
      type: "comparison",
      op: "<=",
      left: { type: "indicator", id: "zscore", output: "zscore" },
      right: { type: "constant", value: -1.6 }
    },
    shortEntry: {
      type: "comparison",
      op: ">=",
      left: { type: "indicator", id: "zscore", output: "zscore" },
      right: { type: "constant", value: 1.6 }
    }
  },
  risk: {
    stopModel: {
      kind: "atr_multiple",
      multiplier: 1.8,
      atrPeriod: 20
    },
    takeProfit: {
      rewardMultiple: 1.8
    }
  }
};

export const VOL_MOMENTUM_V1_SPEC: StrategySpecV1 = {
  name: "vol-momentum-v1",
  version: 1,
  description: "ATR-scaled directional impulse continuation strategy.",
  timeframe: "1H",
  lookbacks: {
    "1H": 22
  },
  indicators: [
    { id: "momentum", kind: "momentum", period: 20 },
    { id: "atr", kind: "atr", period: 20 }
  ],
  rules: {
    longEntry: {
      type: "comparison",
      op: ">=",
      left: { type: "indicator", id: "momentum", output: "momentum" },
      right: { type: "constant", value: 0.9 }
    },
    shortEntry: {
      type: "comparison",
      op: "<=",
      left: { type: "indicator", id: "momentum", output: "momentum" },
      right: { type: "constant", value: -0.9 }
    }
  },
  risk: {
    stopModel: {
      kind: "atr_multiple",
      multiplier: 2.0,
      atrPeriod: 20
    },
    takeProfit: {
      rewardMultiple: 2.2
    }
  }
};
