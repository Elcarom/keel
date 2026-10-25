import {
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
}

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
  private isStepping = false;

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
    this.strategies = options.strategies ?? ["donchian-trend-v1"];
    this.intervalMs = options.intervalMs ?? 60_000;
  }

  public isRunning(): boolean {
    return this.timer !== null;
  }

  public start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.stepOnce().catch(() => {});
    }, this.intervalMs);
  }

  public stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
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

        // 2. Step strategy evaluation on the latest confirmed bar
        const latestBars = this.dataStore.marketDataRepo.getConfirmedBarsAsOf({
          instrumentId: instId,
          timeframe: "1H",
          asOfMs: nowMs,
          limit: 1
        });
        const latestBar = latestBars[0] ?? null;

        if (latestBar) {
          const featureBars = this.dataStore.marketDataRepo.getConfirmedBarsInRange({
            instrumentId: instId,
            timeframe: "1H",
            fromOpenTs: latestBar.openTs - 100 * 3600_000,
            toCloseTs: latestBar.closeTs
          });

          const fundingRates = this.dataStore.marketDataRepo.getSettledFundingInRange({
            instrumentId: instId,
            fromTs: 0,
            toTs: nowMs
          });

          for (const stratId of this.strategies) {
            try {
              const strategy = resolveStrategyById(stratId);
              const tickResult = this.paperBroker.executeConfirmedBarTick({
                bar: latestBar,
                strategy,
                featureBars: { "1H": featureBars },
                settledFundingRates: fundingRates
              });

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
                  barOpenTs: latestBar.openTs,
                  barClosePrice: latestBar.close,
                  positionsOpened: tickResult.positionsOpened.length,
                  positionsClosed: tickResult.positionsClosed.length,
                  vetoedCount: tickResult.vetoedProposals.length
                }
              });
            } catch (err) {
              errors.push(`Strategy tick failed for ${stratId} on ${instId}: ${String(err)}`);
            }
          }
        }
      }

      // 3. In Demo and Live modes, maintain honest DMS heartbeat and position reconciliation
      if (this.exchangeBroker) {
        const sys = this.getSystemConfig();
        if (sys.executionMode === "Demo" || sys.executionMode === "Live") {
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
