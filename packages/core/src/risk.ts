import type { PromotionLadderConfig, RiskConfig } from "./config.js";
import { ScaledDecimal } from "./decimal.js";
import type {
  CircuitBreakerRecord,
  ExperimentRecord,
  PromotionStage,
  Proposal,
  StrategyPromotionRecord
} from "./ports.js";
import { sizeByStopRisk, type InstrumentSpec } from "./sizing.js";

export interface StrategyRiskState {
  readonly strategyId: string;
  readonly equityUsdt: ScaledDecimal;
  readonly dayStartEquityUsdt: ScaledDecimal;
  readonly weekStartEquityUsdt: ScaledDecimal;
  readonly highWaterMarkEquityUsdt: ScaledDecimal;
  readonly currentGrossNotionalUsdt: ScaledDecimal;
  readonly tradesTodayCount: number;
  readonly feesTodayUsdt: ScaledDecimal;
  readonly allocationFraction?: ScaledDecimal | undefined;
}

export interface PortfolioRiskState {
  readonly equityUsdt: ScaledDecimal;
  readonly dayStartEquityUsdt: ScaledDecimal;
  readonly highWaterMarkEquityUsdt: ScaledDecimal;
  readonly grossNotionalUsdt: ScaledDecimal;
  readonly netSignedNotionalUsdt: ScaledDecimal;
  readonly notionalByInstrumentUsdt: Readonly<Record<string, ScaledDecimal>>;
  readonly circuitBreaker: CircuitBreakerRecord;
}

export type RiskVetoCode =
  | "CIRCUIT_BREAKER_ACTIVE"
  | "PORTFOLIO_DRAWDOWN_KILL_SWITCH"
  | "PORTFOLIO_DAILY_LOSS_HALT"
  | "STRATEGY_DRAWDOWN_HALT"
  | "STRATEGY_WEEKLY_LOSS_HALT"
  | "STRATEGY_DAILY_LOSS_HALT"
  | "STRATEGY_MAX_TRADES_PER_DAY"
  | "STRATEGY_DAILY_FEE_BUDGET_EXCEEDED"
  | "SIZING_VETO"
  | "STRATEGY_MAX_GROSS_LEVERAGE"
  | "PORTFOLIO_MAX_GROSS_LEVERAGE"
  | "PORTFOLIO_MAX_SINGLE_INSTRUMENT_EXPOSURE"
  | "PORTFOLIO_MAX_NET_DIRECTIONAL_EXPOSURE";

export type RiskDecision =
  | {
      readonly approved: true;
      readonly contracts: ScaledDecimal;
      readonly notionalUsdt: ScaledDecimal;
      readonly initialRiskUsdt: ScaledDecimal;
      readonly effectiveStopPrice: ScaledDecimal;
    }
  | {
      readonly approved: false;
      readonly vetoCode: RiskVetoCode;
      readonly vetoReason: string;
      readonly triggeredCircuitBreaker?: CircuitBreakerRecord | undefined;
    };

export function getUtcDayStartMs(ts: number): number {
  return Math.floor(ts / 86_400_000) * 86_400_000;
}

export function getUtcWeekStartMs(ts: number): number {
  const d = new Date(ts);
  const day = d.getUTCDay();
  const diffDays = day === 0 ? -6 : 1 - day;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diffDays);
}

function pctToFractionDecimal(pct: number): ScaledDecimal {
  return ScaledDecimal.fromString((pct / 100).toFixed(8));
}

function numToDecimal(val: number): ScaledDecimal {
  return ScaledDecimal.fromString(val.toFixed(8));
}

function computeDrawdownFraction(
  currentEquity: ScaledDecimal,
  referenceEquity: ScaledDecimal
): ScaledDecimal {
  if (!referenceEquity.isPositive() || currentEquity.gte(referenceEquity)) {
    return ScaledDecimal.zero();
  }
  return referenceEquity.sub(currentEquity).divFloor(referenceEquity);
}

/**
 * Two-Tier Deterministic Risk Guardian (Strategy Tier + Portfolio Tier, ADR-0002).
 * Strictly pure and deterministic: zero AI/LLM calls, exact ScaledDecimal accounting.
 */
export class RiskGuardian {
  private readonly config: RiskConfig;

  public constructor(config: RiskConfig) {
    this.config = config;
  }

  public evaluateProposal(input: {
    readonly proposal: Proposal;
    readonly instrument: InstrumentSpec;
    readonly strategyState: StrategyRiskState;
    readonly portfolioState: PortfolioRiskState;
    readonly asOfMs: number;
  }): RiskDecision {
    const { proposal, instrument, strategyState, portfolioState, asOfMs } = input;
    const cb = portfolioState.circuitBreaker;

    // 1. Check active Circuit Breaker / Kill Switch state
    if (cb.status !== "NORMAL") {
      const cooldownActive = cb.cooldownUntilMs === null || asOfMs < cb.cooldownUntilMs;
      if (
        cb.status === "MANUAL_KILL_SWITCH" ||
        cb.status === "DRAWDOWN_KILL_SWITCH" ||
        cooldownActive
      ) {
        return {
          approved: false,
          vetoCode: "CIRCUIT_BREAKER_ACTIVE",
          vetoReason: `Circuit breaker active (${cb.status}): ${cb.reason}`
        };
      }
    }

    // 2. Portfolio-Level Drawdown Kill Switch & Daily Loss Halt
    const portfolioDrawdown = computeDrawdownFraction(
      portfolioState.equityUsdt,
      portfolioState.highWaterMarkEquityUsdt
    );
    const portfolioKillSwitchFraction = pctToFractionDecimal(
      this.config.portfolio.maxDrawdownKillSwitchPct
    );
    if (portfolioDrawdown.gte(portfolioKillSwitchFraction)) {
      const triggered: CircuitBreakerRecord = {
        status: "DRAWDOWN_KILL_SWITCH",
        reason: `Portfolio drawdown reached kill-switch threshold (${this.config.portfolio.maxDrawdownKillSwitchPct}%)`,
        triggeredAtMs: asOfMs,
        cooldownUntilMs: null,
        updatedBy: "RiskGuardian"
      };
      return {
        approved: false,
        vetoCode: "PORTFOLIO_DRAWDOWN_KILL_SWITCH",
        vetoReason: triggered.reason,
        triggeredCircuitBreaker: triggered
      };
    }

    const portfolioDailyLoss = computeDrawdownFraction(
      portfolioState.equityUsdt,
      portfolioState.dayStartEquityUsdt
    );
    const portfolioDailyLossFraction = pctToFractionDecimal(this.config.portfolio.dailyLossStopPct);
    if (portfolioDailyLoss.gte(portfolioDailyLossFraction)) {
      const nextUtcMidnightMs = (Math.floor(asOfMs / 86_400_000) + 1) * 86_400_000;
      const triggered: CircuitBreakerRecord = {
        status: "DAILY_LOSS_HALT",
        reason: `Portfolio daily loss reached cap (${this.config.portfolio.dailyLossStopPct}%)`,
        triggeredAtMs: asOfMs,
        cooldownUntilMs: nextUtcMidnightMs,
        updatedBy: "RiskGuardian"
      };
      return {
        approved: false,
        vetoCode: "PORTFOLIO_DAILY_LOSS_HALT",
        vetoReason: triggered.reason,
        triggeredCircuitBreaker: triggered
      };
    }

    // 3. Strategy-Level Drawdown, Weekly Loss, Daily Loss, Trade Count, & Fee Budget
    const strategyDrawdown = computeDrawdownFraction(
      strategyState.equityUsdt,
      strategyState.highWaterMarkEquityUsdt
    );
    if (strategyDrawdown.gte(pctToFractionDecimal(this.config.strategy.maxDrawdownPct))) {
      return {
        approved: false,
        vetoCode: "STRATEGY_DRAWDOWN_HALT",
        vetoReason: `Strategy ${strategyState.strategyId} breached max drawdown (${this.config.strategy.maxDrawdownPct}%)`
      };
    }

    const strategyWeeklyLoss = computeDrawdownFraction(
      strategyState.equityUsdt,
      strategyState.weekStartEquityUsdt
    );
    if (strategyWeeklyLoss.gte(pctToFractionDecimal(this.config.strategy.weeklyLossStopPct))) {
      const triggered: CircuitBreakerRecord = {
        status: "WEEKLY_LOSS_HALT",
        reason: `Strategy ${strategyState.strategyId} breached weekly loss stop (${this.config.strategy.weeklyLossStopPct}%)`,
        triggeredAtMs: asOfMs,
        cooldownUntilMs: asOfMs + 48 * 3_600_000,
        updatedBy: "RiskGuardian"
      };
      return {
        approved: false,
        vetoCode: "STRATEGY_WEEKLY_LOSS_HALT",
        vetoReason: triggered.reason,
        triggeredCircuitBreaker: triggered
      };
    }

    const strategyDailyLoss = computeDrawdownFraction(
      strategyState.equityUsdt,
      strategyState.dayStartEquityUsdt
    );
    if (strategyDailyLoss.gte(pctToFractionDecimal(this.config.strategy.dailyLossStopPct))) {
      const nextUtcMidnightMs = (Math.floor(asOfMs / 86_400_000) + 1) * 86_400_000;
      const triggered: CircuitBreakerRecord = {
        status: "DAILY_LOSS_HALT",
        reason: `Strategy ${strategyState.strategyId} breached daily loss stop (${this.config.strategy.dailyLossStopPct}%)`,
        triggeredAtMs: asOfMs,
        cooldownUntilMs: nextUtcMidnightMs,
        updatedBy: "RiskGuardian"
      };
      return {
        approved: false,
        vetoCode: "STRATEGY_DAILY_LOSS_HALT",
        vetoReason: triggered.reason,
        triggeredCircuitBreaker: triggered
      };
    }

    if (strategyState.tradesTodayCount >= this.config.strategy.maxTradesPerDay) {
      return {
        approved: false,
        vetoCode: "STRATEGY_MAX_TRADES_PER_DAY",
        vetoReason: `Strategy ${strategyState.strategyId} reached maxTradesPerDay (${this.config.strategy.maxTradesPerDay})`
      };
    }

    const maxDailyFeeQuote = strategyState.dayStartEquityUsdt.mul(
      pctToFractionDecimal(this.config.strategy.dailyFeeBudgetPct)
    );
    if (strategyState.feesTodayUsdt.gte(maxDailyFeeQuote)) {
      return {
        approved: false,
        vetoCode: "STRATEGY_DAILY_FEE_BUDGET_EXCEEDED",
        vetoReason: `Strategy ${strategyState.strategyId} exhausted dailyFeeBudgetPct (${this.config.strategy.dailyFeeBudgetPct}%)`
      };
    }

    // 4. 1R Stop-Distance Sizing
    let entryPrice: ScaledDecimal;
    let stopPrice: ScaledDecimal;
    try {
      entryPrice = ScaledDecimal.fromString(proposal.entryPrice);
      stopPrice = ScaledDecimal.fromString(proposal.protectiveStopPrice);
    } catch {
      return {
        approved: false,
        vetoCode: "SIZING_VETO",
        vetoReason: "Invalid entryPrice or protectiveStopPrice decimal format"
      };
    }

    const strategyMaxGrossLev = numToDecimal(this.config.strategy.maxGrossLeverage);
    const sizing = sizeByStopRisk({
      instrument,
      side: proposal.side,
      strategyEquityQuote: strategyState.equityUsdt,
      riskFraction: pctToFractionDecimal(this.config.strategy.riskPerTradePct),
      entryPrice,
      stopPrice,
      maxGrossLeverage: strategyMaxGrossLev,
      allocationFraction: strategyState.allocationFraction
    });

    if (!sizing.ok) {
      return {
        approved: false,
        vetoCode: "SIZING_VETO",
        vetoReason: `1R stop sizing vetoed: ${sizing.vetoReason}`
      };
    }

    // 5. Strategy & Portfolio Exposure / Leverage Caps (including existing open positions)
    let maxStrategyGrossNotional = strategyState.equityUsdt.mul(strategyMaxGrossLev);
    if (strategyState.allocationFraction && strategyState.allocationFraction.isPositive()) {
      maxStrategyGrossNotional = maxStrategyGrossNotional.mul(strategyState.allocationFraction);
    }
    const projectedStrategyGross = strategyState.currentGrossNotionalUsdt.add(sizing.notionalQuote);
    if (projectedStrategyGross.gt(maxStrategyGrossNotional)) {
      return {
        approved: false,
        vetoCode: "STRATEGY_MAX_GROSS_LEVERAGE",
        vetoReason: `Projected strategy gross notional (${projectedStrategyGross.toString()}) exceeds strategy maxGrossLeverage (${this.config.strategy.maxGrossLeverage}x)`
      };
    }

    const maxPortfolioGrossNotional = portfolioState.equityUsdt.mul(
      numToDecimal(this.config.portfolio.maxGrossLeverage)
    );
    const projectedPortfolioGross = portfolioState.grossNotionalUsdt.add(sizing.notionalQuote);
    if (projectedPortfolioGross.gt(maxPortfolioGrossNotional)) {
      return {
        approved: false,
        vetoCode: "PORTFOLIO_MAX_GROSS_LEVERAGE",
        vetoReason: `Projected portfolio gross notional (${projectedPortfolioGross.toString()}) exceeds portfolio maxGrossLeverage (${this.config.portfolio.maxGrossLeverage}x)`
      };
    }

    const existingInstrumentNotional =
      portfolioState.notionalByInstrumentUsdt[proposal.instrumentId] ?? ScaledDecimal.zero();
    const projectedInstrumentNotional = existingInstrumentNotional.add(sizing.notionalQuote);
    const maxSingleInstrumentNotional = portfolioState.equityUsdt.mul(
      numToDecimal(this.config.portfolio.maxSingleInstrumentExposure)
    );
    if (projectedInstrumentNotional.gt(maxSingleInstrumentNotional)) {
      return {
        approved: false,
        vetoCode: "PORTFOLIO_MAX_SINGLE_INSTRUMENT_EXPOSURE",
        vetoReason: `Projected instrument notional (${projectedInstrumentNotional.toString()}) exceeds maxSingleInstrumentExposure (${this.config.portfolio.maxSingleInstrumentExposure}x)`
      };
    }

    const signedOrderNotional =
      proposal.side === "long"
        ? sizing.notionalQuote
        : ScaledDecimal.zero().sub(sizing.notionalQuote);
    const projectedNetDirectional = portfolioState.netSignedNotionalUsdt
      .add(signedOrderNotional)
      .abs();
    const maxNetDirectionalNotional = portfolioState.equityUsdt.mul(
      numToDecimal(this.config.portfolio.maxNetDirectionalExposure)
    );
    if (projectedNetDirectional.gt(maxNetDirectionalNotional)) {
      return {
        approved: false,
        vetoCode: "PORTFOLIO_MAX_NET_DIRECTIONAL_EXPOSURE",
        vetoReason: `Projected net directional exposure (${projectedNetDirectional.toString()}) exceeds maxNetDirectionalExposure (${this.config.portfolio.maxNetDirectionalExposure}x)`
      };
    }

    return {
      approved: true,
      contracts: sizing.contracts,
      notionalUsdt: sizing.notionalQuote,
      initialRiskUsdt: sizing.sizedRiskQuote,
      effectiveStopPrice: sizing.effectiveStopPrice
    };
  }
}

/**
 * Promotion Ladder Evaluator (ADR-0007).
 * Evaluates quantitative stage gates (Research -> Replay -> Shadow -> Paper -> Demo)
 * and enforces automatic demotion when drawdown exceeds `liveDemotionDrawdownPct`.
 */
export class PromotionLadderEvaluator {
  private readonly config: PromotionLadderConfig;

  public constructor(config: PromotionLadderConfig) {
    this.config = config;
  }

  public evaluate(input: {
    readonly strategyId: string;
    readonly currentStage: PromotionStage;
    readonly latestExperiment: ExperimentRecord | null;
    readonly paperTradesCount: number;
    readonly paperDrawdownPct: number;
    readonly asOfMs: number;
    readonly paperDurationDays?: number | undefined;
    readonly shadowDurationDays?: number | undefined;
    readonly shadowTradesCount?: number | undefined;
    readonly shadowExpectancyR?: number | undefined;
  }): StrategyPromotionRecord {
    const exp = input.latestExperiment;
    const replayGatePassed =
      exp !== null &&
      exp.replayGatePassed &&
      exp.totalTrades >= this.config.replayMinTrades &&
      exp.sharpeRatio >= this.config.replayMinSharpe &&
      exp.deflatedSharpeRatio >= this.config.replayMinDeflatedSharpeConfidence &&
      exp.stressNetExpectancyR > 0 &&
      exp.walkForwardOutOfSampleAvgR > 0;

    // Automatic demotion checks on drawdown breach
    // 1. Catastrophic drawdown: any stage demotes straight to Research
    if (input.paperDrawdownPct >= this.config.liveDemotionDrawdownPct) {
      return {
        strategyId: input.strategyId,
        currentStage: "Research",
        latestExperimentId: exp?.experimentId ?? null,
        replayGatePassed,
        paperTradesCount: input.paperTradesCount,
        paperDrawdownPct: input.paperDrawdownPct,
        rampAllocationPct: 0,
        eligibleNextStage: replayGatePassed ? "Paper" : "Replay",
        demotionReason: `Automatic demotion: catastrophic drawdown (${input.paperDrawdownPct.toFixed(2)}%) breached limit (${this.config.liveDemotionDrawdownPct}%)`,
        updatedAtMs: input.asOfMs
      };
    }

    // 2. Live stage moderate drawdown: demotes to Live-Ramp
    if (
      input.currentStage === "Live" &&
      input.paperDrawdownPct >= this.config.liveDemotionDrawdownPct / 2
    ) {
      return {
        strategyId: input.strategyId,
        currentStage: "Live-Ramp",
        latestExperimentId: exp?.experimentId ?? null,
        replayGatePassed,
        paperTradesCount: input.paperTradesCount,
        paperDrawdownPct: input.paperDrawdownPct,
        rampAllocationPct: 25,
        eligibleNextStage: "Live",
        demotionReason: `Automatic demotion: live drawdown (${input.paperDrawdownPct.toFixed(2)}%) breached ${(this.config.liveDemotionDrawdownPct / 2).toFixed(1)}% threshold`,
        updatedAtMs: input.asOfMs
      };
    }

    // 3. Live-Ramp stage drawdown: demotes to Demo
    if (
      input.currentStage === "Live-Ramp" &&
      input.paperDrawdownPct >= this.config.liveRampDemotionDrawdownPct
    ) {
      return {
        strategyId: input.strategyId,
        currentStage: "Demo",
        latestExperimentId: exp?.experimentId ?? null,
        replayGatePassed,
        paperTradesCount: input.paperTradesCount,
        paperDrawdownPct: input.paperDrawdownPct,
        rampAllocationPct: 0,
        eligibleNextStage: "Live-Ramp",
        demotionReason: `Automatic demotion: live-ramp drawdown (${input.paperDrawdownPct.toFixed(2)}%) exceeded ${this.config.liveRampDemotionDrawdownPct}% limit`,
        updatedAtMs: input.asOfMs
      };
    }

    let nextCurrentStage: PromotionStage = input.currentStage;
    let eligibleNextStage: PromotionStage | null = null;
    let rampAllocationPct = 100;

    if (input.currentStage === "Live") {
      rampAllocationPct = 100;
      eligibleNextStage = null;
    } else if (input.currentStage === "Live-Ramp") {
      if (input.paperTradesCount >= 40) {
        rampAllocationPct = 50;
      } else if (input.paperTradesCount >= 20) {
        rampAllocationPct = 25;
      } else {
        rampAllocationPct = 10;
      }
      if (
        input.paperTradesCount >= this.config.liveRampPromotionMinTrades &&
        input.paperDrawdownPct < this.config.liveRampDemotionDrawdownPct
      ) {
        eligibleNextStage = "Live";
      }
    } else if (input.currentStage === "Demo") {
      rampAllocationPct = 100;
      if (
        input.paperTradesCount >= this.config.demoPromotionMinTrades &&
        input.paperDrawdownPct < this.config.demoPromotionMaxDrawdownPct
      ) {
        eligibleNextStage = "Live-Ramp";
      }
    } else if (input.currentStage === "Paper") {
      rampAllocationPct = 100;
      const meetsPaperDays = (input.paperDurationDays ?? 0) >= this.config.paperMinDays;
      const meetsPaperTrades = input.paperTradesCount >= this.config.paperMinTrades;
      const safeDrawdown = input.paperDrawdownPct < this.config.liveDemotionDrawdownPct;
      if (replayGatePassed && meetsPaperDays && meetsPaperTrades && safeDrawdown) {
        eligibleNextStage = "Demo";
      } else {
        eligibleNextStage = null;
      }
    } else if (input.currentStage === "Shadow") {
      rampAllocationPct = 100;
      const meetsShadowDays = (input.shadowDurationDays ?? 0) >= this.config.shadowMinDays;
      const meetsShadowTrades = (input.shadowTradesCount ?? 0) >= this.config.shadowMinTrades;
      const nonNegativeExpectancy = (input.shadowExpectancyR ?? 0) >= 0;
      if (replayGatePassed && meetsShadowDays && meetsShadowTrades && nonNegativeExpectancy) {
        eligibleNextStage = "Paper";
      } else {
        eligibleNextStage = null;
      }
    } else if (replayGatePassed) {
      if (input.currentStage === "Research" || input.currentStage === "Replay") {
        nextCurrentStage = "Paper";
        const meetsPaperDays = (input.paperDurationDays ?? 0) >= this.config.paperMinDays;
        const meetsPaperTrades = input.paperTradesCount >= this.config.paperMinTrades;
        const safeDrawdown = input.paperDrawdownPct < this.config.liveDemotionDrawdownPct;
        if (meetsPaperDays && meetsPaperTrades && safeDrawdown) {
          eligibleNextStage = "Demo";
        } else {
          eligibleNextStage = null;
        }
      }
    } else if (exp !== null) {
      if (input.currentStage === "Research") {
        nextCurrentStage = "Replay";
      }
      eligibleNextStage = "Paper";
    } else {
      eligibleNextStage = "Replay";
    }

    return {
      strategyId: input.strategyId,
      currentStage: nextCurrentStage,
      latestExperimentId: exp?.experimentId ?? null,
      replayGatePassed,
      paperTradesCount: input.paperTradesCount,
      paperDrawdownPct: input.paperDrawdownPct,
      rampAllocationPct,
      eligibleNextStage,
      demotionReason: null,
      updatedAtMs: input.asOfMs
    };
  }
}
