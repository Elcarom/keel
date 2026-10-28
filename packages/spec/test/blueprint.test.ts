import { describe, expect, it } from "vitest";
import {
  BOT_ARCHETYPES,
  TIMEFRAME_DURATION_MS,
  normalizeBlueprint,
  type BotBlueprintDraft,
  type ConfirmedBar
} from "@keel/core";
import { SpecStrategy, compileBlueprint } from "../src/index.js";

const DRAFT: BotBlueprintDraft = {
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

function sidesProposed(direction: BotBlueprintDraft["direction"], move: "up" | "down") {
  const strategy = new SpecStrategy(
    compileBlueprint(normalizeBlueprint({ ...DRAFT, direction }), "bot_test")
  );
  const bars = breakoutBars(move);
  const menu = strategy.evaluate({
    instrumentId: "BTC-USDT-SWAP",
    asOfMs: bars[bars.length - 1]?.closeTs ?? 0,
    barsByTimeframe: { "1H": bars },
    recentFundingRates: []
  });
  return menu.proposals.map((p) => p.side);
}

describe("Bot blueprints", () => {
  it("clamps every model-chosen parameter into its reviewed range", () => {
    const b = normalizeBlueprint({
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
    const b = normalizeBlueprint({ ...DRAFT, lookbackPeriod: 10, fastPeriod: 40 });
    expect(b.fastPeriod).toBeLessThan(b.lookbackPeriod);
  });

  it("compiles every archetype into a valid spec named after the bot", () => {
    for (const archetype of BOT_ARCHETYPES) {
      const spec = compileBlueprint(normalizeBlueprint({ ...DRAFT, archetype }), "bot_abc");
      expect(spec.name).toBe("bot_abc");
      expect(spec.risk.stopModel.kind).toBe("atr_multiple");
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
    const strategy = new SpecStrategy(compileBlueprint(normalizeBlueprint(DRAFT), "bot_stop"));
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
