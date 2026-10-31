import { ScaledDecimal } from "./decimal.js";

/**
 * One cost model for every simulated fill, backtest and paper alike (ADR-0014, ADR-0035): a taker
 * fee and half the spread are charged as a fee on notional each side; slippage moves the fill price
 * and is never charged a second time as a fee.
 */
export const DEFAULT_EXECUTION_COSTS = {
  takerFeeBps: 5,
  halfSpreadBps: 2,
  slippageBps: 3
} as const;

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
  readonly rawExitPrice: ScaledDecimal | null;
  readonly slippageAmount: ScaledDecimal;
  readonly exitReason: "protective_stop" | "take_profit" | null;
}

/**
 * Evaluates intrabar high/low against attached protective stops and take-profit
 * orders with gap-aware fills (ADR-0009) and adverse exit slippage on stops (ADR-0014 / R1):
 * - Long stops fill at min(barOpen, stopPrice) with adverse slippage (price moves down)
 * - Short stops fill at max(barOpen, stopPrice) with adverse slippage (price moves up)
 * - Long take-profits fill at max(barOpen, tpPrice) with ZERO slippage (resting maker limit)
 * - Short take-profits fill at min(barOpen, tpPrice) with ZERO slippage (resting maker limit)
 */
export function evaluateIntrabarExit(params: {
  readonly side: "long" | "short";
  readonly barOpen: ScaledDecimal;
  readonly barHigh: ScaledDecimal;
  readonly barLow: ScaledDecimal;
  readonly stopPrice: ScaledDecimal;
  readonly tpPrice?: ScaledDecimal | null | undefined;
  readonly slippageBps?: number | undefined;
}): IntrabarExitResult {
  const slippageBps = params.slippageBps ?? 0;
  const slippageFraction = ScaledDecimal.fromString((slippageBps / 10_000).toFixed(8));

  if (params.side === "long") {
    const stopHit = params.barLow.lte(params.stopPrice);
    const tpHit =
      params.tpPrice !== null && params.tpPrice !== undefined && params.barHigh.gte(params.tpPrice);
    if (stopHit) {
      const rawExitPrice = ScaledDecimal.min(params.barOpen, params.stopPrice);
      const slippageAmount = rawExitPrice.mul(slippageFraction);
      const exitPrice = rawExitPrice.sub(slippageAmount);
      return {
        closed: true,
        exitPrice,
        rawExitPrice,
        slippageAmount,
        exitReason: "protective_stop"
      };
    } else if (tpHit && params.tpPrice) {
      const rawExitPrice = ScaledDecimal.max(params.barOpen, params.tpPrice);
      return {
        closed: true,
        exitPrice: rawExitPrice,
        rawExitPrice,
        slippageAmount: ScaledDecimal.zero(),
        exitReason: "take_profit"
      };
    }
  } else {
    const stopHit = params.barHigh.gte(params.stopPrice);
    const tpHit =
      params.tpPrice !== null && params.tpPrice !== undefined && params.barLow.lte(params.tpPrice);
    if (stopHit) {
      const rawExitPrice = ScaledDecimal.max(params.barOpen, params.stopPrice);
      const slippageAmount = rawExitPrice.mul(slippageFraction);
      const exitPrice = rawExitPrice.add(slippageAmount);
      return {
        closed: true,
        exitPrice,
        rawExitPrice,
        slippageAmount,
        exitReason: "protective_stop"
      };
    } else if (tpHit && params.tpPrice) {
      const rawExitPrice = ScaledDecimal.min(params.barOpen, params.tpPrice);
      return {
        closed: true,
        exitPrice: rawExitPrice,
        rawExitPrice,
        slippageAmount: ScaledDecimal.zero(),
        exitReason: "take_profit"
      };
    }
  }

  return {
    closed: false,
    exitPrice: null,
    rawExitPrice: null,
    slippageAmount: ScaledDecimal.zero(),
    exitReason: null
  };
}

/**
 * Computes market exit fill price with adverse slippage (ADR-0014 / R1).
 */
export function computeMarketExitPrice(params: {
  readonly side: "long" | "short";
  readonly marketPrice: ScaledDecimal;
  readonly slippageBps: number;
}): {
  readonly exitPrice: ScaledDecimal;
  readonly slippageAmount: ScaledDecimal;
} {
  const slippageFraction = ScaledDecimal.fromString((params.slippageBps / 10_000).toFixed(8));
  const slippageAmount = params.marketPrice.mul(slippageFraction);
  const exitPrice =
    params.side === "long"
      ? params.marketPrice.sub(slippageAmount)
      : params.marketPrice.add(slippageAmount);
  return { exitPrice, slippageAmount };
}

export interface TradePnLResult {
  readonly grossPnlUsdt: ScaledDecimal;
  readonly totalFeesUsdt: ScaledDecimal;
  readonly totalSlippageUsdt: ScaledDecimal;
  readonly netPnlUsdt: ScaledDecimal;
  readonly stressNetPnlUsdt: ScaledDecimal;
  readonly netR: number;
  readonly stressNetR: number;
}

/**
 * Computes realized trade PnL, R-multiple, and cost-stressed PnL (ADR-0014 / R1).
 * The cost stress multiplier scales BOTH trading fees and slippage:
 * extraStressCost = (costStressMultiplier - 1.0) * (totalFees + totalSlippage).
 */
export function computeTradePnL(params: {
  readonly side: "long" | "short";
  readonly entryPrice: ScaledDecimal;
  readonly exitPrice: ScaledDecimal;
  readonly contracts: ScaledDecimal;
  readonly contractValue: ScaledDecimal;
  readonly entryFeeUsdt: ScaledDecimal;
  readonly exitFeeUsdt: ScaledDecimal;
  readonly entrySlippageUsdt: ScaledDecimal;
  readonly exitSlippageUsdt: ScaledDecimal;
  readonly fundingAccruedUsdt: ScaledDecimal;
  readonly initialRiskUsdt: ScaledDecimal;
  readonly costStressMultiplier: number;
}): TradePnLResult {
  const baseQty = params.contracts.mul(params.contractValue);
  const priceDiff =
    params.side === "long"
      ? params.exitPrice.sub(params.entryPrice)
      : params.entryPrice.sub(params.exitPrice);
  const grossPnlUsdt = priceDiff.mul(baseQty);
  const totalFeesUsdt = params.entryFeeUsdt.add(params.exitFeeUsdt);
  const totalSlippageUsdt = params.entrySlippageUsdt.add(params.exitSlippageUsdt);
  const netPnlUsdt = grossPnlUsdt.sub(totalFeesUsdt).add(params.fundingAccruedUsdt);

  const extraMultiplier = Math.max(0, params.costStressMultiplier - 1.0);
  const extraMultiplierDec = ScaledDecimal.fromString(extraMultiplier.toFixed(8));
  const totalCostForStress = totalFeesUsdt.add(totalSlippageUsdt);
  const extraStressCost = totalCostForStress.mul(extraMultiplierDec);
  const stressNetPnlUsdt = netPnlUsdt.sub(extraStressCost);

  const riskNum = Math.max(0.01, Number(params.initialRiskUsdt.toString()));
  const netR = Number((Number(netPnlUsdt.toString()) / riskNum).toFixed(6));
  const stressNetR = Number((Number(stressNetPnlUsdt.toString()) / riskNum).toFixed(6));

  return {
    grossPnlUsdt,
    totalFeesUsdt,
    totalSlippageUsdt,
    netPnlUsdt,
    stressNetPnlUsdt,
    netR,
    stressNetR
  };
}
