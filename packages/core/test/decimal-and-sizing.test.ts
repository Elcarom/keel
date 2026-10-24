import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ManualClock,
  ScaledDecimal,
  SystemClock,
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
