import { describe, expect, it } from "vitest";
import {
  StrategySpecV1Schema,
  computeSpecHash,
  validateSpecAstBudget,
  DONCHIAN_TREND_V1_SPEC
} from "../src/index.js";

describe("T2 / A3: StrategySpecV1 Resource Bounds & Safe Pre-Parse", () => {
  it("rejects 3,000-deep nested AST with clean validation error without throwing RangeError", () => {
    // Construct 3,000-deep nesting of logical_op "and"
    let deepCondition: Record<string, unknown> = {
      type: "comparison",
      op: ">",
      left: { type: "constant", value: 1 },
      right: { type: "constant", value: 0 }
    };
    for (let i = 0; i < 3000; i++) {
      deepCondition = {
        type: "logical_op",
        op: "and",
        operands: [deepCondition]
      };
    }

    const maliciousSpec = {
      ...DONCHIAN_TREND_V1_SPEC,
      rules: {
        longEntry: deepCondition,
        shortEntry: deepCondition
      }
    };

    // Pre-parse budget validator must cleanly return valid: false without RangeError
    const budget = validateSpecAstBudget(maliciousSpec);
    expect(budget.valid).toBe(false);
    expect(budget.error).toMatch(/depth/i);

    // Schema safeParse must succeed in failing with 400-compatible error without throwing
    const result = StrategySpecV1Schema.safeParse(maliciousSpec);
    expect(result.success).toBe(false);
  });

  it("rejects AST with total node count > 32", () => {
    // Construct a condition with 35 operands (35 nodes in one rule)
    const operands: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 35; i++) {
      operands.push({
        type: "comparison",
        op: ">",
        left: { type: "constant", value: i },
        right: { type: "constant", value: 0 }
      });
    }

    const bigSpec = {
      ...DONCHIAN_TREND_V1_SPEC,
      rules: {
        longEntry: {
          type: "logical_op",
          op: "and",
          operands
        },
        shortEntry: DONCHIAN_TREND_V1_SPEC.rules.shortEntry
      }
    };

    const budget = validateSpecAstBudget(bigSpec);
    expect(budget.valid).toBe(false);
    expect(budget.error).toMatch(/budget|node count/i);

    const result = StrategySpecV1Schema.safeParse(bigSpec);
    expect(result.success).toBe(false);
  });

  it("rejects lookback > 500 (e.g. 1,000,000,000)", () => {
    const spec = {
      ...DONCHIAN_TREND_V1_SPEC,
      lookbacks: {
        "1H": 1_000_000_000
      }
    };
    const res = StrategySpecV1Schema.safeParse(spec);
    expect(res.success).toBe(false);
  });

  it("rejects indicator period < 2 or > 500", () => {
    const specLow = {
      ...DONCHIAN_TREND_V1_SPEC,
      indicators: [{ id: "sma", kind: "sma", period: 1 }]
    };
    expect(StrategySpecV1Schema.safeParse(specLow).success).toBe(false);

    const specHigh = {
      ...DONCHIAN_TREND_V1_SPEC,
      indicators: [{ id: "sma", kind: "sma", period: 501 }]
    };
    expect(StrategySpecV1Schema.safeParse(specHigh).success).toBe(false);
  });

  it("rejects indicator shift > 500", () => {
    const spec = {
      ...DONCHIAN_TREND_V1_SPEC,
      rules: {
        ...DONCHIAN_TREND_V1_SPEC.rules,
        longEntry: {
          type: "comparison",
          op: ">",
          left: { type: "bar_field", field: "close", shift: 501 },
          right: { type: "constant", value: 100 }
        }
      }
    };
    expect(StrategySpecV1Schema.safeParse(spec).success).toBe(false);
  });

  it("rejects indicators list with > 8 indicators", () => {
    const indicators: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 9; i++) {
      indicators.push({ id: `sma_${i}`, kind: "sma", period: 10 + i });
    }
    const spec = {
      ...DONCHIAN_TREND_V1_SPEC,
      indicators
    };
    expect(StrategySpecV1Schema.safeParse(spec).success).toBe(false);
  });

  it("rejects stop multiplier < 0.1 or > 10 and fixed_points <= 0", () => {
    const specLowMult = {
      ...DONCHIAN_TREND_V1_SPEC,
      risk: {
        ...DONCHIAN_TREND_V1_SPEC.risk,
        stopModel: { kind: "atr_multiple", multiplier: 0.05, atrPeriod: 20 }
      }
    };
    expect(StrategySpecV1Schema.safeParse(specLowMult).success).toBe(false);

    const specHighMult = {
      ...DONCHIAN_TREND_V1_SPEC,
      risk: {
        ...DONCHIAN_TREND_V1_SPEC.risk,
        stopModel: { kind: "atr_multiple", multiplier: 11, atrPeriod: 20 }
      }
    };
    expect(StrategySpecV1Schema.safeParse(specHighMult).success).toBe(false);

    const specFixedNeg = {
      ...DONCHIAN_TREND_V1_SPEC,
      risk: {
        ...DONCHIAN_TREND_V1_SPEC.risk,
        stopModel: { kind: "fixed_points", points: 0 }
      }
    };
    expect(StrategySpecV1Schema.safeParse(specFixedNeg).success).toBe(false);
  });

  it("rejects rewardMultiple < 0.5 or > 10", () => {
    const specLow = {
      ...DONCHIAN_TREND_V1_SPEC,
      risk: {
        ...DONCHIAN_TREND_V1_SPEC.risk,
        takeProfit: { rewardMultiple: 0.2 }
      }
    };
    expect(StrategySpecV1Schema.safeParse(specLow).success).toBe(false);

    const specHigh = {
      ...DONCHIAN_TREND_V1_SPEC,
      risk: {
        ...DONCHIAN_TREND_V1_SPEC.risk,
        takeProfit: { rewardMultiple: 15 }
      }
    };
    expect(StrategySpecV1Schema.safeParse(specHigh).success).toBe(false);
  });

  it("supports cooldownBars (0..200, default 0) and timeStopBars (1..500)", () => {
    const specWithCooldown = {
      ...DONCHIAN_TREND_V1_SPEC,
      cooldownBars: 10,
      timeStopBars: 48
    };
    const parsed = StrategySpecV1Schema.safeParse(specWithCooldown);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.cooldownBars).toBe(10);
      expect(parsed.data.timeStopBars).toBe(48);
    }

    // Default cooldownBars should be 0 when omitted
    const defaultParsed = StrategySpecV1Schema.safeParse(DONCHIAN_TREND_V1_SPEC);
    expect(defaultParsed.success).toBe(true);
    if (defaultParsed.success) {
      expect(defaultParsed.data.cooldownBars).toBe(0);
    }

    const invalidCooldown = {
      ...DONCHIAN_TREND_V1_SPEC,
      cooldownBars: 250
    };
    expect(StrategySpecV1Schema.safeParse(invalidCooldown).success).toBe(false);

    const invalidTimeStop = {
      ...DONCHIAN_TREND_V1_SPEC,
      timeStopBars: 0
    };
    expect(StrategySpecV1Schema.safeParse(invalidTimeStop).success).toBe(false);
  });

  it("rejects name longer than 64 characters or with invalid characters", () => {
    const longName = "a".repeat(65);
    expect(
      StrategySpecV1Schema.safeParse({ ...DONCHIAN_TREND_V1_SPEC, name: longName }).success
    ).toBe(false);

    const badChars = "my strategy / with spaces & symbols!";
    expect(
      StrategySpecV1Schema.safeParse({ ...DONCHIAN_TREND_V1_SPEC, name: badChars }).success
    ).toBe(false);

    const validChars = "valid-strategy.v1_test";
    expect(
      StrategySpecV1Schema.safeParse({ ...DONCHIAN_TREND_V1_SPEC, name: validChars }).success
    ).toBe(true);
  });

  it("rejects description longer than 2000 characters", () => {
    const longDesc = "a".repeat(2001);
    expect(
      StrategySpecV1Schema.safeParse({ ...DONCHIAN_TREND_V1_SPEC, description: longDesc }).success
    ).toBe(false);
  });

  it("enforces timeframe literal '1H' and rejects non-1H timeframes", () => {
    expect(
      StrategySpecV1Schema.safeParse({ ...DONCHIAN_TREND_V1_SPEC, timeframe: "4H" }).success
    ).toBe(false);
    expect(
      StrategySpecV1Schema.safeParse({ ...DONCHIAN_TREND_V1_SPEC, timeframe: "1D" }).success
    ).toBe(false);
  });

  it("removes == and != comparison operators from schema", () => {
    const eqSpec = {
      ...DONCHIAN_TREND_V1_SPEC,
      rules: {
        ...DONCHIAN_TREND_V1_SPEC.rules,
        longEntry: {
          type: "comparison",
          op: "==",
          left: { type: "constant", value: 1 },
          right: { type: "constant", value: 1 }
        }
      }
    };
    expect(StrategySpecV1Schema.safeParse(eqSpec).success).toBe(false);

    const neqSpec = {
      ...DONCHIAN_TREND_V1_SPEC,
      rules: {
        ...DONCHIAN_TREND_V1_SPEC.rules,
        longEntry: {
          type: "comparison",
          op: "!=",
          left: { type: "constant", value: 1 },
          right: { type: "constant", value: 2 }
        }
      }
    };
    expect(StrategySpecV1Schema.safeParse(neqSpec).success).toBe(false);
  });

  it("excludes metadata from canonical spec hashing so metadata differences do not affect specHash", () => {
    const specNoMeta = { ...DONCHIAN_TREND_V1_SPEC };
    const specWithMeta1 = {
      ...DONCHIAN_TREND_V1_SPEC,
      metadata: { author: "Alice", buildTag: "123" }
    };
    const specWithMeta2 = {
      ...DONCHIAN_TREND_V1_SPEC,
      metadata: { author: "Bob", hugePayload: "x".repeat(10000) }
    };

    const hashBase = computeSpecHash(specNoMeta);
    const hash1 = computeSpecHash(specWithMeta1);
    const hash2 = computeSpecHash(specWithMeta2);

    expect(hash1).toBe(hashBase);
    expect(hash2).toBe(hashBase);
  });
});
