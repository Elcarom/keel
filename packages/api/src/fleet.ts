import { randomBytes } from "node:crypto";
import {
  ScaledDecimal,
  overlapsSealed2026Holdout,
  type Assessment,
  type Bot,
  type BotRecord,
  type BotTrade,
  type CircuitBreakerRecord,
  type Clock,
  type DesignBatch,
  type DesignBrief,
  type DesignSource,
  type FleetOverview,
  type KeelConfig,
  type LedgerRepository,
  type PaperAccountRepository,
  type PaperPositionRecord,
  type Proposition,
  type Verdict,
  type Wallet
} from "@keel/core";
import { type BotDesigner } from "@keel/ai";
import {
  bookSchemaSql,
  botBook,
  createLedgerRepository,
  createPaperAccountRepository,
  dropBookSql,
  seedSyntheticMarketSeries,
  type OkxPublicIngestor,
  type SqliteDataStore
} from "@keel/data";
import { type ReplayEngine, type ReplayRunResult } from "@keel/replay";
import { SpecStrategy, compileBlueprint } from "@keel/spec";
import { PaperBroker } from "./paper-broker.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Propositions are backtested on the year before 2024-12-01: in-sample data, clear of the sealed
 * holdout (2025 onward) and of the 30-day synthetic seed that ends at the holdout boundary.
 */
export const BACKTEST_TO_TS = 1_733_011_200_000; // 2024-12-01 00:00:00 UTC
export const BACKTEST_DAYS = 365;
export const BACKTEST_FROM_TS = BACKTEST_TO_TS - BACKTEST_DAYS * DAY_MS;
const BACKTEST_EQUITY_USDT = "10000.00";
const DEFAULT_WALLET_USDT = "10000.00000000";

export class FleetError extends Error {
  public constructor(
    public readonly status: 400 | 404 | 409,
    message: string
  ) {
    super(message);
  }
}

interface BotEngine {
  readonly broker: PaperBroker;
  readonly ledgerRepo: LedgerRepository;
  readonly accountRepo: PaperAccountRepository;
  readonly strategy: SpecStrategy;
}

export interface FleetServiceOptions {
  readonly clock: Clock;
  readonly dataStore: SqliteDataStore;
  readonly replayEngine: ReplayEngine;
  readonly designer: BotDesigner;
  readonly getConfig: () => KeelConfig;
  readonly designerInfo: () => { readonly source: DesignSource; readonly model: string };
  readonly isSchedulerRunning: () => boolean;
  readonly ingestor?: OkxPublicIngestor | undefined;
}

function newId(prefix: string, nowMs: number): string {
  return `${prefix}_${nowMs.toString(36)}_${randomBytes(3).toString("hex")}`;
}

function round(value: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/** Turns a backtest into a 0-100 score and a verdict. Statistics only; no money moves here. */
export function scoreBacktest(params: {
  readonly result: ReplayRunResult;
  readonly initialEquityUsdt: string;
  readonly dataSource: "okx" | "synthetic";
}): Assessment {
  const { result } = params;
  const initial = Number(params.initialEquityUsdt);
  const returnPct = round((Number(result.netPnlUsdt) / initial) * 100);
  const sharpe = Number.isFinite(result.sharpeRatio) ? result.sharpeRatio : 0;
  const trades = result.totalTrades;

  let score = ((Math.min(3, Math.max(-1, sharpe)) + 1) / 4) * 40;
  score += result.deflatedSharpeRatio * 20;
  score += Math.max(-10, Math.min(15, returnPct / 2));
  score += returnPct > result.buyAndHoldReturnPct ? 5 : 0;
  score -= Math.min(20, result.maxDrawdownPct);
  if (trades < 10) score -= 15;
  if (result.replayGatePassed) score += 15;
  score = round(Math.max(0, Math.min(100, score)), 0);

  const verdict: Verdict =
    result.replayGatePassed && score >= 60
      ? "seaworthy"
      : score >= 45
        ? "promising"
        : returnPct >= 0 || score >= 25
          ? "choppy"
          : "sinks";

  const curve = result.equityCurve;
  const step = Math.max(1, Math.floor(curve.length / 60));
  const equityCurvePct: number[] = [];
  for (let i = 0; i < curve.length; i += step) {
    const point = curve[i];
    if (point) equityCurvePct.push(round((Number(point.equityUsdt) / initial - 1) * 100));
  }
  const last = curve[curve.length - 1];
  if (last) equityCurvePct.push(round((Number(last.equityUsdt) / initial - 1) * 100));

  const sign = returnPct >= 0 ? "+" : "";
  const headline =
    trades === 0
      ? "Never left harbour: no trades in a year of data"
      : `${sign}${returnPct}% over ${BACKTEST_DAYS} days, ${trades} trades, worst dip ${round(result.maxDrawdownPct, 1)}%`;

  return {
    score,
    verdict,
    headline,
    gatePassed: result.replayGatePassed,
    dataSource: params.dataSource,
    fromTs: result.fromTs,
    toTs: result.toTs,
    totalTrades: trades,
    winRate: round(result.winRate, 4),
    returnPct,
    maxDrawdownPct: round(result.maxDrawdownPct),
    sharpeRatio: round(sharpe),
    deflatedSharpeRatio: round(result.deflatedSharpeRatio, 4),
    avgR: round(result.avgR),
    buyAndHoldReturnPct: round(result.buyAndHoldReturnPct),
    equityCurvePct
  };
}

/**
 * The Fleet: designs bots with the Bot Designer, backtests and ranks the propositions, and runs
 * each launched bot on its own paper Trading Book funded from a wallet. Every order decision is
 * the deterministic strategy and Risk Engine; the model only drafts blueprints.
 */
export class FleetService {
  private readonly clock: Clock;
  private readonly dataStore: SqliteDataStore;
  private readonly replayEngine: ReplayEngine;
  private readonly designer: BotDesigner;
  private readonly getConfig: () => KeelConfig;
  private readonly designerInfo: () => { readonly source: DesignSource; readonly model: string };
  private readonly isSchedulerRunning: () => boolean;
  private readonly ingestor: OkxPublicIngestor | null;
  private readonly engines = new Map<string, BotEngine>();
  private assessQueue: Promise<void> = Promise.resolve();
  private readonly dataFills = new Map<string, Promise<"okx" | "synthetic">>();

  public constructor(options: FleetServiceOptions) {
    this.clock = options.clock;
    this.dataStore = options.dataStore;
    this.replayEngine = options.replayEngine;
    this.designer = options.designer;
    this.getConfig = options.getConfig;
    this.designerInfo = options.designerInfo;
    this.isSchedulerRunning = options.isSchedulerRunning;
    this.ingestor = options.ingestor ?? null;

    if (this.repo.listWallets().length === 0) {
      this.openWallet("Main Treasury", DEFAULT_WALLET_USDT);
    }
    // Propositions still assessing when the server stopped are picked up again
    for (const batch of this.repo.listBatches(20)) {
      if (this.repo.listPropositions(batch.batchId).some((p) => p.status === "assessing")) {
        this.enqueueAssessment(batch.batchId);
      }
    }
  }

  private get repo() {
    return this.dataStore.fleetRepo;
  }

  // ------------------------------------------------------------------------
  // Wallets
  // ------------------------------------------------------------------------

  private openWallet(name: string, startingBalanceUsdt: string): Wallet {
    const nowMs = this.clock.nowMs();
    const wallet = this.repo.createWallet({
      walletId: newId("w", nowMs),
      name,
      kind: "paper",
      createdAtMs: nowMs
    });
    this.repo.appendWalletEntry({
      walletId: wallet.walletId,
      ts: nowMs,
      amountUsdt: ScaledDecimal.fromString(startingBalanceUsdt).toFixed(8),
      reason: "deposit",
      botId: null
    });
    return this.walletView(wallet.walletId);
  }

  public createWallet(name: string, startingBalanceUsdt: string): Wallet {
    return this.openWallet(name, startingBalanceUsdt);
  }

  public deposit(walletId: string, amountUsdt: string): Wallet {
    if (!this.repo.getWallet(walletId)) {
      throw new FleetError(404, "Wallet not found");
    }
    this.repo.appendWalletEntry({
      walletId,
      ts: this.clock.nowMs(),
      amountUsdt: ScaledDecimal.fromString(amountUsdt).toFixed(8),
      reason: "deposit",
      botId: null
    });
    return this.walletView(walletId);
  }

  private walletView(walletId: string): Wallet {
    const wallet = this.repo.getWallet(walletId);
    if (!wallet) throw new FleetError(404, "Wallet not found");
    const active = this.repo
      .listBots()
      .filter((b) => b.walletId === walletId && b.status !== "retired");
    const allocated = active.reduce(
      (sum, b) => sum.add(ScaledDecimal.fromString(b.allocationUsdt)),
      ScaledDecimal.zero()
    );
    return {
      walletId: wallet.walletId,
      name: wallet.name,
      kind: wallet.kind,
      createdAtMs: wallet.createdAtMs,
      availableUsdt: this.repo.getWalletBalanceUsdt(walletId),
      allocatedUsdt: allocated.toFixed(8),
      botCount: active.length
    };
  }

  // ------------------------------------------------------------------------
  // Shipyard: design, assess, rank
  // ------------------------------------------------------------------------

  public async design(brief: DesignBrief): Promise<DesignBatch> {
    const taken = this.repo.listBots().map((b) => b.name);
    const result = await this.designer.design(brief, taken);
    const nowMs = this.clock.nowMs();
    const batch = this.repo.saveBatch({
      batchId: newId("d", nowMs),
      createdAtMs: nowMs,
      brief,
      source: result.source,
      note: result.note
    });
    for (const blueprint of result.blueprints) {
      this.repo.saveProposition({
        propositionId: newId("p", nowMs),
        batchId: batch.batchId,
        createdAtMs: nowMs,
        source: result.source,
        blueprint,
        status: "assessing",
        assessment: null,
        rank: null,
        error: null,
        botId: null
      });
    }
    this.enqueueAssessment(batch.batchId);
    return this.batchView(batch.batchId);
  }

  public listDesigns(limit = 8): readonly DesignBatch[] {
    return this.repo.listBatches(limit).map((b) => this.batchView(b.batchId));
  }

  /** Resolves once every queued assessment has finished (used by tests and shutdown). */
  public whenIdle(): Promise<void> {
    return this.assessQueue;
  }

  private batchView(batchId: string): DesignBatch {
    const batch = this.repo.listBatches(200).find((b) => b.batchId === batchId);
    if (!batch) throw new FleetError(404, "Design batch not found");
    const propositions = [...this.repo.listPropositions(batchId)].sort(
      (a, b) => (a.rank ?? 99) - (b.rank ?? 99)
    );
    return {
      ...batch,
      status: propositions.some((p) => p.status === "assessing") ? "assessing" : "done",
      propositions
    };
  }

  private enqueueAssessment(batchId: string): void {
    this.assessQueue = this.assessQueue
      .then(() => this.assessBatch(batchId))
      .catch(() => undefined);
  }

  private async assessBatch(batchId: string): Promise<void> {
    const pending = this.repo.listPropositions(batchId).filter((p) => p.status === "assessing");
    const trials = this.repo.listPropositions(batchId).length;
    for (const proposition of pending) {
      // Yield between backtests so the API stays responsive
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        const dataSource = await this.ensureBacktestData(proposition.blueprint.instrumentId);
        const assessment = this.backtest(proposition, trials, dataSource);
        this.repo.saveProposition({ ...proposition, status: "ranked", assessment, error: null });
      } catch (err) {
        this.repo.saveProposition({
          ...proposition,
          status: "failed",
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    this.rankBatch(batchId);
  }

  private rankBatch(batchId: string): void {
    const scored = this.repo
      .listPropositions(batchId)
      .filter((p) => p.assessment !== null)
      .sort((a, b) => (b.assessment?.score ?? 0) - (a.assessment?.score ?? 0));
    scored.forEach((p, i) => this.repo.saveProposition({ ...p, rank: i + 1 }));
  }

  private backtest(
    proposition: Proposition,
    trials: number,
    dataSource: "okx" | "synthetic"
  ): Assessment {
    const config = this.getConfig();
    const strategy = new SpecStrategy(
      compileBlueprint(proposition.blueprint, proposition.propositionId)
    );
    const result = this.replayEngine.run({
      instrumentId: proposition.blueprint.instrumentId,
      timeframe: "1H",
      strategy,
      fromTs: BACKTEST_FROM_TS,
      toTs: BACKTEST_TO_TS,
      numTrials: Math.max(1, trials),
      initialEquityUsdt: ScaledDecimal.fromString(BACKTEST_EQUITY_USDT),
      riskFractionPerTrade: config.risk.strategy.riskPerTradePct / 100,
      maxGrossLeverage: config.risk.strategy.maxGrossLeverage,
      costStressMultiplier: config.promotionLadder.replayCostStressMultiplier,
      walkForwardFolds: config.promotionLadder.replayMinWalkForwardFolds,
      replayMinTrades: config.promotionLadder.replayMinTrades,
      replayMinSharpe: config.promotionLadder.replayMinSharpe,
      replayMinDeflatedSharpeConfidence: config.promotionLadder.replayMinDeflatedSharpeConfidence
    });
    return scoreBacktest({ result, initialEquityUsdt: BACKTEST_EQUITY_USDT, dataSource });
  }

  /**
   * Fills the backtest window once per instrument: OKX history when reachable, otherwise a
   * synthetic series that every assessment then labels as synthetic.
   */
  private ensureBacktestData(instrumentId: string): Promise<"okx" | "synthetic"> {
    const known = this.repo.getBacktestDataSource(instrumentId);
    if (known) return Promise.resolve(known);
    const inFlight = this.dataFills.get(instrumentId);
    if (inFlight) return inFlight;

    const fill = (async (): Promise<"okx" | "synthetic"> => {
      const expectedBars = BACKTEST_DAYS * 24;
      const countBars = (): number =>
        this.dataStore.marketDataRepo.getConfirmedBarsInRange({
          instrumentId,
          timeframe: "1H",
          fromOpenTs: BACKTEST_FROM_TS,
          toCloseTs: BACKTEST_TO_TS
        }).length;
      if (this.ingestor) {
        try {
          await this.ingestor.ingestRange({
            instrumentId,
            timeframe: "1H",
            fromOpenTs: BACKTEST_FROM_TS,
            toOpenTs: BACKTEST_TO_TS - HOUR_MS
          });
        } catch {
          // Unreachable venue: fall through to the coverage check
        }
      }
      let source: "okx" | "synthetic" = "okx";
      if (countBars() < expectedBars * 0.95) {
        seedSyntheticMarketSeries({
          marketDataRepo: this.dataStore.marketDataRepo,
          instrumentId,
          endCloseTs: BACKTEST_TO_TS,
          barCount1H: expectedBars
        });
        source = "synthetic";
      }
      this.repo.setBacktestDataSource(instrumentId, source);
      return source;
    })().finally(() => this.dataFills.delete(instrumentId));
    this.dataFills.set(instrumentId, fill);
    return fill;
  }

  public discard(propositionId: string): Proposition {
    const p = this.repo.getProposition(propositionId);
    if (!p) throw new FleetError(404, "Proposition not found");
    if (p.status === "launched") throw new FleetError(409, "This proposition is already a bot");
    return this.repo.saveProposition({ ...p, status: "discarded" });
  }

  // ------------------------------------------------------------------------
  // Bots
  // ------------------------------------------------------------------------

  public launch(
    propositionId: string,
    input: { readonly name: string; readonly walletId: string; readonly allocationUsdt: string }
  ): Bot {
    const p = this.repo.getProposition(propositionId);
    if (!p) throw new FleetError(404, "Proposition not found");
    if (p.status !== "ranked") {
      throw new FleetError(
        409,
        `Only assessed propositions can be launched (this one is ${p.status})`
      );
    }
    if (!this.repo.getWallet(input.walletId)) throw new FleetError(404, "Wallet not found");
    const allocation = ScaledDecimal.fromString(input.allocationUsdt);
    const available = ScaledDecimal.fromString(this.repo.getWalletBalanceUsdt(input.walletId));
    if (allocation.gt(available)) {
      throw new FleetError(400, `The wallet only has ${available.toFixed(2)} USDT available`);
    }
    if (allocation.lt(ScaledDecimal.fromString("100"))) {
      throw new FleetError(400, "Give the bot at least 100 USDT so it can size a trade");
    }
    const name = input.name.trim();
    if (this.repo.listBots().some((b) => b.name.toLowerCase() === name.toLowerCase())) {
      throw new FleetError(409, `There is already a bot called ${name}`);
    }

    const nowMs = this.clock.nowMs();
    const botId = newId("b", nowMs);
    this.repo.appendWalletEntry({
      walletId: input.walletId,
      ts: nowMs,
      amountUsdt: ScaledDecimal.zero().sub(allocation).toFixed(8),
      reason: "allocation",
      botId
    });
    const bot = this.repo.saveBot({
      botId,
      name,
      tagline: p.blueprint.tagline,
      blueprint: { ...p.blueprint, name },
      walletId: input.walletId,
      allocationUsdt: allocation.toFixed(8),
      status: "running",
      statusReason: null,
      createdAtMs: nowMs,
      retiredAtMs: null,
      propositionId,
      backtest: p.assessment
    });
    this.repo.saveProposition({ ...p, status: "launched", botId });

    // The bot trades from the next confirmed bar on; history before launch is never traded
    const engine = this.engineFor(bot);
    const anchorCloseTs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    engine.accountRepo.setSchedulerAnchor({
      instrumentId: bot.blueprint.instrumentId,
      strategyId: botId,
      anchorCloseTs,
      createdAtMs: nowMs
    });
    engine.accountRepo.recordProcessedBar({
      instrumentId: bot.blueprint.instrumentId,
      strategyId: botId,
      closeTs: anchorCloseTs
    });
    void this.warmLookback(bot, engine.strategy, anchorCloseTs);
    return this.botView(bot);
  }

  /** Fetches the bars the bot's indicators need before its first live bar. Best effort. */
  private async warmLookback(
    bot: BotRecord,
    strategy: SpecStrategy,
    anchorCloseTs: number
  ): Promise<void> {
    if (!this.ingestor) return;
    const bars = strategy.lookbacks["1H"] ?? 50;
    try {
      await this.ingestor.ingestRange({
        instrumentId: bot.blueprint.instrumentId,
        timeframe: "1H",
        fromOpenTs: anchorCloseTs - (bars + 5) * HOUR_MS,
        toOpenTs: anchorCloseTs - HOUR_MS
      });
    } catch {
      // The scheduler's own ingest keeps trying
    }
  }

  private requireBot(botId: string): BotRecord {
    const bot = this.repo.getBot(botId);
    if (!bot) throw new FleetError(404, "Bot not found");
    return bot;
  }

  private markPrices(instrumentId: string): Record<string, ScaledDecimal> {
    const latest = this.dataStore.marketDataRepo.getConfirmedBarsAsOf({
      instrumentId,
      timeframe: "1H",
      asOfMs: this.clock.nowMs(),
      limit: 1
    })[0];
    return latest ? { [instrumentId]: ScaledDecimal.fromString(latest.close) } : {};
  }

  private flattenBot(bot: BotRecord, reason: string): void {
    this.engineFor(bot).broker.flattenAllPositions(
      reason,
      this.markPrices(bot.blueprint.instrumentId)
    );
  }

  public pause(botId: string, reason = "Docked by the operator"): Bot {
    const bot = this.requireBot(botId);
    if (bot.status !== "running") throw new FleetError(409, `The bot is ${bot.status}`);
    this.flattenBot(bot, reason);
    return this.botView(this.repo.saveBot({ ...bot, status: "paused", statusReason: reason }));
  }

  public resume(botId: string): Bot {
    const bot = this.requireBot(botId);
    if (bot.status !== "paused") throw new FleetError(409, `The bot is ${bot.status}`);
    const engine = this.engineFor(bot);
    const nowMs = this.clock.nowMs();
    // Skip the bars that closed while docked, and forget any entry queued before the pause
    engine.accountRepo.recordProcessedBar({
      instrumentId: bot.blueprint.instrumentId,
      strategyId: botId,
      closeTs: Math.floor(nowMs / HOUR_MS) * HOUR_MS
    });
    engine.accountRepo.savePendingProposal({
      strategyId: botId,
      instrumentId: bot.blueprint.instrumentId,
      proposal: null
    });
    return this.botView(this.repo.saveBot({ ...bot, status: "running", statusReason: null }));
  }

  public retire(botId: string): Bot {
    const bot = this.requireBot(botId);
    if (bot.status === "retired") throw new FleetError(409, "The bot is already retired");
    this.flattenBot(bot, "Retired");
    const equity = this.equityOf(bot);
    const nowMs = this.clock.nowMs();
    if (equity.isPositive()) {
      this.repo.appendWalletEntry({
        walletId: bot.walletId,
        ts: nowMs,
        amountUsdt: equity.toFixed(8),
        reason: "return",
        botId
      });
    }
    return this.botView(
      this.repo.saveBot({
        ...bot,
        status: "retired",
        statusReason: `Returned ${equity.toFixed(2)} USDT to the wallet`,
        retiredAtMs: nowMs
      })
    );
  }

  public remove(botId: string): void {
    const bot = this.requireBot(botId);
    if (bot.status !== "retired") this.retire(botId);
    this.engines.delete(botId);
    this.dataStore.rawDb.exec(dropBookSql(botBook(botId)));
    this.repo.deleteBot(botId);
  }

  /** Closes every bot position (Kill Switch Flatten). Statuses are left for the operator. */
  public flattenAll(reason: string): number {
    let closed = 0;
    for (const bot of this.repo.listBots()) {
      if (bot.status === "retired") continue;
      closed += this.engineFor(bot).broker.flattenAllPositions(
        reason,
        this.markPrices(bot.blueprint.instrumentId)
      ).length;
    }
    return closed;
  }

  public openPositionCount(): number {
    return this.repo
      .listBots()
      .filter((b) => b.status !== "retired")
      .reduce((n, b) => n + this.engineFor(b).accountRepo.listOpenPositions().length, 0);
  }

  private engineFor(bot: BotRecord): BotEngine {
    const cached = this.engines.get(bot.botId);
    if (cached) return cached;
    const book = botBook(bot.botId);
    const db = this.dataStore.rawDb;
    db.exec(bookSchemaSql(book));
    const ledgerRepo = createLedgerRepository(db, bot.allocationUsdt, book);
    const bookRepo = createPaperAccountRepository(db, this.clock, book);
    // The shared Kill Switch halts every bot, but a bot's own loss limit only docks that bot
    const accountRepo: PaperAccountRepository = {
      ...bookRepo,
      getCircuitBreaker: () => this.dataStore.paperAccountRepo.getCircuitBreaker(),
      setCircuitBreaker: (record: CircuitBreakerRecord) => record
    };
    const broker = new PaperBroker({
      clock: this.clock,
      ledgerRepo,
      paperAccountRepo: accountRepo,
      getRiskConfig: () => this.getConfig().risk,
      onCircuitBreakerTripped: (record) => {
        void Promise.resolve().then(() => this.onBotLimit(bot.botId, record));
      }
    });
    const engine: BotEngine = {
      broker,
      ledgerRepo,
      accountRepo,
      strategy: new SpecStrategy(compileBlueprint(bot.blueprint, bot.botId))
    };
    this.engines.set(bot.botId, engine);
    return engine;
  }

  private onBotLimit(botId: string, record: CircuitBreakerRecord): void {
    const bot = this.repo.getBot(botId);
    if (bot?.status === "running") {
      this.pause(botId, `Hit a risk limit and came back to harbour: ${record.reason}`);
    }
  }

  // ------------------------------------------------------------------------
  // Trading: one step per scheduler tick
  // ------------------------------------------------------------------------

  /** Steps every running bot through its unprocessed confirmed bars. */
  public step(): { readonly ticks: number; readonly errors: readonly string[] } {
    const nowMs = this.clock.nowMs();
    let ticks = 0;
    const errors: string[] = [];
    for (const bot of this.repo.listBots()) {
      if (bot.status !== "running") continue;
      try {
        ticks += this.stepBot(bot, nowMs);
      } catch (err) {
        errors.push(`${bot.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { ticks, errors };
  }

  private stepBot(bot: BotRecord, nowMs: number): number {
    const engine = this.engineFor(bot);
    const instrumentId = bot.blueprint.instrumentId;
    const key = { instrumentId, strategyId: bot.botId };
    const anchor = engine.accountRepo.getSchedulerAnchor(key) ?? 0;
    const last = engine.accountRepo.getLastProcessedBarCloseTs(key) ?? 0;
    const minCloseTs = Math.max(anchor, last);
    const lookbackBars = (engine.strategy.lookbacks["1H"] ?? 50) + 5;

    const bars = this.dataStore.marketDataRepo
      .getConfirmedBarsInRange({
        instrumentId,
        timeframe: "1H",
        fromOpenTs: minCloseTs,
        toCloseTs: nowMs
      })
      .filter((b) => b.closeTs > minCloseTs)
      .slice(0, 500);

    let ticks = 0;
    for (const bar of bars) {
      if (overlapsSealed2026Holdout(bar.openTs, bar.closeTs) && nowMs - bar.closeTs > 2 * HOUR_MS) {
        engine.accountRepo.recordProcessedBar({ ...key, closeTs: bar.closeTs });
        continue;
      }
      const result = engine.broker.executeConfirmedBarTick({
        bar,
        strategy: engine.strategy,
        featureBars: {
          "1H": this.dataStore.marketDataRepo.getConfirmedBarsInRange({
            instrumentId,
            timeframe: "1H",
            fromOpenTs: bar.openTs - lookbackBars * HOUR_MS,
            toCloseTs: bar.closeTs
          })
        },
        settledFundingRates: this.dataStore.marketDataRepo.getSettledFundingInRange({
          instrumentId,
          fromTs: bar.openTs - 9 * HOUR_MS,
          toTs: bar.closeTs
        })
      });
      if (result.barEvaluated !== null) ticks++;
    }
    return ticks;
  }

  // ------------------------------------------------------------------------
  // Views
  // ------------------------------------------------------------------------

  private equityOf(bot: BotRecord): ScaledDecimal {
    const engine = this.engineFor(bot);
    const unrealized = engine.accountRepo
      .listOpenPositions()
      .reduce(
        (sum, p) => sum.add(ScaledDecimal.fromString(p.unrealizedPnlUsdt)),
        ScaledDecimal.zero()
      );
    return engine.ledgerRepo.getRiskMetrics({
      asOfMs: this.clock.nowMs(),
      strategyId: null,
      openUnrealizedPnlUsdt: unrealized
    }).currentEquityUsdt;
  }

  private netPnl(p: PaperPositionRecord): ScaledDecimal {
    return ScaledDecimal.fromString(p.realizedPnlUsdt)
      .sub(ScaledDecimal.fromString(p.feesPaidUsdt))
      .sub(ScaledDecimal.fromString(p.fundingPaidUsdt));
  }

  private botView(bot: BotRecord): Bot {
    const engine = this.engineFor(bot);
    const positions = engine.accountRepo.listAllPositions(1000);
    const closed = positions
      .filter((p) => p.status === "CLOSED")
      .sort((a, b) => (a.closedAtMs ?? 0) - (b.closedAtMs ?? 0));
    const open = engine.accountRepo.listOpenPositions()[0] ?? null;
    const allocation = ScaledDecimal.fromString(bot.allocationUsdt);
    const equity = this.equityOf(bot);
    const pnl = equity.sub(allocation);
    const allocationNum = Number(allocation.toFixed(8));

    // Equity after each closed trade, then now (statistics for display only)
    const curve: number[] = [allocationNum];
    let running = allocation;
    for (const p of closed) {
      running = running.add(this.netPnl(p));
      curve.push(round(Number(running.toFixed(8))));
    }
    curve.push(round(Number(equity.toFixed(8))));
    let peak = curve[0] ?? 0;
    let maxDd = 0;
    for (const v of curve) {
      peak = Math.max(peak, v);
      if (peak > 0) maxDd = Math.max(maxDd, ((peak - v) / peak) * 100);
    }

    const wins = closed.filter((p) => this.netPnl(p).isPositive()).length;
    const wallet = this.repo.getWallet(bot.walletId);
    const recentTrades: BotTrade[] = [...positions]
      .sort((a, b) => b.openedAtMs - a.openedAtMs)
      .slice(0, 8)
      .map((p) => ({
        side: p.side,
        entryPrice: p.entryPrice,
        exitPrice: p.exitPrice,
        contracts: p.contracts,
        pnlUsdt: (p.status === "OPEN"
          ? ScaledDecimal.fromString(p.unrealizedPnlUsdt).sub(
              ScaledDecimal.fromString(p.feesPaidUsdt)
            )
          : this.netPnl(p)
        ).toFixed(2),
        openedAtMs: p.openedAtMs,
        closedAtMs: p.closedAtMs,
        exitReason: p.exitReason
      }));

    return {
      botId: bot.botId,
      name: bot.name,
      tagline: bot.tagline,
      blueprint: bot.blueprint,
      mode: "paper",
      status: bot.status,
      statusReason: bot.statusReason,
      walletId: bot.walletId,
      walletName: wallet?.name ?? "Unknown wallet",
      allocationUsdt: allocation.toFixed(2),
      createdAtMs: bot.createdAtMs,
      retiredAtMs: bot.retiredAtMs,
      backtest: bot.backtest,
      equityUsdt: equity.toFixed(2),
      pnlUsdt: pnl.toFixed(2),
      returnPct: allocationNum > 0 ? round((Number(pnl.toFixed(8)) / allocationNum) * 100) : 0,
      maxDrawdownPct: round(maxDd),
      tradesCount: closed.length,
      winRate: closed.length > 0 ? round(wins / closed.length, 4) : 0,
      openPosition: open
        ? {
            side: open.side,
            entryPrice: open.entryPrice,
            contracts: open.contracts,
            protectiveStopPrice: open.protectiveStopPrice,
            takeProfitPrice: open.takeProfitPrice,
            unrealizedPnlUsdt: ScaledDecimal.fromString(open.unrealizedPnlUsdt).toFixed(2),
            openedAtMs: open.openedAtMs
          }
        : null,
      lastBarAtMs: engine.accountRepo.getLastProcessedBarCloseTs({
        instrumentId: bot.blueprint.instrumentId,
        strategyId: bot.botId
      }),
      equityCurve: curve,
      recentTrades
    };
  }

  public getBot(botId: string): Bot {
    return this.botView(this.requireBot(botId));
  }

  public overview(): FleetOverview {
    const bots = this.repo.listBots().map((b) => this.botView(b));
    const active = bots.filter((b) => b.status !== "retired");
    const equity = active.reduce(
      (sum, b) => sum.add(ScaledDecimal.fromString(b.equityUsdt)),
      ScaledDecimal.zero()
    );
    const allocated = active.reduce(
      (sum, b) => sum.add(ScaledDecimal.fromString(b.allocationUsdt)),
      ScaledDecimal.zero()
    );
    const pnl = equity.sub(allocated);
    const allocatedNum = Number(allocated.toFixed(8));
    const breaker = this.dataStore.paperAccountRepo.getCircuitBreaker();
    const killed =
      breaker.status === "MANUAL_KILL_SWITCH" || breaker.status === "DRAWDOWN_KILL_SWITCH";
    return {
      bots,
      wallets: this.repo.listWallets().map((w) => this.walletView(w.walletId)),
      totals: {
        equityUsdt: equity.toFixed(2),
        pnlUsdt: pnl.toFixed(2),
        returnPct: allocatedNum > 0 ? round((Number(pnl.toFixed(8)) / allocatedNum) * 100) : 0,
        activeBots: active.filter((b) => b.status === "running").length,
        openPositions: active.filter((b) => b.openPosition !== null).length
      },
      schedulerRunning: this.isSchedulerRunning(),
      killSwitchActive: killed,
      killSwitchReason: killed ? breaker.reason : null,
      designer: this.designerInfo(),
      liveTradingAvailable: false
    };
  }
}
