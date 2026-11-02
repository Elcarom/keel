import { describe, expect, it } from "vitest";
import { type Proposition, type Rig } from "@keel/core";
import { RESEARCH_THEMES, ingredientsOf, nextTheme, triedIdeas } from "../src/research-themes.js";

const PLAIN_RULES: NonNullable<Rig["invention"]> = {
  indicators: [{ id: "r", kind: "rsi", period: 14 }],
  longEntry: { type: "comparison", op: "<", left: { type: "indicator", id: "r", output: "rsi" } },
  shortEntry: { type: "comparison", op: ">", left: { type: "indicator", id: "r", output: "rsi" } },
  rules: []
};

const PLAIN: Rig = {
  name: "Trade Wind",
  tagline: "Rides the wind.",
  archetype: "invented",
  instrumentId: "BTC-USDT-SWAP",
  direction: "both",
  lookbackPeriod: 24,
  fastPeriod: 8,
  entryThreshold: 1,
  stopAtrMultiple: 2,
  rewardMultiple: 2,
  rationale: "",
  basket: [],
  pairWith: null,
  trailingAtrMultiple: null,
  maxBarsHeld: null,
  invention: PLAIN_RULES
};

/** A rig that reads funding in the Asian session and leaves after six hours. */
const FUNDING_AT_ASIA: Rig = {
  ...PLAIN,
  name: "Night Toll",
  direction: "short_only",
  maxBarsHeld: 6,
  invention: {
    indicators: [{ id: "v", kind: "volume_sma", period: 24 }],
    longEntry: {
      type: "logical_op",
      op: "and",
      operands: [
        { type: "comparison", op: ">", left: { type: "bar_field", field: "funding" } },
        { type: "comparison", op: "<", left: { type: "bar_field", field: "hour" } }
      ]
    },
    shortEntry: { type: "comparison", op: ">", left: { type: "bar_field", field: "funding" } },
    rules: []
  }
};

function proposition(id: string, rig: Rig, overrides: Partial<Proposition> = {}): Proposition {
  return {
    propositionId: id,
    batchId: "d1",
    createdAtMs: 0,
    source: "claude",
    rig,
    status: "ranked",
    assessment: null,
    rank: 1,
    error: null,
    botId: null,
    ...overrides
  };
}

describe("Research themes", () => {
  it("reads what an idea is built from off its rules", () => {
    expect(ingredientsOf(PLAIN)).toEqual([]);
    expect(ingredientsOf(FUNDING_AT_ASIA)).toEqual([
      "funding",
      "calendar",
      "volume",
      "one side only",
      "time limit"
    ]);
    expect(
      ingredientsOf({ ...PLAIN, pairWith: "ETH-USDT-SWAP", basket: [], maxBarsHeld: 72 })
    ).toEqual(["pair"]);
  });

  it("sends the next round where recent ideas have been least, taking ties in turn", () => {
    // Nothing explored yet: the rounds go through the themes in order
    expect(nextTheme([], 0).title).toBe(RESEARCH_THEMES[0]?.title);
    expect(nextTheme([], 1).title).toBe(RESEARCH_THEMES[1]?.title);
    // Every theme but relative value has been explored: that is where the next round goes
    const everythingButPairs = RESEARCH_THEMES.filter((t) => t.ingredient !== "pair").map(
      (t): Rig => ({
        ...FUNDING_AT_ASIA,
        direction: t.ingredient === "one side only" ? "long_only" : "both",
        basket: t.ingredient === "basket" ? ["ETH-USDT-SWAP"] : [],
        trailingAtrMultiple: t.ingredient === "trailing stop" ? 2 : null,
        maxBarsHeld: t.ingredient === "time limit" ? 6 : null,
        invention: {
          ...PLAIN_RULES,
          indicators: [
            {
              id: "x",
              kind: t.ingredient === "volatility regime" ? "adx" : "rsi",
              period: 14,
              ...(t.ingredient === "other market" ? { market: "ETH-USDT-SWAP" as const } : {}),
              ...(t.ingredient === "higher timeframe" ? { timeframe: "1D" as const } : {})
            }
          ],
          longEntry: {
            type: "comparison",
            op: ">",
            left: {
              type: "bar_field",
              field:
                t.ingredient === "funding"
                  ? "funding"
                  : t.ingredient === "calendar"
                    ? "hour"
                    : t.ingredient === "volume"
                      ? "volume"
                      : "close"
            }
          },
          longExit: t.ingredient === "exit rule" ? { type: "comparison" } : undefined
        }
      })
    );
    for (let round = 0; round < 3; round += 1) {
      expect(nextTheme(everythingButPairs, round).title).toBe("Relative value");
    }
  });

  it("lists ideas already tried with whether they passed, never which checks failed", () => {
    const lines = triedIdeas(
      [
        proposition("old", PLAIN, { createdAtMs: 1 }),
        proposition("new", FUNDING_AT_ASIA, {
          createdAtMs: 2,
          status: "discarded",
          error: "OKX history unreachable"
        }),
        proposition("busy", PLAIN, { createdAtMs: 3, status: "assessing" })
      ],
      2
    );
    expect(lines).toEqual([
      "Trade Wind (BTC): Rides the wind. Built from price and indicators alone. Still in its sea trial.",
      "Night Toll (BTC): Rides the wind. Built from funding, calendar, volume, one side only, time limit. Could not be tested."
    ]);
  });
});
