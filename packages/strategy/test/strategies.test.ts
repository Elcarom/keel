import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ScaledDecimal,
  TIMEFRAME_DURATION_MS,
  type BarTimeframe,
  type ConfirmedBar,
  type FeatureSnapshot
} from "@keel/core";
import {
  BaselineChooser,
  DEFAULT_STRATEGIES,
  DonchianTrendStrategy,
  VolNormalizedMeanReversionStrategy,
  VolNormalizedMomentumStrategy
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

describe("M2-2: Pure Strategy Port, ProposalMenu, BaselineChooser, & Baseline Strategies", () => {
  it("declares explicit LookbackRequirements and deterministic parameter hashes", () => {
    const donchianA = new DonchianTrendStrategy({ channelLength: 20 });
    const donchianB = new DonchianTrendStrategy({ channelLength: 20 });
    const donchianC = new DonchianTrendStrategy({ channelLength: 30 });

    expect(donchianA.strategyId).toBe("donchian-trend-v1");
    expect(donchianA.parameterHash).toBe(donchianB.parameterHash);
    expect(donchianA.parameterHash).not.toBe(donchianC.parameterHash);
    expect(donchianA.lookbacks["1H"]).toBeGreaterThan(20);

    for (const strategy of DEFAULT_STRATEGIES) {
      expect(strategy.strategyId.length).toBeGreaterThan(0);
      expect(strategy.version.length).toBeGreaterThan(0);
      expect(strategy.parameterHash).toMatch(/^[0-9a-f]{64}$/);
      expect((strategy.lookbacks["1H"] ?? 0) > 0).toBe(true);
    }
  });

  it("emits pure deterministic ProposalMenus for breakout, mean-reversion, and momentum regimes", () => {
    // 1. Strong upward breakout for Donchian & Momentum
    const breakoutPrices = [...Array.from({ length: 24 }, (_, i) => 40_000 + (i % 3) * 15), 40_850];
    const breakoutSnapshot = makeSnapshot(buildBars("BTC-USDT-SWAP", "1H", breakoutPrices));

    const donchian = new DonchianTrendStrategy({ channelLength: 20 });
    const menu1 = donchian.evaluate(breakoutSnapshot);
    const menu2 = donchian.evaluate(breakoutSnapshot);
    expect(menu1).toEqual(menu2);
    expect(menu1.proposals.length).toBe(1);
    const p0 = menu1.proposals[0];
    expect(p0?.side).toBe("long");
    expect(
      ScaledDecimal.fromString(p0?.protectiveStopPrice ?? "0").lt(
        ScaledDecimal.fromString(p0?.entryPrice ?? "0")
      )
    ).toBe(true);

    const momentum = new VolNormalizedMomentumStrategy({ lookbackBars: 20 });
    const momMenu = momentum.evaluate(breakoutSnapshot);
    expect(momMenu.proposals.length).toBe(1);
    expect(momMenu.proposals[0]?.side).toBe("long");

    // 2. Sharp oversold dip in a range for Mean Reversion (long)
    const dipPrices = [
      ...Array.from({ length: 24 }, (_, i) => 42_000 + (i % 2 === 0 ? 40 : -40)),
      41_200
    ];
    const dipSnapshot = makeSnapshot(buildBars("BTC-USDT-SWAP", "1H", dipPrices));
    const meanRev = new VolNormalizedMeanReversionStrategy({
      lookbackBars: 20,
      entryZScore: 1.6
    });
    const mrMenu = meanRev.evaluate(dipSnapshot);
    expect(mrMenu.proposals.length).toBe(1);
    const mr0 = mrMenu.proposals[0];
    expect(mr0?.side).toBe("long");
    expect(
      ScaledDecimal.fromString(mr0?.protectiveStopPrice ?? "0").lt(
        ScaledDecimal.fromString(mr0?.entryPrice ?? "0")
      )
    ).toBe(true);

    // 3. BaselineChooser selects highest-ranked candidate deterministically
    const chooser = new BaselineChooser();
    const chosen = chooser.choose([menu1, momMenu, mrMenu]);
    expect(chosen).not.toBeNull();
    expect(chosen?.proposalId).toBeDefined();

    // 4. BaselineChooser returns null when all ProposalMenus are empty
    const shortHistorySnapshot = makeSnapshot(
      buildBars("BTC-USDT-SWAP", "1H", [40_000, 40_010, 40_020])
    );
    const emptyMenus = DEFAULT_STRATEGIES.map((s) => s.evaluate(shortHistorySnapshot));
    expect(chooser.choose(emptyMenus)).toBeNull();
  });

  it("property: every emitted Proposal strictly satisfies protectiveStopPrice side invariant", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 15_000, max: 85_000 }), {
          minLength: 25,
          maxLength: 40
        }),
        (prices) => {
          const snapshot = makeSnapshot(buildBars("BTC-USDT-SWAP", "1H", prices));
          for (const strategy of DEFAULT_STRATEGIES) {
            const menu = strategy.evaluate(snapshot);
            for (const proposal of menu.proposals) {
              const entry = ScaledDecimal.fromString(proposal.entryPrice);
              const stop = ScaledDecimal.fromString(proposal.protectiveStopPrice);
              expect(entry.isPositive()).toBe(true);
              expect(stop.isPositive()).toBe(true);
              if (proposal.side === "long") {
                expect(stop.lt(entry)).toBe(true);
                if (proposal.takeProfitPrice) {
                  expect(ScaledDecimal.fromString(proposal.takeProfitPrice).gt(entry)).toBe(true);
                }
              } else {
                expect(stop.gt(entry)).toBe(true);
                if (proposal.takeProfitPrice) {
                  expect(ScaledDecimal.fromString(proposal.takeProfitPrice).lt(entry)).toBe(true);
                }
              }
            }
          }
        }
      ),
      { numRuns: 35 }
    );
  });
});
