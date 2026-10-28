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

export const INSTRUMENT_SPECS: Readonly<Record<string, InstrumentSpec>> = {
  "BTC-USDT-SWAP": {
    instrumentId: "BTC-USDT-SWAP",
    venue: "OKX_EEA",
    baseCurrency: "BTC",
    settlementCurrency: "USDT",
    contractValue: ScaledDecimal.fromString("0.01"),
    lotSize: ScaledDecimal.fromString("0.01"),
    minOrderSize: ScaledDecimal.fromString("0.01"),
    tickSize: ScaledDecimal.fromString("0.1"),
    maxLeverage: ScaledDecimal.fromString("3")
  },
  "ETH-USDT-SWAP": {
    instrumentId: "ETH-USDT-SWAP",
    venue: "OKX_EEA",
    baseCurrency: "ETH",
    settlementCurrency: "USDT",
    contractValue: ScaledDecimal.fromString("0.1"),
    lotSize: ScaledDecimal.fromString("0.1"),
    minOrderSize: ScaledDecimal.fromString("0.1"),
    tickSize: ScaledDecimal.fromString("0.01"),
    maxLeverage: ScaledDecimal.fromString("3")
  },
  // Paper-only instruments for Fleet boats (contract specs from OKX public instruments, 2026-10)
  "SOL-USDT-SWAP": {
    instrumentId: "SOL-USDT-SWAP",
    venue: "OKX_EEA",
    baseCurrency: "SOL",
    settlementCurrency: "USDT",
    contractValue: ScaledDecimal.fromString("1"),
    lotSize: ScaledDecimal.fromString("0.01"),
    minOrderSize: ScaledDecimal.fromString("0.01"),
    tickSize: ScaledDecimal.fromString("0.01"),
    maxLeverage: ScaledDecimal.fromString("3")
  },
  "XRP-USDT-SWAP": {
    instrumentId: "XRP-USDT-SWAP",
    venue: "OKX_EEA",
    baseCurrency: "XRP",
    settlementCurrency: "USDT",
    contractValue: ScaledDecimal.fromString("100"),
    lotSize: ScaledDecimal.fromString("0.01"),
    minOrderSize: ScaledDecimal.fromString("0.01"),
    tickSize: ScaledDecimal.fromString("0.0001"),
    maxLeverage: ScaledDecimal.fromString("3")
  },
  "DOGE-USDT-SWAP": {
    instrumentId: "DOGE-USDT-SWAP",
    venue: "OKX_EEA",
    baseCurrency: "DOGE",
    settlementCurrency: "USDT",
    contractValue: ScaledDecimal.fromString("1000"),
    lotSize: ScaledDecimal.fromString("0.01"),
    minOrderSize: ScaledDecimal.fromString("0.01"),
    tickSize: ScaledDecimal.fromString("0.00001"),
    maxLeverage: ScaledDecimal.fromString("3")
  },
  "BNB-USDT-SWAP": {
    instrumentId: "BNB-USDT-SWAP",
    venue: "OKX_EEA",
    baseCurrency: "BNB",
    settlementCurrency: "USDT",
    contractValue: ScaledDecimal.fromString("0.01"),
    lotSize: ScaledDecimal.fromString("1"),
    minOrderSize: ScaledDecimal.fromString("1"),
    tickSize: ScaledDecimal.fromString("0.01"),
    maxLeverage: ScaledDecimal.fromString("3")
  },
  "ADA-USDT-SWAP": {
    instrumentId: "ADA-USDT-SWAP",
    venue: "OKX_EEA",
    baseCurrency: "ADA",
    settlementCurrency: "USDT",
    contractValue: ScaledDecimal.fromString("100"),
    lotSize: ScaledDecimal.fromString("0.1"),
    minOrderSize: ScaledDecimal.fromString("0.1"),
    tickSize: ScaledDecimal.fromString("0.0001"),
    maxLeverage: ScaledDecimal.fromString("3")
  },
  "AVAX-USDT-SWAP": {
    instrumentId: "AVAX-USDT-SWAP",
    venue: "OKX_EEA",
    baseCurrency: "AVAX",
    settlementCurrency: "USDT",
    contractValue: ScaledDecimal.fromString("1"),
    lotSize: ScaledDecimal.fromString("0.1"),
    minOrderSize: ScaledDecimal.fromString("0.1"),
    tickSize: ScaledDecimal.fromString("0.001"),
    maxLeverage: ScaledDecimal.fromString("3")
  },
  "LINK-USDT-SWAP": {
    instrumentId: "LINK-USDT-SWAP",
    venue: "OKX_EEA",
    baseCurrency: "LINK",
    settlementCurrency: "USDT",
    contractValue: ScaledDecimal.fromString("1"),
    lotSize: ScaledDecimal.fromString("0.1"),
    minOrderSize: ScaledDecimal.fromString("0.1"),
    tickSize: ScaledDecimal.fromString("0.001"),
    maxLeverage: ScaledDecimal.fromString("3")
  },
  "LTC-USDT-SWAP": {
    instrumentId: "LTC-USDT-SWAP",
    venue: "OKX_EEA",
    baseCurrency: "LTC",
    settlementCurrency: "USDT",
    contractValue: ScaledDecimal.fromString("1"),
    lotSize: ScaledDecimal.fromString("0.1"),
    minOrderSize: ScaledDecimal.fromString("0.1"),
    tickSize: ScaledDecimal.fromString("0.01"),
    maxLeverage: ScaledDecimal.fromString("3")
  }
};

/**
 * The instruments the exchange broker may trade. Every other spec above is paper-only: widening
 * this list is an exchange capability change and goes through Gate G2.
 */
export const EXCHANGE_INSTRUMENT_IDS: readonly string[] = ["BTC-USDT-SWAP", "ETH-USDT-SWAP"];

/** The spec for an exchange order or position; refuses paper-only instruments. */
export function getExchangeInstrumentSpec(instrumentId: string): InstrumentSpec {
  if (!EXCHANGE_INSTRUMENT_IDS.includes(instrumentId)) {
    throw new Error(
      `${instrumentId} is paper-only: exchange orders are limited to ${EXCHANGE_INSTRUMENT_IDS.join(", ")}`
    );
  }
  return getInstrumentSpec(instrumentId);
}

export function getInstrumentSpec(instrumentId: string): InstrumentSpec {
  const spec = INSTRUMENT_SPECS[instrumentId];
  if (!spec) {
    throw new Error(`Unsupported instrument: ${instrumentId}. Explicit InstrumentSpec required.`);
  }
  return spec;
}

export function defaultInstrumentSpec(instrumentId: string): InstrumentSpec {
  return getInstrumentSpec(instrumentId);
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
  /** Optional fractional scaling factor for Live-Ramp ladder (e.g. 0.10, 0.25, 0.50, 1.00). */
  readonly allocationFraction?: ScaledDecimal | undefined;
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

  let riskBudgetQuote = strategyEquityQuote.mul(riskFraction);
  const effectiveMaxLev = ScaledDecimal.min(maxGrossLeverage, instrument.maxLeverage);
  let maxNotionalQuote = strategyEquityQuote.mul(effectiveMaxLev);

  if (input.allocationFraction && input.allocationFraction.isPositive()) {
    riskBudgetQuote = riskBudgetQuote.mul(input.allocationFraction);
    maxNotionalQuote = maxNotionalQuote.mul(input.allocationFraction);
  }

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
