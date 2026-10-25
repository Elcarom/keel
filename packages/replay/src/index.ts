import {
  ALL_BAR_TIMEFRAMES,
  ManualClock,
  SEALED_HOLDOUT_START_TS,
  ScaledDecimal,
  defaultInstrumentSpec,
  sha256Hex,
  sizeByStopRisk,
  type BarTimeframe,
  type BenchmarkBaseline,
  type Clock,
  type ConfirmedBar,
  type ExperimentRecord,
  type ExperimentRepository,
  type InstrumentSpec,
  type MarketDataRepository,
  type Proposal
} from "@keel/core";
import { BaselineChooser, type Strategy } from "@keel/strategy";

export interface ReplayTradeRecord {
  readonly proposalId: string;
  readonly strategyId: string;
  readonly side: "long" | "short";
  readonly entryTs: number;
  readonly exitTs: number;
  readonly entryPrice: ScaledDecimal;
  readonly exitPrice: ScaledDecimal;
  readonly protectiveStopPrice: ScaledDecimal;
  readonly contracts: ScaledDecimal;
  readonly initialRiskUsdt: ScaledDecimal;
  readonly grossPnlUsdt: ScaledDecimal;
  readonly feesUsdt: ScaledDecimal;
  readonly fundingUsdt: ScaledDecimal;
  readonly netPnlUsdt: ScaledDecimal;
  readonly netR: number;
  readonly stressNetR: number;
  readonly exitReason: "stop" | "take-profit" | "end-of-replay";
}

export interface ReplayRunInput {
  readonly instrumentId: string;
  readonly timeframe: BarTimeframe;
  readonly strategy: Strategy;
  readonly fromTs: number;
  readonly toTs: number;
  readonly instrumentSpec?: InstrumentSpec | undefined;
  readonly configHash?: string | undefined;
  readonly initialEquityUsdt?: ScaledDecimal | undefined;
  readonly riskFractionPerTrade?: number | undefined;
  readonly maxGrossLeverage?: number | undefined;
  readonly takerFeeBps?: number | undefined;
  readonly halfSpreadBps?: number | undefined;
  readonly slippageBps?: number | undefined;
  readonly costStressMultiplier?: number | undefined;
  readonly embargoBars?: number | undefined;
  readonly walkForwardFolds?: number | undefined;
  readonly replayMinTrades?: number | undefined;
  readonly replayMinSharpe?: number | undefined;
  readonly replayMinDeflatedSharpeConfidence?: number | undefined;
  readonly numTrialsForDsr?: number | undefined;
  readonly allowHoldoutAccess?: boolean | undefined;
  readonly candidateStrategies?: readonly Strategy[] | undefined;
}

export interface ReplayEquityPoint {
  readonly ts: number;
  readonly equityUsdt: string;
  readonly drawdownPct: number;
}

export interface ReplayRunResult extends ExperimentRecord {
  readonly trades: readonly ReplayTradeRecord[];
  readonly equityCurve: readonly ReplayEquityPoint[];
  readonly baselines: {
    readonly buyAndHold: BenchmarkBaseline;
    readonly randomEntry: BenchmarkBaseline;
  };
}

function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

/**
 * Mathematically verified Peter J. Acklam algorithm (2003) for the inverse normal CDF.
 * Accurate to relative error < 1.15e-9 across the entire standard normal distribution domain.
 */
export function inverseNormalCdf(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  // Central region coefficients
  const a1 = -3.969683028665376e1;
  const a2 = 2.209460984245205e2;
  const a3 = -2.759285104469687e2;
  const a4 = 1.38357751867269e2;
  const a5 = -3.066479806614716e1;
  const a6 = 2.506628277459239;

  const b1 = -5.447609879822406e1;
  const b2 = 1.615858368580409e2;
  const b3 = -1.556989798598866e2;
  const b4 = 6.680131188771972e1;
  const b5 = -1.328068155288572e1;

  // Tail region coefficients
  const c1 = -7.784894002430293e-3;
  const c2 = -3.223964580411365e-1;
  const c3 = -2.400758277161838;
  const c4 = -2.549732539343734;
  const c5 = 4.374664141464968;
  const c6 = 2.938163982698783;

  const d1 = 7.784695709041462e-3;
  const d2 = 3.224671290700398e-1;
  const d3 = 2.445134137142996;
  const d4 = 3.754408661907416;

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
      ((((d1 * q + d2) * q + d3) * q + d4) * q + 1)
    );
  } else if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (
      (q * (((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6)) /
      (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1)
    );
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
      ((((d1 * q + d2) * q + d3) * q + d4) * q + 1)
    );
  }
}

export function getTimeframeAnnualizationPeriods(timeframe: BarTimeframe): number {
  switch (timeframe) {
    case "15m":
      return 35_040;
    case "1H":
      return 8_760;
    case "4H":
      return 2_190;
    case "1D":
      return 365;
    default:
      return 8_760;
  }
}

export function computeDeflatedSharpeRatio(params: {
  readonly periodicReturns?: readonly number[] | undefined;
  readonly returnsR?: readonly number[] | undefined;
  readonly annualizationFactor?: number | undefined;
  readonly numTrials?: number | undefined;
}): {
  readonly sharpeRatio: number;
  readonly periodicSharpeRatio: number;
  readonly deflatedSharpeRatio: number;
} {
  const returns = params.periodicReturns ?? params.returnsR ?? [];
  const n = returns.length;
  if (n < 2) {
    return { sharpeRatio: 0, periodicSharpeRatio: 0, deflatedSharpeRatio: 0 };
  }
  const mean = returns.reduce((acc, r) => acc + r, 0) / n;
  const variance = returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(Math.max(1e-12, variance));
  const sr = mean / std;

  const annualFactor =
    params.annualizationFactor !== undefined
      ? params.annualizationFactor
      : params.periodicReturns !== undefined
        ? Math.sqrt(8760)
        : 1.0;
  const annualizedSr = sr * annualFactor;

  const m3 = returns.reduce((acc, r) => acc + ((r - mean) / std) ** 3, 0) / n;
  const m4 = returns.reduce((acc, r) => acc + ((r - mean) / std) ** 4, 0) / n;

  const trials = Math.max(1, params.numTrials ?? 3);
  const eulerMascheroni = 0.5772156649;
  const sr0 =
    trials <= 1
      ? 0
      : Math.sqrt(1 / Math.max(1, n - 1)) *
        ((1 - eulerMascheroni) * inverseNormalCdf(1 - 1 / trials) +
          eulerMascheroni * inverseNormalCdf(1 - 1 / (trials * Math.E)));

  const denomVar = Math.max(1e-9, 1 - m3 * sr + ((m4 - 1) / 4) * sr * sr);
  const z = ((sr - sr0) * Math.sqrt(Math.max(1, n - 1))) / Math.sqrt(denomVar);
  const dsr = Math.min(1, Math.max(0, normalCdf(z)));

  return {
    sharpeRatio: Number(annualizedSr.toFixed(6)),
    periodicSharpeRatio: Number(sr.toFixed(6)),
    deflatedSharpeRatio: Number(dsr.toFixed(6))
  };
}

function updateTrackedDrawdown(params: {
  readonly peakEquityNum: number;
  readonly closeEquityNum: number;
  readonly worstIntraEquityNum: number;
  readonly currentMaxDrawdownPct: number;
}): {
  readonly newPeakEquityNum: number;
  readonly newMaxDrawdownPct: number;
} {
  let peak = params.peakEquityNum;
  if (params.closeEquityNum > peak) {
    peak = params.closeEquityNum;
  }
  let maxDd = params.currentMaxDrawdownPct;
  if (peak > 0) {
    const ddWorst = ((peak - params.worstIntraEquityNum) / peak) * 100;
    const ddClose = ((peak - params.closeEquityNum) / peak) * 100;
    if (ddWorst > maxDd) maxDd = ddWorst;
    if (ddClose > maxDd) maxDd = ddClose;
  }
  return { newPeakEquityNum: peak, newMaxDrawdownPct: maxDd };
}

export function computeBuyAndHoldBaseline(params: {
  readonly bars: readonly ConfirmedBar[];
  readonly instrumentSpec: InstrumentSpec;
  readonly initialEquityUsdt: ScaledDecimal;
  readonly totalOneWayCostBps: number;
  readonly timeframe: BarTimeframe;
  readonly marketDataRepo: MarketDataRepository;
}): BenchmarkBaseline {
  const bars = params.bars;
  if (bars.length < 2) {
    return { returnPct: 0, sharpeRatio: 0, maxDrawdownPct: 0 };
  }
  const firstBar = bars[0];
  if (!firstBar) {
    return { returnPct: 0, sharpeRatio: 0, maxDrawdownPct: 0 };
  }
  const spec = params.instrumentSpec;
  const costFraction = ScaledDecimal.fromString((params.totalOneWayCostBps / 10_000).toFixed(8));

  const entryPrice = ScaledDecimal.fromString(firstBar.open);
  const notionalPerContract = entryPrice.mul(spec.contractValue);
  if (!notionalPerContract.isPositive()) {
    return { returnPct: 0, sharpeRatio: 0, maxDrawdownPct: 0 };
  }

  const contracts = params.initialEquityUsdt
    .divFloor(notionalPerContract)
    .roundDownToLot(spec.lotSize);
  if (!contracts.isPositive()) {
    return { returnPct: 0, sharpeRatio: 0, maxDrawdownPct: 0 };
  }

  const baseQty = contracts.mul(spec.contractValue);
  const entryNotional = entryPrice.mul(baseQty);
  const entryFee = entryNotional.mul(costFraction);

  const initialEquityNum = Number(params.initialEquityUsdt.toString());
  const cashEquity = params.initialEquityUsdt.sub(entryFee);
  let fundingAccrued = ScaledDecimal.zero();
  let lastFundingTs = firstBar.openTs;
  let peakEquityNum = initialEquityNum;
  let maxDrawdownPct = 0;
  let prevEquityNum = initialEquityNum;
  const periodicReturns: number[] = [];

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (!bar) continue;
    const settled = params.marketDataRepo.getSettledFundingInRange({
      instrumentId: spec.instrumentId,
      fromTs: lastFundingTs + 1,
      toTs: bar.closeTs
    });
    for (const f of settled) {
      const markClose = ScaledDecimal.fromString(bar.close);
      const markNotional = markClose.mul(baseQty);
      const rate = ScaledDecimal.fromString(f.fundingRate);
      const rawPayment = markNotional.mul(rate);
      fundingAccrued = fundingAccrued.sub(rawPayment);
      lastFundingTs = f.fundingTs;
    }

    const closePrice = ScaledDecimal.fromString(bar.close);
    const grossPnl = closePrice.sub(entryPrice).mul(baseQty);
    const exitFee = closePrice.mul(baseQty).mul(costFraction);
    const mtmEquity = cashEquity.add(grossPnl).sub(exitFee).add(fundingAccrued);
    const eqNum = Number(mtmEquity.toString());

    const lowPrice = ScaledDecimal.fromString(bar.low);
    const lowGrossPnl = lowPrice.sub(entryPrice).mul(baseQty);
    const lowExitFee = lowPrice.mul(baseQty).mul(costFraction);
    const worstEq = cashEquity.add(lowGrossPnl).sub(lowExitFee).add(fundingAccrued);
    const worstEqNum = Number(worstEq.toString());

    const dd = updateTrackedDrawdown({
      peakEquityNum,
      closeEquityNum: eqNum,
      worstIntraEquityNum: worstEqNum,
      currentMaxDrawdownPct: maxDrawdownPct
    });
    peakEquityNum = dd.newPeakEquityNum;
    maxDrawdownPct = dd.newMaxDrawdownPct;

    const r = prevEquityNum > 0 ? (eqNum - prevEquityNum) / prevEquityNum : 0;
    periodicReturns.push(r);
    prevEquityNum = eqNum;
  }

  const finalBar = bars[bars.length - 1];
  const finalClose = finalBar ? ScaledDecimal.fromString(finalBar.close) : entryPrice;
  const finalGross = finalClose.sub(entryPrice).mul(baseQty);
  const finalExitFee = finalClose.mul(baseQty).mul(costFraction);
  const finalEquity = cashEquity.add(finalGross).sub(finalExitFee).add(fundingAccrued);
  const finalEquityNum = Number(finalEquity.toString());
  const returnPct = ((finalEquityNum - initialEquityNum) / initialEquityNum) * 100;

  const annualFactor = Math.sqrt(getTimeframeAnnualizationPeriods(params.timeframe));
  const sharpe = computeDeflatedSharpeRatio({
    periodicReturns,
    annualizationFactor: annualFactor
  }).sharpeRatio;

  return {
    returnPct: Number(returnPct.toFixed(4)),
    sharpeRatio: Number(sharpe.toFixed(4)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(4))
  };
}

export function computeRandomEntryBaseline(params: {
  readonly bars: readonly ConfirmedBar[];
  readonly instrumentSpec: InstrumentSpec;
  readonly initialEquityUsdt: ScaledDecimal;
  readonly totalOneWayCostBps: number;
  readonly timeframe: BarTimeframe;
  readonly marketDataRepo: MarketDataRepository;
  readonly riskFraction?: number | undefined;
  readonly maxLeverage?: number | undefined;
  readonly seed?: number | undefined;
}): BenchmarkBaseline {
  const bars = params.bars;
  if (bars.length < 2) {
    return { returnPct: 0, sharpeRatio: 0, maxDrawdownPct: 0 };
  }
  const spec = params.instrumentSpec;
  const costFraction = ScaledDecimal.fromString((params.totalOneWayCostBps / 10_000).toFixed(8));
  const riskFraction = params.riskFraction ?? 0.0075;
  const maxLeverage = params.maxLeverage ?? 2.0;
  const riskFractionDec = ScaledDecimal.fromString(riskFraction.toFixed(8));
  const maxLeverageDec = ScaledDecimal.fromString(maxLeverage.toFixed(8));

  let prngState = (params.seed ?? 1337) >>> 0;
  const prng = (): number => {
    prngState = (1664525 * prngState + 1013904223) >>> 0;
    return prngState / 4294967296;
  };

  let cashEquity = params.initialEquityUsdt;
  const initialEquityNum = Number(cashEquity.toString());
  let peakEquityNum = initialEquityNum;
  let maxDrawdownPct = 0;
  let prevEquityNum = initialEquityNum;
  const periodicReturns: number[] = [];

  interface RandomPosition {
    side: "long" | "short";
    entryPrice: ScaledDecimal;
    stopPrice: ScaledDecimal;
    takeProfitPrice: ScaledDecimal;
    contracts: ScaledDecimal;
    entryFee: ScaledDecimal;
    fundingAccrued: ScaledDecimal;
    lastFundingTs: number;
    barsHeld: number;
  }

  let active: RandomPosition | null = null;

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (!bar) continue;
    const barLow = ScaledDecimal.fromString(bar.low);
    const barHigh = ScaledDecimal.fromString(bar.high);
    const barClose = ScaledDecimal.fromString(bar.close);

    if (active) {
      active.barsHeld += 1;
      const settled = params.marketDataRepo.getSettledFundingInRange({
        instrumentId: spec.instrumentId,
        fromTs: active.lastFundingTs + 1,
        toTs: bar.closeTs
      });
      for (const f of settled) {
        const baseQty = active.contracts.mul(spec.contractValue);
        const markNotional = barClose.mul(baseQty);
        const rate = ScaledDecimal.fromString(f.fundingRate);
        const rawPayment = markNotional.mul(rate);
        const signed = active.side === "long" ? ScaledDecimal.zero().sub(rawPayment) : rawPayment;
        active.fundingAccrued = active.fundingAccrued.add(signed);
        active.lastFundingTs = f.fundingTs;
      }

      let exitPrice: ScaledDecimal | null = null;
      if (active.side === "long") {
        if (barLow.lte(active.stopPrice)) {
          exitPrice = active.stopPrice;
        } else if (barHigh.gte(active.takeProfitPrice)) {
          exitPrice = active.takeProfitPrice;
        } else if (active.barsHeld >= 24) {
          exitPrice = barClose;
        }
      } else {
        if (barHigh.gte(active.stopPrice)) {
          exitPrice = active.stopPrice;
        } else if (barLow.lte(active.takeProfitPrice)) {
          exitPrice = active.takeProfitPrice;
        } else if (active.barsHeld >= 24) {
          exitPrice = barClose;
        }
      }

      if (exitPrice !== null) {
        const baseQty = active.contracts.mul(spec.contractValue);
        const priceDiff =
          active.side === "long"
            ? exitPrice.sub(active.entryPrice)
            : active.entryPrice.sub(exitPrice);
        const grossPnl = priceDiff.mul(baseQty);
        const exitFee = exitPrice.mul(baseQty).mul(costFraction);
        const netPnl = grossPnl.sub(active.entryFee).sub(exitFee).add(active.fundingAccrued);
        cashEquity = cashEquity.add(netPnl);
        active = null;
      }
    }

    let barCloseEquity = cashEquity;
    let worstIntraEquity = cashEquity;

    if (active) {
      const baseQty = active.contracts.mul(spec.contractValue);
      const closeDiff =
        active.side === "long" ? barClose.sub(active.entryPrice) : active.entryPrice.sub(barClose);
      const closeGross = closeDiff.mul(baseQty);
      const closeExitFee = barClose.mul(baseQty).mul(costFraction);
      barCloseEquity = cashEquity
        .add(closeGross)
        .sub(active.entryFee)
        .sub(closeExitFee)
        .add(active.fundingAccrued);

      const worstPrice = active.side === "long" ? barLow : barHigh;
      const worstDiff =
        active.side === "long"
          ? worstPrice.sub(active.entryPrice)
          : active.entryPrice.sub(worstPrice);
      const worstGross = worstDiff.mul(baseQty);
      const worstExitFee = worstPrice.mul(baseQty).mul(costFraction);
      worstIntraEquity = cashEquity
        .add(worstGross)
        .sub(active.entryFee)
        .sub(worstExitFee)
        .add(active.fundingAccrued);
    }

    const eqNum = Number(barCloseEquity.toString());
    const worstEqNum = Number(worstIntraEquity.toString());

    const dd = updateTrackedDrawdown({
      peakEquityNum,
      closeEquityNum: eqNum,
      worstIntraEquityNum: worstEqNum,
      currentMaxDrawdownPct: maxDrawdownPct
    });
    peakEquityNum = dd.newPeakEquityNum;
    maxDrawdownPct = dd.newMaxDrawdownPct;

    const r = prevEquityNum > 0 ? (eqNum - prevEquityNum) / prevEquityNum : 0;
    periodicReturns.push(r);
    prevEquityNum = eqNum;

    if (!active && i < bars.length - 1) {
      if (prng() < 0.15) {
        const side: "long" | "short" = prng() < 0.5 ? "long" : "short";
        const entryPrice = barClose;
        const onePoint = ScaledDecimal.fromString("1.00000000");
        const twoPercent = ScaledDecimal.fromString("0.02000000");
        const twoPointFive = ScaledDecimal.fromString("2.50000000");
        const stopDistance = ScaledDecimal.max(onePoint, entryPrice.mul(twoPercent));
        const stopPrice =
          side === "long"
            ? ScaledDecimal.max(onePoint, entryPrice.sub(stopDistance))
            : entryPrice.add(stopDistance);
        const tpDistance = stopDistance.mul(twoPointFive);
        const tpPrice =
          side === "long"
            ? entryPrice.add(tpDistance)
            : ScaledDecimal.max(onePoint, entryPrice.sub(tpDistance));

        const sizing = sizeByStopRisk({
          instrument: spec,
          side,
          strategyEquityQuote: cashEquity,
          riskFraction: riskFractionDec,
          entryPrice,
          stopPrice,
          maxGrossLeverage: maxLeverageDec
        });

        if (sizing.ok && Number(sizing.contracts.toString()) > 0) {
          const entryFee = sizing.notionalQuote.mul(costFraction);
          active = {
            side,
            entryPrice,
            stopPrice: sizing.effectiveStopPrice,
            takeProfitPrice: tpPrice,
            contracts: sizing.contracts,
            entryFee,
            fundingAccrued: ScaledDecimal.zero(),
            lastFundingTs: bar.closeTs,
            barsHeld: 0
          };
        }
      }
    }
  }

  if (active && bars.length > 0) {
    const lastBar = bars[bars.length - 1];
    if (lastBar) {
      const exitPrice = ScaledDecimal.fromString(lastBar.close);
      const baseQty = active.contracts.mul(spec.contractValue);
      const priceDiff =
        active.side === "long"
          ? exitPrice.sub(active.entryPrice)
          : active.entryPrice.sub(exitPrice);
      const grossPnl = priceDiff.mul(baseQty);
      const exitFee = exitPrice.mul(baseQty).mul(costFraction);
      const netPnl = grossPnl.sub(active.entryFee).sub(exitFee).add(active.fundingAccrued);
      cashEquity = cashEquity.add(netPnl);
      active = null;
    }
  }

  const finalEquityNum = Number(cashEquity.toString());
  const returnPct = ((finalEquityNum - initialEquityNum) / initialEquityNum) * 100;
  const annualFactor = Math.sqrt(getTimeframeAnnualizationPeriods(params.timeframe));
  const sharpe = computeDeflatedSharpeRatio({
    periodicReturns,
    annualizationFactor: annualFactor
  }).sharpeRatio;

  return {
    returnPct: Number(returnPct.toFixed(4)),
    sharpeRatio: Number(sharpe.toFixed(4)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(4))
  };
}

interface ActivePosition {
  readonly proposal: Proposal;
  readonly entryTs: number;
  readonly entryPrice: ScaledDecimal;
  readonly protectiveStopPrice: ScaledDecimal;
  readonly takeProfitPrice: ScaledDecimal | null;
  readonly contracts: ScaledDecimal;
  readonly initialRiskUsdt: ScaledDecimal;
  readonly entryFeeUsdt: ScaledDecimal;
  fundingAccruedUsdt: ScaledDecimal;
  lastFundingTs: number;
}

export interface ReplayEngineOptions {
  readonly marketDataRepo: MarketDataRepository;
  readonly experimentRepo?: ExperimentRepository | undefined;
  readonly clock?: Clock | undefined;
}

export class ReplayEngine {
  private readonly marketDataRepo: MarketDataRepository;
  private readonly experimentRepo: ExperimentRepository | undefined;
  private readonly clock: Clock;
  private readonly chooser = new BaselineChooser();
  private runSequence = 0;

  public constructor(options: ReplayEngineOptions) {
    this.marketDataRepo = options.marketDataRepo;
    this.experimentRepo = options.experimentRepo;
    this.clock = options.clock ?? new ManualClock(1_700_000_000_000);
  }

  public run(input: ReplayRunInput): ReplayRunResult {
    if (input.toTs > SEALED_HOLDOUT_START_TS && !input.allowHoldoutAccess) {
      throw new Error(
        `Sealed holdout violation: Replay toTs (${input.toTs}) extends into sealed 2025 holdout (${SEALED_HOLDOUT_START_TS}) without explicit allowHoldoutAccess authorization (ADR-0009).`
      );
    }

    const initialEquityUsdt = input.initialEquityUsdt ?? ScaledDecimal.fromString("10000.00000000");
    const riskFraction = input.riskFractionPerTrade ?? 0.0075;
    const maxLeverage = input.maxGrossLeverage ?? 2.0;
    const takerFeeBps = input.takerFeeBps ?? 5;
    const halfSpreadBps = input.halfSpreadBps ?? 2;
    const slippageBps = input.slippageBps ?? 3;
    const totalOneWayCostBps = takerFeeBps + halfSpreadBps + slippageBps;
    const costStressMultiplier = input.costStressMultiplier ?? 2.0;
    const spec = input.instrumentSpec ?? defaultInstrumentSpec(input.instrumentId);

    const snapshotMeta = this.marketDataRepo.computeDataSnapshot({
      instrumentIds: [input.instrumentId],
      fromTs: input.fromTs,
      toTs: input.toTs
    });

    const allBars = this.marketDataRepo.getConfirmedBarsInRange({
      instrumentId: input.instrumentId,
      timeframe: input.timeframe,
      fromOpenTs: input.fromTs,
      toCloseTs: input.toTs
    });

    const lookbackCounts = ALL_BAR_TIMEFRAMES.map((tf) => input.strategy.lookbacks[tf] ?? 0);
    const maxLookbackBars = Math.max(22, ...lookbackCounts);
    const embargoBars = input.embargoBars ?? maxLookbackBars;
    const walkForwardFolds = input.walkForwardFolds ?? 2;

    const simulation = this.simulateWindow({
      instrumentId: input.instrumentId,
      instrumentSpec: spec,
      timeframe: input.timeframe,
      strategy: input.strategy,
      bars: allBars,
      initialEquityUsdt,
      riskFraction,
      maxLeverage,
      slippageBps,
      totalOneWayCostBps,
      costStressMultiplier
    });

    const oosResult = this.computePurgedWalkForwardOosExpectancy({
      instrumentId: input.instrumentId,
      instrumentSpec: spec,
      timeframe: input.timeframe,
      primaryStrategy: input.strategy,
      candidateStrategies: input.candidateStrategies,
      bars: allBars,
      embargoBars,
      walkForwardFolds,
      initialEquityUsdt,
      riskFraction,
      maxLeverage,
      slippageBps,
      totalOneWayCostBps,
      costStressMultiplier
    });

    const cumulativeTrials =
      input.numTrialsForDsr ??
      Math.max(1, (this.experimentRepo?.listExperiments(10_000).length ?? 0) + 1);

    const annualFactor = Math.sqrt(getTimeframeAnnualizationPeriods(input.timeframe));

    const dsrMetrics = computeDeflatedSharpeRatio({
      periodicReturns: simulation.periodicReturns,
      annualizationFactor: annualFactor,
      numTrials: cumulativeTrials
    });

    const buyAndHold = computeBuyAndHoldBaseline({
      bars: allBars,
      instrumentSpec: spec,
      initialEquityUsdt,
      totalOneWayCostBps,
      timeframe: input.timeframe,
      marketDataRepo: this.marketDataRepo
    });

    const randomEntry = computeRandomEntryBaseline({
      bars: allBars,
      instrumentSpec: spec,
      initialEquityUsdt,
      totalOneWayCostBps,
      timeframe: input.timeframe,
      marketDataRepo: this.marketDataRepo,
      riskFraction,
      maxLeverage
    });

    const winCount = simulation.trades.filter((t) => t.netR > 0).length;
    const winRate =
      simulation.trades.length > 0 ? Number((winCount / simulation.trades.length).toFixed(4)) : 0;

    const minTrades = input.replayMinTrades ?? 5;
    const minSharpe = input.replayMinSharpe ?? 1.0;
    const minDsr = input.replayMinDeflatedSharpeConfidence ?? 0.5;

    const replayGatePassed =
      oosResult.isSufficientData &&
      simulation.trades.length >= minTrades &&
      simulation.stressNetExpectancyR > 0 &&
      oosResult.oosExpectancyR >= 0 &&
      dsrMetrics.sharpeRatio >= minSharpe &&
      dsrMetrics.deflatedSharpeRatio >= minDsr &&
      simulation.maxDrawdownPct <= 25;

    const configHash =
      input.configHash ??
      sha256Hex(
        JSON.stringify({
          strategyId: input.strategy.strategyId,
          parameterHash: input.strategy.parameterHash,
          riskFraction,
          maxLeverage,
          totalOneWayCostBps,
          costStressMultiplier
        })
      );

    this.runSequence += 1;
    const createdAtMs = this.clock.nowMs();
    const experimentId = `${sha256Hex(
      `${input.strategy.strategyId}:${input.strategy.parameterHash}:${snapshotMeta.snapshotId}:${input.fromTs}:${input.toTs}:${this.runSequence}:${cumulativeTrials}`
    ).slice(0, 16)}-${this.runSequence.toString(36)}`;

    const record: ExperimentRecord = {
      experimentId,
      strategyId: input.strategy.strategyId,
      strategyVersion: input.strategy.version,
      instrumentId: input.instrumentId,
      timeframe: input.timeframe,
      dataSnapshotId: snapshotMeta.snapshotId,
      configHash,
      fromTs: input.fromTs,
      toTs: input.toTs,
      totalTrades: simulation.trades.length,
      winRate,
      avgR: simulation.netExpectancyR,
      netPnlUsdt: simulation.netPnlUsdt.toString(),
      totalFeesUsdt: simulation.totalFeesUsdt.toString(),
      totalFundingUsdt: simulation.totalFundingUsdt.toString(),
      maxDrawdownPct: simulation.maxDrawdownPct,
      sharpeRatio: dsrMetrics.sharpeRatio,
      deflatedSharpeRatio: dsrMetrics.deflatedSharpeRatio,
      stressNetExpectancyR: simulation.stressNetExpectancyR,
      walkForwardOutOfSampleAvgR: oosResult.oosExpectancyR,
      replayGatePassed,
      createdAtMs,
      buyAndHoldReturnPct: buyAndHold.returnPct,
      buyAndHoldSharpeRatio: buyAndHold.sharpeRatio,
      randomEntryReturnPct: randomEntry.returnPct,
      randomEntrySharpeRatio: randomEntry.sharpeRatio
    };

    if (this.experimentRepo) {
      this.experimentRepo.saveExperiment(record);
    }

    return {
      ...record,
      trades: simulation.trades,
      equityCurve: simulation.equityCurve,
      baselines: {
        buyAndHold,
        randomEntry
      }
    };
  }

  private simulateWindow(params: {
    readonly instrumentId: string;
    readonly instrumentSpec: InstrumentSpec;
    readonly timeframe: BarTimeframe;
    readonly strategy: Strategy;
    readonly bars: readonly ConfirmedBar[];
    readonly initialEquityUsdt: ScaledDecimal;
    readonly riskFraction: number;
    readonly maxLeverage: number;
    readonly slippageBps: number;
    readonly totalOneWayCostBps: number;
    readonly costStressMultiplier: number;
  }): {
    readonly trades: readonly ReplayTradeRecord[];
    readonly equityCurve: readonly ReplayEquityPoint[];
    readonly periodicReturns: readonly number[];
    readonly finalEquityUsdt: ScaledDecimal;
    readonly netPnlUsdt: ScaledDecimal;
    readonly totalFeesUsdt: ScaledDecimal;
    readonly totalFundingUsdt: ScaledDecimal;
    readonly maxDrawdownPct: number;
    readonly netExpectancyR: number;
    readonly stressNetExpectancyR: number;
  } {
    const bars = params.bars;
    const firstBar = bars[0];
    if (!firstBar) {
      const zero = ScaledDecimal.zero();
      return {
        trades: [],
        equityCurve: [],
        periodicReturns: [],
        finalEquityUsdt: params.initialEquityUsdt,
        netPnlUsdt: zero,
        totalFeesUsdt: zero,
        totalFundingUsdt: zero,
        maxDrawdownPct: 0,
        netExpectancyR: 0,
        stressNetExpectancyR: 0
      };
    }

    const spec = params.instrumentSpec;
    const clock = new ManualClock(firstBar.openTs);
    let equityUsdt = params.initialEquityUsdt;
    let peakEquityNum = Number(equityUsdt.toString());
    let prevEquityNum = peakEquityNum;
    let maxDrawdownPct = 0;
    let totalFeesUsdt = ScaledDecimal.zero();
    let totalFundingUsdt = ScaledDecimal.zero();

    const trades: ReplayTradeRecord[] = [];
    const equityCurve: ReplayEquityPoint[] = [];
    const periodicReturns: number[] = [];
    let active: ActivePosition | null = null;
    let pendingProposal: Proposal | null = null;

    const costFraction = ScaledDecimal.fromString((params.totalOneWayCostBps / 10_000).toFixed(8));
    const slippageFraction = ScaledDecimal.fromString((params.slippageBps / 10_000).toFixed(8));
    const extraStressMultiplierDec = ScaledDecimal.fromString(
      Math.max(0, params.costStressMultiplier - 1).toFixed(8)
    );
    const riskFractionDec = ScaledDecimal.fromString(params.riskFraction.toFixed(8));
    const maxLeverageDec = ScaledDecimal.fromString(params.maxLeverage.toFixed(8));

    const closePosition = (
      pos: ActivePosition,
      exitTs: number,
      exitPrice: ScaledDecimal,
      exitReason: "stop" | "take-profit" | "end-of-replay"
    ) => {
      const priceDiff =
        pos.proposal.side === "long"
          ? exitPrice.sub(pos.entryPrice)
          : pos.entryPrice.sub(exitPrice);
      const baseQty = pos.contracts.mul(spec.contractValue);
      const grossPnlUsdt = priceDiff.mul(baseQty);
      const exitNotionalUsdt = exitPrice.mul(baseQty);
      const exitFeeUsdt = exitNotionalUsdt.mul(costFraction);
      const tradeFeesUsdt = pos.entryFeeUsdt.add(exitFeeUsdt);
      const netPnlUsdt = grossPnlUsdt.sub(tradeFeesUsdt).add(pos.fundingAccruedUsdt);

      // Cost stress deducts (costStressMultiplier - 1) * tradeFeesUsdt
      const stressNetPnlUsdt = netPnlUsdt.sub(tradeFeesUsdt.mul(extraStressMultiplierDec));

      const riskNum = Math.max(0.01, Number(pos.initialRiskUsdt.toString()));
      const netR = Number((Number(netPnlUsdt.toString()) / riskNum).toFixed(6));
      const stressNetR = Number((Number(stressNetPnlUsdt.toString()) / riskNum).toFixed(6));

      equityUsdt = equityUsdt.add(netPnlUsdt);
      totalFeesUsdt = totalFeesUsdt.add(tradeFeesUsdt);
      totalFundingUsdt = totalFundingUsdt.add(pos.fundingAccruedUsdt);

      trades.push({
        proposalId: pos.proposal.proposalId,
        strategyId: pos.proposal.strategyId,
        side: pos.proposal.side,
        entryTs: pos.entryTs,
        exitTs,
        entryPrice: pos.entryPrice,
        exitPrice,
        protectiveStopPrice: pos.protectiveStopPrice,
        contracts: pos.contracts,
        initialRiskUsdt: pos.initialRiskUsdt,
        grossPnlUsdt,
        feesUsdt: tradeFeesUsdt,
        fundingUsdt: pos.fundingAccruedUsdt,
        netPnlUsdt,
        netR,
        stressNetR,
        exitReason
      });
    };

    for (let idx = 0; idx < bars.length; idx += 1) {
      const bar = bars[idx];
      if (!bar) continue;
      clock.setMs(bar.closeTs);
      const nowMs = clock.nowMs();
      const barOpen = ScaledDecimal.fromString(bar.open);
      const barHigh = ScaledDecimal.fromString(bar.high);
      const barLow = ScaledDecimal.fromString(bar.low);
      const barClose = ScaledDecimal.fromString(bar.close);

      // Execute pending proposal confirmed on prior bar at this bar's open with slippage (M2)
      if (pendingProposal !== null && active === null) {
        const slippageAmount = barOpen.mul(slippageFraction);
        const entryPrice =
          pendingProposal.side === "long"
            ? barOpen.add(slippageAmount)
            : barOpen.sub(slippageAmount);

        const proposedEntry = ScaledDecimal.fromString(pendingProposal.entryPrice);
        const proposedStop = ScaledDecimal.fromString(pendingProposal.protectiveStopPrice);
        const stopDist =
          pendingProposal.side === "long"
            ? proposedEntry.sub(proposedStop)
            : proposedStop.sub(proposedEntry);
        const stopPrice =
          pendingProposal.side === "long" ? entryPrice.sub(stopDist) : entryPrice.add(stopDist);

        let tpPrice: ScaledDecimal | null = null;
        if (pendingProposal.takeProfitPrice) {
          const proposedTp = ScaledDecimal.fromString(pendingProposal.takeProfitPrice);
          const tpDist =
            pendingProposal.side === "long"
              ? proposedTp.sub(proposedEntry)
              : proposedEntry.sub(proposedTp);
          tpPrice =
            pendingProposal.side === "long" ? entryPrice.add(tpDist) : entryPrice.sub(tpDist);
        }

        const sizing = sizeByStopRisk({
          instrument: spec,
          side: pendingProposal.side,
          strategyEquityQuote: equityUsdt,
          riskFraction: riskFractionDec,
          entryPrice,
          stopPrice,
          maxGrossLeverage: maxLeverageDec
        });

        if (sizing.ok && Number(sizing.contracts.toString()) > 0) {
          const entryFeeUsdt = sizing.notionalQuote.mul(costFraction);
          active = {
            proposal: pendingProposal,
            entryTs: bar.openTs,
            entryPrice,
            protectiveStopPrice: sizing.effectiveStopPrice,
            takeProfitPrice: tpPrice,
            contracts: sizing.contracts,
            initialRiskUsdt: sizing.sizedRiskQuote,
            entryFeeUsdt,
            fundingAccruedUsdt: ScaledDecimal.zero(),
            lastFundingTs: bar.openTs
          };
        }
        pendingProposal = null;
      }

      if (active) {
        // 1. Apply any settled 8h funding events in (active.lastFundingTs, nowMs]
        const settledFunding = this.marketDataRepo.getSettledFundingInRange({
          instrumentId: params.instrumentId,
          fromTs: active.lastFundingTs + 1,
          toTs: nowMs
        });

        for (const f of settledFunding) {
          const baseQty = active.contracts.mul(spec.contractValue);
          const markNotionalUsdt = barClose.mul(baseQty);
          const rateDec = ScaledDecimal.fromString(f.fundingRate);
          const rawPayment = markNotionalUsdt.mul(rateDec);
          const signedFunding =
            active.proposal.side === "long" ? ScaledDecimal.zero().sub(rawPayment) : rawPayment;
          active.fundingAccruedUsdt = active.fundingAccruedUsdt.add(signedFunding);
          active.lastFundingTs = f.fundingTs;
        }

        // 2. Conservative intrabar ProtectiveStop & take-profit check with gap-aware fills (M2)
        if (active.proposal.side === "long") {
          const stopHit = barLow.lte(active.protectiveStopPrice);
          const tpHit = active.takeProfitPrice !== null && barHigh.gte(active.takeProfitPrice);
          if (stopHit) {
            const fillPrice = ScaledDecimal.min(barOpen, active.protectiveStopPrice);
            closePosition(active, nowMs, fillPrice, "stop");
            active = null;
          } else if (tpHit && active.takeProfitPrice) {
            const fillPrice = ScaledDecimal.max(barOpen, active.takeProfitPrice);
            closePosition(active, nowMs, fillPrice, "take-profit");
            active = null;
          }
        } else {
          const stopHit = barHigh.gte(active.protectiveStopPrice);
          const tpHit = active.takeProfitPrice !== null && barLow.lte(active.takeProfitPrice);
          if (stopHit) {
            const fillPrice = ScaledDecimal.max(barOpen, active.protectiveStopPrice);
            closePosition(active, nowMs, fillPrice, "stop");
            active = null;
          } else if (tpHit && active.takeProfitPrice) {
            const fillPrice = ScaledDecimal.min(barOpen, active.takeProfitPrice);
            closePosition(active, nowMs, fillPrice, "take-profit");
            active = null;
          }
        }
      }

      // 3. Mark-to-market equity evaluation for this bar
      let barCloseEquity = equityUsdt;
      let worstIntraEquity = equityUsdt;

      if (active) {
        const baseQty = active.contracts.mul(spec.contractValue);
        const closeDiff =
          active.proposal.side === "long"
            ? barClose.sub(active.entryPrice)
            : active.entryPrice.sub(barClose);
        const closeGross = closeDiff.mul(baseQty);
        const closeExitFee = barClose.mul(baseQty).mul(costFraction);
        barCloseEquity = equityUsdt
          .add(closeGross)
          .sub(active.entryFeeUsdt)
          .sub(closeExitFee)
          .add(active.fundingAccruedUsdt);

        const worstPrice = active.proposal.side === "long" ? barLow : barHigh;
        const worstDiff =
          active.proposal.side === "long"
            ? worstPrice.sub(active.entryPrice)
            : active.entryPrice.sub(worstPrice);
        const worstGross = worstDiff.mul(baseQty);
        const worstExitFee = worstPrice.mul(baseQty).mul(costFraction);
        worstIntraEquity = equityUsdt
          .add(worstGross)
          .sub(active.entryFeeUsdt)
          .sub(worstExitFee)
          .add(active.fundingAccruedUsdt);
      }

      const eqNum = Number(barCloseEquity.toString());
      const worstEqNum = Number(worstIntraEquity.toString());

      const dd = updateTrackedDrawdown({
        peakEquityNum,
        closeEquityNum: eqNum,
        worstIntraEquityNum: worstEqNum,
        currentMaxDrawdownPct: maxDrawdownPct
      });
      peakEquityNum = dd.newPeakEquityNum;
      maxDrawdownPct = dd.newMaxDrawdownPct;

      const barDd = peakEquityNum > 0 ? ((peakEquityNum - eqNum) / peakEquityNum) * 100 : 0;
      equityCurve.push({
        ts: bar.closeTs,
        equityUsdt: barCloseEquity.toString(),
        drawdownPct: Number(barDd.toFixed(4))
      });

      const r = prevEquityNum > 0 ? (eqNum - prevEquityNum) / prevEquityNum : 0;
      periodicReturns.push(r);
      prevEquityNum = eqNum;

      // 4. When flat and idx < bars.length - 1, build strictly causal FeatureSnapshot and evaluate Strategy
      if (!active && pendingProposal === null && idx < bars.length - 1) {
        const snapshot = this.marketDataRepo.buildFeatureSnapshot({
          instrumentId: params.instrumentId,
          asOfMs: nowMs,
          requirements: params.strategy.lookbacks
        });
        const menu = params.strategy.evaluate(snapshot);
        const chosen = this.chooser.choose([menu]);
        if (chosen) {
          pendingProposal = chosen;
        }
      }
    }

    const lastBar = bars[bars.length - 1];
    if (active && lastBar) {
      closePosition(
        active,
        lastBar.closeTs,
        ScaledDecimal.fromString(lastBar.close),
        "end-of-replay"
      );
      active = null;
    }

    const netPnlUsdt = equityUsdt.sub(params.initialEquityUsdt);
    const netExpectancyR =
      trades.length > 0
        ? Number((trades.reduce((acc, t) => acc + t.netR, 0) / trades.length).toFixed(6))
        : 0;
    const stressNetExpectancyR =
      trades.length > 0
        ? Number((trades.reduce((acc, t) => acc + t.stressNetR, 0) / trades.length).toFixed(6))
        : 0;

    return {
      trades,
      equityCurve,
      periodicReturns,
      finalEquityUsdt: equityUsdt,
      netPnlUsdt,
      totalFeesUsdt,
      totalFundingUsdt,
      maxDrawdownPct: Number(maxDrawdownPct.toFixed(4)),
      netExpectancyR,
      stressNetExpectancyR
    };
  }

  private computePurgedWalkForwardOosExpectancy(params: {
    readonly instrumentId: string;
    readonly instrumentSpec: InstrumentSpec;
    readonly timeframe: BarTimeframe;
    readonly primaryStrategy: Strategy;
    readonly candidateStrategies?: readonly Strategy[] | undefined;
    readonly bars: readonly ConfirmedBar[];
    readonly embargoBars: number;
    readonly walkForwardFolds: number;
    readonly initialEquityUsdt: ScaledDecimal;
    readonly riskFraction: number;
    readonly maxLeverage: number;
    readonly slippageBps: number;
    readonly totalOneWayCostBps: number;
    readonly costStressMultiplier: number;
  }): {
    readonly oosExpectancyR: number;
    readonly isSufficientData: boolean;
  } {
    const total = params.bars.length;
    const folds = Math.max(2, params.walkForwardFolds);
    const embargo = Math.max(1, params.embargoBars);
    if (total < embargo * folds + 30) {
      return { oosExpectancyR: 0, isSufficientData: false };
    }
    const foldLength = Math.floor(total / folds);
    const oosReturns: number[] = [];
    const candidates =
      params.candidateStrategies && params.candidateStrategies.length > 0
        ? params.candidateStrategies
        : [params.primaryStrategy];

    for (let f = 1; f < folds; f += 1) {
      const trainBars = params.bars.slice(0, f * foldLength);
      // Purge and embargo: remove the last embargo bars of the train fold
      const purgedTrainBars = trainBars.slice(0, Math.max(0, trainBars.length - embargo));
      if (purgedTrainBars.length <= embargo) {
        continue;
      }

      // Fit: select best candidate on purged training data
      let bestCandidate = params.primaryStrategy;
      let bestInSampleScore = -Infinity;
      for (const candidate of candidates) {
        const trainSim = this.simulateWindow({
          instrumentId: params.instrumentId,
          instrumentSpec: params.instrumentSpec,
          timeframe: params.timeframe,
          strategy: candidate,
          bars: purgedTrainBars,
          initialEquityUsdt: params.initialEquityUsdt,
          riskFraction: params.riskFraction,
          maxLeverage: params.maxLeverage,
          slippageBps: params.slippageBps,
          totalOneWayCostBps: params.totalOneWayCostBps,
          costStressMultiplier: params.costStressMultiplier
        });
        const score = trainSim.stressNetExpectancyR;
        if (score > bestInSampleScore) {
          bestInSampleScore = score;
          bestCandidate = candidate;
        }
      }

      // Out-of-sample validation on fold f
      const valStart = f * foldLength;
      const valEnd = f === folds - 1 ? total : (f + 1) * foldLength;
      const valBars = params.bars.slice(valStart, valEnd);
      if (valBars.length > 0) {
        const valSim = this.simulateWindow({
          instrumentId: params.instrumentId,
          instrumentSpec: params.instrumentSpec,
          timeframe: params.timeframe,
          strategy: bestCandidate,
          bars: valBars,
          initialEquityUsdt: params.initialEquityUsdt,
          riskFraction: params.riskFraction,
          maxLeverage: params.maxLeverage,
          slippageBps: params.slippageBps,
          totalOneWayCostBps: params.totalOneWayCostBps,
          costStressMultiplier: params.costStressMultiplier
        });
        for (const t of valSim.trades) {
          oosReturns.push(t.netR);
        }
      }
    }

    if (oosReturns.length === 0) {
      return { oosExpectancyR: 0, isSufficientData: false };
    }
    const avg = oosReturns.reduce((acc, r) => acc + r, 0) / oosReturns.length;
    return { oosExpectancyR: Number(avg.toFixed(6)), isSufficientData: true };
  }
}
