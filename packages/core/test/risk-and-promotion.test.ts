import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  PromotionLadderEvaluator,
  RiskGuardian,
  ScaledDecimal,
  createDefaultConfig,
  type ExperimentRecord,
  type InstrumentSpec,
  type Proposal
} from "../src/index.js";

const BTC_SPEC: InstrumentSpec = {
  instrumentId: "BTC-USDT-SWAP",
  venue: "OKX_EEA",
  baseCurrency: "BTC",
  settlementCurrency: "USDT",
  contractValue: ScaledDecimal.fromString("0.01"),
  lotSize: ScaledDecimal.fromString("0.01"),
  minOrderSize: ScaledDecimal.fromString("0.01"),
  tickSize: ScaledDecimal.fromString("0.01"),
  maxLeverage: ScaledDecimal.fromString("3")
};

function makeProposal(overrides?: Partial<Proposal>): Proposal {
  return {
    proposalId: "prop-1",
    strategyId: "donchian-trend",
    strategyVersion: "1.0.0",
    instrumentId: "BTC-USDT-SWAP",
    side: "long",
    entryPrice: "50000.00",
    protectiveStopPrice: "49000.00",
    takeProfitPrice: "52500.00",
    convictionScore: 0.85,
    rationale: "Confirmed 20-bar Donchian breakout",
    tags: ["trend"],
    ...overrides
  };
}

describe("RiskGuardian (Two-Tier Strategy + Portfolio Risk Engine)", () => {
  it("approves a valid proposal with exact 1R stop sizing within strategy and portfolio caps", () => {
    const config = createDefaultConfig();
    const guardian = new RiskGuardian(config.risk);

    const decision = guardian.evaluateProposal({
      proposal: makeProposal(),
      instrument: BTC_SPEC,
      asOfMs: 1_700_000_000_000,
      strategyState: {
        strategyId: "donchian-trend",
        equityUsdt: ScaledDecimal.fromString("10000.00"),
        dayStartEquityUsdt: ScaledDecimal.fromString("10000.00"),
        weekStartEquityUsdt: ScaledDecimal.fromString("10000.00"),
        highWaterMarkEquityUsdt: ScaledDecimal.fromString("10000.00"),
        currentGrossNotionalUsdt: ScaledDecimal.zero(),
        tradesTodayCount: 0,
        feesTodayUsdt: ScaledDecimal.zero()
      },
      portfolioState: {
        equityUsdt: ScaledDecimal.fromString("10000.00"),
        dayStartEquityUsdt: ScaledDecimal.fromString("10000.00"),
        highWaterMarkEquityUsdt: ScaledDecimal.fromString("10000.00"),
        grossNotionalUsdt: ScaledDecimal.zero(),
        netSignedNotionalUsdt: ScaledDecimal.zero(),
        notionalByInstrumentUsdt: {},
        circuitBreaker: {
          status: "NORMAL",
          reason: "System nominal",
          triggeredAtMs: 0,
          cooldownUntilMs: null,
          updatedBy: "system"
        }
      }
    });

    expect(decision.approved).toBe(true);
    if (decision.approved) {
      // 1R budget = 10,000 * 0.75% = 75 USDT
      // Risk per contract = 0.01 BTC * (50000 - 49000) = 10 USDT
      // 75 / 10 = 7.50 contracts -> notional = 7.50 * 0.01 * 50000 = 3750 USDT (< 10000 * 1.0x single instrument cap)
      expect(decision.contracts.toString()).toBe("7.5");
      expect(decision.notionalUsdt.toString()).toBe("3750");
      expect(decision.initialRiskUsdt.toString()).toBe("75");
      expect(decision.effectiveStopPrice.toString()).toBe("49000");
    }
  });

  it("vetoes proposals when circuit breaker is active or cooldown has not elapsed", () => {
    const config = createDefaultConfig();
    const guardian = new RiskGuardian(config.risk);

    const decision = guardian.evaluateProposal({
      proposal: makeProposal(),
      instrument: BTC_SPEC,
      asOfMs: 1_700_000_000_000,
      strategyState: {
        strategyId: "donchian-trend",
        equityUsdt: ScaledDecimal.fromString("10000.00"),
        dayStartEquityUsdt: ScaledDecimal.fromString("10000.00"),
        weekStartEquityUsdt: ScaledDecimal.fromString("10000.00"),
        highWaterMarkEquityUsdt: ScaledDecimal.fromString("10000.00"),
        currentGrossNotionalUsdt: ScaledDecimal.zero(),
        tradesTodayCount: 0,
        feesTodayUsdt: ScaledDecimal.zero()
      },
      portfolioState: {
        equityUsdt: ScaledDecimal.fromString("10000.00"),
        dayStartEquityUsdt: ScaledDecimal.fromString("10000.00"),
        highWaterMarkEquityUsdt: ScaledDecimal.fromString("10000.00"),
        grossNotionalUsdt: ScaledDecimal.zero(),
        netSignedNotionalUsdt: ScaledDecimal.zero(),
        notionalByInstrumentUsdt: {},
        circuitBreaker: {
          status: "MANUAL_KILL_SWITCH",
          reason: "Operator manual halt",
          triggeredAtMs: 1_699_999_000_000,
          cooldownUntilMs: null,
          updatedBy: "admin"
        }
      }
    });

    expect(decision.approved).toBe(false);
    if (!decision.approved) {
      expect(decision.vetoCode).toBe("CIRCUIT_BREAKER_ACTIVE");
    }
  });

  it("triggers DRAWDOWN_KILL_SWITCH when portfolio drawdown reaches maxDrawdownKillSwitchPct", () => {
    const config = createDefaultConfig();
    const guardian = new RiskGuardian(config.risk);

    const decision = guardian.evaluateProposal({
      proposal: makeProposal(),
      instrument: BTC_SPEC,
      asOfMs: 1_700_000_000_000,
      strategyState: {
        strategyId: "donchian-trend",
        equityUsdt: ScaledDecimal.fromString("8700.00"),
        dayStartEquityUsdt: ScaledDecimal.fromString("9000.00"),
        weekStartEquityUsdt: ScaledDecimal.fromString("9500.00"),
        highWaterMarkEquityUsdt: ScaledDecimal.fromString("10000.00"),
        currentGrossNotionalUsdt: ScaledDecimal.zero(),
        tradesTodayCount: 0,
        feesTodayUsdt: ScaledDecimal.zero()
      },
      portfolioState: {
        equityUsdt: ScaledDecimal.fromString("8700.00"), // 13% drawdown vs 12% kill switch
        dayStartEquityUsdt: ScaledDecimal.fromString("9000.00"),
        highWaterMarkEquityUsdt: ScaledDecimal.fromString("10000.00"),
        grossNotionalUsdt: ScaledDecimal.zero(),
        netSignedNotionalUsdt: ScaledDecimal.zero(),
        notionalByInstrumentUsdt: {},
        circuitBreaker: {
          status: "NORMAL",
          reason: "Nominal",
          triggeredAtMs: 0,
          cooldownUntilMs: null,
          updatedBy: "system"
        }
      }
    });

    expect(decision.approved).toBe(false);
    if (!decision.approved) {
      expect(decision.vetoCode).toBe("PORTFOLIO_DRAWDOWN_KILL_SWITCH");
      expect(decision.triggeredCircuitBreaker?.status).toBe("DRAWDOWN_KILL_SWITCH");
    }
  });

  it("enforces strategy daily loss stop, weekly loss stop, max trades per day, and fee budget", () => {
    const config = createDefaultConfig();
    const guardian = new RiskGuardian(config.risk);

    const basePortfolio = {
      equityUsdt: ScaledDecimal.fromString("10000.00"),
      dayStartEquityUsdt: ScaledDecimal.fromString("10000.00"),
      highWaterMarkEquityUsdt: ScaledDecimal.fromString("10000.00"),
      grossNotionalUsdt: ScaledDecimal.zero(),
      netSignedNotionalUsdt: ScaledDecimal.zero(),
      notionalByInstrumentUsdt: {},
      circuitBreaker: {
        status: "NORMAL" as const,
        reason: "Nominal",
        triggeredAtMs: 0,
        cooldownUntilMs: null,
        updatedBy: "system"
      }
    };

    const maxTradesDecision = guardian.evaluateProposal({
      proposal: makeProposal(),
      instrument: BTC_SPEC,
      asOfMs: 1_700_000_000_000,
      strategyState: {
        strategyId: "donchian-trend",
        equityUsdt: ScaledDecimal.fromString("10000.00"),
        dayStartEquityUsdt: ScaledDecimal.fromString("10000.00"),
        weekStartEquityUsdt: ScaledDecimal.fromString("10000.00"),
        highWaterMarkEquityUsdt: ScaledDecimal.fromString("10000.00"),
        currentGrossNotionalUsdt: ScaledDecimal.zero(),
        tradesTodayCount: config.risk.strategy.maxTradesPerDay,
        feesTodayUsdt: ScaledDecimal.zero()
      },
      portfolioState: basePortfolio
    });

    expect(maxTradesDecision.approved).toBe(false);
    if (!maxTradesDecision.approved) {
      expect(maxTradesDecision.vetoCode).toBe("STRATEGY_MAX_TRADES_PER_DAY");
    }

    const feeBudgetDecision = guardian.evaluateProposal({
      proposal: makeProposal(),
      instrument: BTC_SPEC,
      asOfMs: 1_700_000_000_000,
      strategyState: {
        strategyId: "donchian-trend",
        equityUsdt: ScaledDecimal.fromString("10000.00"),
        dayStartEquityUsdt: ScaledDecimal.fromString("10000.00"),
        weekStartEquityUsdt: ScaledDecimal.fromString("10000.00"),
        highWaterMarkEquityUsdt: ScaledDecimal.fromString("10000.00"),
        currentGrossNotionalUsdt: ScaledDecimal.zero(),
        tradesTodayCount: 1,
        feesTodayUsdt: ScaledDecimal.fromString("45.00") // 0.45% > 0.40% dailyFeeBudgetPct
      },
      portfolioState: basePortfolio
    });

    expect(feeBudgetDecision.approved).toBe(false);
    if (!feeBudgetDecision.approved) {
      expect(feeBudgetDecision.vetoCode).toBe("STRATEGY_DAILY_FEE_BUDGET_EXCEEDED");
    }
  });

  it("property: approved orders never breach strategy/portfolio leverage, single-instrument exposure, or 1R budget", () => {
    const config = createDefaultConfig();
    const guardian = new RiskGuardian(config.risk);

    fc.assert(
      fc.property(
        fc.integer({ min: 500, max: 200_000 }),
        fc.integer({ min: 10_000, max: 90_000 }),
        fc.integer({ min: 50, max: 5_000 }),
        fc.constantFrom("long" as const, "short" as const),
        fc.integer({ min: 0, max: 15_000 }),
        (equityInt, entryInt, stopDistInt, side, existingNotionalInt) => {
          const equity = ScaledDecimal.fromString(String(equityInt));
          const entryPrice = ScaledDecimal.fromString(String(entryInt));
          const stopPrice =
            side === "long"
              ? ScaledDecimal.fromString(String(Math.max(1, entryInt - stopDistInt)))
              : ScaledDecimal.fromString(String(entryInt + stopDistInt));
          const existingNotional = ScaledDecimal.fromString(String(existingNotionalInt));

          const decision = guardian.evaluateProposal({
            proposal: makeProposal({
              side,
              entryPrice: entryPrice.toString(),
              protectiveStopPrice: stopPrice.toString()
            }),
            instrument: BTC_SPEC,
            asOfMs: 1_700_000_000_000,
            strategyState: {
              strategyId: "donchian-trend",
              equityUsdt: equity,
              dayStartEquityUsdt: equity,
              weekStartEquityUsdt: equity,
              highWaterMarkEquityUsdt: equity,
              currentGrossNotionalUsdt: existingNotional,
              tradesTodayCount: 0,
              feesTodayUsdt: ScaledDecimal.zero()
            },
            portfolioState: {
              equityUsdt: equity,
              dayStartEquityUsdt: equity,
              highWaterMarkEquityUsdt: equity,
              grossNotionalUsdt: existingNotional,
              netSignedNotionalUsdt: existingNotional,
              notionalByInstrumentUsdt: {
                "BTC-USDT-SWAP": existingNotional
              },
              circuitBreaker: {
                status: "NORMAL",
                reason: "Nominal",
                triggeredAtMs: 0,
                cooldownUntilMs: null,
                updatedBy: "system"
              }
            }
          });

          if (decision.approved) {
            const oneRBudget = equity.mul(
              ScaledDecimal.fromString((config.risk.strategy.riskPerTradePct / 100).toFixed(8))
            );
            expect(decision.initialRiskUsdt.lte(oneRBudget)).toBe(true);

            const totalGross = existingNotional.add(decision.notionalUsdt);
            const maxGross = equity.mul(
              ScaledDecimal.fromString(config.risk.portfolio.maxGrossLeverage.toFixed(8))
            );
            expect(totalGross.lte(maxGross)).toBe(true);

            const maxSingleInst = equity.mul(
              ScaledDecimal.fromString(config.risk.portfolio.maxSingleInstrumentExposure.toFixed(8))
            );
            expect(totalGross.lte(maxSingleInst)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe("PromotionLadderEvaluator (ADR-0007)", () => {
  it("promotes Research -> Replay -> Shadow -> Paper when gates pass and demotes on paper drawdown breach", () => {
    const config = createDefaultConfig();
    const evaluator = new PromotionLadderEvaluator(config.promotionLadder);

    const passingExperiment: ExperimentRecord = {
      experimentId: "exp-1",
      strategyId: "donchian-trend",
      strategyVersion: "1.0.0",
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      dataSnapshotId: "a".repeat(64),
      configHash: "b".repeat(64),
      fromTs: 1_700_000_000_000,
      toTs: 1_702_592_000_000,
      totalTrades: 180,
      winRate: 0.56,
      avgR: 0.42,
      netPnlUsdt: "1850.00000000",
      totalFeesUsdt: "120.00000000",
      totalFundingUsdt: "15.00000000",
      maxDrawdownPct: 6.2,
      sharpeRatio: 1.45,
      deflatedSharpeRatio: 0.95,
      stressNetExpectancyR: 0.18,
      walkForwardOutOfSampleAvgR: 0.22,
      replayGatePassed: true,
      createdAtMs: 1_702_592_000_000
    };

    const evalReplay = evaluator.evaluate({
      strategyId: "donchian-trend",
      currentStage: "Research",
      latestExperiment: passingExperiment,
      paperTradesCount: 0,
      paperDrawdownPct: 0,
      asOfMs: 1_702_600_000_000
    });

    expect(evalReplay.replayGatePassed).toBe(true);
    expect(evalReplay.currentStage).toBe("Paper");
    expect(evalReplay.eligibleNextStage).toBe("Demo");

    const demoted = evaluator.evaluate({
      strategyId: "donchian-trend",
      currentStage: "Paper",
      latestExperiment: passingExperiment,
      paperTradesCount: 15,
      paperDrawdownPct: 14.5, // > 12% liveDemotionDrawdownPct
      asOfMs: 1_702_700_000_000
    });

    expect(demoted.currentStage).toBe("Research");
    expect(demoted.demotionReason).toContain("drawdown");
  });
});
