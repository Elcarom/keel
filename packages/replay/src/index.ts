import {
  ALL_BAR_TIMEFRAMES,
  ManualClock,
  ScaledDecimal,
  sha256Hex,
  sizeByStopRisk,
  type BarTimeframe,
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
}

export interface ReplayRunResult extends ExperimentRecord {
  readonly trades: readonly ReplayTradeRecord[];
}

function defaultInstrumentSpec(instrumentId: string): InstrumentSpec {
  const baseCurrency = instrumentId.split("-")[0] ?? "BTC";
  const contractValStr = baseCurrency === "ETH" ? "0.1" : "0.01";
  return {
    instrumentId,
    venue: "OKX_EEA",
    baseCurrency,
    settlementCurrency: "USDT",
    contractValue: ScaledDecimal.fromString(contractValStr),
    lotSize: ScaledDecimal.fromString("0.01"),
    minOrderSize: ScaledDecimal.fromString("0.01"),
    tickSize: ScaledDecimal.fromString("0.01"),
    maxLeverage: ScaledDecimal.fromString("3")
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

export function computeDeflatedSharpeRatio(params: {
  readonly returnsR: readonly number[];
  readonly numTrials?: number | undefined;
}): {
  readonly sharpeRatio: number;
  readonly deflatedSharpeRatio: number;
} {
  const returns = params.returnsR;
  const n = returns.length;
  if (n < 2) {
    return { sharpeRatio: 0, deflatedSharpeRatio: 0 };
  }
  const mean = returns.reduce((acc, r) => acc + r, 0) / n;
  const variance = returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(Math.max(1e-12, variance));
  const sr = mean / std;

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
    sharpeRatio: Number(sr.toFixed(6)),
    deflatedSharpeRatio: Number(dsr.toFixed(6))
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
      totalOneWayCostBps,
      costStressMultiplier
    });

    const oosExpectancyR = this.computePurgedWalkForwardOosExpectancy({
      instrumentId: input.instrumentId,
      instrumentSpec: spec,
      timeframe: input.timeframe,
      strategy: input.strategy,
      bars: allBars,
      embargoBars,
      walkForwardFolds,
      initialEquityUsdt,
      riskFraction,
      maxLeverage,
      totalOneWayCostBps,
      costStressMultiplier
    });

    const cumulativeTrials =
      input.numTrialsForDsr ??
      Math.max(1, (this.experimentRepo?.listExperiments(10_000).length ?? 0) + 1);

    const dsrMetrics = computeDeflatedSharpeRatio({
      returnsR: simulation.trades.map((t) => t.netR),
      numTrials: cumulativeTrials
    });

    const winCount = simulation.trades.filter((t) => t.netR > 0).length;
    const winRate =
      simulation.trades.length > 0 ? Number((winCount / simulation.trades.length).toFixed(4)) : 0;

    const minTrades = input.replayMinTrades ?? 5;
    const minSharpe = input.replayMinSharpe ?? 0.2;
    const minDsr = input.replayMinDeflatedSharpeConfidence ?? 0.5;

    const replayGatePassed =
      simulation.trades.length >= minTrades &&
      simulation.stressNetExpectancyR > 0 &&
      oosExpectancyR >= 0 &&
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
      walkForwardOutOfSampleAvgR: oosExpectancyR,
      replayGatePassed,
      createdAtMs
    };

    if (this.experimentRepo) {
      this.experimentRepo.saveExperiment(record);
    }

    return {
      ...record,
      trades: simulation.trades
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
    readonly totalOneWayCostBps: number;
    readonly costStressMultiplier: number;
  }): {
    readonly trades: readonly ReplayTradeRecord[];
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
    let maxDrawdownPct = 0;
    let totalFeesUsdt = ScaledDecimal.zero();
    let totalFundingUsdt = ScaledDecimal.zero();

    const trades: ReplayTradeRecord[] = [];
    let active: ActivePosition | null = null;

    const costFraction = ScaledDecimal.fromString((params.totalOneWayCostBps / 10_000).toFixed(8));
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

      const eqNum = Number(equityUsdt.toString());
      if (eqNum > peakEquityNum) {
        peakEquityNum = eqNum;
      } else if (peakEquityNum > 0) {
        const dd = ((peakEquityNum - eqNum) / peakEquityNum) * 100;
        if (dd > maxDrawdownPct) {
          maxDrawdownPct = dd;
        }
      }

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
      const barHigh = ScaledDecimal.fromString(bar.high);
      const barLow = ScaledDecimal.fromString(bar.low);
      const barClose = ScaledDecimal.fromString(bar.close);

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

        // 2. Conservative intrabar ProtectiveStop & take-profit check
        if (active.proposal.side === "long") {
          const stopHit = barLow.lte(active.protectiveStopPrice);
          const tpHit = active.takeProfitPrice !== null && barHigh.gte(active.takeProfitPrice);
          if (stopHit) {
            closePosition(active, nowMs, active.protectiveStopPrice, "stop");
            active = null;
          } else if (tpHit && active.takeProfitPrice) {
            closePosition(active, nowMs, active.takeProfitPrice, "take-profit");
            active = null;
          }
        } else {
          const stopHit = barHigh.gte(active.protectiveStopPrice);
          const tpHit = active.takeProfitPrice !== null && barLow.lte(active.takeProfitPrice);
          if (stopHit) {
            closePosition(active, nowMs, active.protectiveStopPrice, "stop");
            active = null;
          } else if (tpHit && active.takeProfitPrice) {
            closePosition(active, nowMs, active.takeProfitPrice, "take-profit");
            active = null;
          }
        }
      }

      // 3. When flat, build strictly causal FeatureSnapshot and evaluate Strategy
      if (!active && idx < bars.length - 1) {
        const snapshot = this.marketDataRepo.buildFeatureSnapshot({
          instrumentId: params.instrumentId,
          asOfMs: nowMs,
          requirements: params.strategy.lookbacks
        });
        const menu = params.strategy.evaluate(snapshot);
        const chosen = this.chooser.choose([menu]);
        if (chosen) {
          const entryPrice = ScaledDecimal.fromString(chosen.entryPrice);
          const stopPrice = ScaledDecimal.fromString(chosen.protectiveStopPrice);
          const sizing = sizeByStopRisk({
            instrument: spec,
            side: chosen.side,
            strategyEquityQuote: equityUsdt,
            riskFraction: riskFractionDec,
            entryPrice,
            stopPrice,
            maxGrossLeverage: maxLeverageDec
          });
          if (sizing.ok) {
            const entryFeeUsdt = sizing.notionalQuote.mul(costFraction);
            active = {
              proposal: chosen,
              entryTs: nowMs,
              entryPrice,
              protectiveStopPrice: sizing.effectiveStopPrice,
              takeProfitPrice: chosen.takeProfitPrice
                ? ScaledDecimal.fromString(chosen.takeProfitPrice)
                : null,
              contracts: sizing.contracts,
              initialRiskUsdt: sizing.sizedRiskQuote,
              entryFeeUsdt,
              fundingAccruedUsdt: ScaledDecimal.zero(),
              lastFundingTs: nowMs
            };
          }
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
    readonly strategy: Strategy;
    readonly bars: readonly ConfirmedBar[];
    readonly embargoBars: number;
    readonly walkForwardFolds: number;
    readonly initialEquityUsdt: ScaledDecimal;
    readonly riskFraction: number;
    readonly maxLeverage: number;
    readonly totalOneWayCostBps: number;
    readonly costStressMultiplier: number;
  }): number {
    const total = params.bars.length;
    const folds = Math.max(2, params.walkForwardFolds);
    const embargo = Math.max(1, params.embargoBars);
    if (total < embargo * folds + 20) {
      return 0;
    }
    const foldLength = Math.floor(total / folds);
    const oosReturns: number[] = [];

    for (let f = 0; f < folds; f += 1) {
      const startIdx = Math.min(total, f * foldLength + embargo);
      const endIdx = f === folds - 1 ? total : Math.min(total, (f + 1) * foldLength);
      const foldBars = params.bars.slice(startIdx, endIdx);
      if (foldBars.length > embargo) {
        const foldSim = this.simulateWindow({
          instrumentId: params.instrumentId,
          instrumentSpec: params.instrumentSpec,
          timeframe: params.timeframe,
          strategy: params.strategy,
          bars: foldBars,
          initialEquityUsdt: params.initialEquityUsdt,
          riskFraction: params.riskFraction,
          maxLeverage: params.maxLeverage,
          totalOneWayCostBps: params.totalOneWayCostBps,
          costStressMultiplier: params.costStressMultiplier
        });
        for (const t of foldSim.trades) {
          oosReturns.push(t.netR);
        }
      }
    }
    if (oosReturns.length === 0) {
      return 0;
    }
    const avg = oosReturns.reduce((acc, r) => acc + r, 0) / oosReturns.length;
    return Number(avg.toFixed(6));
  }
}
