import { describe, expect, it } from "vitest";
import { ManualClock } from "@keel/core";
import { createSqliteDataStore, seedSyntheticMarketSeries } from "@keel/data";
import { SpecStrategy, type StrategySpecV1 } from "@keel/spec";
import { ReplayEngine } from "../src/index.js";

const HOUR = 3_600_000;
const ALWAYS = {
  type: "comparison",
  op: ">",
  left: { type: "constant", value: 1 },
  right: { type: "constant", value: 0 }
} as const;
const NEVER = { ...ALWAYS, op: "<" } as const;

/** Goes long on every bar with a wide stop and target, so only the exits under test end trades. */
function spec(risk: Partial<StrategySpecV1["risk"]>): StrategySpecV1 {
  return {
    name: "exit-test",
    version: 1,
    description: "Always long; exits under test.",
    timeframe: "1H",
    lookbacks: { "1H": 30 },
    indicators: [],
    rules: { longEntry: ALWAYS, shortEntry: NEVER },
    risk: {
      stopModel: { kind: "atr_multiple", multiplier: 8, atrPeriod: 14 },
      takeProfit: { rewardMultiple: 10 },
      ...risk
    },
    cooldownBars: 0
  };
}

function replay(strategySpec: StrategySpecV1) {
  const clock = new ManualClock(1_700_000_000_000);
  const store = createSqliteDataStore({ dbPath: ":memory:", clock });
  const seeded = seedSyntheticMarketSeries({
    marketDataRepo: store.marketDataRepo,
    instrumentId: "BTC-USDT-SWAP",
    endCloseTs: 1_700_000_000_000,
    barCount1H: 600
  });
  const engine = new ReplayEngine({ marketDataRepo: store.marketDataRepo, clock });
  const result = engine.run({
    instrumentId: "BTC-USDT-SWAP",
    timeframe: "1H",
    strategy: new SpecStrategy(strategySpec),
    fromTs: seeded.fromTs + 40 * HOUR,
    toTs: seeded.toTs,
    replayMinTrades: 1
  });
  store.close();
  return result;
}

describe("Exits in the replay", () => {
  it("ends every trade at its time limit, at that bar's close", () => {
    const result = replay(spec({ timeStopBars: 5 }));
    const timed = result.trades.filter((t) => t.exitReason === "time-stop");
    expect(timed.length).toBeGreaterThan(10);
    for (const t of timed) {
      // Entered at a bar's open, out at the close of the fifth bar held
      expect(t.exitTs - t.entryTs).toBe(5 * HOUR);
    }
    expect(result.trades.every((t) => t.exitTs - t.entryTs <= 5 * HOUR)).toBe(true);
  });

  it("trails the stop only towards safety, so winners lock in gains", () => {
    const fixed = replay(spec({}));
    const trailed = replay(spec({ trailingStop: { atrMultiple: 1.5, atrPeriod: 14 } }));
    // A tight trail ends trades far sooner than the 8-ATR fixed stop
    expect(trailed.trades.length).toBeGreaterThan(fixed.trades.length);
    // Some stops were ratcheted past the entry: those trades closed in profit by the stop
    const lockedIn = trailed.trades.filter(
      (t) => t.exitReason === "stop" && t.protectiveStopPrice.gt(t.entryPrice)
    );
    expect(lockedIn.length).toBeGreaterThan(0);
    for (const t of lockedIn) expect(t.grossPnlUsdt.isPositive()).toBe(true);
  });
});
