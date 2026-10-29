import { describe, expect, it } from "vitest";
import {
  TIMEFRAME_DURATION_MS,
  type BotBlueprint,
  type ConfirmedBar,
  type DesignBrief
} from "@keel/core";
import {
  SpecStrategy,
  checkImportedInvention,
  checkInvention,
  compileBlueprint,
  nudgeInvention,
  readInventionFile
} from "../src/index.js";

const BRIEF: Pick<DesignBrief, "instruments" | "direction"> = {
  instruments: ["BTC-USDT-SWAP", "SOL-USDT-SWAP"],
  direction: "any"
};

const SNAPBACK = {
  name: "Tidal Snapback",
  tagline: "Rides the snap back.",
  rationale: "Panic dips in uptrends recover.",
  instrumentId: "SOL-USDT-SWAP",
  direction: "both",
  indicators: [
    { id: "fast_rsi", kind: "rsi", period: 7 },
    { id: "tide", kind: "ema", period: 160 }
  ],
  longEntry: {
    type: "logical_op",
    op: "and",
    operands: [
      {
        type: "crosses_above",
        seriesA: { type: "indicator", id: "fast_rsi", output: "rsi" },
        seriesB: { type: "constant", value: 25 }
      },
      {
        type: "comparison",
        op: ">",
        left: { type: "bar_field", field: "close" },
        right: { type: "indicator", id: "tide", output: "ema" }
      }
    ]
  },
  shortEntry: {
    type: "crosses_below",
    seriesA: { type: "indicator", id: "fast_rsi", output: "rsi" },
    seriesB: { type: "constant", value: 75 }
  },
  stopAtrMultiple: 2,
  rewardMultiple: 2.5
};

function ok(raw: unknown, brief = BRIEF): BotBlueprint {
  const result = checkInvention(raw, brief);
  if (!result.ok) throw new Error(result.error);
  return result.blueprint;
}

function errorOf(raw: unknown): string {
  const result = checkInvention(raw, BRIEF);
  if (result.ok) throw new Error("expected the invention to be rejected");
  return result.error;
}

describe("Inventions", () => {
  it("turns a valid invention into a blueprint with its rules in plain English", () => {
    const b = ok(SNAPBACK);
    expect(b.archetype).toBe("invented");
    expect(b.instrumentId).toBe("SOL-USDT-SWAP");
    expect(b.invention?.rules).toEqual([
      "Long when RSI(7) crosses above 25 and close > EMA(160)",
      "Short when RSI(7) crosses below 75",
      "Stop 2× ATR(14) away, target 2.5× the risk"
    ]);
    const spec = compileBlueprint(b, "inv_test");
    expect(spec.risk.stopModel).toEqual({ kind: "atr_multiple", multiplier: 2, atrPeriod: 14 });
    // EMA(160) needs three periods to settle, capped by the Spec's 500-bar lookback
    expect(spec.lookbacks["1H"]).toBe(483);
  });

  it("names exactly what is wrong so Claude can repair it", () => {
    expect(
      errorOf({
        ...SNAPBACK,
        shortEntry: {
          type: "comparison",
          op: ">",
          left: { type: "indicator", id: "tidee", output: "ema" },
          right: { type: "constant", value: 1 }
        }
      })
    ).toBe('shortEntry: no indicator has id "tidee"');
    expect(
      errorOf({
        ...SNAPBACK,
        shortEntry: {
          type: "comparison",
          op: ">",
          left: { type: "indicator", id: "tide", output: "mean" },
          right: { type: "constant", value: 1 }
        }
      })
    ).toBe('shortEntry: indicator "tide" (ema) needs output one of ema');
    expect(errorOf({ ...SNAPBACK, longEntry: { type: "comparison", op: "==" } })).toMatch(
      /^longEntry\./
    );
  });

  it("rejects rules beyond Keel's size limits", () => {
    const leaf = {
      type: "comparison",
      op: ">",
      left: { type: "bar_field", field: "close" },
      right: { type: "bar_field", field: "open" }
    };
    const huge = { type: "logical_op", op: "and", operands: Array.from({ length: 6 }, () => leaf) };
    expect(errorOf({ ...SNAPBACK, longEntry: huge, shortEntry: huge })).toMatch(
      /budget limit of 32/
    );
  });

  it("follows the brief's waters and direction whatever the invention asked for", () => {
    const b = ok(
      { ...SNAPBACK, instrumentId: "DOGE-USDT-SWAP", direction: "both" },
      { instruments: ["ETH-USDT-SWAP"], direction: "long_only" }
    );
    expect(b.instrumentId).toBe("ETH-USDT-SWAP");
    expect(b.direction).toBe("long_only");
    expect(b.invention?.rules[1]).toBe("Never goes short");
  });

  it("reads the UTC clock from each bar's open time", () => {
    const b = ok({
      ...SNAPBACK,
      indicators: [{ id: "avg", kind: "sma", period: 3 }],
      longEntry: {
        type: "comparison",
        op: "<=",
        left: { type: "bar_field", field: "hour" },
        right: { type: "constant", value: 7 }
      },
      shortEntry: {
        type: "comparison",
        op: "<",
        left: { type: "constant", value: 1 },
        right: { type: "constant", value: 0 }
      }
    });
    expect(b.invention?.rules[0]).toBe("Long when the UTC hour ≤ 07:00");
    const strategy = new SpecStrategy(compileBlueprint(b, "inv_clock"));
    const dt = TIMEFRAME_DURATION_MS["1H"];
    const day = Date.UTC(2024, 5, 3); // a Monday, 00:00 UTC
    const bars: ConfirmedBar[] = Array.from({ length: 24 }, (_, h) => ({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      openTs: day + h * dt,
      closeTs: day + (h + 1) * dt,
      open: "100",
      high: "101",
      low: "99",
      close: "100",
      volumeContracts: "1",
      volumeQuote: "100",
      confirm: "1"
    }));
    const firesAt = bars.flatMap((_, h) =>
      h < 15
        ? []
        : strategy.evaluate({
              instrumentId: "BTC-USDT-SWAP",
              asOfMs: bars[h]?.closeTs ?? 0,
              barsByTimeframe: { "1H": bars.slice(0, h + 1) },
              recentFundingRates: []
            }).proposals.length > 0
          ? [h]
          : []
    );
    // From 15:00 on, nothing fires: the rule only trades bars opening at or before 07:00
    expect(firesAt).toEqual([]);
    const early = strategy.evaluate({
      instrumentId: "BTC-USDT-SWAP",
      asOfMs: bars[6]?.closeTs ?? 0,
      barsByTimeframe: { "1H": bars.slice(0, 7) },
      recentFundingRates: []
    });
    expect(early.proposals.map((p) => p.side)).toEqual(["long"]);
  });

  it("reads inventions from a file or a pasted chat reply in any of its usual shapes", () => {
    const inventions = (text: string) => {
      const read = readInventionFile(text);
      if (!read.ok) throw new Error(read.error);
      return read.inventions.map((i) => (i as { name: string }).name);
    };
    expect(inventions(JSON.stringify({ propositions: [SNAPBACK] }))).toEqual(["Tidal Snapback"]);
    expect(inventions(JSON.stringify({ inventions: [SNAPBACK, SNAPBACK] }))).toHaveLength(2);
    expect(inventions(JSON.stringify([SNAPBACK]))).toEqual(["Tidal Snapback"]);
    expect(inventions(JSON.stringify(SNAPBACK))).toEqual(["Tidal Snapback"]);
    expect(
      inventions(
        `Here you go.\n\n\`\`\`json\n${JSON.stringify({ propositions: [SNAPBACK] })}\n\`\`\`\nEnjoy!`
      )
    ).toEqual(["Tidal Snapback"]);
    expect(
      inventions(`Prose first ${JSON.stringify({ propositions: [SNAPBACK] })} prose after`)
    ).toEqual(["Tidal Snapback"]);

    const fails = (text: string) => {
      const read = readInventionFile(text);
      return read.ok ? null : read.error;
    };
    expect(fails("nothing to see")).toMatch(/^No JSON found/);
    expect(fails(JSON.stringify({ propositions: [] }))).toMatch(/at least one invention/);
    expect(fails(JSON.stringify(Array.from({ length: 21 }, () => SNAPBACK)))).toMatch(
      /holds 21 inventions; import at most 20/
    );
  });

  it("keeps an imported invention's own market and direction, and refuses markets Keel does not trade", () => {
    const own = checkImportedInvention({
      ...SNAPBACK,
      instrumentId: "LINK-USDT-SWAP",
      direction: "short_only"
    });
    if (!own.ok) throw new Error(own.error);
    expect(own.blueprint.instrumentId).toBe("LINK-USDT-SWAP");
    expect(own.blueprint.direction).toBe("short_only");

    const pepe = checkImportedInvention({ ...SNAPBACK, instrumentId: "PEPE-USDT-SWAP" });
    expect(pepe).toMatchObject({ ok: false, name: "Tidal Snapback" });
    expect(pepe.ok ? "" : pepe.error).toMatch(/^instrumentId must be one of BTC-USDT-SWAP/);
  });

  it("reads another market hour by hour, never a later hour, and waits for one that lags", () => {
    const btcClose = { type: "bar_field", field: "close", market: "BTC-USDT-SWAP" };
    const b = ok({
      ...SNAPBACK,
      indicators: [{ id: "btc_avg", kind: "sma", period: 3, market: "BTC-USDT-SWAP" }],
      longEntry: {
        type: "comparison",
        op: ">",
        left: btcClose,
        right: { type: "indicator", id: "btc_avg", output: "mean" }
      },
      shortEntry: {
        type: "comparison",
        op: "<",
        left: { type: "constant", value: 1 },
        right: { type: "constant", value: 0 }
      }
    });
    expect(b.invention?.rules[0]).toBe("Long when BTC close > BTC SMA(3)");
    const strategy = new SpecStrategy(compileBlueprint(b, "inv_lead"));
    expect(strategy.referenceMarkets).toEqual(["BTC-USDT-SWAP"]);

    const dt = TIMEFRAME_DURATION_MS["1H"];
    const day = Date.UTC(2024, 5, 3);
    const series = (instrumentId: string, close: (h: number) => number): ConfirmedBar[] =>
      Array.from({ length: 20 }, (_, h) => ({
        instrumentId,
        timeframe: "1H",
        openTs: day + h * dt,
        closeTs: day + (h + 1) * dt,
        open: "100",
        high: "120",
        low: "90",
        close: String(close(h)),
        volumeContracts: "1",
        volumeQuote: "100",
        confirm: "1"
      }));
    // SOL never moves; BTC jumps at the last hour
    const sol = series("SOL-USDT-SWAP", () => 100);
    const btc = series("BTC-USDT-SWAP", (h) => (h === 19 ? 110 : 100));
    const at = (h: number, btcUpTo: number) =>
      strategy.evaluate({
        instrumentId: "SOL-USDT-SWAP",
        asOfMs: sol[h]?.closeTs ?? 0,
        barsByTimeframe: { "1H": sol.slice(0, h + 1) },
        recentFundingRates: [],
        referenceBars: { "BTC-USDT-SWAP": btc.slice(0, btcUpTo + 1) }
      });

    // Hour 18 never sees BTC's jump, even when the snapshot wrongly holds the next hour
    expect(at(18, 19).proposals).toEqual([]);
    expect(at(18, 19).standDownReason).toBe("no_spec_signals");
    // Hour 19 trades SOL on BTC's move
    expect(at(19, 19).proposals.map((p) => [p.instrumentId, p.side])).toEqual([
      ["SOL-USDT-SWAP", "long"]
    ]);
    // BTC has not posted hour 19 yet: stand down rather than read hour 18 as if it were current
    expect(at(19, 18).proposals).toEqual([]);
    expect(at(19, 18).standDownReason).toBe("reference_market_not_current_BTC-USDT-SWAP");
  });

  it("sails a basket of the brief's coins and names it in the rules", () => {
    const b = ok(
      { ...SNAPBACK, basket: ["AVAX-USDT-SWAP", "DOGE-USDT-SWAP", "SOL-USDT-SWAP"] },
      { instruments: ["SOL-USDT-SWAP", "AVAX-USDT-SWAP", "LINK-USDT-SWAP"], direction: "any" }
    );
    // DOGE is not in the brief, and SOL is already the boat's own market
    expect(b.basket).toEqual(["AVAX-USDT-SWAP"]);
    expect(b.invention?.rules.at(-1)).toBe(
      "Trades SOL, AVAX with the same rules, one position per coin"
    );
  });

  it("refuses imported baskets and signals on markets Keel does not trade", () => {
    const error = (raw: unknown) => {
      const check = checkImportedInvention(raw);
      return check.ok ? null : check.error;
    };
    expect(error({ ...SNAPBACK, basket: ["AVAX-USDT-SWAP"] })).toBeNull();
    expect(error({ ...SNAPBACK, basket: ["PEPE-USDT-SWAP"] })).toMatch(
      /^basket: "PEPE-USDT-SWAP" must be one of/
    );
    expect(
      error({
        ...SNAPBACK,
        basket: [
          "BTC-USDT-SWAP",
          "ETH-USDT-SWAP",
          "XRP-USDT-SWAP",
          "ADA-USDT-SWAP",
          "LTC-USDT-SWAP"
        ]
      })
    ).toMatch(/at most 5 coins/);
    expect(
      error({
        ...SNAPBACK,
        indicators: [...SNAPBACK.indicators, { id: "pepe", kind: "ema", period: 9, market: "PEPE" }]
      })
    ).toMatch(/^indicator "pepe": market "PEPE" must be one of/);
    expect(
      error({
        ...SNAPBACK,
        shortEntry: {
          type: "comparison",
          op: ">",
          left: { type: "bar_field", field: "close", market: "PEPE-USDT-SWAP" },
          right: { type: "constant", value: 1 }
        }
      })
    ).toMatch(/^shortEntry: market "PEPE-USDT-SWAP" must be one of/);
  });

  it("nudges windows and thresholds, but never the clock", () => {
    const b = ok({
      ...SNAPBACK,
      longEntry: {
        type: "logical_op",
        op: "and",
        operands: [
          {
            type: "comparison",
            op: ">=",
            left: { type: "bar_field", field: "weekday" },
            right: { type: "constant", value: 1 }
          },
          {
            type: "comparison",
            op: "<=",
            left: { type: "indicator", id: "fast_rsi", output: "rsi" },
            right: { type: "constant", value: 30 }
          }
        ]
      }
    });
    expect(b.invention?.rules[0]).toBe("Long when the weekday ≥ Monday and RSI(7) ≤ 30");
    const nudged = nudgeInvention(b, 1.33, 1.1);
    expect(nudged.invention?.indicators.map((i) => i.period)).toEqual([9, 200]);
    expect(nudged.invention?.rules[0]).toBe("Long when the weekday ≥ Monday and RSI(9) ≤ 33");
  });
});
