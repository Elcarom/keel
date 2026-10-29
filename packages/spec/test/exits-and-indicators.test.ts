import { describe, expect, it } from "vitest";
import { TIMEFRAME_DURATION_MS, type ConfirmedBar, type DesignBrief } from "@keel/core";
import { SpecStrategy, aggregateBars, checkInvention, compileBlueprint } from "../src/index.js";

const BRIEF: Pick<DesignBrief, "instruments" | "direction"> = {
  instruments: ["SOL-USDT-SWAP"],
  direction: "any"
};
const HOUR = TIMEFRAME_DURATION_MS["1H"];
const START = Date.UTC(2024, 5, 3);

const k = (value: number) => ({ type: "constant", value });
const close = { type: "bar_field", field: "close" };
const ind = (id: string, output: string) => ({ type: "indicator", id, output });
const cmp = (left: unknown, op: string, right: unknown) => ({
  type: "comparison",
  op,
  left,
  right
});
const NEVER = cmp(k(1), "<", k(0));

/** Hourly bars whose closes follow `closes`, each spanning ±1 around its close. */
function series(closes: readonly number[], instrumentId = "SOL-USDT-SWAP"): ConfirmedBar[] {
  return closes.map((c, h) => ({
    instrumentId,
    timeframe: "1H",
    openTs: START + h * HOUR,
    closeTs: START + (h + 1) * HOUR,
    open: String(c),
    high: String(c + 1),
    low: String(c - 1),
    close: String(c),
    volumeContracts: "1",
    volumeQuote: String(c),
    confirm: "1"
  }));
}

function strategyFor(raw: Record<string, unknown>): SpecStrategy {
  const check = checkInvention(
    {
      name: "Test Hull",
      tagline: "Sails for the tests.",
      rationale: "None.",
      instrumentId: "SOL-USDT-SWAP",
      direction: "both",
      indicators: [{ id: "avg", kind: "sma", period: 3 }],
      longEntry: NEVER,
      shortEntry: NEVER,
      stopAtrMultiple: 2,
      rewardMultiple: 3,
      ...raw
    },
    BRIEF
  );
  if (!check.ok) throw new Error(check.error);
  return new SpecStrategy(compileBlueprint(check.blueprint, "exit_test"));
}

const snapshot = (
  bars: readonly ConfirmedBar[],
  referenceBars?: Record<string, ConfirmedBar[]>
) => ({
  instrumentId: "SOL-USDT-SWAP",
  asOfMs: bars[bars.length - 1]?.closeTs ?? 0,
  barsByTimeframe: { "1H": bars },
  recentFundingRates: [],
  ...(referenceBars ? { referenceBars } : {})
});

describe("Exits", () => {
  it("closes a long when its exit rule turns, and leaves shorts to their own rule", () => {
    const strategy = strategyFor({ longExit: cmp(close, ">", ind("avg", "mean")) });
    const rising = series([100, 100, 100, 104]);
    const flat = series([100, 100, 100, 100]);
    const long = {
      side: "long" as const,
      entryPrice: "100",
      protectiveStopPrice: "96",
      barsHeld: 3
    };
    expect(strategy.manage(long, snapshot(rising))).toEqual({
      kind: "exit",
      reason: "signal_exit"
    });
    expect(strategy.manage(long, snapshot(flat))).toEqual({ kind: "hold" });
    expect(strategy.manage({ ...long, side: "short" }, snapshot(rising))).toEqual({ kind: "hold" });
  });

  it("ends a trade after its time limit, whatever the rules say", () => {
    const strategy = strategyFor({ maxBarsHeld: 6 });
    const bars = series([100, 100, 100, 100]);
    const position = { side: "short" as const, entryPrice: "100", protectiveStopPrice: "104" };
    expect(strategy.manage({ ...position, barsHeld: 5 }, snapshot(bars))).toEqual({ kind: "hold" });
    expect(strategy.manage({ ...position, barsHeld: 6 }, snapshot(bars))).toEqual({
      kind: "exit",
      reason: "time_stop"
    });
  });

  it("trails the stop behind each close by its ATR multiple", () => {
    // True range is 2 every hour, so ATR(14) is 2 and the stop trails 3 ATRs = 6 behind
    const strategy = strategyFor({ trailingAtrMultiple: 3 });
    const bars = series(Array.from({ length: 20 }, (_, i) => 100 + i));
    const close = 119;
    const long = strategy.manage(
      { side: "long", entryPrice: "100", protectiveStopPrice: "96", barsHeld: 4 },
      snapshot(bars)
    );
    const short = strategy.manage(
      { side: "short", entryPrice: "100", protectiveStopPrice: "104", barsHeld: 4 },
      snapshot(bars)
    );
    expect(long.kind === "hold" && Number(long.newStopPrice)).toBeCloseTo(close - 6, 6);
    expect(short.kind === "hold" && Number(short.newStopPrice)).toBeCloseTo(close + 6, 6);
  });

  it("names every exit in the rules it shows", () => {
    const check = checkInvention(
      {
        name: "Test Hull",
        tagline: "Sails for the tests.",
        rationale: "None.",
        instrumentId: "SOL-USDT-SWAP",
        direction: "both",
        indicators: [{ id: "avg", kind: "sma", period: 3 }],
        longEntry: NEVER,
        shortEntry: NEVER,
        longExit: cmp(close, ">", ind("avg", "mean")),
        stopAtrMultiple: 2,
        rewardMultiple: 3,
        trailingAtrMultiple: 2.5,
        maxBarsHeld: 48
      },
      BRIEF
    );
    if (!check.ok) throw new Error(check.error);
    expect(check.blueprint.invention?.rules.slice(3)).toEqual([
      "Exit longs when close > SMA(3)",
      "Trail the stop 2.5× ATR(14) behind each close",
      "Close any position after 48 hours"
    ]);
  });
});

describe("New indicators", () => {
  const long = (
    strategy: SpecStrategy,
    bars: readonly ConfirmedBar[],
    refs?: Record<string, ConfirmedBar[]>
  ) => strategy.evaluate(snapshot(bars, refs)).proposals.map((p) => p.side);

  it("reads trend strength: ADX rises in a steady climb with +DI above −DI", () => {
    const strategy = strategyFor({
      indicators: [{ id: "trend", kind: "adx", period: 14 }],
      longEntry: {
        type: "logical_op",
        op: "and",
        operands: [
          cmp(ind("trend", "adx"), ">", k(25)),
          cmp(ind("trend", "plus_di"), ">", ind("trend", "minus_di"))
        ]
      }
    });
    const climbing = series(Array.from({ length: 60 }, (_, i) => 100 + 2 * i));
    const choppy = series(Array.from({ length: 60 }, (_, i) => 100 + (i % 2 === 0 ? 0 : 0.5)));
    expect(long(strategy, climbing)).toEqual(["long"]);
    expect(long(strategy, choppy)).toEqual([]);
  });

  it("places the close within its Bollinger bands and ranks it against recent closes", () => {
    const strategy = strategyFor({
      indicators: [
        { id: "bands", kind: "bollinger", period: 20 },
        { id: "rank", kind: "percentile", period: 20 }
      ],
      longEntry: {
        type: "logical_op",
        op: "and",
        operands: [
          cmp(ind("bands", "percent_b"), ">", k(1)),
          cmp(ind("rank", "percentile"), ">=", k(100))
        ]
      }
    });
    const quietThenBreak = series([...Array.from({ length: 30 }, (_, i) => 100 + (i % 2)), 110]);
    const quiet = series(Array.from({ length: 31 }, (_, i) => 100 + (i % 2)));
    expect(long(strategy, quietThenBreak)).toEqual(["long"]);
    expect(long(strategy, quiet)).toEqual([]);
  });

  it("measures correlation and beta of the traded coin against another market", () => {
    const strategy = strategyFor({
      indicators: [{ id: "link", kind: "correlation", period: 20, market: "BTC-USDT-SWAP" }],
      longEntry: {
        type: "logical_op",
        op: "and",
        operands: [
          cmp(ind("link", "correlation"), ">", k(0.99)),
          cmp(ind("link", "beta"), ">", k(1.9))
        ]
      }
    });
    // SOL moves exactly twice as much as BTC every hour: correlation 1, beta 2
    const btcMoves = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? 0.01 : -0.004));
    const btcCloses = [100];
    const solCloses = [50];
    for (const r of btcMoves) {
      btcCloses.push((btcCloses[btcCloses.length - 1] ?? 0) * (1 + r));
      solCloses.push((solCloses[solCloses.length - 1] ?? 0) * (1 + 2 * r));
    }
    const sol = series(solCloses);
    const btc = series(btcCloses, "BTC-USDT-SWAP");
    expect(long(strategy, sol, { "BTC-USDT-SWAP": btc })).toEqual(["long"]);
    expect(
      long(strategy, sol, {
        "BTC-USDT-SWAP": series(
          solCloses.map(() => 100),
          "BTC-USDT-SWAP"
        )
      })
    ).toEqual([]);
  });

  it("refuses a correlation with nothing to correlate against", () => {
    const check = checkInvention(
      {
        name: "Test Hull",
        tagline: "Sails for the tests.",
        rationale: "None.",
        instrumentId: "SOL-USDT-SWAP",
        direction: "both",
        indicators: [{ id: "link", kind: "correlation", period: 20 }],
        longEntry: cmp(ind("link", "correlation"), ">", k(0.5)),
        shortEntry: NEVER,
        stopAtrMultiple: 2,
        rewardMultiple: 3
      },
      BRIEF
    );
    expect(check.ok ? "" : check.error).toBe(
      'indicator "link": correlation needs the "market" to correlate with'
    );
  });
});

describe("Higher timeframes and funding", () => {
  it("builds 4-hour bars only from complete hours, never a forming one", () => {
    // Hours 0-9 of a day: 4H buckets 00-04 and 04-08 are complete, 08-12 is still forming
    const hourly = series([10, 11, 12, 13, 14, 15, 16, 17, 30, 31]);
    const fourHour = aggregateBars(hourly, 4);
    expect(fourHour.map((b) => [b.open, b.high, b.low, b.close])).toEqual([
      ["10", "14", "9", "13"],
      ["14", "18", "13", "17"]
    ]);
  });

  it("reads the last complete daily close, and names the timeframe in its rules", () => {
    const check = checkInvention(
      {
        name: "Test Hull",
        tagline: "Sails for the tests.",
        rationale: "None.",
        instrumentId: "SOL-USDT-SWAP",
        direction: "both",
        indicators: [{ id: "avg", kind: "sma", period: 3 }],
        longEntry: cmp(close, ">", { type: "bar_field", field: "close", timeframe: "1D" }),
        shortEntry: NEVER,
        stopAtrMultiple: 2,
        rewardMultiple: 3
      },
      BRIEF
    );
    if (!check.ok) throw new Error(check.error);
    expect(check.blueprint.invention?.rules[0]).toBe("Long when close > daily close");
    const strategy = new SpecStrategy(compileBlueprint(check.blueprint, "daily_test"));
    // Day one closes at 100; day two climbs to 120 by its 10th hour
    const twoDays = series([
      ...Array.from({ length: 24 }, () => 100),
      ...Array.from({ length: 10 }, (_, i) => 101 + 2 * i)
    ]);
    expect(strategy.evaluate(snapshot(twoDays)).proposals.map((p) => p.side)).toEqual(["long"]);
    // Within day one, there is no complete daily bar yet
    expect(strategy.evaluate(snapshot(twoDays.slice(0, 20))).proposals).toEqual([]);
  });

  it("reads the traded coin's settled funding as of each bar, in basis points", () => {
    const strategy = strategyFor({
      longEntry: cmp({ type: "bar_field", field: "funding" }, "<", k(-2))
    });
    const bars = series([100, 100, 100, 100]);
    const at = (rate: string, ts: number) =>
      strategy.evaluate({
        ...snapshot(bars),
        recentFundingRates: [{ instrumentId: "SOL-USDT-SWAP", fundingTs: ts, fundingRate: rate }]
      }).proposals.length;
    const lastClose = bars[bars.length - 1]?.closeTs ?? 0;
    expect(at("-0.0003", lastClose)).toBe(1);
    expect(at("0.0001", lastClose)).toBe(0);
    // A rate settled after this bar's close is not visible yet
    expect(at("-0.0003", lastClose + 1)).toBe(0);
  });

  it("keeps higher-timeframe windows inside the 20-day lookback", () => {
    const check = checkInvention(
      {
        name: "Test Hull",
        tagline: "Sails for the tests.",
        rationale: "None.",
        instrumentId: "SOL-USDT-SWAP",
        direction: "both",
        indicators: [{ id: "slow", kind: "sma", period: 30, timeframe: "1D" }],
        longEntry: cmp(close, ">", ind("slow", "mean")),
        shortEntry: NEVER,
        stopAtrMultiple: 2,
        rewardMultiple: 3
      },
      BRIEF
    );
    expect(check.ok ? "" : check.error).toBe(
      'indicator "slow": a 1D period may cover at most 20 bars'
    );
  });
});
