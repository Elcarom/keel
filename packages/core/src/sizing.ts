import { ScaledDecimal } from "./decimal.js";

export type VenueId = "OKX_EEA";
export type PositionSide = "long" | "short";

/**
 * Normalized linear quote-settled perpetual swap contract specification (ADR-0001).
 */
export interface InstrumentSpec {
  readonly instrumentId: string;
  readonly venue: VenueId;
  readonly baseCurrency: string;
  readonly settlementCurrency: "USDT" | "USDC";
  /** Base asset quantity per 1 contract (ctVal on OKX). */
  readonly contractValue: ScaledDecimal;
  /** Minimum contract increment (lotSz on OKX). */
  readonly lotSize: ScaledDecimal;
  /** Minimum order size in contracts (minSz on OKX). */
  readonly minOrderSize: ScaledDecimal;
  /** Minimum price tick increment (tickSz on OKX). */
  readonly tickSize: ScaledDecimal;
  /** Maximum isolated leverage allowed by strategy/instrument policy. */
  readonly maxLeverage: ScaledDecimal;
}

export interface StopRiskSizingInput {
  readonly instrument: InstrumentSpec;
  readonly side: PositionSide;
  readonly strategyEquityQuote: ScaledDecimal;
  /** Fraction of strategy equity risked per trade (e.g., 0.0075 for 0.75% = 1R). */
  readonly riskFraction: ScaledDecimal;
  readonly entryPrice: ScaledDecimal;
  readonly stopPrice: ScaledDecimal;
  readonly maxGrossLeverage: ScaledDecimal;
}

export type SizingVetoReason =
  | "non_positive_equity"
  | "non_positive_risk_fraction"
  | "invalid_stop_direction"
  | "min_lot_exceeds_risk_cap"
  | "min_lot_exceeds_leverage_cap";

export type StopRiskSizingResult =
  | {
      readonly ok: true;
      readonly contracts: ScaledDecimal;
      readonly riskBudgetQuote: ScaledDecimal;
      readonly sizedRiskQuote: ScaledDecimal;
      readonly notionalQuote: ScaledDecimal;
      readonly effectiveStopPrice: ScaledDecimal;
    }
  | {
      readonly ok: false;
      readonly vetoReason: SizingVetoReason;
    };

/**
 * Deterministically computes integer/lot-aligned contract size from stop distance (1R)
 * bounded by both risk budget and max gross leverage (ADR-0002).
 * Vetoes rather than rounding up if 1 minimum order lot exceeds the 1R budget.
 */
export function sizeByStopRisk(input: StopRiskSizingInput): StopRiskSizingResult {
  const {
    instrument,
    side,
    strategyEquityQuote,
    riskFraction,
    entryPrice,
    stopPrice,
    maxGrossLeverage
  } = input;

  if (!strategyEquityQuote.isPositive()) {
    return { ok: false, vetoReason: "non_positive_equity" };
  }

  if (!riskFraction.isPositive()) {
    return { ok: false, vetoReason: "non_positive_risk_fraction" };
  }

  // Round protective stop conservatively to tick (away from entry so stop loss is never optimistic)
  const effectiveStopPrice =
    side === "long"
      ? stopPrice.roundToTick(instrument.tickSize, "floor")
      : stopPrice.roundToTick(instrument.tickSize, "ceil");

  if (!entryPrice.isPositive() || !effectiveStopPrice.isPositive()) {
    return { ok: false, vetoReason: "invalid_stop_direction" };
  }

  if (side === "long" && !effectiveStopPrice.lt(entryPrice)) {
    return { ok: false, vetoReason: "invalid_stop_direction" };
  }
  if (side === "short" && !effectiveStopPrice.gt(entryPrice)) {
    return { ok: false, vetoReason: "invalid_stop_direction" };
  }

  const priceDistance = entryPrice.sub(effectiveStopPrice).abs();
  const riskPerContractQuote = instrument.contractValue.mul(priceDistance);
  const notionalPerContractQuote = instrument.contractValue.mul(entryPrice);

  if (!riskPerContractQuote.isPositive() || !notionalPerContractQuote.isPositive()) {
    return { ok: false, vetoReason: "invalid_stop_direction" };
  }

  const riskBudgetQuote = strategyEquityQuote.mul(riskFraction);
  const effectiveMaxLev = ScaledDecimal.min(maxGrossLeverage, instrument.maxLeverage);
  const maxNotionalQuote = strategyEquityQuote.mul(effectiveMaxLev);

  const rawByRisk = riskBudgetQuote
    .divFloor(riskPerContractQuote)
    .roundDownToLot(instrument.lotSize);
  const rawByLeverage = maxNotionalQuote
    .divFloor(notionalPerContractQuote)
    .roundDownToLot(instrument.lotSize);

  if (rawByRisk.lt(instrument.minOrderSize)) {
    return { ok: false, vetoReason: "min_lot_exceeds_risk_cap" };
  }

  if (rawByLeverage.lt(instrument.minOrderSize)) {
    return { ok: false, vetoReason: "min_lot_exceeds_leverage_cap" };
  }

  const contracts = ScaledDecimal.min(rawByRisk, rawByLeverage);
  const sizedRiskQuote = contracts.mul(riskPerContractQuote);
  const notionalQuote = contracts.mul(notionalPerContractQuote);

  return {
    ok: true,
    contracts,
    riskBudgetQuote,
    sizedRiskQuote,
    notionalQuote,
    effectiveStopPrice
  };
}
