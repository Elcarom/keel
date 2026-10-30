import { describe, expect, it } from "vitest";
import {
  ManualClock,
  ScaledDecimal,
  defaultInstrumentSpec,
  normalizeBlueprint,
  type BotBlueprintDraftInput,
  type RawOkxCandlePayload
} from "@keel/core";
import { createSqliteDataStore, type SqliteDataStore } from "@keel/data";
import { SpecStrategy, compileBlueprint } from "@keel/spec";
import { runPairReplay } from "../src/index.js";

const HOUR = 3_600_000;
// Ends before the sealed holdouts
const END = 1_700_000_000_000 - (1_700_000_000_000 % HOUR);
const BARS = 900;

/**
 * BTC wanders; ETH follows it, except that every 60 hours ETH lags BTC by 5% for six hours and
 * then catches up. A pair that fades the gap has something to trade.
 */
function seedPair(store: SqliteDataStore): void {
  const start = END - BARS * HOUR;
  const btc: RawOkxCandlePayload[] = [];
  const eth: RawOkxCandlePayload[] = [];
  const candle = (openTs: number, open: number, close: number): RawOkxCandlePayload => ({
    openTs,
    open: open.toFixed(2),
    high: (Math.max(open, close) * 1.003).toFixed(2),
    low: (Math.min(open, close) * 0.997).toFixed(2),
    close: close.toFixed(2),
    volumeContracts: "100",
    volumeQuote: (100 * close).toFixed(2),
    confirm: "1"
  });
  let prevBtc = 60_000;
  let prevEth = 3_000;
  for (let i = 0; i < BARS; i++) {
    const btcClose = 60_000 * (1 + 0.04 * Math.sin(i / 40) + 0.004 * Math.sin(i * 1.7));
    const gap = i % 60 < 6 ? -0.05 : 0;
    const ethClose = (btcClose / 20) * (1 + gap + 0.003 * Math.cos(i * 2.3));
    btc.push(candle(start + i * HOUR, prevBtc, btcClose));
    eth.push(candle(start + i * HOUR, prevEth, ethClose));
    prevBtc = btcClose;
    prevEth = ethClose;
  }
  store.marketDataRepo.ingestOkxCandles({
    instrumentId: "BTC-USDT-SWAP",
    timeframe: "1H",
    candles: btc
  });
  store.marketDataRepo.ingestOkxCandles({
    instrumentId: "ETH-USDT-SWAP",
    timeframe: "1H",
    candles: eth
  });
}

function pairBlueprint(changes: Partial<BotBlueprintDraftInput> = {}) {
  return normalizeBlueprint({
    name: "Catamaran",
    tagline: "Two hulls.",
    archetype: "pair_reversion",
    instrumentId: "ETH-USDT-SWAP",
    pairWith: "BTC-USDT-SWAP",
    direction: "both",
    lookbackPeriod: 48,
    fastPeriod: 12,
    entryThreshold: 1.8,
    stopAtrMultiple: 3,
    rewardMultiple: 2,
    rationale: "Test pair.",
    ...changes
  });
}

function replayPair(changes: Partial<BotBlueprintDraftInput> = {}) {
  const store = createSqliteDataStore({ dbPath: ":memory:", clock: new ManualClock(END) });
  seedPair(store);
  const b = pairBlueprint(changes);
  const result = runPairReplay(store.marketDataRepo, {
    legs: [
      { instrumentId: "ETH-USDT-SWAP", strategy: new SpecStrategy(compileBlueprint(b, "pair", 0)) },
      { instrumentId: "BTC-USDT-SWAP", strategy: new SpecStrategy(compileBlueprint(b, "pair", 1)) }
    ],
    fromTs: END - (BARS - 60) * HOUR,
    toTs: END,
    initialEquityUsdt: ScaledDecimal.fromString("10000"),
    riskFractionPerTrade: 0.01,
    maxGrossLeverage: 3,
    costStressMultiplier: 2,
    walkForwardFolds: 2,
    numTrials: 1,
    randomEntryPaths: 50,
    seed: 7
  });
  store.close();
  return result;
}

const notional = (
  instrumentId: string,
  price: { toString(): string },
  contracts: { toString(): string }
) =>
  Number(price.toString()) *
  Number(contracts.toString()) *
  Number(defaultInstrumentSpec(instrumentId).contractValue.toString());

describe("Pair replay", () => {
  it("buys the lagging coin and sells the other, both legs together and the same size", () => {
    const result = replayPair();
    expect(result.totalTrades).toBeGreaterThan(5);
    for (const trade of result.trades) {
      expect(trade.legs).toHaveLength(2);
      const [eth, btc] = [
        trade.legs.find((l) => l.instrumentId === "ETH-USDT-SWAP"),
        trade.legs.find((l) => l.instrumentId === "BTC-USDT-SWAP")
      ];
      expect(eth && btc).toBeTruthy();
      if (!eth || !btc) continue;
      // Opposite sides, entered on the same bar, and the trade's side is the first leg's
      expect(eth.side).not.toBe(btc.side);
      expect(eth.entryTs).toBe(btc.entryTs);
      expect(trade.side).toBe(eth.side);
      // The same stop distance on both legs gives (within lot rounding) the same notional
      const a = notional(eth.instrumentId, eth.entryPrice, eth.contracts);
      const b = notional(btc.instrumentId, btc.entryPrice, btc.contracts);
      expect(Math.abs(a - b) / Math.max(a, b)).toBeLessThan(0.05);
    }
    // ETH only ever lags here, so every pair buys ETH against BTC
    expect(result.trades.every((t) => t.side === "long")).toBe(true);
    // A market-neutral pair is judged against cash
    expect(result.buyAndHoldReturnPct).toBe(0);
  });

  it("never leaves one leg at sea: when a leg is stopped out, the other closes on that bar", () => {
    // Stops far tighter than the gap, so legs are stopped out on their own
    const result = replayPair({ stopAtrMultiple: 0.5 });
    const stopped = result.trades.filter((t) => t.legs.some((l) => l.exitReason === "stop"));
    expect(stopped.length).toBeGreaterThan(0);
    for (const trade of result.trades) {
      const exits = new Set(trade.legs.map((l) => l.exitTs));
      expect(exits.size).toBe(1);
      for (const leg of trade.legs) {
        expect([
          "stop",
          "take-profit",
          "signal-exit",
          "time-stop",
          "pair-leg",
          "end-of-replay"
        ]).toContain(leg.exitReason);
      }
    }
    expect(stopped.some((t) => t.legs.some((l) => l.exitReason === "pair-leg"))).toBe(true);
  });

  it("refuses to read the sealed holdout", () => {
    const store = createSqliteDataStore({ dbPath: ":memory:", clock: new ManualClock(END) });
    const b = pairBlueprint();
    expect(() =>
      runPairReplay(store.marketDataRepo, {
        legs: [
          {
            instrumentId: "ETH-USDT-SWAP",
            strategy: new SpecStrategy(compileBlueprint(b, "p", 0))
          },
          { instrumentId: "BTC-USDT-SWAP", strategy: new SpecStrategy(compileBlueprint(b, "p", 1)) }
        ],
        fromTs: 1_735_000_000_000,
        toTs: 1_740_000_000_000,
        initialEquityUsdt: ScaledDecimal.fromString("10000"),
        riskFractionPerTrade: 0.01,
        maxGrossLeverage: 3,
        costStressMultiplier: 2,
        walkForwardFolds: 0,
        numTrials: 1,
        randomEntryPaths: 0,
        seed: 1
      })
    ).toThrow(/holdout/);
    store.close();
  });
});
