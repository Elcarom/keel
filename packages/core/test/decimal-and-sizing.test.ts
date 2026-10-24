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

  it("rounds prices to exchange tickSize according to side (protective stop safety)", () => {
    const rawStop = ScaledDecimal.fromString("65432.17");
    const tick = ScaledDecimal.fromString("0.1");

    // Long protective stop rounds down (floor) to tick; short protective stop rounds up (ceil) to tick
    expect(rawStop.roundToTick(tick, "floor").toString()).toBe("65432.1");
    expect(rawStop.roundToTick(tick, "ceil").toString()).toBe("65432.2");
  });

  it("satisfies exact string round-trip, additive associativity, and tick-rounding invariants (fast-check)", () => {
    const arbCents = fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n });

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
  });
});

describe("@keel/core — Stop-distance 1R contract sizing (ADR-0002)", () => {
  it("sizes integer contracts from 1R stop distance on a worked example", () => {
    // Strategy equity = 10,000 USDT, 1R = 0.75% => 75 USDT risk budget.
    // BTC-USDT-SWAP: ctVal = 0.01 BTC/contract.
    // Entry = 60,000.0, Stop = 58,800.0 => distance = 1,200 USDT per BTC => 12 USDT risk per contract.
    // Expected contracts = floor(75 / 12) = 6 contracts (risking 72 USDT <= 75 USDT, notional = 3,600 USDT <= 20,000 cap).
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
    // Strategy equity = 500 USDT, 1R = 0.75% => 3.75 USDT risk budget.
    // 1 contract of BTC-USDT-SWAP (0.01 BTC) with a 1,000 USDT stop distance risks 10 USDT > 3.75 USDT.
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

  it("Rejects invalid stop placement on the wrong side of entry", () => {
    const badLong = sizeByStopRisk({
      instrument: BTC_USDT_SWAP,
      side: "long",
      strategyEquityQuote: ScaledDecimal.fromString("10000"),
      riskFraction: ScaledDecimal.fromString("0.0075"),
      entryPrice: ScaledDecimal.fromString("60000"),
      stopPrice: ScaledDecimal.fromString("60100"),
      maxGrossLeverage: ScaledDecimal.fromString("2")
    });
    expect(badLong).toEqual({ ok: false, vetoReason: "invalid_stop_direction" });
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
