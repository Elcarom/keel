import { ARCHETYPE_LABELS, type BotBlueprint } from "@keel/core";
import { StrategySpecV1Schema, type Condition, type StrategySpecV1 } from "./index.js";

// ============================================================================
// Bot Blueprints: the flat, bounded shape an LLM fills in. Deterministic code (never the model)
// compiles a blueprint into a Strategy Spec, so every rule a bot trades on is one of a few
// reviewed archetypes with clamped parameters.
// ============================================================================

const NEVER: Condition = {
  type: "comparison",
  op: "<",
  left: { type: "constant", value: 1 },
  right: { type: "constant", value: 0 }
};

function entryRules(b: BotBlueprint): { longEntry: Condition; shortEntry: Condition } {
  const close = { type: "bar_field", field: "close" } as const;
  switch (b.archetype) {
    case "breakout":
      return {
        longEntry: {
          type: "comparison",
          op: ">",
          left: close,
          right: { type: "indicator", id: "channel", output: "highest_high" }
        },
        shortEntry: {
          type: "comparison",
          op: "<",
          left: close,
          right: { type: "indicator", id: "channel", output: "lowest_low" }
        }
      };
    case "mean_reversion":
      return {
        longEntry: {
          type: "comparison",
          op: "<=",
          left: { type: "indicator", id: "z", output: "zscore" },
          right: { type: "constant", value: -b.entryThreshold }
        },
        shortEntry: {
          type: "comparison",
          op: ">=",
          left: { type: "indicator", id: "z", output: "zscore" },
          right: { type: "constant", value: b.entryThreshold }
        }
      };
    case "momentum":
      return {
        longEntry: {
          type: "comparison",
          op: ">=",
          left: { type: "indicator", id: "impulse", output: "momentum" },
          right: { type: "constant", value: b.entryThreshold }
        },
        shortEntry: {
          type: "comparison",
          op: "<=",
          left: { type: "indicator", id: "impulse", output: "momentum" },
          right: { type: "constant", value: -b.entryThreshold }
        }
      };
    case "ma_crossover":
      return {
        longEntry: {
          type: "crosses_above",
          seriesA: { type: "indicator", id: "fast", output: "mean" },
          seriesB: { type: "indicator", id: "slow", output: "mean" }
        },
        shortEntry: {
          type: "crosses_below",
          seriesA: { type: "indicator", id: "fast", output: "mean" },
          seriesB: { type: "indicator", id: "slow", output: "mean" }
        }
      };
    case "trend_pullback":
      return {
        longEntry: {
          type: "logical_op",
          op: "and",
          operands: [
            {
              type: "comparison",
              op: ">",
              left: close,
              right: { type: "indicator", id: "slow", output: "mean" }
            },
            {
              type: "comparison",
              op: "<=",
              left: { type: "indicator", id: "z", output: "zscore" },
              right: { type: "constant", value: -b.entryThreshold }
            }
          ]
        },
        shortEntry: {
          type: "logical_op",
          op: "and",
          operands: [
            {
              type: "comparison",
              op: "<",
              left: close,
              right: { type: "indicator", id: "slow", output: "mean" }
            },
            {
              type: "comparison",
              op: ">=",
              left: { type: "indicator", id: "z", output: "zscore" },
              right: { type: "constant", value: b.entryThreshold }
            }
          ]
        }
      };
  }
}

function indicatorsFor(b: BotBlueprint): StrategySpecV1["indicators"] {
  switch (b.archetype) {
    case "breakout":
      return [{ id: "channel", kind: "donchian", period: b.lookbackPeriod }];
    case "mean_reversion":
      return [{ id: "z", kind: "zscore", period: b.lookbackPeriod }];
    case "momentum":
      return [{ id: "impulse", kind: "momentum", period: b.lookbackPeriod }];
    case "ma_crossover":
      return [
        { id: "fast", kind: "sma", period: b.fastPeriod },
        { id: "slow", kind: "sma", period: b.lookbackPeriod }
      ];
    case "trend_pullback":
      return [
        { id: "slow", kind: "sma", period: b.lookbackPeriod },
        { id: "z", kind: "zscore", period: b.fastPeriod }
      ];
  }
}

const ATR_PERIOD = 14;

/**
 * Compiles a blueprint into a validated Strategy Spec. `specName` becomes the strategy id, so
 * each bot (and each proposition) trades and backtests under an id of its own.
 */
export function compileBlueprint(blueprint: BotBlueprint, specName: string): StrategySpecV1 {
  const rules = entryRules(blueprint);
  const indicators = indicatorsFor(blueprint);
  const longestPeriod = Math.max(ATR_PERIOD, ...indicators.map((i) => i.period));
  return StrategySpecV1Schema.parse({
    name: specName,
    version: 1,
    description: `${ARCHETYPE_LABELS[blueprint.archetype]} on ${blueprint.instrumentId}: ${blueprint.tagline}`,
    timeframe: "1H",
    lookbacks: { "1H": longestPeriod + 2 },
    indicators,
    rules: {
      longEntry: blueprint.direction === "short_only" ? NEVER : rules.longEntry,
      shortEntry: blueprint.direction === "long_only" ? NEVER : rules.shortEntry
    },
    risk: {
      stopModel: {
        kind: "atr_multiple",
        multiplier: blueprint.stopAtrMultiple,
        atrPeriod: ATR_PERIOD
      },
      takeProfit: { rewardMultiple: blueprint.rewardMultiple }
    },
    cooldownBars: 0
  });
}
