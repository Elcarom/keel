import { describe, expect, it } from "vitest";
import {
  TIMEFRAME_DURATION_MS,
  blueprintMarkets,
  normalizeBlueprint,
  pairLegs,
  type BotBlueprintDraftInput,
  type ConfirmedBar,
  type DesignBrief
} from "@keel/core";
import { reconcilePairLegs } from "@keel/strategy";
import { SpecStrategy, checkInvention, compileBlueprint } from "../src/index.js";

const HOUR = TIMEFRAME_DURATION_MS["1H"];
const START = Date.UTC(2024, 5, 3);
const ETH = "ETH-USDT-SWAP";
const BTC = "BTC-USDT-SWAP";

/** Hourly bars for one coin, each spanning ±0.5% around its close. */
function series(instrumentId: string, closes: readonly number[]): ConfirmedBar[] {
  return closes.map((c, h) => ({
    instrumentId,
    timeframe: "1H",
    openTs: START + h * HOUR,
    closeTs: START + (h + 1) * HOUR,
    open: String(c),
    high: String(c * 1.005),
    low: String(c * 0.995),
    close: String(c),
    volumeContracts: "1",
    volumeQuote: String(c),
    confirm: "1"
  }));
}

function pair(changes: Partial<BotBlueprintDraftInput> = {}) {
  return normalizeBlueprint({
    name: "Catamaran",
    tagline: "Two hulls.",
    archetype: "pair_reversion",
    instrumentId: ETH,
    pairWith: BTC,
    direction: "both",
    lookbackPeriod: 30,
    fastPeriod: 10,
    entryThreshold: 2,
    stopAtrMultiple: 2,
    rewardMultiple: 2,
    rationale: "Test pair.",
    ...changes
  });
}

// BTC drifts gently; ETH tracks it at 1/20, then drops 6% behind on the last bar
const btcCloses = Array.from({ length: 60 }, (_, i) => 60_000 * (1 + 0.01 * Math.sin(i / 5)));
const ethCloses = btcCloses.map((c, i) => (c / 20) * (i === 59 ? 0.94 : 1 + 0.002 * Math.cos(i)));
const btcBars = series(BTC, btcCloses);
const ethBars = series(ETH, ethCloses);
const asOfMs = START + 60 * HOUR;

describe("Pair blueprints", () => {
  it("pair a coin with a different one, and nothing else", () => {
    const b = pair();
    expect(pairLegs(b)).toEqual([ETH, BTC]);
    expect(blueprintMarkets(b)).toEqual([ETH, BTC]);
    expect(b.basket).toEqual([]);
    expect(b.trailingAtrMultiple).toBeNull();
    // A pair always has a time limit: three lookbacks unless told otherwise
    expect(b.maxBarsHeld).toBe(90);

    // Paired with itself (or nothing), it borrows the coin's sibling
    expect(pair({ pairWith: ETH }).pairWith).toBe(BTC);
    expect(pair({ pairWith: null }).pairWith).toBe(BTC);
    // Single-coin archetypes never carry a pair leg
    expect(pair({ archetype: "momentum" }).pairWith).toBeNull();
  });

  it("compile into mirrored legs: one buys exactly when the other sells", () => {
    const b = pair();
    const first = new SpecStrategy(compileBlueprint(b, "pair", 0));
    const second = new SpecStrategy(compileBlueprint(b, "pair", 1));
    expect(first.referenceMarkets).toEqual([BTC]);
    expect(second.referenceMarkets).toEqual([ETH]);

    const ethMenu = first.evaluate({
      instrumentId: ETH,
      asOfMs,
      barsByTimeframe: { "1H": ethBars },
      recentFundingRates: [],
      referenceBars: { [BTC]: btcBars }
    });
    const btcMenu = second.evaluate({
      instrumentId: BTC,
      asOfMs,
      barsByTimeframe: { "1H": btcBars },
      recentFundingRates: [],
      referenceBars: { [ETH]: ethBars }
    });
    const [buy] = ethMenu.proposals;
    const [sell] = btcMenu.proposals;
    // ETH fell behind BTC: buy ETH, sell BTC
    expect(buy?.side).toBe("long");
    expect(sell?.side).toBe("short");
    if (!buy || !sell) return;

    // Both legs' stops sit the same share of price away, so they size to the same notional
    const pct = (p: typeof buy) =>
      Math.abs(Number(p.entryPrice) - Number(p.protectiveStopPrice)) / Number(p.entryPrice);
    expect(pct(buy)).toBeCloseTo(pct(sell), 6);
  });

  it("mirror a one-way pair: long only buys the first coin, so the second leg only sells", () => {
    const b = pair({ direction: "long_only" });
    const first = compileBlueprint(b, "pair", 0);
    const second = compileBlueprint(b, "pair", 1);
    const never = { type: "comparison", op: "<" };
    expect(first.rules.shortEntry).toMatchObject(never);
    expect(second.rules.longEntry).toMatchObject(never);
    expect(first.rules.longEntry).not.toMatchObject(never);
    expect(second.rules.shortEntry).not.toMatchObject(never);
  });

  it("hold the pair together after every bar", () => {
    // A leg left alone closes, and any waiting entry is dropped
    expect(
      reconcilePairLegs({ open: "long", pending: null }, { open: null, pending: "long" })
    ).toEqual({ closeLegs: [0], cancelPending: true });
    expect(
      reconcilePairLegs({ open: null, pending: null }, { open: "short", pending: null })
    ).toEqual({ closeLegs: [1], cancelPending: true });
    // Two legs on the same side are not a pair
    expect(
      reconcilePairLegs({ open: "long", pending: null }, { open: "long", pending: null })
    ).toEqual({ closeLegs: [0, 1], cancelPending: true });
    // A matched pair holds; entries wait only as a matched pair
    expect(
      reconcilePairLegs({ open: "long", pending: null }, { open: "short", pending: null })
    ).toEqual({ closeLegs: [], cancelPending: false });
    expect(
      reconcilePairLegs({ open: null, pending: "short" }, { open: null, pending: "long" })
    ).toEqual({ closeLegs: [], cancelPending: false });
    expect(
      reconcilePairLegs({ open: null, pending: "long" }, { open: null, pending: null })
    ).toEqual({ closeLegs: [], cancelPending: true });
    expect(
      reconcilePairLegs({ open: null, pending: "long" }, { open: null, pending: "long" })
    ).toEqual({ closeLegs: [], cancelPending: true });
  });
});

describe("Pair inventions", () => {
  const brief: Pick<DesignBrief, "instruments" | "direction"> = {
    instruments: [ETH, BTC, "SOL-USDT-SWAP"],
    direction: "any"
  };
  const z = (op: string, value: number) => ({
    type: "comparison",
    op,
    left: { type: "indicator", id: "gap", output: "zscore" },
    right: { type: "constant", value }
  });
  const invention = {
    name: "Tow Line",
    tagline: "Pulls the laggard back alongside.",
    rationale: "ETH and BTC share flows. It fails when the gap opens on news.",
    instrumentId: ETH,
    pairWith: BTC,
    direction: "both",
    indicators: [{ id: "gap", kind: "spread", period: 48, market: BTC }],
    longEntry: z("<=", -2),
    shortEntry: z(">=", 2),
    longExit: z(">=", 0),
    shortExit: z("<=", 0),
    stopAtrMultiple: 2,
    rewardMultiple: 2
  };

  it("turn into a pair boat with mirrored rules described in words", () => {
    const check = checkInvention(invention, brief);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.blueprint.pairWith).toBe(BTC);
    expect(check.blueprint.maxBarsHeld).toBe(144);
    expect(check.blueprint.invention?.rules[0]).toBe(
      "A pair: ETH against BTC, one long and one short, entering and leaving together"
    );
    expect(check.blueprint.invention?.rules[1]).toBe(
      "Buys ETH and sells BTC when z-score of the spread to BTC (48) ≤ -2"
    );
    // The second leg reads ETH where the first read BTC
    const second = new SpecStrategy(compileBlueprint(check.blueprint, "inv", 1));
    expect(second.referenceMarkets).toEqual([ETH]);
  });

  it("must read the other coin, trade only the two, and give a spread its market", () => {
    const noRead = checkInvention(
      {
        ...invention,
        indicators: [{ id: "gap", kind: "zscore", period: 48 }]
      },
      brief
    );
    expect(noRead.ok ? "" : noRead.error).toMatch(/must read its other coin/);
    const basket = checkInvention({ ...invention, basket: ["SOL-USDT-SWAP"] }, brief);
    expect(basket.ok ? "" : basket.error).toMatch(/leave basket empty/);
    const bare = checkInvention(
      {
        ...invention,
        pairWith: null,
        indicators: [{ id: "gap", kind: "spread", period: 48 }]
      },
      brief
    );
    expect(bare.ok ? "" : bare.error).toMatch(/spread needs the "market"/);
    const outside = checkInvention({ ...invention, pairWith: "DOGE-USDT-SWAP" }, brief);
    expect(outside.ok ? "" : outside.error).toMatch(/pairWith/);
  });
});
