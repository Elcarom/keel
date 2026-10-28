import {
  overlapsSealed2026Holdout,
  isExchangeExecutionMode,
  type Clock,
  type RiskConfig,
  type SystemConfig,
  type NotificationChannel,
  type ExchangeBroker
} from "@keel/core";
import { type SqliteDataStore, type OkxPublicIngestor } from "@keel/data";
import { resolveStrategyById } from "@keel/strategy";
import { type PaperBroker } from "./paper-broker.js";

export interface UnattendedSchedulerOptions {
  readonly clock: Clock;
  readonly dataStore: SqliteDataStore;
  readonly paperBroker: PaperBroker;
  readonly exchangeBroker?: ExchangeBroker | undefined;
  readonly ingestor?: OkxPublicIngestor | undefined;
  readonly getRiskConfig: () => RiskConfig;
  readonly getSystemConfig: () => SystemConfig;
  readonly notificationChannel?: NotificationChannel | undefined;
  readonly instruments?: readonly string[] | undefined;
  readonly strategies?: readonly string[] | undefined;
  readonly intervalMs?: number | undefined;
  /** Runs after every DMS heartbeat in exchange modes: watches Venue Book loss limits between orders. */
  readonly checkVenueBookRisk?: (() => Promise<void>) | undefined;
}

/**
 * DMS heartbeat cadence: 4 beats per 60s cancel-all-after countdown, on a timer of its own so a
 * slow bar step can never let the switch fire on a healthy engine (audit-3 H8).
 */
export const DMS_HEARTBEAT_INTERVAL_MS = 15_000;

export interface SchedulerStepResult {
  readonly ok: boolean;
  readonly timestampMs: number;
  readonly barsIngested: number;
  readonly ticksExecuted: number;
  readonly errors: readonly string[];
}

/**
 * Unattended Ingest & Tick Scheduler (M7).
 * Periodically ingests newly confirmed 1H market bars, steps strategy ticks,
 * audits execution, sends DMS heartbeats, and verifies exchange reconciliation.
 */
export class UnattendedScheduler {
  private readonly clock: Clock;
  private readonly dataStore: SqliteDataStore;
  private readonly paperBroker: PaperBroker;
  private readonly exchangeBroker: ExchangeBroker | null;
  private readonly ingestor: OkxPublicIngestor | null;
  private readonly getRiskConfig: () => RiskConfig;
  private readonly getSystemConfig: () => SystemConfig;
  private readonly notificationChannel: NotificationChannel | null;
  private readonly instruments: readonly string[];
  private readonly strategies: readonly string[];
  private readonly intervalMs: number;

  private timer: NodeJS.Timeout | null = null;
  private dmsTimer: NodeJS.Timeout | null = null;
  private isStepping = false;
  private isBeating = false;
  private readonly checkVenueBookRisk: (() => Promise<void>) | null;

  public constructor(options: UnattendedSchedulerOptions) {
    this.clock = options.clock;
    this.dataStore = options.dataStore;
    this.paperBroker = options.paperBroker;
    this.exchangeBroker = options.exchangeBroker ?? null;
    this.ingestor = options.ingestor ?? null;
    this.getRiskConfig = options.getRiskConfig;
    this.getSystemConfig = options.getSystemConfig;
    this.notificationChannel = options.notificationChannel ?? null;
    this.instruments = options.instruments ?? ["BTC-USDT-SWAP", "ETH-USDT-SWAP"];
    this.strategies = options.strategies ?? [];
    this.intervalMs = options.intervalMs ?? 60_000;
    this.checkVenueBookRisk = options.checkVenueBookRisk ?? null;
  }

  public isRunning(): boolean {
    return this.timer !== null;
  }

  public start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.stepOnce().catch(() => {});
    }, this.intervalMs);
    this.startHeartbeat();
  }

  /** Starts only the DMS heartbeat timer; idempotent, and stopped by stop(). */
  public startHeartbeat(): void {
    if (this.dmsTimer !== null) return;
    this.dmsTimer = setInterval(() => {
      void this.heartbeatOnce();
    }, DMS_HEARTBEAT_INTERVAL_MS);
    this.dmsTimer.unref();
  }

  /** Refreshes the exchange DMS countdown in exchange Execution Modes; alerts on failure. */
  public async heartbeatOnce(): Promise<void> {
    if (!this.exchangeBroker || !this.isExchangeMode() || this.isBeating) {
      return;
    }
    this.isBeating = true;
    try {
      await this.exchangeBroker.sendDmsHeartbeat();
    } catch (err) {
      if (this.notificationChannel) {
        const nowMs = this.clock.nowMs();
        void this.notificationChannel.send({
          severity: "CRITICAL",
          title: "DEAD-MAN SWITCH HEARTBEAT FAILED",
          body: `DMS heartbeat failed: ${String(err)}`,
          dedupKey: `dms-beat-fail-${Math.floor(nowMs / 300_000)}`
        });
      }
    }
    try {
      await this.checkVenueBookRisk?.();
    } catch (err) {
      if (this.notificationChannel) {
        const nowMs = this.clock.nowMs();
        void this.notificationChannel.send({
          severity: "CRITICAL",
          title: "VENUE BOOK RISK CHECK FAILED",
          body: `Venue Book loss-limit check failed: ${String(err)}`,
          dedupKey: `venue-risk-fail-${Math.floor(nowMs / 300_000)}`
        });
      }
    } finally {
      this.isBeating = false;
    }
  }

  private isExchangeMode(): boolean {
    return isExchangeExecutionMode(this.getSystemConfig().executionMode);
  }

  public stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.dmsTimer !== null) {
      clearInterval(this.dmsTimer);
      this.dmsTimer = null;
    }
  }

  public async stepOnce(): Promise<SchedulerStepResult> {
    if (this.isStepping) {
      return {
        ok: true,
        timestampMs: this.clock.nowMs(),
        barsIngested: 0,
        ticksExecuted: 0,
        errors: ["Scheduler step already in progress"]
      };
    }

    this.isStepping = true;
    const nowMs = this.clock.nowMs();
    let barsIngested = 0;
    let ticksExecuted = 0;
    const errors: string[] = [];

    try {
      // 0. Anchor newly enabled (instrument, strategy) pairs at the scheduler's current time (A1)
      // anchor_close_ts = floor(clock.nowMs()/1h)*1h (the close of the most recent fully closed bar).
      // Bars with closeTs <= anchor are never evaluated, regardless of stored coverage.
      // Anchor creation must not depend on whether the DB has any bars. Existing anchors are never moved.
      for (const instId of this.instruments) {
        for (const stratId of this.strategies) {
          const existingAnchor = this.dataStore.paperAccountRepo.getSchedulerAnchor({
            instrumentId: instId,
            strategyId: stratId
          });
          if (existingAnchor === null) {
            const anchorCloseTs = Math.floor(nowMs / 3600_000) * 3600_000;
            this.dataStore.paperAccountRepo.setSchedulerAnchor({
              instrumentId: instId,
              strategyId: stratId,
              anchorCloseTs,
              createdAtMs: nowMs
            });
            this.dataStore.paperAccountRepo.recordProcessedBar({
              instrumentId: instId,
              strategyId: stratId,
              closeTs: anchorCloseTs
            });
          }
        }
      }

      // 1. Ingest newly confirmed 1H bars for each tracked instrument
      for (const instId of this.instruments) {
        if (this.ingestor) {
          const latestBars = this.dataStore.marketDataRepo.getConfirmedBarsAsOf({
            instrumentId: instId,
            timeframe: "1H",
            asOfMs: nowMs,
            limit: 1
          });
          const latest = latestBars[0] ?? null;

          const fromOpenTs = latest ? latest.openTs + 3600_000 : nowMs - 48 * 3600_000;
          // AGENTS.md: Never compute signals on unconfirmed (forming) bars.
          // Only ingest bars strictly prior to the current forming bar.
          const toOpenTs = Math.floor(nowMs / 3600_000) * 3600_000 - 3600_000;

          if (toOpenTs >= fromOpenTs) {
            try {
              const res = await this.ingestor.ingestRange({
                instrumentId: instId,
                timeframe: "1H",
                fromOpenTs,
                toOpenTs
              });
              barsIngested += res.insertedCount;
            } catch (err) {
              errors.push(`Failed ingesting ${instId}: ${String(err)}`);
            }
          }
        }

        // 2. Step strategy evaluation on all unprocessed confirmed bars in chronological order (capped at 500 per step) (R6, C2)
        for (const stratId of this.strategies) {
          try {
            const strategy = resolveStrategyById(stratId);
            const anchorCloseTs = this.dataStore.paperAccountRepo.getSchedulerAnchor({
              instrumentId: instId,
              strategyId: stratId
            });
            const lastProcessedCloseTs = this.dataStore.paperAccountRepo.getLastProcessedBarCloseTs(
              {
                instrumentId: instId,
                strategyId: stratId
              }
            );

            // Bars at or before the anchor are never evaluated by the scheduler (C2)
            const minAllowedCloseTs = Math.max(anchorCloseTs ?? 0, lastProcessedCloseTs ?? 0);
            const fromOpenTs = minAllowedCloseTs;
            const candidateBars = this.dataStore.marketDataRepo.getConfirmedBarsInRange({
              instrumentId: instId,
              timeframe: "1H",
              fromOpenTs,
              toCloseTs: nowMs
            });

            const eligibleBars = [];
            for (const bar of candidateBars) {
              if (bar.closeTs <= minAllowedCloseTs) {
                continue;
              }

              // Scheduler never evaluates bars inside the sealed 2026 partition unless that is
              // the live present (closeTs within 2 hours of clock.nowMs()) (C2, A1, audit-4 M1)
              if (overlapsSealed2026Holdout(bar.openTs, bar.closeTs)) {
                const isLivePresent = Math.abs(nowMs - bar.closeTs) <= 2 * 3600_000;
                if (!isLivePresent) {
                  this.dataStore.paperAccountRepo.recordProcessedBar({
                    instrumentId: instId,
                    strategyId: stratId,
                    closeTs: bar.closeTs
                  });
                  continue;
                }
              }

              eligibleBars.push(bar);
              if (eligibleBars.length >= 500) {
                break;
              }
            }

            for (const bar of eligibleBars) {
              const featureBars = this.dataStore.marketDataRepo.getConfirmedBarsInRange({
                instrumentId: instId,
                timeframe: "1H",
                fromOpenTs: bar.openTs - 100 * 3600_000,
                toCloseTs: bar.closeTs
              });

              const fundingRates = this.dataStore.marketDataRepo.getSettledFundingInRange({
                instrumentId: instId,
                fromTs: 0,
                toTs: bar.closeTs
              });

              const tickResult = this.paperBroker.executeConfirmedBarTick({
                bar,
                strategy,
                featureBars: { "1H": featureBars },
                settledFundingRates: fundingRates
              });

              if (tickResult.barEvaluated !== null) {
                ticksExecuted++;

                this.dataStore.auditRepo.append({
                  ts: nowMs,
                  actor: "scheduler",
                  clientIp: "127.0.0.1",
                  action: "scheduler.unattended_tick",
                  riskClass: "safe",
                  configHash: "system-scheduled",
                  details: {
                    instrumentId: instId,
                    strategyId: stratId,
                    barOpenTs: bar.openTs,
                    barClosePrice: bar.close,
                    positionsOpened: tickResult.positionsOpened.length,
                    positionsClosed: tickResult.positionsClosed.length,
                    vetoedCount: tickResult.vetoedProposals.length
                  }
                });
              }
            }

            if (eligibleBars.length > 0) {
              const strategyMetrics = this.dataStore.ledgerRepo.getRiskMetrics({
                asOfMs: nowMs,
                strategyId: stratId
              });
              this.dataStore.ledgerRepo.recordEquitySnapshot({
                ts: nowMs,
                strategyId: stratId,
                equityUsdt: strategyMetrics.currentEquityUsdt
              });
            }
          } catch (err) {
            errors.push(`Strategy tick failed for ${stratId} on ${instId}: ${String(err)}`);
          }
        }

        // If no strategies are configured but open paper positions exist, evaluate exits & funding across unprocessed bars
        if (this.strategies.length === 0) {
          const openPositions = this.dataStore.paperAccountRepo
            .listOpenPositions()
            .filter((p) => p.instrumentId === instId);

          if (openPositions.length > 0) {
            const earliestPending = Math.min(...openPositions.map((p) => p.lastFundingSettledTs));
            const unprocessedBars = this.dataStore.marketDataRepo
              .getConfirmedBarsInRange({
                instrumentId: instId,
                timeframe: "1H",
                fromOpenTs: earliestPending + 1,
                toCloseTs: nowMs
              })
              .slice(0, 500);

            for (const bar of unprocessedBars) {
              const fundingRates = this.dataStore.marketDataRepo.getSettledFundingInRange({
                instrumentId: instId,
                fromTs: 0,
                toTs: bar.closeTs
              });

              this.paperBroker.executeConfirmedBarTick({
                bar,
                settledFundingRates: fundingRates
              });
            }
          }
        }

        // Record portfolio equity snapshot after instrument step
        const portfolioMetrics = this.dataStore.ledgerRepo.getRiskMetrics({
          asOfMs: nowMs,
          strategyId: null
        });
        this.dataStore.ledgerRepo.recordEquitySnapshot({
          ts: nowMs,
          strategyId: null,
          equityUsdt: portfolioMetrics.currentEquityUsdt
        });

        // Resolve any pending shadow decisions across ingested confirmed bars (T7)
        try {
          this.dataStore.shadowRepo.resolvePendingDecisions({
            marketDataRepo: this.dataStore.marketDataRepo
          });
        } catch (err) {
          errors.push(`Shadow resolution failed: ${String(err)}`);
        }
      }

      // 3. In Demo and Live modes, maintain honest DMS heartbeat and position reconciliation
      if (this.exchangeBroker) {
        if (this.isExchangeMode()) {
          try {
            await this.exchangeBroker.sendDmsHeartbeat();
          } catch (err) {
            errors.push(`DMS heartbeat failed: ${String(err)}`);
          }

          try {
            const recon = await this.exchangeBroker.reconcilePositions();
            if (!recon.matched) {
              errors.push(`Reconciliation drift detected: ${recon.driftDetails.join("; ")}`);
            }
          } catch (err) {
            errors.push(`Position reconciliation failed: ${String(err)}`);
          }
        }
      }
    } finally {
      this.isStepping = false;
    }

    if (errors.length > 0 && this.notificationChannel) {
      void this.notificationChannel.send({
        severity: "WARNING",
        title: "UNATTENDED SCHEDULER WARNING",
        body: `Scheduler encountered ${errors.length} error(s) during step: ${errors.join("; ")}`,
        dedupKey: `scheduler-err-${Math.floor(nowMs / 300_000)}`
      });
    }

    return {
      ok: errors.length === 0,
      timestampMs: nowMs,
      barsIngested,
      ticksExecuted,
      errors
    };
  }
}
