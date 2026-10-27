import { describe, expect, it } from "vitest";
import {
  TIMEFRAME_DURATION_MS,
  type BarTimeframe,
  type ConfirmedBar,
  type FeatureSnapshot
} from "@keel/core";
import {
  DonchianTrendStrategy,
  VolNormalizedMeanReversionStrategy,
  VolNormalizedMomentumStrategy
} from "@keel/strategy";
import {
  StrategySpecV1Schema,
  computeSpecHash,
  describeSpec,
  SpecStrategy,
  DONCHIAN_TREND_V1_SPEC,
  VOL_MEAN_REVERSION_V1_SPEC,
  VOL_MOMENTUM_V1_SPEC,
  type StrategySpecV1
} from "../src/index.js";

function buildBars(
  instrumentId: string,
  timeframe: BarTimeframe,
  prices: readonly number[],
  startCloseTs = 1_700_003_600_000
): ConfirmedBar[] {
  const stepMs = TIMEFRAME_DURATION_MS[timeframe];
  return prices.map((price, idx) => {
    const prev = idx > 0 ? (prices[idx - 1] ?? price) : price;
    const high = Math.max(price, prev) + 25;
    const low = Math.max(10, Math.min(price, prev) - 25);
    const closeTs = startCloseTs + idx * stepMs;
    return {
      instrumentId,
      timeframe,
      openTs: closeTs - stepMs,
      closeTs,
      open: prev.toFixed(2),
      high: high.toFixed(2),
      low: low.toFixed(2),
      close: price.toFixed(2),
      volumeContracts: (100 + idx * 5).toFixed(2),
      volumeQuote: ((100 + idx * 5) * price).toFixed(2),
      confirm: "1"
    };
  });
}

function makeSnapshot(bars1H: readonly ConfirmedBar[]): FeatureSnapshot {
  const lastCloseTs = bars1H[bars1H.length - 1]?.closeTs ?? 1_700_003_600_000;
  return {
    instrumentId: "BTC-USDT-SWAP",
    asOfMs: lastCloseTs,
    barsByTimeframe: {
      "1H": bars1H
    },
    recentFundingRates: []
  };
}

describe("StrategySpecV1 Schema & Canonical Hash (ADR-0020)", () => {
  it("validates well-formed specs and rejects invalid configurations", () => {
    const valid = StrategySpecV1Schema.safeParse(DONCHIAN_TREND_V1_SPEC);
    expect(valid.success).toBe(true);

    const invalidTimeframe = StrategySpecV1Schema.safeParse({
      ...DONCHIAN_TREND_V1_SPEC,
      timeframe: "1m" // not supported
    });
    expect(invalidTimeframe.success).toBe(false);

    const invalidIndicator = StrategySpecV1Schema.safeParse({
      ...DONCHIAN_TREND_V1_SPEC,
      indicators: [{ id: "bad", kind: "non_existent", period: 10 }]
    });
    expect(invalidIndicator.success).toBe(false);
  });

  it("produces deterministic canonical hash invariant to object key ordering", () => {
    const specA: StrategySpecV1 = { ...DONCHIAN_TREND_V1_SPEC };
    const specB = JSON.parse(JSON.stringify(specA));

    // Permute keys in specB
    const permutedB = {
      version: specB.version,
      synthetic: specB.synthetic,
      risk: specB.risk,
      name: specB.name,
      description: specB.description,
      rules: specB.rules,
      lookbacks: specB.lookbacks,
      indicators: specB.indicators,
      timeframe: specB.timeframe,
      cooldownBars: specB.cooldownBars
    };

    const hashA = computeSpecHash(specA);
    const hashB = computeSpecHash(permutedB as StrategySpecV1);

    expect(hashA).toHaveLength(64);
    expect(hashA).toBe(hashB);
  });

  it("describes spec in deterministic plain English", () => {
    const desc = describeSpec(DONCHIAN_TREND_V1_SPEC);
    expect(desc).toContain("Timeframe: 1H");
    expect(desc).toContain("Donchian");
    expect(desc).toContain("ATR");
  });
});

describe("SpecStrategy Golden Parity Tests with Hardcoded Baseline Strategies", () => {
  it("achieves proposal-by-proposal parity with DonchianTrendStrategy", () => {
    const hardcoded = new DonchianTrendStrategy();
    const specStrategy = new SpecStrategy(DONCHIAN_TREND_V1_SPEC);

    // Test across ranging and breakout price series
    const prices = [
      100,
      102,
      101,
      103,
      102,
      101,
      104,
      103,
      102,
      105,
      104,
      103,
      102,
      101,
      103,
      104,
      105,
      106,
      105,
      104,
      103,
      115 // Upside breakout on bar 22
    ];
    const bars = buildBars("BTC-USDT-SWAP", "1H", prices);
    const snapshot = makeSnapshot(bars);

    const hardcodedMenu = hardcoded.evaluate(snapshot);
    const specMenu = specStrategy.evaluate(snapshot);

    expect(specMenu.proposals).toHaveLength(hardcodedMenu.proposals.length);
    const p1 = hardcodedMenu.proposals[0];
    const p2 = specMenu.proposals[0];
    if (p1 && p2) {
      expect(p2.side).toBe(p1.side);
      expect(p2.entryPrice).toBe(p1.entryPrice);
      expect(p2.protectiveStopPrice).toBe(p1.protectiveStopPrice);
      expect(p2.takeProfitPrice).toBe(p1.takeProfitPrice);
      expect(p2.convictionScore).toBeCloseTo(p1.convictionScore, 3);
    }

    // Downside breakdown
    const downPrices = [
      100,
      102,
      101,
      103,
      102,
      101,
      104,
      103,
      102,
      105,
      104,
      103,
      102,
      101,
      103,
      104,
      105,
      106,
      105,
      104,
      103,
      85 // Downside breakdown on bar 22
    ];
    const downBars = buildBars("BTC-USDT-SWAP", "1H", downPrices);
    const downSnapshot = makeSnapshot(downBars);

    const downHardcoded = hardcoded.evaluate(downSnapshot);
    const downSpec = specStrategy.evaluate(downSnapshot);

    expect(downSpec.proposals).toHaveLength(downHardcoded.proposals.length);
    const dp1 = downHardcoded.proposals[0];
    const dp2 = downSpec.proposals[0];
    if (dp1 && dp2) {
      expect(dp2.side).toBe(dp1.side);
      expect(dp2.entryPrice).toBe(dp1.entryPrice);
      expect(dp2.protectiveStopPrice).toBe(dp1.protectiveStopPrice);
      expect(dp2.takeProfitPrice).toBe(dp1.takeProfitPrice);
      expect(dp2.convictionScore).toBeCloseTo(dp1.convictionScore, 3);
    }
  });

  it("achieves proposal-by-proposal parity with VolNormalizedMeanReversionStrategy", () => {
    const hardcoded = new VolNormalizedMeanReversionStrategy();
    const specStrategy = new SpecStrategy(VOL_MEAN_REVERSION_V1_SPEC);

    // Extreme drop -> high negative zScore -> buy long
    const prices = [
      100, 100, 101, 100, 99, 100, 101, 100, 99, 100, 100, 101, 100, 99, 100, 101, 100, 99, 100,
      100, 80
    ];
    const bars = buildBars("BTC-USDT-SWAP", "1H", prices);
    const snapshot = makeSnapshot(bars);

    const hardcodedMenu = hardcoded.evaluate(snapshot);
    const specMenu = specStrategy.evaluate(snapshot);

    expect(specMenu.proposals).toHaveLength(hardcodedMenu.proposals.length);
    const p1 = hardcodedMenu.proposals[0];
    const p2 = specMenu.proposals[0];
    if (p1 && p2) {
      expect(p2.side).toBe(p1.side);
      expect(p2.entryPrice).toBe(p1.entryPrice);
      expect(p2.protectiveStopPrice).toBe(p1.protectiveStopPrice);
      expect(p2.takeProfitPrice).toBe(p1.takeProfitPrice);
      expect(p2.convictionScore).toBeCloseTo(p1.convictionScore, 3);
    }
  });

  it("achieves proposal-by-proposal parity with VolNormalizedMomentumStrategy", () => {
    const hardcoded = new VolNormalizedMomentumStrategy();
    const specStrategy = new SpecStrategy(VOL_MOMENTUM_V1_SPEC);

    // Strong upward trend
    const prices = [
      100, 102, 104, 106, 108, 110, 112, 114, 116, 118, 120, 122, 124, 126, 128, 130, 132, 134, 136,
      138, 150
    ];
    const bars = buildBars("BTC-USDT-SWAP", "1H", prices);
    const snapshot = makeSnapshot(bars);

    const hardcodedMenu = hardcoded.evaluate(snapshot);
    const specMenu = specStrategy.evaluate(snapshot);

    expect(specMenu.proposals).toHaveLength(hardcodedMenu.proposals.length);
    const p1 = hardcodedMenu.proposals[0];
    const p2 = specMenu.proposals[0];
    if (p1 && p2) {
      expect(p2.side).toBe(p1.side);
      expect(p2.entryPrice).toBe(p1.entryPrice);
      expect(p2.protectiveStopPrice).toBe(p1.protectiveStopPrice);
      expect(p2.takeProfitPrice).toBe(p1.takeProfitPrice);
      expect(p2.convictionScore).toBeCloseTo(p1.convictionScore, 3);
    }
  });

  it("exposes isSynthetic and correctly identifies synthetic specs", () => {
    const regularStrategy = new SpecStrategy(DONCHIAN_TREND_V1_SPEC);
    expect(regularStrategy.isSynthetic).toBe(false);

    const syntheticSpec: StrategySpecV1 = {
      ...DONCHIAN_TREND_V1_SPEC,
      name: "synthetic-donchian-fixture",
      synthetic: true
    };
    const syntheticStrategy = new SpecStrategy(syntheticSpec);
    expect(syntheticStrategy.isSynthetic).toBe(true);
  });

  it("evaluates channel_bound stop model correctly", () => {
    const channelSpec: StrategySpecV1 = {
      ...DONCHIAN_TREND_V1_SPEC,
      name: "channel-stop-spec",
      risk: {
        stopModel: {
          kind: "channel_bound",
          period: 5
        },
        takeProfit: {
          rewardMultiple: 2
        }
      }
    };
    const strategy = new SpecStrategy(channelSpec);
    const prices = [
      100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118,
      119, 200
    ];
    const bars = buildBars("BTC-USDT-SWAP", "1H", prices);
    const snapshot = makeSnapshot(bars);
    const menu = strategy.evaluate(snapshot);

    expect(menu.proposals.length).toBe(1);
    const prop = menu.proposals[0];
    expect(prop).toBeDefined();
    if (prop) {
      expect(prop.side).toBe("long");
      expect(Number(prop.protectiveStopPrice)).toBeLessThan(200);
    }
  });

  it("evaluates shifted indicator expressions in conditions", () => {
    const shiftSpec: StrategySpecV1 = {
      ...DONCHIAN_TREND_V1_SPEC,
      name: "shift-spec",
      rules: {
        longEntry: {
          type: "comparison",
          op: ">",
          left: {
            type: "indicator",
            id: "donchian",
            output: "highest_high",
            shift: 1
          },
          right: {
            type: "constant",
            value: 50
          }
        },
        shortEntry: {
          type: "comparison",
          op: "<",
          left: {
            type: "bar_field",
            field: "close"
          },
          right: {
            type: "constant",
            value: 0
          }
        }
      }
    };
    const strategy = new SpecStrategy(shiftSpec);
    const prices = [
      100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118,
      119, 130
    ];
    const bars = buildBars("BTC-USDT-SWAP", "1H", prices);
    const snapshot = makeSnapshot(bars);
    const menu = strategy.evaluate(snapshot);
    expect(menu.proposals.length).toBe(1);
  });
});
