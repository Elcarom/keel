import { z } from "zod";
import {
  INDICATOR_KINDS,
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
// 1. AST Expressions, Structural Budget Validator, & Zod Schema (ADR-0020 & T2/A3)
// ============================================================================

export interface AstBudgetCheckResult {
  readonly valid: boolean;
  readonly error?: string;
  readonly totalNodes?: number;
  readonly maxDepth?: number;
}

export function validateSpecAstBudget(raw: unknown): AstBudgetCheckResult {
  if (typeof raw !== "object" || raw === null) {
    return { valid: false, error: "Spec must be a non-null object" };
  }

  const spec = raw as Record<string, unknown>;

  // 1. Check general JSON nesting depth across the whole object using an iterative DFS
  // Max depth budget: 8 for any branch.
  const generalStack: Array<{ val: unknown; depth: number }> = [{ val: raw, depth: 1 }];
  while (generalStack.length > 0) {
    const item = generalStack.pop();
    if (!item) break;
    if (item.depth > 8) {
      return {
        valid: false,
        error: `JSON nesting depth exceeds maximum allowed limit of 8 (found depth > ${item.depth})`
      };
    }
    if (typeof item.val === "object" && item.val !== null) {
      if (Array.isArray(item.val)) {
        for (let i = 0; i < item.val.length; i++) {
          generalStack.push({ val: item.val[i], depth: item.depth + 1 });
        }
      } else {
        const obj = item.val as Record<string, unknown>;
        const keys = Object.keys(obj);
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i];
          if (key !== undefined) {
            generalStack.push({ val: obj[key], depth: item.depth + 1 });
          }
        }
      }
    }
  }

  // 2. Count AST nodes and check AST depth specifically within rules (longEntry, shortEntry)
  // Max AST depth: 6
  // Max AST total nodes: 32
  let totalAstNodes = 0;
  let maxAstDepthFound = 0;

  const rulesObj = spec["rules"];
  if (typeof rulesObj === "object" && rulesObj !== null) {
    const rules = rulesObj as Record<string, unknown>;
    const entryRules = [rules["longEntry"], rules["shortEntry"]].filter(
      (r): r is Record<string, unknown> => typeof r === "object" && r !== null
    );

    for (const entryRule of entryRules) {
      const astStack: Array<{ node: Record<string, unknown>; depth: number }> = [
        { node: entryRule, depth: 1 }
      ];

      while (astStack.length > 0) {
        const item = astStack.pop();
        if (!item) break;
        const { node, depth } = item;
        totalAstNodes++;

        if (depth > maxAstDepthFound) {
          maxAstDepthFound = depth;
        }

        if (depth > 6) {
          return {
            valid: false,
            error: `AST expression depth ${depth} exceeds maximum limit of 6`
          };
        }

        if (totalAstNodes > 32) {
          return {
            valid: false,
            error: `Total AST node count ${totalAstNodes} exceeds budget limit of 32`
          };
        }

        const nodeType = typeof node["type"] === "string" ? node["type"] : undefined;

        if (nodeType === "logical_op") {
          const operands = node["operands"];
          if (Array.isArray(operands)) {
            for (const op of operands) {
              if (typeof op === "object" && op !== null) {
                astStack.push({ node: op as Record<string, unknown>, depth: depth + 1 });
              }
            }
          }
        } else if (nodeType === "comparison") {
          if (typeof node["left"] === "object" && node["left"] !== null) {
            astStack.push({ node: node["left"] as Record<string, unknown>, depth: depth + 1 });
          }
          if (typeof node["right"] === "object" && node["right"] !== null) {
            astStack.push({ node: node["right"] as Record<string, unknown>, depth: depth + 1 });
          }
        } else if (nodeType === "binary_op") {
          if (typeof node["left"] === "object" && node["left"] !== null) {
            astStack.push({ node: node["left"] as Record<string, unknown>, depth: depth + 1 });
          }
          if (typeof node["right"] === "object" && node["right"] !== null) {
            astStack.push({ node: node["right"] as Record<string, unknown>, depth: depth + 1 });
          }
        } else if (nodeType === "crosses_above" || nodeType === "crosses_below") {
          if (typeof node["seriesA"] === "object" && node["seriesA"] !== null) {
            astStack.push({ node: node["seriesA"] as Record<string, unknown>, depth: depth + 1 });
          }
          if (typeof node["seriesB"] === "object" && node["seriesB"] !== null) {
            astStack.push({ node: node["seriesB"] as Record<string, unknown>, depth: depth + 1 });
          }
        } else {
          for (const key of Object.keys(node)) {
            const val = node[key];
            if (typeof val === "object" && val !== null && !Array.isArray(val)) {
              astStack.push({ node: val as Record<string, unknown>, depth: depth + 1 });
            } else if (Array.isArray(val)) {
              for (const elem of val) {
                if (typeof elem === "object" && elem !== null) {
                  astStack.push({ node: elem as Record<string, unknown>, depth: depth + 1 });
                }
              }
            }
          }
        }
      }
    }
  }

  return {
    valid: true,
    totalNodes: totalAstNodes,
    maxDepth: maxAstDepthFound
  };
}

export type NumExpr =
  | { readonly type: "constant"; readonly value: number }
  | {
      readonly type: "bar_field";
      /** `hour` (0-23) and `weekday` (0 = Sunday) are UTC, from the bar's open time. */
      readonly field: "open" | "high" | "low" | "close" | "volume" | "hour" | "weekday";
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
      field: z.enum(["open", "high", "low", "close", "volume", "hour", "weekday"]),
      shift: z.number().int().min(0).max(500).optional()
    }),
    z.object({
      type: z.literal("indicator"),
      id: z.string().min(1),
      output: z.string().optional(),
      shift: z.number().int().min(0).max(500).optional()
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
      readonly op: ">" | ">=" | "<" | "<=";
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
      op: z.enum([">", ">=", "<", "<="]),
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
  kind: z.enum(INDICATOR_KINDS),
  period: z.number().int().min(2).max(500),
  params: z.record(z.string(), z.union([z.number(), z.string()])).optional()
});
export type IndicatorDef = z.infer<typeof IndicatorDefSchema>;

export const RiskRulesSchema = z.object({
  stopModel: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("atr_multiple"),
      multiplier: z.number().min(0.1).max(10),
      atrPeriod: z.number().int().min(2).max(500)
    }),
    z.object({
      kind: z.literal("channel_bound"),
      period: z.number().int().min(2).max(500)
    }),
    z.object({
      kind: z.literal("fixed_points"),
      points: z.number().positive().max(1_000_000)
    })
  ]),
  takeProfit: z.object({
    rewardMultiple: z.number().min(0.5).max(10)
  }),
  timeStopBars: z.number().int().min(1).max(500).optional()
});
export type RiskRules = z.infer<typeof RiskRulesSchema>;

export const BaseStrategySpecV1Schema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, "Name must contain only alphanumeric characters, '.', '_', or '-'"),
  version: z.literal(1),
  description: z.string().max(2000),
  timeframe: z.literal("1H"),
  lookbacks: z.record(z.literal("1H"), z.number().int().min(1).max(500)),
  indicators: z.array(IndicatorDefSchema).max(8),
  rules: z.object({
    longEntry: ConditionSchema,
    shortEntry: ConditionSchema
  }),
  risk: RiskRulesSchema,
  cooldownBars: z.number().int().min(0).max(200).default(0),
  timeStopBars: z.number().int().min(1).max(500).optional(),
  synthetic: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export type StrategySpecV1 = z.infer<typeof BaseStrategySpecV1Schema>;

export const StrategySpecV1Schema: z.ZodType<StrategySpecV1, z.ZodTypeDef, unknown> = z
  .unknown()
  .superRefine((val, ctx) => {
    const budget = validateSpecAstBudget(val);
    if (!budget.valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: budget.error ?? "Spec AST resource budget exceeded"
      });
    }
  })
  .pipe(BaseStrategySpecV1Schema);

// ============================================================================
// 2. Canonical JSON Serialization & Parameter Hashing (ADR-0020 & T2)
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
  // Exclude metadata from canonical hash calculation (ADR-0020 & Ticket T2)
  const { metadata: _omittedMetadata, ...hashableSpec } = spec;
  const canonical = JSON.stringify(sortObjectKeys(hashableSpec));
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

/**
 * Exponential average of closes, seeded with the simple average of the first `period` closes in
 * the window. The window should span several periods so the seed has washed out.
 */
function computeEma(bars: readonly ConfirmedBar[], period: number): number {
  const closes = bars.map((b) => Number(b.close));
  if (closes.length === 0) return 0;
  const seedLength = Math.min(period, closes.length);
  let ema = closes.slice(0, seedLength).reduce((acc, v) => acc + v, 0) / seedLength;
  const alpha = 2 / (period + 1);
  for (let i = seedLength; i < closes.length; i += 1) {
    ema = alpha * (closes[i] ?? ema) + (1 - alpha) * ema;
  }
  return ema;
}

/** Wilder's relative strength index of closes, 0-100; 50 when the window is too short. */
function computeRsi(bars: readonly ConfirmedBar[], period: number): number {
  const closes = bars.map((b) => Number(b.close));
  if (closes.length < period + 1) return 50;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i += 1) {
    const change = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    avgGain = (avgGain * (period - 1) + Math.max(0, change)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -change)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
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
      case "ema": {
        res["ema"] = computeEma(bars, def.period);
        break;
      }
      case "rsi": {
        res["rsi"] = computeRsi(bars, def.period);
        break;
      }
      case "volume_sma": {
        const window = bars.slice(-def.period);
        const volumes = window.map((b) => Number(b.volumeContracts));
        res["mean"] = volumes.reduce((acc, v) => acc + v, 0) / (volumes.length || 1);
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
        case "hour":
          return new Date(bar.openTs).getUTCHours();
        case "weekday":
          return new Date(bar.openTs).getUTCDay();
      }
      return 0;
    }
    case "indicator": {
      let targetIndicators = indicators;
      if (expr.shift && expr.shift > 0) {
        if (bars.length <= expr.shift) return 0;
        const shiftedBars = bars.slice(0, -expr.shift);
        targetIndicators = indicatorDefs
          ? computeIndicators(indicatorDefs, shiftedBars)
          : indicators;
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
      }
      return false;
    }
    case "logical_op": {
      switch (cond.op) {
        case "and":
          return cond.operands.every((op) =>
            evaluateCondition(op, bars, indicators, indicatorDefs)
          );
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
  public readonly cooldownBars: number;
  public readonly timeStopBars?: number | undefined;
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
    this.cooldownBars = this.spec.cooldownBars ?? 0;
    this.timeStopBars = this.spec.timeStopBars ?? this.spec.risk.timeStopBars;
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
  },
  cooldownBars: 0
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
  },
  cooldownBars: 0
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
  },
  cooldownBars: 0
};

export const SYNTHETIC_DONCHIAN_FIXTURE_SPEC: StrategySpecV1 = {
  ...DONCHIAN_TREND_V1_SPEC,
  name: "synthetic-donchian-fixture",
  synthetic: true
};
export * from "./blueprint.js";
export * from "./invention.js";
export * from "./invention-check.js";
