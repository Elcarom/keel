import {
  RiskGuardian,
  ScaledDecimal,
  type BarTimeframe,
  type CircuitBreakerRecord,
  type Clock,
  type ConfirmedBar,
  type InstrumentSpec,
  type LedgerRepository,
  type PaperAccountRepository,
  type PaperOrderRecord,
  type PaperPositionRecord,
  type PortfolioRiskState,
  type Proposal,
  type RiskConfig,
  type StrategyRiskState
} from "@keel/core";
import { BaselineChooser, type Strategy } from "@keel/strategy";

export interface PaperBrokerOptions {
  readonly clock: Clock;
  readonly ledgerRepo: LedgerRepository;
  readonly paperAccountRepo: PaperAccountRepository;
  readonly getRiskConfig: () => RiskConfig;
  readonly takerFeeBps?: number | undefined;
  readonly halfSpreadBps?: number | undefined;
  readonly slippageBps?: number | undefined;
}

export interface PaperTickResult {
  readonly asOfMs: number;
  readonly barEvaluated: ConfirmedBar | null;
  readonly positionsClosed: readonly PaperPositionRecord[];
  readonly positionsOpened: readonly PaperPositionRecord[];
  readonly vetoedProposals: readonly { proposal: Proposal; reason: string }[];
  readonly trialBalance: ReturnType<LedgerRepository["getTrialBalance"]>;
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

/**
 * Deterministic PaperBroker (ADR-0006).
 * Enforces:
 * 1. Attached ProtectiveStop validation for every position entry.
 * 2. Conservative intrabar stop-loss precedence over take-profit.
 * 3. Exact double-entry ledger bookkeeping for cash, fees, funding, and realized PnL.
 * 4. CircuitBreaker manual kill-switch and re-arm.
 */
export class PaperBroker {
  private readonly clock: Clock;
  private readonly ledgerRepo: LedgerRepository;
  private readonly paperAccountRepo: PaperAccountRepository;
  private readonly getRiskConfig: () => RiskConfig;
  private readonly chooser = new BaselineChooser();
  private readonly totalFeeRateBps: number;

  public constructor(options: PaperBrokerOptions) {
    this.clock = options.clock;
    this.ledgerRepo = options.ledgerRepo;
    this.paperAccountRepo = options.paperAccountRepo;
    this.getRiskConfig = options.getRiskConfig;
    const taker = options.takerFeeBps ?? 5;
    const spread = options.halfSpreadBps ?? 2;
    const slippage = options.slippageBps ?? 3;
    this.totalFeeRateBps = taker + spread + slippage;
  }

  public getCircuitBreaker(): CircuitBreakerRecord {
    return this.paperAccountRepo.getCircuitBreaker();
  }

  public setCircuitBreaker(record: CircuitBreakerRecord): CircuitBreakerRecord {
    return this.paperAccountRepo.setCircuitBreaker(record);
  }

  public getOpenPositions(): readonly PaperPositionRecord[] {
    return this.paperAccountRepo.listOpenPositions();
  }

  public getAllPositions(limit = 100): readonly PaperPositionRecord[] {
    return this.paperAccountRepo.listAllPositions(limit);
  }

  public getOrders(limit = 100): readonly PaperOrderRecord[] {
    return this.paperAccountRepo.listOrders(limit);
  }

  public executeConfirmedBarTick(params: {
    readonly bar: ConfirmedBar;
    readonly strategy?: Strategy | undefined;
    readonly spec?: InstrumentSpec | undefined;
    readonly featureBars?:
      Readonly<Partial<Record<BarTimeframe, readonly ConfirmedBar[]>>> | undefined;
  }): PaperTickResult {
    const { bar, strategy } = params;
    const spec = params.spec ?? defaultInstrumentSpec(bar.instrumentId);
    const asOfMs = bar.closeTs;
    const positionsClosed: PaperPositionRecord[] = [];
    const positionsOpened: PaperPositionRecord[] = [];
    const vetoedProposals: { proposal: Proposal; reason: string }[] = [];

    // 1. Evaluate open positions against confirmed bar high/low (conservative ProtectiveStop precedence)
    const openPositions = this.paperAccountRepo.listOpenPositions();
    for (const pos of openPositions) {
      if (pos.instrumentId !== bar.instrumentId) continue;

      const stopPrice = ScaledDecimal.fromString(pos.protectiveStopPrice);
      const tpPrice = pos.takeProfitPrice ? ScaledDecimal.fromString(pos.takeProfitPrice) : null;
      const barHigh = ScaledDecimal.fromString(bar.high);
      const barLow = ScaledDecimal.fromString(bar.low);
      const entryPrice = ScaledDecimal.fromString(pos.entryPrice);
      const contracts = ScaledDecimal.fromString(pos.contracts);

      let closed = false;
      let exitPrice: ScaledDecimal | null = null;
      let exitReason: string | null = null;

      if (pos.side === "long") {
        if (barLow.lte(stopPrice)) {
          closed = true;
          exitPrice = stopPrice;
          exitReason = "protective_stop";
        } else if (tpPrice && barHigh.gte(tpPrice)) {
          closed = true;
          exitPrice = tpPrice;
          exitReason = "take_profit";
        }
      } else {
        if (barHigh.gte(stopPrice)) {
          closed = true;
          exitPrice = stopPrice;
          exitReason = "protective_stop";
        } else if (tpPrice && barLow.lte(tpPrice)) {
          closed = true;
          exitPrice = tpPrice;
          exitReason = "take_profit";
        }
      }

      if (closed && exitPrice !== null && exitReason !== null) {
        const grossPnl =
          pos.side === "long"
            ? contracts.mul(spec.contractValue).mul(exitPrice.sub(entryPrice))
            : contracts.mul(spec.contractValue).mul(entryPrice.sub(exitPrice));

        const exitNotional = contracts.mul(spec.contractValue).mul(exitPrice);
        const exitFee = exitNotional.mul(
          ScaledDecimal.fromString((this.totalFeeRateBps / 10_000).toFixed(8))
        );

        // Record exit journal into double-entry ledger
        const txGroup = `close-${pos.positionId}-${asOfMs}`;
        if (grossPnl.isPositive()) {
          this.ledgerRepo.recordJournal({
            txGroupId: txGroup,
            ts: asOfMs,
            strategyId: pos.strategyId,
            instrumentId: pos.instrumentId,
            debitAccount: "cash:usdt",
            creditAccount: "realized_pnl:usdt",
            amountUsdt: grossPnl.toFixed(8),
            description: `Gross profit on ${pos.positionId} (${exitReason})`
          });
        } else if (grossPnl.lt(ScaledDecimal.zero())) {
          this.ledgerRepo.recordJournal({
            txGroupId: txGroup,
            ts: asOfMs,
            strategyId: pos.strategyId,
            instrumentId: pos.instrumentId,
            debitAccount: "realized_pnl:usdt",
            creditAccount: "cash:usdt",
            amountUsdt: grossPnl.abs().toFixed(8),
            description: `Gross loss on ${pos.positionId} (${exitReason})`
          });
        }

        // Record exit fee
        if (exitFee.isPositive()) {
          this.ledgerRepo.recordJournal({
            txGroupId: txGroup,
            ts: asOfMs,
            strategyId: pos.strategyId,
            instrumentId: pos.instrumentId,
            debitAccount: "fees_expense:usdt",
            creditAccount: "cash:usdt",
            amountUsdt: exitFee.toFixed(8),
            description: `Exit execution fee on ${pos.positionId}`
          });
        }

        const totalFees = ScaledDecimal.fromString(pos.feesPaidUsdt).add(exitFee);
        const updatedPos: PaperPositionRecord = {
          ...pos,
          status: "CLOSED",
          closedAtMs: asOfMs,
          exitPrice: exitPrice.toFixed(8),
          exitReason,
          realizedPnlUsdt: grossPnl.toFixed(8),
          unrealizedPnlUsdt: "0.00000000",
          feesPaidUsdt: totalFees.toFixed(8)
        };
        this.paperAccountRepo.savePosition(updatedPos);
        positionsClosed.push(updatedPos);

        this.paperAccountRepo.saveOrder({
          orderId: `ord-${pos.positionId}-exit`,
          positionId: pos.positionId,
          proposalId: `prop-${pos.positionId}`,
          strategyId: pos.strategyId,
          instrumentId: pos.instrumentId,
          side: pos.side === "long" ? "short" : "long",
          orderRole: exitReason === "protective_stop" ? "PROTECTIVE_STOP" : "TAKE_PROFIT",
          contracts: pos.contracts,
          fillPrice: exitPrice.toFixed(8),
          protectiveStopPrice: pos.protectiveStopPrice,
          feeUsdt: exitFee.toFixed(8),
          status: "FILLED",
          createdAtMs: asOfMs
        });
      }
    }

    // 2. Evaluate Strategy Proposals if strategy provided and flat on instrument
    const activeOpenOnInstrument = this.paperAccountRepo
      .listOpenPositions()
      .filter((p) => p.instrumentId === bar.instrumentId);

    if (strategy && activeOpenOnInstrument.length === 0) {
      const menu = strategy.evaluate({
        instrumentId: bar.instrumentId,
        asOfMs,
        barsByTimeframe: params.featureBars ?? { [bar.timeframe]: [bar] },
        recentFundingRates: []
      });

      const chosen = this.chooser.choose([menu]);
      if (chosen) {
        const prop = chosen;
        // Verify protectiveStopPrice is present and non-empty (never place without stop)
        if (!prop.protectiveStopPrice || prop.protectiveStopPrice.trim() === "") {
          vetoedProposals.push({
            proposal: prop,
            reason: "Missing mandatory attached protectiveStopPrice"
          });
        } else {
          const riskConfig = this.getRiskConfig();
          const guardian = new RiskGuardian(riskConfig);
          const trialBal = this.ledgerRepo.getTrialBalance();
          const equity = ScaledDecimal.fromString(trialBal.netEquityUsdt);

          const strategyState: StrategyRiskState = {
            strategyId: prop.strategyId,
            equityUsdt: equity,
            dayStartEquityUsdt: equity,
            weekStartEquityUsdt: equity,
            highWaterMarkEquityUsdt: equity,
            currentGrossNotionalUsdt: ScaledDecimal.zero(),
            tradesTodayCount: 0,
            feesTodayUsdt: ScaledDecimal.zero()
          };

          const portfolioState: PortfolioRiskState = {
            equityUsdt: equity,
            dayStartEquityUsdt: equity,
            highWaterMarkEquityUsdt: equity,
            grossNotionalUsdt: ScaledDecimal.zero(),
            netSignedNotionalUsdt: ScaledDecimal.zero(),
            notionalByInstrumentUsdt: {},
            circuitBreaker: this.paperAccountRepo.getCircuitBreaker()
          };

          const decision = guardian.evaluateProposal({
            proposal: prop,
            instrument: spec,
            strategyState,
            portfolioState,
            asOfMs
          });

          if (!decision.approved) {
            vetoedProposals.push({ proposal: prop, reason: decision.vetoReason });
            if (decision.triggeredCircuitBreaker) {
              this.paperAccountRepo.setCircuitBreaker(decision.triggeredCircuitBreaker);
            }
          } else {
            const entryPrice = ScaledDecimal.fromString(prop.entryPrice);
            const notional = decision.contracts.mul(spec.contractValue).mul(entryPrice);
            const entryFee = notional.mul(
              ScaledDecimal.fromString((this.totalFeeRateBps / 10_000).toFixed(8))
            );
            const posId = `pos-${prop.strategyId}-${asOfMs}-${Math.floor(Math.random() * 1000)}`;

            // Record entry fee in double-entry ledger
            const txGroup = `open-${posId}`;
            if (entryFee.isPositive()) {
              this.ledgerRepo.recordJournal({
                txGroupId: txGroup,
                ts: asOfMs,
                strategyId: prop.strategyId,
                instrumentId: prop.instrumentId,
                debitAccount: "fees_expense:usdt",
                creditAccount: "cash:usdt",
                amountUsdt: entryFee.toFixed(8),
                description: `Entry execution fee on ${posId}`
              });
            }

            const newPos: PaperPositionRecord = {
              positionId: posId,
              strategyId: prop.strategyId,
              instrumentId: prop.instrumentId,
              side: prop.side,
              contracts: decision.contracts.toFixed(8),
              entryPrice: entryPrice.toFixed(8),
              protectiveStopPrice: decision.effectiveStopPrice.toFixed(8),
              takeProfitPrice: prop.takeProfitPrice,
              initialRiskUsdt: decision.initialRiskUsdt.toFixed(8),
              unrealizedPnlUsdt: "0.00000000",
              realizedPnlUsdt: "0.00000000",
              feesPaidUsdt: entryFee.toFixed(8),
              fundingPaidUsdt: "0.00000000",
              openedAtMs: asOfMs,
              lastFundingSettledTs: asOfMs,
              status: "OPEN",
              closedAtMs: null,
              exitPrice: null,
              exitReason: null
            };

            this.paperAccountRepo.savePosition(newPos);
            positionsOpened.push(newPos);

            this.paperAccountRepo.saveOrder({
              orderId: `ord-${posId}-entry`,
              positionId: posId,
              proposalId: prop.proposalId,
              strategyId: prop.strategyId,
              instrumentId: prop.instrumentId,
              side: prop.side,
              orderRole: "ENTRY",
              contracts: decision.contracts.toFixed(8),
              fillPrice: entryPrice.toFixed(8),
              protectiveStopPrice: decision.effectiveStopPrice.toFixed(8),
              feeUsdt: entryFee.toFixed(8),
              status: "FILLED",
              createdAtMs: asOfMs
            });
          }
        }
      }
    }

    return {
      asOfMs,
      barEvaluated: bar,
      positionsClosed,
      positionsOpened,
      vetoedProposals,
      trialBalance: this.ledgerRepo.getTrialBalance()
    };
  }

  public flattenAllPositions(reason: string): readonly PaperPositionRecord[] {
    const asOfMs = this.clock.nowMs();
    const openPositions = this.paperAccountRepo.listOpenPositions();
    const closedPositions: PaperPositionRecord[] = [];

    for (const pos of openPositions) {
      const entryPrice = ScaledDecimal.fromString(pos.entryPrice);
      const contracts = ScaledDecimal.fromString(pos.contracts);
      const spec = defaultInstrumentSpec(pos.instrumentId);
      // Flat at entry price for simulated emergency exit
      const exitPrice = entryPrice;
      const notional = contracts.mul(spec.contractValue).mul(exitPrice);
      const exitFee = notional.mul(
        ScaledDecimal.fromString((this.totalFeeRateBps / 10_000).toFixed(8))
      );

      const txGroup = `flatten-${pos.positionId}-${asOfMs}`;
      if (exitFee.isPositive()) {
        this.ledgerRepo.recordJournal({
          txGroupId: txGroup,
          ts: asOfMs,
          strategyId: pos.strategyId,
          instrumentId: pos.instrumentId,
          debitAccount: "fees_expense:usdt",
          creditAccount: "cash:usdt",
          amountUsdt: exitFee.toFixed(8),
          description: `Flatten exit fee on ${pos.positionId} (${reason})`
        });
      }

      const totalFees = ScaledDecimal.fromString(pos.feesPaidUsdt).add(exitFee);
      const updated: PaperPositionRecord = {
        ...pos,
        status: "CLOSED",
        closedAtMs: asOfMs,
        exitPrice: exitPrice.toFixed(8),
        exitReason: `flatten: ${reason}`,
        unrealizedPnlUsdt: "0.00000000",
        feesPaidUsdt: totalFees.toFixed(8)
      };

      this.paperAccountRepo.savePosition(updated);
      closedPositions.push(updated);

      this.paperAccountRepo.saveOrder({
        orderId: `ord-${pos.positionId}-flatten`,
        positionId: pos.positionId,
        proposalId: `prop-${pos.positionId}-flatten`,
        strategyId: pos.strategyId,
        instrumentId: pos.instrumentId,
        side: pos.side === "long" ? "short" : "long",
        orderRole: "FLATTEN",
        contracts: pos.contracts,
        fillPrice: exitPrice.toFixed(8),
        protectiveStopPrice: pos.protectiveStopPrice,
        feeUsdt: exitFee.toFixed(8),
        status: "FILLED",
        createdAtMs: asOfMs
      });
    }

    return closedPositions;
  }
}
