import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ManualClock,
  ScaledDecimal,
  SystemClock,
  EXCHANGE_INSTRUMENT_IDS,
  defaultInstrumentSpec,
  getExchangeInstrumentSpec,
  getInstrumentSpec,
  sizeByStopRisk,
  type InstrumentSpec
} from "../src/index.js";

const BTC_USDT_SWAP: InstrumentSpec = {
  instrumentId: "BTC-USDT-SWAP",
  venue: "OKX_EEA",
  baseCurrency: "BTC",
  settlementCurrency: "USDT",
  contractValue: ScaledDecimal.fromString("0.01"),
  lotSize: ScaledDecimal.fromString("1"),
  minOrderSize: ScaledDecimal.fromString("1"),
  tickSize: ScaledDecimal.fromString("0.1"),
  maxLeverage: ScaledDecimal.fromString("2")
};

describe("@keel/core — ScaledDecimal fixed-point arithmetic", () => {
  it("eliminates IEEE-754 float drift on classic decimal additions (0.1 + 0.2 === 0.3)", () => {
    const a = ScaledDecimal.fromString("0.1");
    const b = ScaledDecimal.fromString("0.2");
    expect(a.add(b).toString()).toBe("0.3");
  });

  it("rounds prices to exchange tickSize and quantities to lotSize", () => {
    const rawStop = ScaledDecimal.fromString("65432.17");
    const tick = ScaledDecimal.fromString("0.1");

    expect(rawStop.roundToTick(tick, "floor").toString()).toBe("65432.1");
    expect(rawStop.roundToTick(tick, "ceil").toString()).toBe("65432.2");

    const rawQty = ScaledDecimal.fromString("14.95");
    const lot = ScaledDecimal.fromString("1");
    expect(rawQty.roundDownToLot(lot).toString()).toBe("14");
  });

  it("rounds venue rates with more than 8 decimals half away from zero", () => {
    expect(ScaledDecimal.fromStringRounded("0.0000892989172342").toString()).toBe("0.0000893");
    expect(ScaledDecimal.fromStringRounded("0.0000892949999999").toString()).toBe("0.00008929");
    expect(ScaledDecimal.fromStringRounded("-0.0000123450000001").toString()).toBe("-0.00001235");
    expect(ScaledDecimal.fromStringRounded("-0.000000004").toString()).toBe("0");
    expect(ScaledDecimal.fromStringRounded("0.0001").toString()).toBe("0.0001");
    expect(() => ScaledDecimal.fromStringRounded("1e-5")).toThrow(/Invalid/);
  });

  it("satisfies exact string round-trip, additive associativity, mul/divFloor, and tick/lot rounding invariants (fast-check)", () => {
    const arbCents = fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n });
    const arbPos = fc.bigInt({ min: 1n, max: 1_000_000_000_000n });

    fc.assert(
      fc.property(arbCents, arbCents, arbCents, (xRaw, yRaw, zRaw) => {
        const x = ScaledDecimal.fromScaledBigInt(xRaw);
        const y = ScaledDecimal.fromScaledBigInt(yRaw);
        const z = ScaledDecimal.fromScaledBigInt(zRaw);

        // String round-trip preserves exact value
        expect(ScaledDecimal.fromString(x.toString()).equals(x)).toBe(true);

        // Associativity: (x + y) + z === x + (y + z)
        expect(
          x
            .add(y)
            .add(z)
            .equals(x.add(y.add(z)))
        ).toBe(true);

        // Identity: (x + y) - y === x
        expect(x.add(y).sub(y).equals(x)).toBe(true);
      })
    );

    const tick = ScaledDecimal.fromString("0.1");
    const lot = ScaledDecimal.fromString("0.5");

    fc.assert(
      fc.property(arbPos, (posRaw) => {
        const val = ScaledDecimal.fromScaledBigInt(posRaw);
        const flooredTick = val.roundToTick(tick, "floor");
        const ceiledTick = val.roundToTick(tick, "ceil");

        expect(flooredTick.lte(val)).toBe(true);
        expect(ceiledTick.gte(val)).toBe(true);
        expect(ceiledTick.sub(flooredTick).lte(tick)).toBe(true);

        const roundedLot = val.roundDownToLot(lot);
        expect(roundedLot.lte(val)).toBe(true);
        expect(val.sub(roundedLot).lt(lot)).toBe(true);

        const doubled = val.mul(ScaledDecimal.fromString("2"));
        expect(doubled.divFloor(ScaledDecimal.fromString("2")).equals(val)).toBe(true);
      })
    );
  });
});

describe("@keel/core — Stop-distance 1R contract sizing (ADR-0002)", () => {
  it("sizes integer contracts from 1R stop distance on a worked example", () => {
    const result = sizeByStopRisk({
      instrument: BTC_USDT_SWAP,
      side: "long",
      strategyEquityQuote: ScaledDecimal.fromString("10000"),
      riskFraction: ScaledDecimal.fromString("0.0075"),
      entryPrice: ScaledDecimal.fromString("60000"),
      stopPrice: ScaledDecimal.fromString("58800"),
      maxGrossLeverage: ScaledDecimal.fromString("2")
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contracts.toString()).toBe("6");
      expect(result.riskBudgetQuote.toString()).toBe("75");
      expect(result.sizedRiskQuote.toString()).toBe("72");
      expect(result.notionalQuote.toString()).toBe("3600");
    }
  });

  it("vetoes with min_lot_exceeds_risk_cap when 1 minimum lot risks more than 1R (small account guard)", () => {
    const result = sizeByStopRisk({
      instrument: BTC_USDT_SWAP,
      side: "long",
      strategyEquityQuote: ScaledDecimal.fromString("500"),
      riskFraction: ScaledDecimal.fromString("0.0075"),
      entryPrice: ScaledDecimal.fromString("60000"),
      stopPrice: ScaledDecimal.fromString("59000"),
      maxGrossLeverage: ScaledDecimal.fromString("2")
    });

    expect(result).toEqual({
      ok: false,
      vetoReason: "min_lot_exceeds_risk_cap"
    });
  });

  it("distinguishes non_positive_equity, non_positive_risk_fraction, and invalid_stop_direction", () => {
    expect(
      sizeByStopRisk({
        instrument: BTC_USDT_SWAP,
        side: "long",
        strategyEquityQuote: ScaledDecimal.zero(),
        riskFraction: ScaledDecimal.fromString("0.0075"),
        entryPrice: ScaledDecimal.fromString("60000"),
        stopPrice: ScaledDecimal.fromString("59000"),
        maxGrossLeverage: ScaledDecimal.fromString("2")
      })
    ).toEqual({ ok: false, vetoReason: "non_positive_equity" });

    expect(
      sizeByStopRisk({
        instrument: BTC_USDT_SWAP,
        side: "long",
        strategyEquityQuote: ScaledDecimal.fromString("10000"),
        riskFraction: ScaledDecimal.zero(),
        entryPrice: ScaledDecimal.fromString("60000"),
        stopPrice: ScaledDecimal.fromString("59000"),
        maxGrossLeverage: ScaledDecimal.fromString("2")
      })
    ).toEqual({ ok: false, vetoReason: "non_positive_risk_fraction" });

    expect(
      sizeByStopRisk({
        instrument: BTC_USDT_SWAP,
        side: "long",
        strategyEquityQuote: ScaledDecimal.fromString("10000"),
        riskFraction: ScaledDecimal.fromString("0.0075"),
        entryPrice: ScaledDecimal.fromString("60000"),
        stopPrice: ScaledDecimal.fromString("60100"),
        maxGrossLeverage: ScaledDecimal.fromString("2")
      })
    ).toEqual({ ok: false, vetoReason: "invalid_stop_direction" });
  });

  it("never exceeds 1R risk or maxGrossLeverage across arbitrary prices, stops, and equities (fast-check)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 500, max: 100_000 }),
        fc.integer({ min: 10_000, max: 100_000 }),
        fc.integer({ min: 50, max: 5_000 }),
        fc.constantFrom("long" as const, "short" as const),
        (equityInt, entryInt, stopDeltaInt, side) => {
          const equity = ScaledDecimal.fromString(String(equityInt));
          const entry = ScaledDecimal.fromString(String(entryInt));
          const delta = ScaledDecimal.fromString(String(stopDeltaInt));
          const stop = side === "long" ? entry.sub(delta) : entry.add(delta);
          if (!stop.isPositive()) return;

          const riskFrac = ScaledDecimal.fromString("0.0075");
          const maxLev = ScaledDecimal.fromString("2");

          const res = sizeByStopRisk({
            instrument: BTC_USDT_SWAP,
            side,
            strategyEquityQuote: equity,
            riskFraction: riskFrac,
            entryPrice: entry,
            stopPrice: stop,
            maxGrossLeverage: maxLev
          });

          const maxRiskBudget = equity.mul(riskFrac);
          const maxNotional = equity.mul(maxLev);

          if (res.ok) {
            expect(res.sizedRiskQuote.lte(maxRiskBudget)).toBe(true);
            expect(res.notionalQuote.lte(maxNotional)).toBe(true);
            expect(res.contracts.gte(BTC_USDT_SWAP.minOrderSize)).toBe(true);
          }
        }
      )
    );
  });
});

describe("@keel/core — Injected Clock port", () => {
  it("ManualClock advances deterministically and SystemClock reads current wall time", () => {
    const manual = new ManualClock(1_700_000_000_000);
    expect(manual.nowMs()).toBe(1_700_000_000_000);
    expect(manual.isoNow()).toBe("2023-11-14T22:13:20.000Z");

    manual.advanceMs(60_000);
    expect(manual.nowMs()).toBe(1_700_000_060_000);

    const sys = new SystemClock();
    expect(sys.nowMs()).toBeGreaterThan(1_700_000_000_000);
  });
});

describe("@keel/core — Instrument specifications (M5)", () => {
  it("enforces explicit static specs for BTC and ETH and rejects unknown instruments", () => {
    const btc = getInstrumentSpec("BTC-USDT-SWAP");
    expect(btc.contractValue.toString()).toBe("0.01");
    expect(btc.lotSize.toString()).toBe("0.01");
    expect(btc.tickSize.toString()).toBe("0.1");
    expect(btc.minOrderSize.toString()).toBe("0.01");

    const eth = getInstrumentSpec("ETH-USDT-SWAP");
    expect(eth.contractValue.toString()).toBe("0.1");
    expect(eth.lotSize.toString()).toBe("0.1");
    expect(eth.tickSize.toString()).toBe("0.01");
    expect(eth.minOrderSize.toString()).toBe("0.1");

    // defaultInstrumentSpec delegates to getInstrumentSpec
    expect(defaultInstrumentSpec("BTC-USDT-SWAP")).toEqual(btc);

    // Instruments without an explicit spec must not silently default to ctVal 0.01
    expect(() => getInstrumentSpec("PEPE-USDT-SWAP")).toThrow(/Unsupported instrument/);
    expect(() => defaultInstrumentSpec("PEPE-USDT-SWAP")).toThrow(/Unsupported instrument/);

    // Paper-only Fleet instruments carry OKX's own contract specs
    const sol = getInstrumentSpec("SOL-USDT-SWAP");
    expect(sol.contractValue.toString()).toBe("1");
    expect(sol.tickSize.toString()).toBe("0.01");
    const doge = getInstrumentSpec("DOGE-USDT-SWAP");
    expect(doge.contractValue.toString()).toBe("1000");
    expect(doge.tickSize.toString()).toBe("0.00001");

    // ...but the exchange broker only ever sees BTC and ETH
    expect(EXCHANGE_INSTRUMENT_IDS).toEqual(["BTC-USDT-SWAP", "ETH-USDT-SWAP"]);
    expect(getExchangeInstrumentSpec("ETH-USDT-SWAP")).toEqual(eth);
    expect(() => getExchangeInstrumentSpec("SOL-USDT-SWAP")).toThrow(/paper-only/);

    // Verify fractional contract lot sizing with production static specs
    const btcSizing = sizeByStopRisk({
      instrument: btc,
      side: "long",
      strategyEquityQuote: ScaledDecimal.fromString("10000"),
      riskFraction: ScaledDecimal.fromString("0.0075"), // $75 risk budget
      entryPrice: ScaledDecimal.fromString("60000"),
      stopPrice: ScaledDecimal.fromString("58800"), // delta $1200
      maxGrossLeverage: ScaledDecimal.fromString("2")
    });
    expect(btcSizing.ok).toBe(true);
    if (btcSizing.ok) {
      // 1 contract = 0.01 BTC = $600 notional. Risk per contract = $12.
      // Contracts = floor(75 / 12) = 6.25 contracts (aligned to 0.01 lot size).
      expect(btcSizing.contracts.toString()).toBe("6.25");
      expect(btcSizing.notionalQuote.toString()).toBe("3750");
    }

    const ethSizing = sizeByStopRisk({
      instrument: eth,
      side: "long",
      strategyEquityQuote: ScaledDecimal.fromString("10000"),
      riskFraction: ScaledDecimal.fromString("0.0075"), // $75 risk budget
      entryPrice: ScaledDecimal.fromString("3000"),
      stopPrice: ScaledDecimal.fromString("2900"), // delta $100
      maxGrossLeverage: ScaledDecimal.fromString("2")
    });
    expect(ethSizing.ok).toBe(true);
    if (ethSizing.ok) {
      // 1 contract = 0.1 ETH = $300 notional. Risk per contract = $10.
      // Contracts = floor(75 / 10) = 7.5 contracts (aligned to 0.1 lot size).
      expect(ethSizing.contracts.toString()).toBe("7.5");
      expect(ethSizing.notionalQuote.toString()).toBe("2250");
    }
  });
});
