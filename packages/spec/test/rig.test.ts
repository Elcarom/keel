import { describe, expect, it } from "vitest";
import {
  BOT_ARCHETYPES,
  PAIR_ARCHETYPES,
  TIMEFRAME_DURATION_MS,
  normalizeRig,
  type RigDraft,
  type ConfirmedBar
} from "@keel/core";
import { SpecStrategy, compileRig } from "../src/index.js";

const DRAFT: RigDraft = {
  name: "Breakwater",
  tagline: "Charges through the harbour wall.",
  archetype: "breakout",
  instrumentId: "BTC-USDT-SWAP",
  direction: "both",
  lookbackPeriod: 20,
  fastPeriod: 8,
  entryThreshold: 1.5,
  stopAtrMultiple: 2,
  rewardMultiple: 2,
  rationale: "Breakouts start trends."
};

/** Flat bars then a final bar that closes far above (or below) everything before it. */
function breakoutBars(direction: "up" | "down"): ConfirmedBar[] {
  const dt = TIMEFRAME_DURATION_MS["1H"];
  const bars: ConfirmedBar[] = [];
  for (let i = 0; i < 40; i++) {
    const last = i === 39;
    const close = last ? (direction === "up" ? 120 : 80) : 100;
    bars.push({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      openTs: i * dt,
      closeTs: (i + 1) * dt,
      open: "100",
      high: String(Math.max(101, close)),
      low: String(Math.min(99, close)),
      close: String(close),
      volumeContracts: "10",
      volumeQuote: "1000",
      confirm: "1"
    });
  }
  return bars;
}

function sidesProposed(direction: RigDraft["direction"], move: "up" | "down") {
  const strategy = new SpecStrategy(compileRig(normalizeRig({ ...DRAFT, direction }), "bot_test"));
  const bars = breakoutBars(move);
  const menu = strategy.evaluate({
    instrumentId: "BTC-USDT-SWAP",
    asOfMs: bars[bars.length - 1]?.closeTs ?? 0,
    barsByTimeframe: { "1H": bars },
    recentFundingRates: []
  });
  return menu.proposals.map((p) => p.side);
}

describe("Bot rigs", () => {
  it("clamps every model-chosen parameter into its reviewed range", () => {
    const b = normalizeRig({
      ...DRAFT,
      name: "A name far longer than any vessel should ever carry on her bow",
      lookbackPeriod: 9000,
      fastPeriod: 1,
      entryThreshold: -3,
      stopAtrMultiple: 50,
      rewardMultiple: Number.NaN
    });
    expect(b.name.length).toBeLessThanOrEqual(40);
    expect(b.lookbackPeriod).toBe(200);
    expect(b.fastPeriod).toBe(3);
    expect(b.entryThreshold).toBe(0.2);
    expect(b.stopAtrMultiple).toBe(6);
    expect(b.rewardMultiple).toBe(0.8);
  });

  it("keeps the fast average faster than the slow one", () => {
    const b = normalizeRig({ ...DRAFT, lookbackPeriod: 10, fastPeriod: 40 });
    expect(b.fastPeriod).toBeLessThan(b.lookbackPeriod);
  });

  it("compiles every archetype into a valid spec named after the bot", () => {
    for (const archetype of BOT_ARCHETYPES) {
      const spec = compileRig(normalizeRig({ ...DRAFT, archetype }), "bot_abc");
      expect(spec.name).toBe("bot_abc");
      // A pair's legs share one percentage stop (ADR-0032)
      expect(spec.risk.stopModel.kind).toBe(
        PAIR_ARCHETYPES.has(archetype) ? "pair_atr" : "atr_multiple"
      );
      expect(new SpecStrategy(spec).strategyId).toBe("bot_abc");
    }
  });

  it("trades the breakout side the market broke to, and honours a one-way direction", () => {
    expect(sidesProposed("both", "up")).toEqual(["long"]);
    expect(sidesProposed("both", "down")).toEqual(["short"]);
    expect(sidesProposed("short_only", "up")).toEqual([]);
    expect(sidesProposed("long_only", "down")).toEqual([]);
  });

  it("attaches a protective stop to every proposal", () => {
    const strategy = new SpecStrategy(compileRig(normalizeRig(DRAFT), "bot_stop"));
    const bars = breakoutBars("up");
    const menu = strategy.evaluate({
      instrumentId: "BTC-USDT-SWAP",
      asOfMs: bars[bars.length - 1]?.closeTs ?? 0,
      barsByTimeframe: { "1H": bars },
      recentFundingRates: []
    });
    for (const p of menu.proposals) {
      expect(Number(p.protectiveStopPrice)).toBeLessThan(Number(p.entryPrice));
    }
  });
});

/** A seeded random walk with alternating calm/stormy and up/down regimes, plus volume bursts. */
function regimeBars(count: number): ConfirmedBar[] {
  const dt = TIMEFRAME_DURATION_MS["1H"];
  let state = 12345;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const bars: ConfirmedBar[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const regime = Math.floor(i / 150) % 4;
    const drift = regime === 0 ? 0.4 : regime === 2 ? -0.4 : 0;
    const vol = regime === 1 ? 0.2 : 1.2;
    const open = price;
    const close = Math.max(5, open + drift + (random() - 0.5) * 2 * vol);
    const high = Math.max(open, close) + random() * vol;
    const low = Math.min(open, close) - random() * vol;
    price = close;
    bars.push({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      openTs: i * dt,
      closeTs: (i + 1) * dt,
      open: open.toFixed(4),
      high: high.toFixed(4),
      low: low.toFixed(4),
      close: close.toFixed(4),
      volumeContracts: (random() < 0.05 ? 500 + random() * 500 : 50 + random() * 100).toFixed(2),
      volumeQuote: "0",
      confirm: "1"
    });
  }
  return bars;
}

function bar(i: number, o: number, h: number, l: number, c: number, volume = 10): ConfirmedBar {
  const dt = TIMEFRAME_DURATION_MS["1H"];
  return {
    instrumentId: "BTC-USDT-SWAP",
    timeframe: "1H",
    openTs: i * dt,
    closeTs: (i + 1) * dt,
    open: String(o),
    high: String(h),
    low: String(l),
    close: String(c),
    volumeContracts: String(volume),
    volumeQuote: "0",
    confirm: "1"
  };
}

function propose(
  strategy: SpecStrategy,
  bars: readonly ConfirmedBar[],
  referenceBars?: Readonly<Record<string, readonly ConfirmedBar[]>>
) {
  return strategy.evaluate({
    instrumentId: "BTC-USDT-SWAP",
    asOfMs: bars[bars.length - 1]?.closeTs ?? 0,
    barsByTimeframe: { "1H": bars },
    recentFundingRates: [],
    ...(referenceBars ? { referenceBars } : {})
  }).proposals;
}

describe("Boat archetypes on a changing sea", () => {
  const market = regimeBars(2400);
  // A pair's other coin: the same sea, drifting ahead of and behind the first in slow swells
  const partner = market.map((b, i) => {
    const f = 1 + 0.04 * Math.sin(i / 30);
    const at = (v: string) => (Number(v) * f).toFixed(6);
    return {
      ...b,
      instrumentId: "ETH-USDT-SWAP",
      open: at(b.open),
      high: at(b.high),
      low: at(b.low),
      close: at(b.close)
    };
  });

  it.each(BOT_ARCHETYPES)(
    "%s trades both sides, always with the protective stop on the losing side",
    (archetype) => {
      const strategy = new SpecStrategy(
        compileRig(normalizeRig({ ...DRAFT, archetype, entryThreshold: 1 }), `bot_${archetype}`)
      );
      const window = strategy.lookbacks["1H"] ?? 50;
      let longs = 0;
      let shorts = 0;
      const reads = strategy.referenceMarkets.length > 0;
      for (let end = window; end <= market.length; end++) {
        const refs = reads ? { "ETH-USDT-SWAP": partner.slice(end - window, end) } : undefined;
        for (const p of propose(strategy, market.slice(end - window, end), refs)) {
          const entry = Number(p.entryPrice);
          const stop = Number(p.protectiveStopPrice);
          if (p.side === "long") {
            longs++;
            expect(stop).toBeLessThan(entry);
          } else {
            shorts++;
            expect(stop).toBeGreaterThan(entry);
          }
        }
      }
      expect(longs).toBeGreaterThan(0);
      expect(shorts).toBeGreaterThan(0);
    }
  );

  it("fades a failed breakout only once the close is back inside the channel", () => {
    const strategy = new SpecStrategy(
      compileRig(
        normalizeRig({ ...DRAFT, archetype: "failed_breakout", lookbackPeriod: 10 }),
        "bot_fade"
      )
    );
    const range = Array.from({ length: 20 }, (_, i) => bar(i, 100, 101, 99, 100));
    const poke = bar(20, 100, 100, 97, 98); // dips below the 99 floor
    expect(
      propose(strategy, [...range, poke, bar(21, 98, 100.5, 98, 100)]).map((p) => p.side)
    ).toEqual(["long"]);
    // Still below the floor: the breakout has not failed yet
    expect(propose(strategy, [...range, poke, bar(21, 98, 98.5, 97, 98)])).toEqual([]);
  });

  it("only takes an inside-bar breakout in the direction of the trend", () => {
    const strategy = new SpecStrategy(
      compileRig(
        normalizeRig({ ...DRAFT, archetype: "inside_bar_breakout", lookbackPeriod: 20 }),
        "bot_inside"
      )
    );
    const climb = Array.from({ length: 20 }, (_, i) => bar(i, 90 + i, 91 + i, 89 + i, 90 + i));
    const mother = bar(20, 110, 114, 106, 112);
    const inside = bar(21, 112, 113, 108, 110);
    expect(
      propose(strategy, [...climb, mother, inside, bar(22, 110, 116, 110, 115)]).map((p) => p.side)
    ).toEqual(["long"]);
    // Breaking the inside bar's low while still above the trend average is not a trade
    expect(propose(strategy, [...climb, mother, inside, bar(22, 110, 110, 106, 107)])).toEqual([]);
  });

  it("only counts a breakout when volume surges past the average", () => {
    const strategy = new SpecStrategy(
      compileRig(
        normalizeRig({
          ...DRAFT,
          archetype: "volume_breakout",
          lookbackPeriod: 10,
          entryThreshold: 2
        }),
        "bot_volume"
      )
    );
    const range = Array.from({ length: 20 }, (_, i) => bar(i, 100, 101, 99, 100, 10));
    expect(
      propose(strategy, [...range, bar(20, 100, 105, 100, 104, 50)]).map((p) => p.side)
    ).toEqual(["long"]);
    expect(propose(strategy, [...range, bar(20, 100, 105, 100, 104, 12)])).toEqual([]);
  });
});

/** A one-indicator spec that goes long only while the indicator sits inside [lo, hi]. */
function probe(kind: "ema" | "rsi", period: number, lo: number, hi: number): SpecStrategy {
  const output = kind;
  return new SpecStrategy({
    name: `probe_${kind}`,
    version: 1,
    description: "indicator probe",
    timeframe: "1H",
    lookbacks: { "1H": 50 },
    indicators: [{ id: "x", kind, period }],
    rules: {
      longEntry: {
        type: "logical_op",
        op: "and",
        operands: [
          {
            type: "comparison",
            op: ">=",
            left: { type: "indicator", id: "x", output },
            right: { type: "constant", value: lo }
          },
          {
            type: "comparison",
            op: "<=",
            left: { type: "indicator", id: "x", output },
            right: { type: "constant", value: hi }
          }
        ]
      },
      shortEntry: {
        type: "comparison",
        op: "<",
        left: { type: "constant", value: 1 },
        right: { type: "constant", value: 0 }
      }
    },
    risk: {
      stopModel: { kind: "atr_multiple", multiplier: 2, atrPeriod: 2 },
      takeProfit: { rewardMultiple: 2 }
    },
    cooldownBars: 0
  });
}

describe("New indicators", () => {
  const closes = (values: number[]) => values.map((c, i) => bar(i, c, c + 0.5, c - 0.5, c));

  it("seeds the EMA with a simple average, then smooths (worked example: 1..5, period 3 → 4)", () => {
    // seed = mean(1,2,3) = 2; alpha = 0.5; then 3 after the 4, then 4 after the 5
    expect(propose(probe("ema", 3, 3.999, 4.001), closes([1, 2, 3, 4, 5]))).toHaveLength(1);
    expect(propose(probe("ema", 3, 4.5, 5), closes([1, 2, 3, 4, 5]))).toHaveLength(0);
  });

  it("puts RSI at 100 after only gains, 0 after only losses and 50 for equal swings", () => {
    const up = closes(Array.from({ length: 20 }, (_, i) => 100 + i));
    const down = closes(Array.from({ length: 20 }, (_, i) => 100 - i));
    const flat = closes(Array.from({ length: 21 }, (_, i) => (i % 2 === 0 ? 100 : 101)));
    expect(propose(probe("rsi", 14, 99.99, 100), up)).toHaveLength(1);
    expect(propose(probe("rsi", 14, 0, 0.01), down)).toHaveLength(1);
    expect(propose(probe("rsi", 14, 45, 55), flat)).toHaveLength(1);
  });
});
