import { randomBytes } from "node:crypto";
import {
  FLEET_INSTRUMENTS,
  SIBLING_INSTRUMENTS,
  ScaledDecimal,
  blueprintMarkets,
  overlapsSealed2026Holdout,
  type Assessment,
  type BatchBrief,
  type Bot,
  type BotBlueprint,
  type BotRecord,
  type BotTrade,
  type CircuitBreakerRecord,
  type Clock,
  type DesignBatch,
  type DesignBrief,
  type DesignSource,
  type FleetInstrument,
  type FleetOverview,
  type InventionRejection,
  type InventorPromptRequest,
  type KeelConfig,
  type LedgerRepository,
  type PaperAccountRepository,
  type PaperPositionRecord,
  type Proposition,
  type SeaTrialVariant,
  type Wallet
} from "@keel/core";
import {
  inventorChatPrompt,
  inventorChatRepairPrompt,
  withUniqueNames,
  type BotDesigner
} from "@keel/ai";
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
import { seedFromString, type ReplayEngine, type ReplayRunResult } from "@keel/replay";
import {
  SpecStrategy,
  checkImportedInvention,
  compileBlueprint,
  readInventionFile
} from "@keel/spec";
import { PaperBroker } from "./paper-broker.js";
import {
  ASSUMED_FUNDING_BPS_PER_8H,
  BACKTEST_DAYS,
  BACKTEST_FROM_TS,
  BACKTEST_TO_TS,
  DEFAULT_SEA_TRIAL_SETTINGS,
  assessSeaTrial,
  basketIndexBars,
  combineRuns,
  neighbourBlueprints,
  variantOf,
  type SeaTrialSettings,
  type TrialRun
} from "./sea-trial.js";

const HOUR_MS = 3_600_000;

/** How long a boat waits for a market it reads to post the same hour before trading without it. */
const REFERENCE_GRACE_MS = 3 * HOUR_MS;

const coin = (id: string): string => id.replace("-USDT-SWAP", "");

/**
 * The market a boat is cross-checked on: its lead coin's sibling, unless the boat already trades
 * or reads it; then the first coin it neither trades nor reads.
 */
function siblingFor(
  markets: readonly FleetInstrument[],
  references: readonly FleetInstrument[]
): FleetInstrument {
  const lead = markets[0] ?? FLEET_INSTRUMENTS[0];
  const used = (m: FleetInstrument) => markets.includes(m) || references.includes(m);
  const preferred = SIBLING_INSTRUMENTS[lead];
  if (!used(preferred)) return preferred;
  return FLEET_INSTRUMENTS.find((m) => !used(m)) ?? preferred;
}

/** Other markets a blueprint's rules read, besides the coins it trades. */
function referenceMarketsOf(b: BotBlueprint): FleetInstrument[] {
  const markets: readonly string[] = new SpecStrategy(compileBlueprint(b, "references"))
    .referenceMarkets;
  return FLEET_INSTRUMENTS.filter((m) => markets.includes(m));
}

const BACKTEST_EQUITY_USDT = "10000.00";
const DEFAULT_WALLET_USDT = "10000.00000000";

/** Starting prices for the synthetic stand-in series when OKX history is unreachable. */
const SYNTHETIC_BASE_PRICES: Readonly<Record<FleetInstrument, number>> = {
  "BTC-USDT-SWAP": 60000,
  "ETH-USDT-SWAP": 2500,
  "SOL-USDT-SWAP": 150,
  "XRP-USDT-SWAP": 0.6,
  "DOGE-USDT-SWAP": 0.15,
  "BNB-USDT-SWAP": 550,
  "ADA-USDT-SWAP": 0.45,
  "AVAX-USDT-SWAP": 30,
  "LINK-USDT-SWAP": 15,
  "LTC-USDT-SWAP": 80
};

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
  /** Tests shrink the sea trial's random paths; production uses the defaults. */
  readonly seaTrial?: Partial<SeaTrialSettings> | undefined;
}

function newId(prefix: string, nowMs: number): string {
  return `${prefix}_${nowMs.toString(36)}_${randomBytes(3).toString("hex")}`;
}

function round(value: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
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
  private readonly seaTrialSettings: SeaTrialSettings;
  /** What each assessing batch's sea trial is doing right now, for the Shipyard. */
  private readonly progress = new Map<string, string>();

  public constructor(options: FleetServiceOptions) {
    this.clock = options.clock;
    this.dataStore = options.dataStore;
    this.replayEngine = options.replayEngine;
    this.designer = options.designer;
    this.getConfig = options.getConfig;
    this.designerInfo = options.designerInfo;
    this.isSchedulerRunning = options.isSchedulerRunning;
    this.ingestor = options.ingestor ?? null;
    this.seaTrialSettings = { ...DEFAULT_SEA_TRIAL_SETTINGS, ...options.seaTrial };

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
    return this.launchBatch(brief, result.source, result.note, result.blueprints);
  }

  /** The Inventor prompt to paste into a Claude chat, briefed like the Shipyard's own. */
  public inventorPrompt(request: InventorPromptRequest): string {
    return inventorChatPrompt({
      ...request,
      namesAlreadyInTheFleet: this.repo.listBots().map((b) => b.name)
    });
  }

  /**
   * Imports inventions from a file a Claude chat wrote (ADR-0027). Each one faces exactly the
   * checks an API invention faces; those that pass are sea-trialled and ranked as a new batch, and
   * the rest come back with a repair message for the same chat.
   */
  public importInventions(text: string): {
    batch: DesignBatch | null;
    rejected: InventionRejection[];
    repairPrompt: string | null;
  } {
    const file = readInventionFile(text);
    if (!file.ok) throw new FleetError(400, file.error);
    const checks = file.inventions.map(checkImportedInvention);
    const rejected = checks.flatMap((c) => (c.ok ? [] : [{ name: c.name, error: c.error }]));
    const accepted = withUniqueNames(
      checks.flatMap((c) => (c.ok ? [c.blueprint] : [])),
      this.repo.listBots().map((b) => b.name)
    );
    const repairPrompt = rejected.length > 0 ? inventorChatRepairPrompt(rejected) : null;
    if (accepted.length === 0) return { batch: null, rejected, repairPrompt };

    const brief: BatchBrief = {
      mode: "inventor",
      instruments: [...new Set(accepted.map((b) => b.instrumentId))],
      styles: [],
      riskAppetite: "balanced",
      direction: "any",
      count: accepted.length,
      notes: "Imported from a JSON file"
    };
    const note =
      rejected.length > 0
        ? `${rejected.length} invention${rejected.length === 1 ? "" : "s"} in the file broke Keel's rules and ${rejected.length === 1 ? "was" : "were"} left out: ${rejected.map((r) => r.name).join(", ")}.`
        : null;
    return { batch: this.launchBatch(brief, "imported", note, accepted), rejected, repairPrompt };
  }

  /** Saves a batch and its propositions, then queues their sea trials. */
  private launchBatch(
    brief: BatchBrief,
    source: DesignSource,
    note: string | null,
    blueprints: readonly BotBlueprint[]
  ): DesignBatch {
    const nowMs = this.clock.nowMs();
    const batch = this.repo.saveBatch({
      batchId: newId("d", nowMs),
      createdAtMs: nowMs,
      brief,
      source,
      note
    });
    for (const blueprint of blueprints) {
      this.repo.saveProposition({
        propositionId: newId("p", nowMs),
        batchId: batch.batchId,
        createdAtMs: nowMs,
        source,
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
    const assessing = propositions.some((p) => p.status === "assessing");
    return {
      ...batch,
      status: assessing ? "assessing" : "done",
      progress: assessing ? (this.progress.get(batchId) ?? "Waiting for the slipway…") : null,
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
    // Every idea ever drafted counts as a trial: the more ideas tried, the more luck is discounted
    const trials = Math.max(
      this.repo.listPropositions(batchId).length,
      this.repo.countPropositions()
    );
    try {
      for (const [index, proposition] of pending.entries()) {
        const say = (stage: string) =>
          this.progress.set(
            batchId,
            `Sea trial ${index + 1} of ${pending.length}: ${proposition.blueprint.name} — ${stage}`
          );
        try {
          const assessment = await this.seaTrial(proposition, trials, say);
          this.repo.saveProposition({ ...proposition, status: "ranked", assessment, error: null });
        } catch (err) {
          this.repo.saveProposition({
            ...proposition,
            status: "failed",
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    } finally {
      this.progress.delete(batchId);
    }
    this.rankBatch(batchId);
  }

  private rankBatch(batchId: string): void {
    const scored = this.repo
      .listPropositions(batchId)
      .filter((p) => p.assessment !== null)
      .sort(
        (a, b) =>
          (b.assessment?.score ?? 0) - (a.assessment?.score ?? 0) ||
          (b.assessment?.sharpeRatio ?? 0) - (a.assessment?.sharpeRatio ?? 0)
      );
    scored.forEach((p, i) => this.repo.saveProposition({ ...p, rank: i + 1 }));
  }

  /** Yields to the event loop so API calls are served between backtests. */
  private breathe(): Promise<void> {
    return new Promise<void>((resolve) => setImmediate(resolve));
  }

  private replay(
    blueprint: Proposition["blueprint"],
    strategyId: string,
    trials: number,
    full: boolean
  ): ReplayRunResult {
    const config = this.getConfig();
    return this.replayEngine.run({
      instrumentId: blueprint.instrumentId,
      timeframe: "1H",
      strategy: new SpecStrategy(compileBlueprint(blueprint, strategyId)),
      fromTs: BACKTEST_FROM_TS,
      toTs: BACKTEST_TO_TS,
      numTrials: Math.max(1, trials),
      initialEquityUsdt: ScaledDecimal.fromString(BACKTEST_EQUITY_USDT),
      riskFractionPerTrade: config.risk.strategy.riskPerTradePct / 100,
      maxGrossLeverage: config.risk.strategy.maxGrossLeverage,
      costStressMultiplier: config.promotionLadder.replayCostStressMultiplier,
      assumedFundingBpsPer8h: ASSUMED_FUNDING_BPS_PER_8H,
      // Variants only need returns and Sharpe: skip walk-forward and the random-entry baseline
      walkForwardFolds: full ? config.promotionLadder.replayMinWalkForwardFolds : 0,
      randomEntryPaths: full ? this.seaTrialSettings.randomEntryPaths : 1,
      replayMinTrades: config.promotionLadder.replayMinTrades,
      replayMinSharpe: config.promotionLadder.replayMinSharpe,
      replayMinDeflatedSharpeConfidence: config.promotionLadder.replayMinDeflatedSharpeConfidence
    });
  }

  /**
   * The full sea trial: the backtest itself, the same idea with each parameter nudged, the same
   * idea on a sibling market, then trade statistics. See ADR-0025.
   */
  private async seaTrial(
    proposition: Proposition,
    trials: number,
    say: (stage: string) => void
  ): Promise<Assessment> {
    const b = proposition.blueprint;
    const initial = Number(BACKTEST_EQUITY_USDT);
    const markets = blueprintMarkets(b);
    const references = referenceMarketsOf(b);
    const needed = [...new Set([...markets, ...references])];

    let dataSource: "okx" | "synthetic" = "okx";
    for (const market of needed) {
      say(`charting ${BACKTEST_DAYS} days of ${coin(market)} history`);
      if ((await this.ensureBacktestData(market)) === "synthetic") dataSource = "synthetic";
      await this.breathe();
    }

    say(
      markets.length > 1
        ? `full backtest on ${markets.map(coin).join(", ")}, cost stress and walk-forward`
        : "full backtest, cost stress and walk-forward"
    );
    const main = await this.replayBasket(b, proposition.propositionId, trials, true);

    const neighbours: SeaTrialVariant[] = [];
    for (const [i, n] of neighbourBlueprints(b).entries()) {
      say(`nudging settings (${i + 1} of 4): ${n.label}`);
      neighbours.push(
        variantOf(
          n.label,
          await this.replayBasket(n.blueprint, `${proposition.propositionId}_n${i}`, trials, false),
          initial
        )
      );
    }

    const siblingId = siblingFor(markets, references);
    say(`sailing the same course on ${coin(siblingId)}`);
    let sibling: (SeaTrialVariant & { instrumentId: string }) | null = null;
    try {
      await this.ensureBacktestData(siblingId);
      await this.breathe();
      const run = this.replay(
        { ...b, instrumentId: siblingId, basket: [] },
        `${proposition.propositionId}_sib`,
        trials,
        false
      );
      sibling = { ...variantOf(siblingId, run, initial), instrumentId: siblingId };
    } catch {
      // No sibling data: the check fails rather than the whole trial
    }

    say("reshuffling trades and scoring");
    await this.breathe();
    const repo = this.dataStore.marketDataRepo;
    const bars = basketIndexBars(
      markets.map((instrumentId) =>
        repo.getConfirmedBarsInRange({
          instrumentId,
          timeframe: "1H",
          fromOpenTs: BACKTEST_FROM_TS,
          toCloseTs: BACKTEST_TO_TS
        })
      )
    );
    const settled = markets.every(
      (instrumentId) =>
        repo.getSettledFundingInRange({
          instrumentId,
          fromTs: BACKTEST_FROM_TS,
          toTs: BACKTEST_TO_TS
        }).length > 0
    );
    return assessSeaTrial({
      main,
      bars,
      neighbours,
      sibling,
      initialEquityUsdt: BACKTEST_EQUITY_USDT,
      dataSource,
      funding: settled ? "settled" : "assumed",
      trials,
      days: BACKTEST_DAYS,
      seed: seedFromString(proposition.propositionId),
      settings: this.seaTrialSettings
    });
  }

  /** One backtest per coin a boat trades, combined into the boat's portfolio (ADR-0028). */
  private async replayBasket(
    blueprint: BotBlueprint,
    strategyId: string,
    trials: number,
    full: boolean
  ): Promise<TrialRun> {
    const runs: TrialRun[] = [];
    for (const instrumentId of blueprintMarkets(blueprint)) {
      await this.breathe();
      runs.push(this.replay({ ...blueprint, instrumentId, basket: [] }, strategyId, trials, full));
    }
    return combineRuns(runs, Number(BACKTEST_EQUITY_USDT), trials);
  }

  /**
   * Fills the backtest window once per instrument: OKX history when reachable, otherwise a
   * synthetic series that every assessment then labels as synthetic.
   */
  private ensureBacktestData(instrumentId: FleetInstrument): Promise<"okx" | "synthetic"> {
    const known = this.repo.getBacktestDataSource(instrumentId, BACKTEST_FROM_TS);
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
          barCount1H: expectedBars,
          basePrice: SYNTHETIC_BASE_PRICES[instrumentId]
        });
        source = "synthetic";
      }
      this.repo.setBacktestDataSource(instrumentId, BACKTEST_FROM_TS, source);
      return source;
    })().finally(() => this.dataFills.delete(instrumentId));
    this.dataFills.set(instrumentId, fill);
    return fill;
  }

  public discard(propositionId: string): Proposition {
    const p = this.repo.getProposition(propositionId);
    if (!p) throw new FleetError(404, "Proposition not found");
    if (p.status === "launched") throw new FleetError(409, "This proposition is already a boat");
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
      throw new FleetError(400, "Give the boat at least 100 USDT so it can size a trade");
    }
    const name = input.name.trim();
    if (this.repo.listBots().some((b) => b.name.toLowerCase() === name.toLowerCase())) {
      throw new FleetError(409, `There is already a boat called ${name}`);
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
    for (const instrumentId of blueprintMarkets(bot.blueprint)) {
      engine.accountRepo.setSchedulerAnchor({
        instrumentId,
        strategyId: botId,
        anchorCloseTs,
        createdAtMs: nowMs
      });
      engine.accountRepo.recordProcessedBar({
        instrumentId,
        strategyId: botId,
        closeTs: anchorCloseTs
      });
    }
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
    for (const instrumentId of this.marketsReadBy(bot)) {
      try {
        await this.ingestor.ingestRange({
          instrumentId,
          timeframe: "1H",
          fromOpenTs: anchorCloseTs - (bars + 5) * HOUR_MS,
          toOpenTs: anchorCloseTs - HOUR_MS
        });
      } catch {
        // The scheduler's own ingest keeps trying
      }
    }
  }

  /** Every market a boat needs bars for: the coins it trades, then the ones its rules read. */
  private marketsReadBy(bot: BotRecord): string[] {
    return [
      ...new Set<string>([
        ...blueprintMarkets(bot.blueprint),
        ...(this.engineFor(bot).strategy.referenceMarkets ?? [])
      ])
    ];
  }

  private requireBot(botId: string): BotRecord {
    const bot = this.repo.getBot(botId);
    if (!bot) throw new FleetError(404, "Boat not found");
    return bot;
  }

  private markPrices(bot: BotRecord): Record<string, ScaledDecimal> {
    const prices: Record<string, ScaledDecimal> = {};
    for (const instrumentId of blueprintMarkets(bot.blueprint)) {
      const latest = this.dataStore.marketDataRepo.getConfirmedBarsAsOf({
        instrumentId,
        timeframe: "1H",
        asOfMs: this.clock.nowMs(),
        limit: 1
      })[0];
      if (latest) prices[instrumentId] = ScaledDecimal.fromString(latest.close);
    }
    return prices;
  }

  private flattenBot(bot: BotRecord, reason: string): void {
    this.engineFor(bot).broker.flattenAllPositions(reason, this.markPrices(bot));
  }

  public pause(botId: string, reason = "Docked by the operator"): Bot {
    const bot = this.requireBot(botId);
    if (bot.status !== "running") throw new FleetError(409, `The boat is ${bot.status}`);
    this.flattenBot(bot, reason);
    return this.botView(this.repo.saveBot({ ...bot, status: "paused", statusReason: reason }));
  }

  public resume(botId: string): Bot {
    const bot = this.requireBot(botId);
    if (bot.status !== "paused") throw new FleetError(409, `The boat is ${bot.status}`);
    const engine = this.engineFor(bot);
    const nowMs = this.clock.nowMs();
    // Skip the bars that closed while docked, and forget any entry queued before the pause
    for (const instrumentId of blueprintMarkets(bot.blueprint)) {
      engine.accountRepo.recordProcessedBar({
        instrumentId,
        strategyId: botId,
        closeTs: Math.floor(nowMs / HOUR_MS) * HOUR_MS
      });
      engine.accountRepo.savePendingProposal({ strategyId: botId, instrumentId, proposal: null });
    }
    return this.botView(this.repo.saveBot({ ...bot, status: "running", statusReason: null }));
  }

  public retire(botId: string): Bot {
    const bot = this.requireBot(botId);
    if (bot.status === "retired") throw new FleetError(409, "The boat is already retired");
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
      closed += this.engineFor(bot).broker.flattenAllPositions(reason, this.markPrices(bot)).length;
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

  /** The instruments running boats trade, so the scheduler keeps their bars current. */
  public tradedInstruments(): readonly string[] {
    const running = this.repo.listBots().filter((b) => b.status === "running");
    return [...new Set(running.flatMap((b) => this.marketsReadBy(b)))];
  }

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
    let ticks = 0;
    for (const instrumentId of blueprintMarkets(bot.blueprint)) {
      ticks += this.stepBotOn(bot, instrumentId, nowMs);
    }
    return ticks;
  }

  /** Steps one of a boat's coins through its unprocessed confirmed bars. */
  private stepBotOn(bot: BotRecord, instrumentId: string, nowMs: number): number {
    const engine = this.engineFor(bot);
    const repo = this.dataStore.marketDataRepo;
    const key = { instrumentId, strategyId: bot.botId };
    const anchor = engine.accountRepo.getSchedulerAnchor(key) ?? 0;
    const last = engine.accountRepo.getLastProcessedBarCloseTs(key) ?? 0;
    const minCloseTs = Math.max(anchor, last);
    const lookbackBars = (engine.strategy.lookbacks["1H"] ?? 50) + 5;
    const references = engine.strategy.referenceMarkets ?? [];

    const bars = repo
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
      const fromOpenTs = bar.openTs - lookbackBars * HOUR_MS;
      const referenceBars = Object.fromEntries(
        references.map((market) => [
          market,
          repo.getConfirmedBarsInRange({
            instrumentId: market,
            timeframe: "1H",
            fromOpenTs,
            toCloseTs: bar.closeTs
          })
        ])
      );
      // A market the rules read has not posted this hour yet: wait for it, within reason
      const waiting = references.some(
        (m) => referenceBars[m]?.[referenceBars[m].length - 1]?.closeTs !== bar.closeTs
      );
      if (waiting && nowMs - bar.closeTs < REFERENCE_GRACE_MS) break;

      const result = engine.broker.executeConfirmedBarTick({
        bar,
        strategy: engine.strategy,
        featureBars: {
          "1H": repo.getConfirmedBarsInRange({
            instrumentId,
            timeframe: "1H",
            fromOpenTs,
            toCloseTs: bar.closeTs
          })
        },
        ...(references.length > 0 ? { referenceBars } : {}),
        settledFundingRates: repo.getSettledFundingInRange({
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
    const openPositions = engine.accountRepo.listOpenPositions().map((p) => ({
      instrumentId: p.instrumentId,
      side: p.side,
      entryPrice: p.entryPrice,
      contracts: p.contracts,
      protectiveStopPrice: p.protectiveStopPrice,
      takeProfitPrice: p.takeProfitPrice,
      unrealizedPnlUsdt: ScaledDecimal.fromString(p.unrealizedPnlUsdt).toFixed(2),
      openedAtMs: p.openedAtMs
    }));
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
        instrumentId: p.instrumentId,
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
      openPosition: openPositions[0] ?? null,
      openPositions,
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
        openPositions: active.reduce((n, b) => n + b.openPositions.length, 0)
      },
      schedulerRunning: this.isSchedulerRunning(),
      killSwitchActive: killed,
      killSwitchReason: killed ? breaker.reason : null,
      designer: this.designerInfo(),
      liveTradingAvailable: false
    };
  }
}
