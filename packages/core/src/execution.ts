import { ScaledDecimal } from "./decimal.js";

export interface NextBarOpenExecutionResult {
  readonly entryPrice: ScaledDecimal;
  readonly effectiveStopPrice: ScaledDecimal;
  readonly effectiveTpPrice: ScaledDecimal | null;
  readonly slippageAmount: ScaledDecimal;
}

/**
 * Computes the next-bar open fill price with adverse slippage and adjusts
 * protective stop and take-profit distances relative to the actual fill (ADR-0009).
 */
export function computeNextBarOpenEntry(params: {
  readonly side: "long" | "short";
  readonly barOpen: ScaledDecimal;
  readonly slippageBps: number;
  readonly proposedEntryPrice: ScaledDecimal;
  readonly proposedStopPrice: ScaledDecimal;
  readonly proposedTpPrice?: ScaledDecimal | null | undefined;
}): NextBarOpenExecutionResult {
  const slippageFraction = ScaledDecimal.fromString((params.slippageBps / 10_000).toFixed(8));
  const slippageAmount = params.barOpen.mul(slippageFraction);
  const entryPrice =
    params.side === "long"
      ? params.barOpen.add(slippageAmount)
      : params.barOpen.sub(slippageAmount);

  const stopDist =
    params.side === "long"
      ? params.proposedEntryPrice.sub(params.proposedStopPrice)
      : params.proposedStopPrice.sub(params.proposedEntryPrice);
  const effectiveStopPrice =
    params.side === "long" ? entryPrice.sub(stopDist) : entryPrice.add(stopDist);

  let effectiveTpPrice: ScaledDecimal | null = null;
  if (params.proposedTpPrice) {
    const tpDist =
      params.side === "long"
        ? params.proposedTpPrice.sub(params.proposedEntryPrice)
        : params.proposedEntryPrice.sub(params.proposedTpPrice);
    effectiveTpPrice = params.side === "long" ? entryPrice.add(tpDist) : entryPrice.sub(tpDist);
  }

  return {
    entryPrice,
    effectiveStopPrice,
    effectiveTpPrice,
    slippageAmount
  };
}

export interface IntrabarExitResult {
  readonly closed: boolean;
  readonly exitPrice: ScaledDecimal | null;
  readonly exitReason: "protective_stop" | "take_profit" | null;
}

/**
 * Evaluates intrabar high/low against attached protective stops and take-profit
 * orders with gap-aware fills (ADR-0009):
 * - Long stops fill at min(barOpen, stopPrice)
 * - Short stops fill at max(barOpen, stopPrice)
 * - Long take-profits fill at max(barOpen, tpPrice)
 * - Short take-profits fill at min(barOpen, tpPrice)
 */
export function evaluateIntrabarExit(params: {
  readonly side: "long" | "short";
  readonly barOpen: ScaledDecimal;
  readonly barHigh: ScaledDecimal;
  readonly barLow: ScaledDecimal;
  readonly stopPrice: ScaledDecimal;
  readonly tpPrice?: ScaledDecimal | null | undefined;
}): IntrabarExitResult {
  if (params.side === "long") {
    const stopHit = params.barLow.lte(params.stopPrice);
    const tpHit =
      params.tpPrice !== null && params.tpPrice !== undefined && params.barHigh.gte(params.tpPrice);
    if (stopHit) {
      return {
        closed: true,
        exitPrice: ScaledDecimal.min(params.barOpen, params.stopPrice),
        exitReason: "protective_stop"
      };
    } else if (tpHit && params.tpPrice) {
      return {
        closed: true,
        exitPrice: ScaledDecimal.max(params.barOpen, params.tpPrice),
        exitReason: "take_profit"
      };
    }
  } else {
    const stopHit = params.barHigh.gte(params.stopPrice);
    const tpHit =
      params.tpPrice !== null && params.tpPrice !== undefined && params.barLow.lte(params.tpPrice);
    if (stopHit) {
      return {
        closed: true,
        exitPrice: ScaledDecimal.max(params.barOpen, params.stopPrice),
        exitReason: "protective_stop"
      };
    } else if (tpHit && params.tpPrice) {
      return {
        closed: true,
        exitPrice: ScaledDecimal.min(params.barOpen, params.tpPrice),
        exitReason: "take_profit"
      };
    }
  }

  return {
    closed: false,
    exitPrice: null,
    exitReason: null
  };
}
