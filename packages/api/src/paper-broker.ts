import {
  RiskGuardian,
  ScaledDecimal,
  computeMarketExitPrice,
  computeNextBarOpenEntry,
  defaultInstrumentSpec,
  evaluateIntrabarExit,
  getUtcDayStartMs,
  type BarTimeframe,
  type Broker,
  type CircuitBreakerRecord,
  type Clock,
  type ConfirmedBar,
  type InstrumentSpec,
  type LedgerRepository,
  type PaperAccountRepository,
  type PaperOrderRecord,
  type PaperPositionRecord,
  type PaperTickResult,
  type PortfolioRiskState,
  type Proposal,
  type RiskConfig,
  type SettledFundingRate,
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
  /** Notified after the Risk Engine trips the circuit breaker (e.g. to run a Kill Switch Flatten). */
  readonly onCircuitBreakerTripped?: ((record: CircuitBreakerRecord) => void) | undefined;
}

export { type PaperTickResult };

/**
 * Deterministic PaperBroker (ADR-0006).
 * Enforces:
 * 1. Attached ProtectiveStop validation for every position entry.
 * 2. Conservative intrabar stop-loss precedence over take-profit.
 * 3. Periodic 8h settled funding and mark-to-market unrealized PnL updates.
 * 4. Exact double-entry ledger bookkeeping for cash, fees, funding, and realized PnL.
 * 5. CircuitBreaker manual kill-switch and re-arm.
 */
export class PaperBroker implements Broker {
  private readonly clock: Clock;
  private readonly ledgerRepo: LedgerRepository;
  private readonly paperAccountRepo: PaperAccountRepository;
  private readonly getRiskConfig: () => RiskConfig;
  private readonly onCircuitBreakerTripped: ((record: CircuitBreakerRecord) => void) | undefined;
  private readonly chooser = new BaselineChooser();
  private readonly totalFeeRateBps: number;
  private readonly slippageBps: number;

  public constructor(options: PaperBrokerOptions) {
    this.clock = options.clock;
    this.ledgerRepo = options.ledgerRepo;
    this.paperAccountRepo = options.paperAccountRepo;
    this.getRiskConfig = options.getRiskConfig;
    this.onCircuitBreakerTripped = options.onCircuitBreakerTripped;
    const taker = options.takerFeeBps ?? 5;
    const spread = options.halfSpreadBps ?? 2;
    const slippage = options.slippageBps ?? 3;
    this.slippageBps = slippage;
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
    readonly settledFundingRates?: readonly SettledFundingRate[] | undefined;
    /** Other markets' confirmed 1H bars the strategy reads, as of this bar's close. */
    readonly referenceBars?: Readonly<Record<string, readonly ConfirmedBar[]>> | undefined;
  }): PaperTickResult {
    const { bar, strategy } = params;
    const spec = params.spec ?? defaultInstrumentSpec(bar.instrumentId);
    const asOfMs = bar.closeTs;
    const positionsClosed: PaperPositionRecord[] = [];
    const positionsOpened: PaperPositionRecord[] = [];
    const vetoedProposals: { proposal: Proposal; reason: string }[] = [];

    // Per-bar idempotency & anchor enforcement (C2): check if bar was already processed or is at/before anchor
    const strategyId = strategy?.strategyId;
    if (strategyId) {
      const anchorCloseTs = this.paperAccountRepo.getSchedulerAnchor({
        instrumentId: bar.instrumentId,
        strategyId
      });
      if (anchorCloseTs !== null && bar.closeTs <= anchorCloseTs) {
        return {
          asOfMs,
          barEvaluated: null,
          positionsClosed,
          positionsOpened,
          vetoedProposals,
          trialBalance: this.ledgerRepo.getTrialBalance()
        };
      }

      const lastCloseTs = this.paperAccountRepo.getLastProcessedBarCloseTs({
        instrumentId: bar.instrumentId,
        strategyId
      });
      if (lastCloseTs !== null && bar.closeTs <= lastCloseTs) {
        return {
          asOfMs,
          barEvaluated: null,
          positionsClosed,
          positionsOpened,
          vetoedProposals,
          trialBalance: this.ledgerRepo.getTrialBalance()
        };
      }
    }

    // 1. Next-Bar-Open Execution: Check if there is a pending proposal from the prior bar (M-A / ADR-0009)
    const pendingProp = strategyId
      ? this.paperAccountRepo.getPendingProposal({
          strategyId,
          instrumentId: bar.instrumentId
        })
      : null;

    if (pendingProp !== null) {
      const openPositions = this.paperAccountRepo.listOpenPositions();
      const hasOpenForInst = openPositions.some((p) => p.instrumentId === bar.instrumentId);
      if (!hasOpenForInst) {
        const exec = computeNextBarOpenEntry({
          side: pendingProp.side,
          barOpen: ScaledDecimal.fromString(bar.open),
          slippageBps: this.slippageBps,
          proposedEntryPrice: ScaledDecimal.fromString(pendingProp.entryPrice),
          proposedStopPrice: ScaledDecimal.fromString(pendingProp.protectiveStopPrice),
          proposedTpPrice: pendingProp.takeProfitPrice
            ? ScaledDecimal.fromString(pendingProp.takeProfitPrice)
            : null
        });

        const adjustedProp: Proposal = {
          ...pendingProp,
          entryPrice: exec.entryPrice.toFixed(8),
          protectiveStopPrice: exec.effectiveStopPrice.toFixed(8),
          takeProfitPrice: exec.effectiveTpPrice ? exec.effectiveTpPrice.toFixed(8) : null
        };

        const riskConfig = this.getRiskConfig();
        const guardian = new RiskGuardian(riskConfig);

        // Aggregate current open positions exposure & unrealized PnL
        let grossNotional = ScaledDecimal.zero();
        let netSignedNotional = ScaledDecimal.zero();
        const notionalByInstrument: Record<string, ScaledDecimal> = {};
        let strategyGrossNotional = ScaledDecimal.zero();
        let totalUnrealizedPnl = ScaledDecimal.zero();
        let strategyUnrealizedPnl = ScaledDecimal.zero();

        for (const p of openPositions) {
          const pContracts = ScaledDecimal.fromString(p.contracts);
          const pPrice = ScaledDecimal.fromString(p.entryPrice);
          const pSpec = defaultInstrumentSpec(p.instrumentId);
          const pNotional = pContracts.mul(pSpec.contractValue).mul(pPrice);

          grossNotional = grossNotional.add(pNotional);
          const signed = p.side === "long" ? pNotional : ScaledDecimal.zero().sub(pNotional);
          netSignedNotional = netSignedNotional.add(signed);

          const existingInst = notionalByInstrument[p.instrumentId] ?? ScaledDecimal.zero();
          notionalByInstrument[p.instrumentId] = existingInst.add(pNotional);

          const pUnrealized = ScaledDecimal.fromString(p.unrealizedPnlUsdt);
          totalUnrealizedPnl = totalUnrealizedPnl.add(pUnrealized);

          if (p.strategyId === adjustedProp.strategyId) {
            strategyGrossNotional = strategyGrossNotional.add(pNotional);
            strategyUnrealizedPnl = strategyUnrealizedPnl.add(pUnrealized);
          }
        }

        const dayStartMs = getUtcDayStartMs(asOfMs);
        const strategyMetrics = this.ledgerRepo.getRiskMetrics({
          asOfMs,
          strategyId: adjustedProp.strategyId,
          openUnrealizedPnlUsdt: strategyUnrealizedPnl
        });
        const portfolioMetrics = this.ledgerRepo.getRiskMetrics({
          asOfMs,
          strategyId: null,
          openUnrealizedPnlUsdt: totalUnrealizedPnl
        });
        const tradesTodayCount = this.paperAccountRepo.countFilledOrdersToday({
          sinceMs: dayStartMs,
          strategyId: adjustedProp.strategyId
        });

        const strategyState: StrategyRiskState = {
          strategyId: adjustedProp.strategyId,
          equityUsdt: strategyMetrics.currentEquityUsdt,
          dayStartEquityUsdt: strategyMetrics.dayStartEquityUsdt,
          weekStartEquityUsdt: strategyMetrics.weekStartEquityUsdt,
          highWaterMarkEquityUsdt: strategyMetrics.highWaterMarkEquityUsdt,
          currentGrossNotionalUsdt: strategyGrossNotional,
          tradesTodayCount,
          feesTodayUsdt: strategyMetrics.feesTodayUsdt
        };

        const portfolioState: PortfolioRiskState = {
          equityUsdt: portfolioMetrics.currentEquityUsdt,
          dayStartEquityUsdt: portfolioMetrics.dayStartEquityUsdt,
          highWaterMarkEquityUsdt: portfolioMetrics.highWaterMarkEquityUsdt,
          grossNotionalUsdt: grossNotional,
          netSignedNotionalUsdt: netSignedNotional,
          notionalByInstrumentUsdt: notionalByInstrument,
          circuitBreaker: this.paperAccountRepo.getCircuitBreaker()
        };

        const decision = guardian.evaluateProposal({
          proposal: adjustedProp,
          instrument: spec,
          strategyState,
          portfolioState,
          asOfMs
        });

        if (!decision.approved) {
          vetoedProposals.push({ proposal: adjustedProp, reason: decision.vetoReason });
          if (decision.triggeredCircuitBreaker) {
            this.paperAccountRepo.setCircuitBreaker(decision.triggeredCircuitBreaker);
            this.onCircuitBreakerTripped?.(decision.triggeredCircuitBreaker);
          }
        } else {
          const entryPrice = exec.entryPrice;
          const notional = decision.contracts.mul(spec.contractValue).mul(entryPrice);
          const entryFee = notional.mul(
            ScaledDecimal.fromString((this.totalFeeRateBps / 10_000).toFixed(8))
          );
          const existingPosCount = this.paperAccountRepo.listAllPositions().length;
          const posId = `pos-${adjustedProp.strategyId}-${asOfMs}-${existingPosCount + 1}`;

          // Record entry fee in double-entry ledger
          const txGroup = `open-${posId}`;
          if (entryFee.isPositive()) {
            this.ledgerRepo.recordJournal({
              txGroupId: txGroup,
              ts: asOfMs,
              strategyId: adjustedProp.strategyId,
              instrumentId: adjustedProp.instrumentId,
              debitAccount: "fees_expense:usdt",
              creditAccount: "cash:usdt",
              amountUsdt: entryFee.toFixed(8),
              description: `Entry execution fee on ${posId}`
            });
          }

          const newPos: PaperPositionRecord = {
            positionId: posId,
            strategyId: adjustedProp.strategyId,
            instrumentId: adjustedProp.instrumentId,
            side: adjustedProp.side,
            contracts: decision.contracts.toFixed(8),
            entryPrice: entryPrice.toFixed(8),
            protectiveStopPrice: decision.effectiveStopPrice.toFixed(8),
            takeProfitPrice: adjustedProp.takeProfitPrice,
            initialRiskUsdt: decision.initialRiskUsdt.toFixed(8),
            unrealizedPnlUsdt: "0.00000000",
            realizedPnlUsdt: "0.00000000",
            feesPaidUsdt: entryFee.toFixed(8),
            fundingPaidUsdt: "0.00000000",
            openedAtMs: bar.openTs,
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
            proposalId: adjustedProp.proposalId,
            strategyId: adjustedProp.strategyId,
            instrumentId: adjustedProp.instrumentId,
            side: adjustedProp.side,
            orderRole: "ENTRY",
            contracts: decision.contracts.toFixed(8),
            fillPrice: entryPrice.toFixed(8),
            protectiveStopPrice: decision.effectiveStopPrice.toFixed(8),
            feeUsdt: entryFee.toFixed(8),
            status: "FILLED",
            createdAtMs: bar.openTs
          });
        }
      }
      this.paperAccountRepo.savePendingProposal({
        strategyId: pendingProp.strategyId,
        instrumentId: bar.instrumentId,
        proposal: null
      });
    }

    // 2. Evaluate open positions against confirmed bar high/low & 8h settled funding (Gap-aware fills)
    const openPositions = this.paperAccountRepo.listOpenPositions();
    for (const pos of openPositions) {
      if (pos.instrumentId !== bar.instrumentId) continue;
      if (strategyId && pos.strategyId !== strategyId) continue;
      // N1: Evaluate exits only against bars that started on or after position openedAtMs.
      if (bar.openTs < pos.openedAtMs) continue;

      const stopPrice = ScaledDecimal.fromString(pos.protectiveStopPrice);
      const tpPrice = pos.takeProfitPrice ? ScaledDecimal.fromString(pos.takeProfitPrice) : null;
      const barOpen = ScaledDecimal.fromString(bar.open);
      const barHigh = ScaledDecimal.fromString(bar.high);
      const barLow = ScaledDecimal.fromString(bar.low);
      const barClose = ScaledDecimal.fromString(bar.close);
      const entryPrice = ScaledDecimal.fromString(pos.entryPrice);
      const contracts = ScaledDecimal.fromString(pos.contracts);

      // Settle periodic 8h funding (ADR-0001, ADR-0008)
      let updatedLastFundingTs = pos.lastFundingSettledTs;
      let totalFundingPaid = ScaledDecimal.fromString(pos.fundingPaidUsdt);
      if (params.settledFundingRates && params.settledFundingRates.length > 0) {
        for (const funding of params.settledFundingRates) {
          if (
            funding.instrumentId === pos.instrumentId &&
            funding.fundingTs > pos.lastFundingSettledTs &&
            funding.fundingTs <= asOfMs
          ) {
            const fundingRate = ScaledDecimal.fromString(funding.fundingRate);
            const positionNotional = contracts.mul(spec.contractValue).mul(barClose);
            const fundingPayment =
              pos.side === "long"
                ? positionNotional.mul(fundingRate)
                : ScaledDecimal.zero().sub(positionNotional.mul(fundingRate));

            if (fundingPayment.gt(ScaledDecimal.zero())) {
              this.ledgerRepo.recordJournal({
                txGroupId: `fund-${pos.positionId}-${funding.fundingTs}`,
                ts: funding.fundingTs,
                strategyId: pos.strategyId,
                instrumentId: pos.instrumentId,
                debitAccount: "funding_pnl:usdt",
                creditAccount: "cash:usdt",
                amountUsdt: fundingPayment.toFixed(8),
                description: `8h funding payment on ${pos.positionId} (${funding.fundingRate})`
              });
              totalFundingPaid = totalFundingPaid.add(fundingPayment);
            } else if (fundingPayment.lt(ScaledDecimal.zero())) {
              const creditAmt = fundingPayment.abs();
              this.ledgerRepo.recordJournal({
                txGroupId: `fund-${pos.positionId}-${funding.fundingTs}`,
                ts: funding.fundingTs,
                strategyId: pos.strategyId,
                instrumentId: pos.instrumentId,
                debitAccount: "cash:usdt",
                creditAccount: "funding_pnl:usdt",
                amountUsdt: creditAmt.toFixed(8),
                description: `8h funding receipt on ${pos.positionId} (${funding.fundingRate})`
              });
              totalFundingPaid = totalFundingPaid.sub(creditAmt);
            }
            if (funding.fundingTs > updatedLastFundingTs) {
              updatedLastFundingTs = funding.fundingTs;
            }
          }
        }
      }

      // Shared gap-aware exit evaluation with adverse stop slippage (M-A / ADR-0009 / ADR-0014)
      const exitRes = evaluateIntrabarExit({
        side: pos.side,
        barOpen,
        barHigh,
        barLow,
        stopPrice,
        tpPrice,
        slippageBps: this.slippageBps
      });

      if (exitRes.closed && exitRes.exitPrice !== null && exitRes.exitReason !== null) {
        const exitPrice = exitRes.exitPrice;
        const exitReason = exitRes.exitReason;
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
          feesPaidUsdt: totalFees.toFixed(8),
          fundingPaidUsdt: totalFundingPaid.toFixed(8),
          lastFundingSettledTs: updatedLastFundingTs
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
      } else {
        // Mark-to-market unrealized PnL refresh for ongoing position
        const unrealizedPnl =
          pos.side === "long"
            ? contracts.mul(spec.contractValue).mul(barClose.sub(entryPrice))
            : contracts.mul(spec.contractValue).mul(entryPrice.sub(barClose));

        this.paperAccountRepo.savePosition({
          ...pos,
          unrealizedPnlUsdt: unrealizedPnl.toFixed(8),
          fundingPaidUsdt: totalFundingPaid.toFixed(8),
          lastFundingSettledTs: updatedLastFundingTs
        });
      }
    }

    // 3. Evaluate Strategy Proposals on bar close if flat on instrument (saved for next-bar open)
    const activeOpenOnInstrument = this.paperAccountRepo
      .listOpenPositions()
      .filter((p) => p.instrumentId === bar.instrumentId);

    if (strategy && activeOpenOnInstrument.length === 0) {
      const menu = strategy.evaluate({
        instrumentId: bar.instrumentId,
        asOfMs,
        barsByTimeframe: params.featureBars ?? { [bar.timeframe]: [bar] },
        recentFundingRates: params.settledFundingRates ?? [],
        ...(params.referenceBars ? { referenceBars: params.referenceBars } : {})
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

          const currentOpen = this.paperAccountRepo.listOpenPositions();
          let grossNotional = ScaledDecimal.zero();
          let netSignedNotional = ScaledDecimal.zero();
          const notionalByInstrument: Record<string, ScaledDecimal> = {};
          let strategyGrossNotional = ScaledDecimal.zero();
          let totalUnrealizedPnl = ScaledDecimal.zero();
          let strategyUnrealizedPnl = ScaledDecimal.zero();

          for (const p of currentOpen) {
            const pContracts = ScaledDecimal.fromString(p.contracts);
            const pPrice = ScaledDecimal.fromString(p.entryPrice);
            const pSpec = defaultInstrumentSpec(p.instrumentId);
            const pNotional = pContracts.mul(pSpec.contractValue).mul(pPrice);

            grossNotional = grossNotional.add(pNotional);
            const signed = p.side === "long" ? pNotional : ScaledDecimal.zero().sub(pNotional);
            netSignedNotional = netSignedNotional.add(signed);

            const existingInst = notionalByInstrument[p.instrumentId] ?? ScaledDecimal.zero();
            notionalByInstrument[p.instrumentId] = existingInst.add(pNotional);

            const pUnrealized = ScaledDecimal.fromString(p.unrealizedPnlUsdt);
            totalUnrealizedPnl = totalUnrealizedPnl.add(pUnrealized);

            if (p.strategyId === prop.strategyId) {
              strategyGrossNotional = strategyGrossNotional.add(pNotional);
              strategyUnrealizedPnl = strategyUnrealizedPnl.add(pUnrealized);
            }
          }

          const dayStartMs = getUtcDayStartMs(asOfMs);
          const strategyMetrics = this.ledgerRepo.getRiskMetrics({
            asOfMs,
            strategyId: prop.strategyId,
            openUnrealizedPnlUsdt: strategyUnrealizedPnl
          });
          const portfolioMetrics = this.ledgerRepo.getRiskMetrics({
            asOfMs,
            strategyId: null,
            openUnrealizedPnlUsdt: totalUnrealizedPnl
          });
          const tradesTodayCount = this.paperAccountRepo.countFilledOrdersToday({
            sinceMs: dayStartMs,
            strategyId: prop.strategyId
          });

          const strategyState: StrategyRiskState = {
            strategyId: prop.strategyId,
            equityUsdt: strategyMetrics.currentEquityUsdt,
            dayStartEquityUsdt: strategyMetrics.dayStartEquityUsdt,
            weekStartEquityUsdt: strategyMetrics.weekStartEquityUsdt,
            highWaterMarkEquityUsdt: strategyMetrics.highWaterMarkEquityUsdt,
            currentGrossNotionalUsdt: strategyGrossNotional,
            tradesTodayCount,
            feesTodayUsdt: strategyMetrics.feesTodayUsdt
          };

          const portfolioState: PortfolioRiskState = {
            equityUsdt: portfolioMetrics.currentEquityUsdt,
            dayStartEquityUsdt: portfolioMetrics.dayStartEquityUsdt,
            highWaterMarkEquityUsdt: portfolioMetrics.highWaterMarkEquityUsdt,
            grossNotionalUsdt: grossNotional,
            netSignedNotionalUsdt: netSignedNotional,
            notionalByInstrumentUsdt: notionalByInstrument,
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
              this.onCircuitBreakerTripped?.(decision.triggeredCircuitBreaker);
            }
          } else {
            this.paperAccountRepo.savePendingProposal({
              strategyId: prop.strategyId,
              instrumentId: bar.instrumentId,
              proposal: prop
            });
          }
        }
      }
    }

    if (strategyId) {
      this.paperAccountRepo.recordProcessedBar({
        instrumentId: bar.instrumentId,
        strategyId,
        closeTs: bar.closeTs
      });

      const strategyMetrics = this.ledgerRepo.getRiskMetrics({
        asOfMs,
        strategyId
      });
      this.ledgerRepo.recordEquitySnapshot({
        ts: asOfMs,
        strategyId,
        equityUsdt: strategyMetrics.currentEquityUsdt
      });
    }

    const portfolioMetrics = this.ledgerRepo.getRiskMetrics({
      asOfMs,
      strategyId: null
    });
    this.ledgerRepo.recordEquitySnapshot({
      ts: asOfMs,
      strategyId: null,
      equityUsdt: portfolioMetrics.currentEquityUsdt
    });

    return {
      asOfMs,
      barEvaluated: bar,
      positionsClosed,
      positionsOpened,
      vetoedProposals,
      trialBalance: this.ledgerRepo.getTrialBalance()
    };
  }

  /**
   * Closes every open position. With a mark price for an instrument the exit fills at that mark
   * and books the realized PnL; without one it exits at the entry price (fees only).
   */
  public flattenAllPositions(
    reason: string,
    markPrices: Readonly<Record<string, ScaledDecimal>> = {}
  ): readonly PaperPositionRecord[] {
    const asOfMs = this.clock.nowMs();
    const openPositions = this.paperAccountRepo.listOpenPositions();
    const closedPositions: PaperPositionRecord[] = [];

    for (const pos of openPositions) {
      const entryPrice = ScaledDecimal.fromString(pos.entryPrice);
      const contracts = ScaledDecimal.fromString(pos.contracts);
      const spec = defaultInstrumentSpec(pos.instrumentId);
      // Flat with market exit adverse slippage (ADR-0014)
      const mark = markPrices[pos.instrumentId];
      const exitMarket = computeMarketExitPrice({
        side: pos.side,
        marketPrice: mark ?? entryPrice,
        slippageBps: this.slippageBps
      });
      const exitPrice = exitMarket.exitPrice;
      const notional = contracts.mul(spec.contractValue).mul(exitPrice);
      const exitFee = notional.mul(
        ScaledDecimal.fromString((this.totalFeeRateBps / 10_000).toFixed(8))
      );
      const grossPnl =
        pos.side === "long"
          ? contracts.mul(spec.contractValue).mul(exitPrice.sub(entryPrice))
          : contracts.mul(spec.contractValue).mul(entryPrice.sub(exitPrice));

      const txGroup = `flatten-${pos.positionId}-${asOfMs}`;
      if (mark !== undefined && !grossPnl.isZero()) {
        const profit = grossPnl.isPositive();
        this.ledgerRepo.recordJournal({
          txGroupId: txGroup,
          ts: asOfMs,
          strategyId: pos.strategyId,
          instrumentId: pos.instrumentId,
          debitAccount: profit ? "cash:usdt" : "realized_pnl:usdt",
          creditAccount: profit ? "realized_pnl:usdt" : "cash:usdt",
          amountUsdt: grossPnl.abs().toFixed(8),
          description: `Flatten gross ${profit ? "profit" : "loss"} on ${pos.positionId} (${reason})`
        });
      }
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
        realizedPnlUsdt: mark !== undefined ? grossPnl.toFixed(8) : pos.realizedPnlUsdt,
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
