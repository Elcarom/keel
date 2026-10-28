import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import {
  CONFIG_FIELD_REGISTRY,
  MANUAL_EXECUTION_STRATEGY_ID,
  PromotionLadderEvaluator,
  RiskGuardian,
  ScaledDecimal,
  SEALED_HOLDOUT_START_TS,
  SEALED_2026_HOLDOUT_START_TS,
  overlapsSealed2026Holdout,
  SystemClock,
  createDefaultConfig,
  defaultInstrumentSpec,
  diffConfigs,
  getUtcDayStartMs,
  isExchangeExecutionMode,
  isRealMoneyExecutionMode,
  keelApiContract,
  type CircuitBreakerRecord,
  type CircuitBreakerStatus,
  type Clock,
  type ExchangeBroker,
  type KeelConfig,
  type LookbackValidationResult,
  type ExecutionMode,
  type KillSwitchFlattenOutcome,
  type LlmGateway,
  type PaperPositionRecord,
  type PortfolioRiskState,
  type PromotionStage,
  type Proposal,
  type SecretKeyName,
  type StrategyRiskState
} from "@keel/core";
import {
  createSqliteDataStore,
  seedSyntheticMarketSeries,
  OkxPublicIngestor,
  type SqliteDataStore
} from "@keel/data";
import {
  BotDesigner,
  ClaudeLlmGateway,
  ContextAnalyst,
  EventGateAdvisor,
  GeminiLlmGateway,
  MarkoutForensicsAnalyst,
  NarrativeClusterTagger,
  ShadowAdvisor
} from "@keel/ai";
import { OkxBroker, okxDemoVenueFor } from "@keel/broker";
import { ReplayEngine } from "@keel/replay";
import { StrategySpecV1Schema, computeSpecHash, describeSpec } from "@keel/spec";
import { BaselineChooser, DEFAULT_STRATEGIES, resolveStrategyById } from "@keel/strategy";
import { initServer } from "@ts-rest/fastify";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { DiscordWebhookNotifier, type WebhookFetchFn } from "./notifications.js";
import { FleetError, FleetService } from "./fleet.js";
import { PaperBroker } from "./paper-broker.js";
import { UnattendedScheduler } from "./scheduler.js";
import { PINO_REDACT_PATHS } from "./redact.js";
import {
  AuthManager,
  RateLimitError,
  SecretVault,
  formatClearSessionCookieHeader,
  formatSessionCookieHeader,
  resolveIngressContext,
  validateMasterKey,
  type IngressContext
} from "./security.js";

export interface KeelServerOptions {
  readonly config?: KeelConfig | undefined;
  readonly clock?: Clock | undefined;
  readonly dbPath?: string | undefined;
  readonly backupsDir?: string | undefined;
  readonly dataStore?: SqliteDataStore | undefined;
  readonly masterKeyMaterial?: string | undefined;
  readonly initialBootstrapToken?: string | undefined;
  readonly onBootstrapToken?: ((token: string) => void) | undefined;
  readonly webhookFetchFn?: WebhookFetchFn | undefined;
  readonly llmGateway?: LlmGateway | undefined;
  readonly exchangeBroker?: ExchangeBroker | undefined;
  readonly webDistPath?: string | undefined;
  readonly logger?: boolean | undefined;
  readonly enableScheduler?: boolean | undefined;
  /** Lets session cookies work over plain HTTP (LAN testing); HTTPS requests still get Secure. */
  readonly allowInsecureHttp?: boolean | undefined;
  readonly schedulerIntervalMs?: number | undefined;
  readonly scheduler?: UnattendedScheduler | undefined;
  /** Replaces the Shipyard's designer (tests); defaults to Claude, or samples without a key. */
  readonly botDesigner?: BotDesigner | undefined;
  /** OKX public market data source (tests inject one that never reaches the network). */
  readonly marketIngestor?: OkxPublicIngestor | undefined;
}

export async function createKeelServer(options: KeelServerOptions = {}): Promise<FastifyInstance> {
  const initialConfig = options.config ?? createDefaultConfig();
  const clock = options.clock ?? new SystemClock();
  const startedAtMs = clock.nowMs();
  const dbPath = options.dbPath ?? process.env["KEEL_DB_PATH"] ?? ":memory:";
  const backupsDir = options.backupsDir ?? process.env["KEEL_BACKUPS_DIR"];

  const dataStore =
    options.dataStore ??
    createSqliteDataStore({
      dbPath,
      clock,
      backupsDir,
      initialConfig
    });

  const masterKeyMaterial = options.masterKeyMaterial ?? process.env["KEEL_MASTER_KEY"];
  const masterKeyCheck = validateMasterKey(masterKeyMaterial);

  const secretVault = new SecretVault({
    repo: dataStore.secretVaultRepo,
    clock,
    masterKeyMaterial,
    allowUnconfigured: !masterKeyCheck.valid
  });

  const authManager = new AuthManager({
    authRepo: dataStore.authRepo,
    clock,
    initialBootstrapToken: options.initialBootstrapToken,
    onBootstrapToken:
      options.onBootstrapToken ??
      ((token) => {
        if (options.logger === true) {
          process.stdout.write(`\n[KEEL BOOTSTRAP] One-time admin bootstrap token: ${token}\n\n`);
        }
      })
  });

  const getActiveSnapshot = () => dataStore.configRepo.getActiveConfig();

  const getSecretSafe = (key: SecretKeyName): string | null => {
    try {
      return secretVault.getDecryptedSecret(key);
    } catch {
      return null;
    }
  };

  const notifier = new DiscordWebhookNotifier({
    clock,
    getConfig: () => getActiveSnapshot().config,
    getWebhookUrl: () =>
      getSecretSafe("discordWebhookUrl") ?? process.env["KEEL_DISCORD_WEBHOOK_URL"] ?? null,
    fetchFn: options.webhookFetchFn
  });

  const replayEngine = new ReplayEngine({
    marketDataRepo: dataStore.marketDataRepo,
    experimentRepo: dataStore.experimentRepo,
    clock
  });

  const paperBroker = new PaperBroker({
    clock,
    ledgerRepo: dataStore.ledgerRepo,
    paperAccountRepo: dataStore.paperAccountRepo,
    getRiskConfig: () => getActiveSnapshot().config.risk,
    // Deferred until the running tick returns so the flatten never re-enters it
    onCircuitBreakerTripped: (record) => {
      void Promise.resolve().then(() => onCircuitBreakerTripped(record));
    }
  });

  const llmGateway =
    options.llmGateway ??
    new GeminiLlmGateway({
      clock,
      getConfig: () => getActiveSnapshot().config.ai,
      getApiKey: () => getSecretSafe("geminiApiKey") ?? process.env["KEEL_GEMINI_API_KEY"] ?? null
    });

  const claudeGateway = new ClaudeLlmGateway({
    clock,
    getConfig: () => getActiveSnapshot().config.ai,
    getApiKey: () => getSecretSafe("anthropicApiKey") ?? process.env["ANTHROPIC_API_KEY"] ?? null
  });
  const designerIsLive = (): boolean =>
    claudeGateway.hasApiKey() && !getActiveSnapshot().config.ai.simulateResponses;
  const botDesigner =
    options.botDesigner ??
    new BotDesigner({ clock, gateway: claudeGateway, isLive: designerIsLive });

  const okxIngestor =
    options.marketIngestor ?? new OkxPublicIngestor({ marketDataRepo: dataStore.marketDataRepo });

  const fleet: FleetService = new FleetService({
    clock,
    dataStore,
    replayEngine,
    designer: botDesigner,
    getConfig: () => getActiveSnapshot().config,
    designerInfo: () => ({
      source: options.botDesigner || designerIsLive() ? "claude" : "sample",
      model: getActiveSnapshot().config.ai.botDesignerModel
    }),
    isSchedulerRunning: (): boolean => scheduler.isRunning(),
    ingestor: okxIngestor
  });

  const contextAnalyst = new ContextAnalyst(llmGateway);
  const shadowAdvisor = new ShadowAdvisor(llmGateway);
  const eventGateAdvisor = new EventGateAdvisor(llmGateway);
  const narrativeClusterTagger = new NarrativeClusterTagger(llmGateway);
  const markoutForensicsAnalyst = new MarkoutForensicsAnalyst(llmGateway);

  // Demo and real-money positions live on different OKX accounts: switching venue while the
  // exchange book holds positions would orphan them from the DMS, reconciliation and flatten
  // Leaving the exchange modes would likewise stop their DMS heartbeat and reconciliation.
  const venueSwitchStrandsPositions = (from: ExecutionMode, to: ExecutionMode): string | null => {
    if (isExchangeExecutionMode(to) && okxDemoVenueFor(from) === okxDemoVenueFor(to)) {
      return null;
    }
    const open = dataStore.exchangeAccountRepo.listOpenPositions().length;
    return open > 0
      ? `Cannot switch Execution Mode from ${from} to ${to} with ${open} open exchange position(s); flatten them first`
      : null;
  };

  const okxBroker =
    options.exchangeBroker ??
    new OkxBroker({
      clock,
      getRiskConfig: () => getActiveSnapshot().config.risk,
      // Trading keys come only from the encrypted vault, whose writes need step-up and are audited
      // (audit-4 M4); there is deliberately no plaintext environment fallback
      getCredentials: () => {
        const apiKey = getSecretSafe("okxApiKey");
        const secretKey = getSecretSafe("okxSecretKey");
        const passphrase = getSecretSafe("okxPassphrase");

        if (!apiKey || !secretKey || !passphrase) {
          return null;
        }

        return { apiKey, secretKey, passphrase };
      },
      // Re-evaluated per request so a mode change can never leave orders on the wrong venue
      isDemo: () => okxDemoVenueFor(getActiveSnapshot().config.system.executionMode),
      notificationChannel: notifier,
      accountRepo: dataStore.exchangeAccountRepo,
      ledgerRepo: dataStore.exchangeLedgerRepo,
      marketDataRepo: dataStore.marketDataRepo
    });

  if (okxBroker instanceof OkxBroker) {
    // Real-venue positions and journals live in the exchange book, never the paper book (audit-3 C2)
    okxBroker.setRepositories({
      accountRepo: dataStore.exchangeAccountRepo,
      ledgerRepo: dataStore.exchangeLedgerRepo,
      marketDataRepo: dataStore.marketDataRepo
    });
  }

  /** Demotion flattens must not fail the request after the paper book already flattened. */
  const flattenExchangeOrAlert = async (
    reason: string
  ): Promise<readonly PaperPositionRecord[]> => {
    try {
      return await okxBroker.flattenAllPositions(reason);
    } catch (err) {
      await notifier.send({
        severity: "CRITICAL",
        title: "EXCHANGE FLATTEN FAILED",
        body: `${reason}: ${err instanceof Error ? err.message : String(err)}`,
        dedupKey: `exchange-flatten-fail-${clock.nowMs()}`
      });
      return [];
    }
  };

  const isKillSwitchStatus = (status: CircuitBreakerStatus): boolean =>
    status === "MANUAL_KILL_SWITCH" || status === "DRAWDOWN_KILL_SWITCH";

  /**
   * Kill Switch Flatten (audit-3 H9): closes every position in both Trading Books, then verifies
   * against the venue itself, so untracked positions the flatten could not close count as open.
   */
  const runKillSwitchFlatten = async (reason: string): Promise<KillSwitchFlattenOutcome> => {
    const errors: string[] = [];
    const paperClosed = paperBroker.flattenAllPositions(`Kill Switch: ${reason}`);
    const fleetClosed = fleet.flattenAll(`Kill Switch: ${reason}`);
    let exchangeClosed: readonly PaperPositionRecord[] = [];
    try {
      exchangeClosed = await okxBroker.flattenAllPositions(`Kill Switch: ${reason}`);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    let exchangeFlat = false;
    try {
      const recon = await okxBroker.reconcilePositions();
      exchangeFlat =
        okxBroker.getOpenPositions().length === 0 && recon.exchangePositionsCount === 0;
    } catch (err) {
      errors.push(`Venue verification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const outcome: KillSwitchFlattenOutcome = {
      paperFlattenedCount: paperClosed.length + fleetClosed,
      exchangeFlattenedCount: exchangeClosed.length,
      paperFlat:
        dataStore.paperAccountRepo.listOpenPositions().length === 0 &&
        fleet.openPositionCount() === 0,
      exchangeFlat,
      errors
    };
    if (!outcome.paperFlat || !outcome.exchangeFlat) {
      await notifier.send({
        severity: "CRITICAL",
        title: "KILL SWITCH FLATTEN INCOMPLETE",
        body: `Kill Switch tripped but positions remain open (paper flat: ${outcome.paperFlat}, exchange flat: ${outcome.exchangeFlat}). ${errors.join("; ")}`,
        dedupKey: `kill-switch-incomplete-${clock.nowMs()}`
      });
    }
    return outcome;
  };

  /** Risk Engine trips land here: refresh the exchange broker's breaker, flatten on Kill Switch. */
  const onCircuitBreakerTripped = async (record: CircuitBreakerRecord): Promise<void> => {
    okxBroker.setCircuitBreaker(record);
    if (isKillSwitchStatus(record.status)) {
      const outcome = await runKillSwitchFlatten(record.reason);
      dataStore.auditRepo.append({
        ts: clock.nowMs(),
        actor: record.updatedBy,
        clientIp: "internal",
        action: "kill_switch.trip",
        riskClass: "confirm",
        configHash: getActiveSnapshot().configHash,
        details: { status: record.status, reason: record.reason, killSwitch: outcome }
      });
    }
  };

  // Real-money loss limits are watched on every heartbeat, not only when an order is attempted
  // (audit-4 H1). An active breaker is never re-tripped or overridden here.
  const checkVenueBookRisk = async (): Promise<void> => {
    if (dataStore.paperAccountRepo.getCircuitBreaker().status !== "NORMAL") {
      return;
    }
    const nowMs = clock.nowMs();
    const openUnrealizedPnlUsdt = okxBroker
      .getOpenPositions()
      .reduce(
        (sum, p) => sum.add(ScaledDecimal.fromString(p.unrealizedPnlUsdt)),
        ScaledDecimal.zero()
      );
    const metrics = dataStore.exchangeLedgerRepo.getRiskMetrics({
      asOfMs: nowMs,
      strategyId: null,
      openUnrealizedPnlUsdt
    });
    const breach = new RiskGuardian(getActiveSnapshot().config.risk).evaluatePortfolioBreakers(
      {
        equityUsdt: metrics.currentEquityUsdt,
        highWaterMarkEquityUsdt: metrics.highWaterMarkEquityUsdt,
        dayStartEquityUsdt: metrics.dayStartEquityUsdt
      },
      nowMs
    );
    if (breach) {
      const breaker = { ...breach.breaker, reason: `Venue Book: ${breach.breaker.reason}` };
      dataStore.paperAccountRepo.setCircuitBreaker(breaker);
      await onCircuitBreakerTripped(breaker);
    }
  };

  const scheduler =
    options.scheduler ??
    new UnattendedScheduler({
      clock,
      dataStore,
      paperBroker,
      exchangeBroker: okxBroker,
      ingestor: okxIngestor,
      fleet,
      getRiskConfig: () => getActiveSnapshot().config.risk,
      getSystemConfig: () => getActiveSnapshot().config.system,
      notificationChannel: notifier,
      intervalMs: options.schedulerIntervalMs,
      checkVenueBookRisk
    });

  if (options.enableScheduler === true) {
    scheduler.start();
  } else {
    // The DMS must stay armed in exchange modes even when bar stepping is disabled (audit-3 H8)
    scheduler.startHeartbeat();
  }

  const getUptimeSeconds = (): number =>
    Math.max(0, Math.floor((clock.nowMs() - startedAtMs) / 1000));

  const app = Fastify({
    // Caps input before zod validates it: zod 3 has an unpatched oversized-input memory advisory,
    // and ts-rest 3.52 cannot move to zod 4 yet (docs/audit/audit-4.md)
    bodyLimit: 1_048_576,
    trustProxy: initialConfig.system.trustCloudflareHeaders,
    logger:
      options.logger === true
        ? {
            level: process.env["LOG_LEVEL"] ?? "info",
            redact: {
              paths: PINO_REDACT_PATHS,
              censor: "[REDACTED]"
            }
          }
        : false
  });

  if (!masterKeyCheck.valid) {
    const errorMsg = `[KEEL SECURITY ERROR] Vault master key is invalid or unset: ${masterKeyCheck.reason}. Vault storage and retrieval are disabled.`;
    if (options.logger === true) {
      app.log.error(errorMsg);
    } else {
      process.stderr.write(`${errorMsg}\n`);
    }
  }

  // Browser hardening for the dashboard: same-origin everything, no framing, no MIME sniffing
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    return payload;
  });

  app.addHook("onClose", async () => {
    scheduler.stop();
    const active = getActiveSnapshot();
    try {
      if (active.config.system.shutdownPolicy === "flatten") {
        await paperBroker.flattenAllPositions("Container shutdown with shutdownPolicy=flatten");
        await okxBroker.flattenAllPositions("Container shutdown with shutdownPolicy=flatten");
      }
    } finally {
      dataStore.close();
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (
      error instanceof RateLimitError ||
      (typeof error === "object" &&
        error !== null &&
        (error as { isRateLimited?: boolean }).isRateLimited)
    ) {
      const retryAfter = (error as { retryAfterSeconds?: number }).retryAfterSeconds ?? 60;
      void reply.header("retry-after", String(retryAfter));
      return reply.status(429).send({
        error: error instanceof Error ? error.message : "Rate limit exceeded"
      });
    }
    return reply.send(error);
  });

  const getIngress = (req: FastifyRequest): IngressContext => {
    const active = getActiveSnapshot();
    return resolveIngressContext({
      headers: req.headers,
      fallbackIp: req.ip,
      config: active.config,
      authManager,
      nowMs: clock.nowMs()
    });
  };

  // One step-up check for every human-gated action; rate limiting always keys on the request IP
  const stepUpDenied = (
    ingress: IngressContext,
    credentials: {
      readonly stepUpPassword?: string | undefined;
      readonly stepUpTotpCode?: string | undefined;
    },
    error: string
  ) =>
    authManager.verifyStepUp({
      sessionToken: ingress.sessionToken,
      password: credentials.stepUpPassword,
      totpCode: credentials.stepUpTotpCode,
      clientIp: ingress.clientIp
    })
      ? null
      : { status: 403 as const, body: { error, requiresStepUp: true } };

  // Gates G2 and G3 are step-up MFA (docs/design/bot-platform.md): no exchange order (G2, even on
  // Demo) and no real-money capability (G3) is reachable until a TOTP authenticator is enrolled,
  // after which step-up demands its code (audit-4 H4)
  const mfaDenied = (gate: "G2" | "G3", action: string) =>
    authManager.isTotpEnabled()
      ? null
      : {
          status: 403 as const,
          body: {
            error: `Gate ${gate}: enrol a TOTP authenticator before ${action}`,
            requiresStepUp: true
          }
        };
  const exchangeGateFor = (mode: ExecutionMode): "G2" | "G3" =>
    isRealMoneyExecutionMode(mode) ? "G3" : "G2";

  /** Denies a config change that would move into a real-money Execution Mode without G3 MFA. */
  const realMoneySwitchDenied = (from: ExecutionMode, to: ExecutionMode) =>
    isRealMoneyExecutionMode(to) && to !== from
      ? mfaDenied("G3", `switching to the ${to} Execution Mode`)
      : null;

  const requireAuthenticatedIngress = (
    req: FastifyRequest
  ): (IngressContext & { readonly username: string }) | null => {
    const ingress = getIngress(req);
    if (!ingress.session.authenticated || !ingress.session.username) {
      return null;
    }
    return {
      ...ingress,
      username: ingress.session.username
    };
  };

  app.get("/healthz", async () => {
    return {
      status: "ok",
      appName: "Keel",
      timestampMs: clock.nowMs()
    };
  });

  app.get("/readyz", async () => {
    const active = getActiveSnapshot();
    return {
      ready: true,
      executionMode: active.config.system.executionMode
    };
  });

  app.get("/metrics", async (_req, reply) => {
    const active = getActiveSnapshot();
    const uptimeSeconds = getUptimeSeconds();
    const lines = [
      "# HELP keel_up Whether the Keel process is healthy (1 = up).",
      "# TYPE keel_up gauge",
      "keel_up 1",
      "# HELP keel_uptime_seconds Process uptime in seconds.",
      "# TYPE keel_uptime_seconds gauge",
      `keel_uptime_seconds ${uptimeSeconds}`,
      "# HELP keel_execution_mode_info Active execution mode label.",
      "# TYPE keel_execution_mode_info gauge",
      `keel_execution_mode_info{mode="${active.config.system.executionMode}"} 1`
    ];
    return reply
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .send(`${lines.join("\n")}\n`);
  });

  // SSE live heartbeat stream (15s keep-alive for Cloudflare Tunnel ADR-0003)
  app.get("/api/v1/stream/heartbeat", (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const writeBeat = () => {
      const active = getActiveSnapshot();
      const payload = JSON.stringify({
        timestampMs: clock.nowMs(),
        executionMode: active.config.system.executionMode,
        configHash: active.configHash.slice(0, 12),
        configVersion: active.version
      });
      reply.raw.write(`event: heartbeat\ndata: ${payload}\n\n`);
    };

    writeBeat();
    const timer = setInterval(writeBeat, initialConfig.system.sseHeartbeatMs);

    req.raw.on("close", () => {
      clearInterval(timer);
    });
  });

  const computeStrategyDrawdownPct = (
    strategyId: string,
    book: "paper" | "exchange" = "paper"
  ): number => {
    const accountRepo =
      book === "paper" ? dataStore.paperAccountRepo : dataStore.exchangeAccountRepo;
    const ledgerRepo = book === "paper" ? dataStore.ledgerRepo : dataStore.exchangeLedgerRepo;
    const openPositions = accountRepo.listOpenPositions();
    let openUnrealized = ScaledDecimal.zero();
    for (const pos of openPositions) {
      if (pos.strategyId === strategyId) {
        openUnrealized = openUnrealized.add(ScaledDecimal.fromString(pos.unrealizedPnlUsdt));
      }
    }
    const riskMetrics = ledgerRepo.getRiskMetrics({
      asOfMs: clock.nowMs(),
      strategyId,
      openUnrealizedPnlUsdt: openUnrealized
    });
    return Number(riskMetrics.drawdownPct.toFixed(4));
  };

  // Promotion evidence comes from the book the stage trades in: paper up to Paper, and the Venue
  // Book from Demo on, counting only trades closed since the strategy entered its stage (audit-4 H3).
  // The evaluator's paperTradesCount / paperDrawdownPct fields carry whichever book applies.
  const stageEvidence = (
    strategyId: string,
    stage: PromotionStage,
    stageStartMs: number
  ): { readonly tradesCount: number; readonly drawdownPct: number } => {
    const onVenue = stage === "Demo" || stage === "Live-Ramp" || stage === "Live";
    if (!onVenue) {
      return {
        tradesCount: dataStore.paperAccountRepo
          .listAllPositions()
          .filter((p) => p.strategyId === strategyId && p.status === "CLOSED").length,
        drawdownPct: computeStrategyDrawdownPct(strategyId)
      };
    }
    return {
      tradesCount: dataStore.exchangeAccountRepo
        .listAllPositions()
        .filter(
          (p) =>
            p.strategyId === strategyId &&
            p.status === "CLOSED" &&
            (p.closedAtMs ?? 0) >= stageStartMs
        ).length,
      drawdownPct: computeStrategyDrawdownPct(strategyId, "exchange")
    };
  };

  /** Runs a Fleet action for a signed-in operator, mapping refusals to their HTTP status. */
  const fleetAction = async <T>(
    request: FastifyRequest,
    action: string,
    run: () => T | Promise<T>
  ): Promise<
    { status: 200; body: T } | { status: 400 | 401 | 404 | 409; body: { error: string } }
  > => {
    const authIngress = requireAuthenticatedIngress(request);
    if (!authIngress) {
      return { status: 401, body: { error: "Authentication required" } };
    }
    try {
      const body = await run();
      dataStore.auditRepo.append({
        ts: clock.nowMs(),
        actor: authIngress.username,
        clientIp: authIngress.clientIp,
        action: `fleet.${action}`,
        riskClass: "safe",
        configHash: getActiveSnapshot().configHash,
        details: {}
      });
      return { status: 200, body };
    } catch (err) {
      if (err instanceof FleetError) {
        return { status: err.status, body: { error: err.message } };
      }
      throw err;
    }
  };

  const s = initServer();
  const router = s.router(keelApiContract, {
    fleet: {
      getOverview: async ({ request }) => {
        if (!requireAuthenticatedIngress(request)) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        return { status: 200, body: fleet.overview() };
      },
      createWallet: async ({ body, request }) =>
        fleetAction(request, "wallet.create", () => ({
          wallet: fleet.createWallet(body.name, body.startingBalanceUsdt)
        })),
      depositToWallet: async ({ params, body, request }) =>
        fleetAction(request, "wallet.deposit", () => ({
          wallet: fleet.deposit(params.walletId, body.amountUsdt)
        })),
      listDesigns: async ({ request }) => {
        if (!requireAuthenticatedIngress(request)) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        return { status: 200, body: { batches: [...fleet.listDesigns()] } };
      },
      designBots: async ({ body, request }) => {
        try {
          return await fleetAction(request, "design", async () => ({
            batch: await fleet.design(body)
          }));
        } catch (err) {
          return {
            status: 502,
            body: {
              error: `The bot designer could not answer: ${err instanceof Error ? err.message : String(err)}`
            }
          };
        }
      },
      discardProposition: async ({ params, request }) =>
        fleetAction(request, "proposition.discard", () => ({
          proposition: fleet.discard(params.propositionId)
        })),
      launchBot: async ({ params, body, request }) =>
        fleetAction(request, "bot.launch", () => ({
          bot: fleet.launch(params.propositionId, body)
        })),
      pauseBot: async ({ params, request }) =>
        fleetAction(request, "bot.pause", () => ({ bot: fleet.pause(params.botId) })),
      resumeBot: async ({ params, request }) =>
        fleetAction(request, "bot.resume", () => ({ bot: fleet.resume(params.botId) })),
      retireBot: async ({ params, request }) =>
        fleetAction(request, "bot.retire", () => ({ bot: fleet.retire(params.botId) })),
      deleteBot: async ({ params, request }) =>
        fleetAction(request, "bot.delete", () => {
          fleet.remove(params.botId);
          return { deleted: true as const };
        })
    },
    system: {
      getStatus: async ({ request }) => {
        const active = getActiveSnapshot();
        const nowMs = clock.nowMs();
        const uptimeSeconds = getUptimeSeconds();
        const ingress = getIngress(request);
        return {
          status: 200,
          body: {
            appName: "Keel",
            version: "0.1.0",
            executionMode: active.config.system.executionMode,
            configHash: active.configHash,
            configVersion: active.version,
            serverTimeMs: nowMs,
            serverTimeIso: clock.isoNow(),
            uptimeSeconds,
            cloudflareTunnelActive: ingress.cloudflareTunnelActive,
            forwardedProto: ingress.forwardedProto,
            clientIp: ingress.clientIp,
            status: "ok"
          }
        };
      },

      createBackup: async ({ request }) => {
        const authIngress = requireAuthenticatedIngress(request);
        if (!authIngress) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        const active = getActiveSnapshot();
        const backup = dataStore.createBackup();
        dataStore.auditRepo.append({
          ts: clock.nowMs(),
          actor: authIngress.username,
          clientIp: authIngress.clientIp,
          action: "system.backup",
          riskClass: "safe",
          configHash: active.configHash,
          details: {
            fileName: backup.fileName,
            sizeBytes: backup.sizeBytes,
            integrityOk: backup.integrityOk
          }
        });
        return {
          status: 200,
          body: { backup }
        };
      },

      stepScheduler: async ({ request }) => {
        const authIngress = requireAuthenticatedIngress(request);
        if (!authIngress) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        const stepResult = await scheduler.stepOnce();
        return {
          status: 200,
          body: {
            ok: stepResult.ok,
            timestampMs: stepResult.timestampMs,
            barsIngested: stepResult.barsIngested,
            ticksExecuted: stepResult.ticksExecuted,
            errors: [...stepResult.errors]
          }
        };
      }
    },

    auth: {
      getSession: async ({ request }) => {
        const ingress = getIngress(request);
        return {
          status: 200,
          body: ingress.session
        };
      },

      bootstrap: async ({ body, request, reply }) => {
        const ingress = getIngress(request);
        const active = getActiveSnapshot();
        try {
          const boot = authManager.bootstrapAdmin(body);
          const loginRes = authManager.login({
            username: body.username,
            password: body.password,
            clientIp: ingress.clientIp
          });
          reply.header(
            "set-cookie",
            formatSessionCookieHeader(loginRes.sessionToken, ingress.forwardedProto, {
              allowInsecureHttp: options.allowInsecureHttp === true
            })
          );
          dataStore.auditRepo.append({
            ts: clock.nowMs(),
            actor: boot.username,
            clientIp: ingress.clientIp,
            action: "auth.bootstrap",
            riskClass: "confirm",
            configHash: active.configHash,
            details: { username: boot.username }
          });
          return {
            status: 200,
            body: {
              ok: true as const,
              username: boot.username,
              totpSecretBase32: boot.totpSecretBase32,
              otpauthUri: boot.otpauthUri
            }
          };
        } catch (err) {
          if (
            err instanceof RateLimitError ||
            (typeof err === "object" &&
              err !== null &&
              (err as { isRateLimited?: boolean }).isRateLimited)
          ) {
            const retryAfter = (err as { retryAfterSeconds?: number }).retryAfterSeconds ?? 60;
            reply.header("retry-after", String(retryAfter));
            return {
              status: 429,
              body: {
                error: err instanceof Error ? err.message : "Rate limit exceeded"
              }
            };
          }
          return {
            status: 403,
            body: {
              error: err instanceof Error ? err.message : "Bootstrap failed"
            }
          };
        }
      },

      login: async ({ body, request, reply }) => {
        const ingress = getIngress(request);
        const active = getActiveSnapshot();
        try {
          const loginRes = authManager.login({
            username: body.username,
            password: body.password,
            totpCode: body.totpCode,
            clientIp: ingress.clientIp
          });
          reply.header(
            "set-cookie",
            formatSessionCookieHeader(loginRes.sessionToken, ingress.forwardedProto, {
              allowInsecureHttp: options.allowInsecureHttp === true
            })
          );
          dataStore.auditRepo.append({
            ts: clock.nowMs(),
            actor: loginRes.username,
            clientIp: ingress.clientIp,
            action: "auth.login",
            riskClass: "safe",
            configHash: active.configHash,
            details: { totpEnabled: loginRes.totpEnabled }
          });
          return {
            status: 200,
            body: {
              ok: true as const,
              username: loginRes.username,
              totpEnabled: loginRes.totpEnabled
            }
          };
        } catch (err) {
          if (
            err instanceof RateLimitError ||
            (typeof err === "object" &&
              err !== null &&
              (err as { isRateLimited?: boolean }).isRateLimited)
          ) {
            const retryAfter = (err as { retryAfterSeconds?: number }).retryAfterSeconds ?? 60;
            reply.header("retry-after", String(retryAfter));
            return {
              status: 429,
              body: {
                error: err instanceof Error ? err.message : "Rate limit exceeded"
              }
            };
          }
          return {
            status: 401,
            body: {
              error: err instanceof Error ? err.message : "Authentication failed"
            }
          };
        }
      },

      logout: async ({ request, reply }) => {
        const ingress = getIngress(request);
        const active = getActiveSnapshot();
        authManager.logout(ingress.sessionToken);
        reply.header("set-cookie", formatClearSessionCookieHeader());
        if (ingress.session.username) {
          dataStore.auditRepo.append({
            ts: clock.nowMs(),
            actor: ingress.session.username,
            clientIp: ingress.clientIp,
            action: "auth.logout",
            riskClass: "safe",
            configHash: active.configHash,
            details: {}
          });
        }
        return {
          status: 200,
          body: { ok: true as const }
        };
      },

      enrollTotp: async ({ body, request }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated || !ingress.sessionToken || !ingress.session.username) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        const active = getActiveSnapshot();
        try {
          const enrolled = authManager.enrollTotp(ingress.sessionToken, body.password);
          dataStore.auditRepo.append({
            ts: clock.nowMs(),
            actor: ingress.session.username,
            clientIp: ingress.clientIp,
            action: "auth.totp_enroll",
            riskClass: "confirm",
            configHash: active.configHash,
            details: {}
          });
          return {
            status: 200,
            body: enrolled
          };
        } catch (err) {
          return {
            status: 401,
            body: {
              error: err instanceof Error ? err.message : "Failed to enroll TOTP"
            }
          };
        }
      },

      verifyTotp: async ({ body, request }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated || !ingress.sessionToken || !ingress.session.username) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        const active = getActiveSnapshot();
        try {
          authManager.enableTotp(ingress.sessionToken, body.code);
          dataStore.auditRepo.append({
            ts: clock.nowMs(),
            actor: ingress.session.username,
            clientIp: ingress.clientIp,
            action: "auth.totp_verify",
            riskClass: "confirm",
            configHash: active.configHash,
            details: { totpEnabled: true }
          });
          return {
            status: 200,
            body: {
              ok: true as const,
              totpEnabled: true as const
            }
          };
        } catch (err) {
          return {
            status: 400,
            body: {
              error: err instanceof Error ? err.message : "Invalid TOTP code"
            }
          };
        }
      }
    },

    config: {
      getActive: async ({ request }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        return {
          status: 200,
          body: {
            active: getActiveSnapshot(),
            registry: [...CONFIG_FIELD_REGISTRY]
          }
        };
      },

      previewDiff: async ({ body, request }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        const active = getActiveSnapshot();
        const diff = diffConfigs(active.config, body.config, active.config.system.executionMode);
        return {
          status: 200,
          body: {
            ...diff,
            changes: [...diff.changes],
            blockedPaths: [...diff.blockedPaths]
          }
        };
      },

      updateConfig: async ({ body, request }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated || !ingress.session.username) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        const active = getActiveSnapshot();
        const strandError = venueSwitchStrandsPositions(
          active.config.system.executionMode,
          body.config.system.executionMode
        );
        if (strandError) {
          return { status: 403, body: { error: strandError } };
        }
        const g3Denial = realMoneySwitchDenied(
          active.config.system.executionMode,
          body.config.system.executionMode
        );
        if (g3Denial) {
          return g3Denial;
        }
        const diff = diffConfigs(active.config, body.config, active.config.system.executionMode);

        if (!diff.allowed) {
          dataStore.auditRepo.append({
            ts: clock.nowMs(),
            actor: ingress.session.username,
            clientIp: ingress.clientIp,
            action: "config.update_blocked",
            riskClass: "locked-in-live",
            configHash: active.configHash,
            details: {
              reason: body.reason,
              blockedPaths: [...diff.blockedPaths]
            }
          });
          return {
            status: 403,
            body: {
              error: "Cannot modify locked-in-live settings while in Live or Live-Ramp mode",
              blockedPaths: [...diff.blockedPaths]
            }
          };
        }

        if (diff.requiresStepUp) {
          const stepUpDenial = stepUpDenied(
            ingress,
            body,
            "Step-up authentication (password or TOTP code) required for this change"
          );
          if (stepUpDenial) {
            dataStore.auditRepo.append({
              ts: clock.nowMs(),
              actor: ingress.session.username,
              clientIp: ingress.clientIp,
              action: "config.update_step_up_failed",
              riskClass: diff.highestRiskClass,
              configHash: active.configHash,
              details: {
                reason: body.reason,
                highestRiskClass: diff.highestRiskClass
              }
            });
            return stepUpDenial;
          }
        }

        const snapshot = dataStore.configRepo.saveConfigSnapshot({
          config: body.config,
          actor: ingress.session.username,
          reason: body.reason,
          highestRiskClass: diff.highestRiskClass,
          createdAtMs: clock.nowMs()
        });

        dataStore.auditRepo.append({
          ts: clock.nowMs(),
          actor: ingress.session.username,
          clientIp: ingress.clientIp,
          action: "config.update",
          riskClass: diff.highestRiskClass,
          configHash: snapshot.configHash,
          details: {
            version: snapshot.version,
            reason: body.reason,
            changedPaths: diff.changes.map((c) => c.path)
          }
        });

        return {
          status: 200,
          body: {
            snapshot,
            diff: {
              ...diff,
              changes: [...diff.changes],
              blockedPaths: [...diff.blockedPaths]
            }
          }
        };
      },

      getHistory: async ({ request }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        return {
          status: 200,
          body: {
            history: [...dataStore.configRepo.getHistory(50)]
          }
        };
      },

      rollbackConfig: async ({ body, request }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated || !ingress.session.username) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        const active = getActiveSnapshot();
        const target = dataStore.configRepo.getVersion(body.targetVersion);
        if (!target) {
          return {
            status: 404,
            body: { error: `Version ${body.targetVersion} does not exist` }
          };
        }

        const strandError = venueSwitchStrandsPositions(
          active.config.system.executionMode,
          target.config.system.executionMode
        );
        if (strandError) {
          return { status: 403, body: { error: strandError } };
        }
        const g3Denial = realMoneySwitchDenied(
          active.config.system.executionMode,
          target.config.system.executionMode
        );
        if (g3Denial) {
          return g3Denial;
        }

        const diff = diffConfigs(active.config, target.config, active.config.system.executionMode);

        if (!diff.allowed) {
          return {
            status: 403,
            body: {
              error: "Rollback modifies locked-in-live fields while in Live or Live-Ramp mode",
              blockedPaths: [...diff.blockedPaths]
            }
          };
        }

        const stepUpDenial = stepUpDenied(
          ingress,
          body,
          "Step-up authentication required for configuration rollback"
        );
        if (stepUpDenial) {
          return stepUpDenial;
        }

        const snapshot = dataStore.configRepo.rollbackToVersion({
          targetVersion: body.targetVersion,
          actor: ingress.session.username,
          reason: body.reason,
          createdAtMs: clock.nowMs()
        });

        dataStore.auditRepo.append({
          ts: clock.nowMs(),
          actor: ingress.session.username,
          clientIp: ingress.clientIp,
          action: "config.rollback",
          riskClass: "confirm",
          configHash: snapshot.configHash,
          details: {
            fromVersion: active.version,
            targetVersion: body.targetVersion,
            newVersion: snapshot.version,
            reason: body.reason
          }
        });

        return {
          status: 200,
          body: {
            snapshot,
            diff: {
              ...diff,
              changes: [...diff.changes],
              blockedPaths: [...diff.blockedPaths]
            }
          }
        };
      }
    },

    secrets: {
      listMetadata: async ({ request }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        return {
          status: 200,
          body: {
            secrets: [...secretVault.listMetadata()]
          }
        };
      },

      upsertSecret: async ({ body, request }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated || !ingress.session.username) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        const stepUpDenial = stepUpDenied(
          ingress,
          body,
          "Step-up authentication required to update vault secrets"
        );
        if (stepUpDenial) {
          return stepUpDenial;
        }

        const active = getActiveSnapshot();
        const secret = secretVault.upsertSecret({
          keyName: body.keyName,
          plaintextValue: body.plaintextValue,
          actor: ingress.session.username
        });

        dataStore.auditRepo.append({
          ts: clock.nowMs(),
          actor: ingress.session.username,
          clientIp: ingress.clientIp,
          action: "secrets.upsert",
          riskClass: "confirm",
          configHash: active.configHash,
          details: {
            keyName: body.keyName,
            maskedPreview: secret.maskedPreview
          }
        });

        return {
          status: 200,
          body: { secret }
        };
      }
    },

    audit: {
      listRecent: async ({ request }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        return {
          status: 200,
          body: {
            events: [...dataStore.auditRepo.listRecent(100)]
          }
        };
      }
    },

    notifications: {
      sendTest: async ({ body, request }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated || !ingress.session.username) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        const active = getActiveSnapshot();
        const result = await notifier.send({
          severity: "INFO",
          title: body.title ?? "Keel Operator Test Alert",
          body: body.body ?? "Discord webhook telemetry channel verified."
        });

        dataStore.auditRepo.append({
          ts: clock.nowMs(),
          actor: ingress.session.username,
          clientIp: ingress.clientIp,
          action: "notifications.test",
          riskClass: "safe",
          configHash: active.configHash,
          details: {
            delivered: result.delivered,
            suppressedReason: result.suppressedReason ?? null
          }
        });

        return {
          status: 200,
          body: result
        };
      }
    },

    market: {
      getSummary: async ({ request }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        const instruments = [...dataStore.marketDataRepo.listInstrumentsWithCoverage()];
        const trackedIds =
          instruments.length > 0
            ? instruments.map((i) => i.instrumentId)
            : ["BTC-USDT-SWAP", "ETH-USDT-SWAP"];

        const strategies = DEFAULT_STRATEGIES.map((strategy) => {
          const lookbackRequirements: Record<string, number> = {};
          for (const [tf, count] of Object.entries(strategy.lookbacks)) {
            if (typeof count === "number" && count > 0) {
              lookbackRequirements[tf] = count;
            }
          }
          const lookbackStatusByInstrument: Record<string, LookbackValidationResult> = {};
          for (const instId of trackedIds) {
            const cov = instruments.find((i) => i.instrumentId === instId);
            const asOfMs = cov?.latestCloseTs ?? clock.nowMs();
            lookbackStatusByInstrument[instId] = dataStore.marketDataRepo.assertLookbackSatisfied({
              instrumentId: instId,
              asOfMs,
              requirements: strategy.lookbacks
            });
          }
          return {
            id: strategy.strategyId,
            version: strategy.version,
            name: strategy.name,
            description: strategy.description,
            lookbackRequirements,
            lookbackStatusByInstrument
          };
        });

        return {
          status: 200,
          body: {
            instruments,
            strategies
          }
        };
      },

      seedSynthetic: async ({ body, request }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated || !ingress.session.username) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        const active = getActiveSnapshot();
        // Synthetic bars stay in the in-sample period so research on them never reaches a sealed holdout (ADR-0011)
        const snapshot = seedSyntheticMarketSeries({
          marketDataRepo: dataStore.marketDataRepo,
          instrumentId: body.instrumentId,
          endCloseTs: Math.min(clock.nowMs(), SEALED_HOLDOUT_START_TS),
          barCount1H: body.barCount1H
        });

        dataStore.auditRepo.append({
          ts: clock.nowMs(),
          actor: ingress.session.username,
          clientIp: ingress.clientIp,
          action: "market.seed_synthetic",
          riskClass: "safe",
          configHash: active.configHash,
          details: {
            instrumentId: body.instrumentId,
            barCount1H: body.barCount1H,
            snapshotId: snapshot.snapshotId,
            barCount: snapshot.barCount,
            fundingCount: snapshot.fundingCount
          }
        });

        return {
          status: 200,
          body: { snapshot }
        };
      }
    },

    replay: {
      runBacktest: async ({ body, request }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated || !ingress.session.username) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        let strategy;
        try {
          strategy = resolveStrategyById(body.strategyId);
        } catch (err) {
          return {
            status: 400,
            body: {
              error: err instanceof Error ? err.message : "Unknown strategyId"
            }
          };
        }

        const coverage = dataStore.marketDataRepo
          .listInstrumentsWithCoverage()
          .find((i) => i.instrumentId === body.instrumentId);
        if (
          !coverage ||
          coverage.earliestOpenTs === null ||
          coverage.latestCloseTs === null ||
          (coverage.barCounts[body.timeframe] ?? 0) === 0
        ) {
          return {
            status: 400,
            body: {
              error: `No confirmed ${body.timeframe} bars found for ${body.instrumentId}. Seed or ingest market data first.`
            }
          };
        }

        const active = getActiveSnapshot();
        const effectiveFromTs = body.fromTs ?? coverage.earliestOpenTs;
        const defaultToTs =
          coverage.earliestOpenTs < SEALED_HOLDOUT_START_TS
            ? Math.min(coverage.latestCloseTs, SEALED_HOLDOUT_START_TS)
            : coverage.latestCloseTs;
        const effectiveToTs = body.toTs ?? defaultToTs;

        const reaches2026Holdout = overlapsSealed2026Holdout(effectiveFromTs, effectiveToTs);

        if (reaches2026Holdout) {
          if (!body.allowHoldoutAccess) {
            return {
              status: 400,
              body: {
                error: `Sealed 2026 holdout violation: Access to data at or after ${SEALED_2026_HOLDOUT_START_TS} requires explicit allowHoldoutAccess authorization (ADR-0011).`
              }
            };
          }
          const hasToken = dataStore.experimentRepo.hasUnusedHoldoutToken("2026_holdout");
          if (!hasToken) {
            return {
              status: 400,
              body: {
                error: `Sealed 2026 holdout violation: Access to data at or after ${SEALED_2026_HOLDOUT_START_TS} requires explicit authorization and an unused holdout token (ADR-0011).`
              }
            };
          }
        }

        const trialCount = dataStore.experimentRepo.recordTrial({
          strategyId: strategy.strategyId,
          parameterHash: strategy.parameterHash,
          instrumentId: body.instrumentId,
          timeframe: body.timeframe,
          recordedAtMs: clock.nowMs()
        });

        const allowHoldoutAccess = Boolean(body.allowHoldoutAccess);

        const experiment = replayEngine.run({
          instrumentId: body.instrumentId,
          timeframe: body.timeframe,
          strategy,
          fromTs: effectiveFromTs,
          toTs: effectiveToTs,
          allowHoldoutAccess,
          numTrials: trialCount,
          configHash: active.configHash,
          initialEquityUsdt: ScaledDecimal.fromString(
            active.config.risk.paperPortfolioEquityUsdt.toFixed(2)
          ),
          riskFractionPerTrade: active.config.risk.strategy.riskPerTradePct / 100,
          maxGrossLeverage: active.config.risk.strategy.maxGrossLeverage,
          costStressMultiplier: active.config.promotionLadder.replayCostStressMultiplier,
          walkForwardFolds: active.config.promotionLadder.replayMinWalkForwardFolds,
          replayMinTrades: active.config.promotionLadder.replayMinTrades,
          replayMinSharpe: active.config.promotionLadder.replayMinSharpe,
          replayMinDeflatedSharpeConfidence:
            active.config.promotionLadder.replayMinDeflatedSharpeConfidence
        });

        dataStore.auditRepo.append({
          ts: clock.nowMs(),
          actor: ingress.session.username,
          clientIp: ingress.clientIp,
          action: "replay.run_backtest",
          riskClass: "safe",
          configHash: active.configHash,
          details: {
            experimentId: experiment.experimentId,
            strategyId: experiment.strategyId,
            instrumentId: experiment.instrumentId,
            dataSnapshotId: experiment.dataSnapshotId,
            totalTrades: experiment.totalTrades,
            avgR: experiment.avgR,
            stressNetExpectancyR: experiment.stressNetExpectancyR,
            deflatedSharpeRatio: experiment.deflatedSharpeRatio
          }
        });

        return {
          status: 200,
          body: { experiment }
        };
      },

      listExperiments: async ({ request }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        return {
          status: 200,
          body: {
            experiments: [...dataStore.experimentRepo.listExperiments(50)]
          }
        };
      }
    },

    paper: {
      getStatus: async ({ request }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        return {
          status: 200,
          body: {
            circuitBreaker: paperBroker.getCircuitBreaker(),
            trialBalance: dataStore.ledgerRepo.getTrialBalance(),
            openPositions: [...paperBroker.getOpenPositions()],
            recentOrders: [...paperBroker.getOrders(20)],
            promotions: [...dataStore.promotionRepo.listPromotions()]
          }
        };
      },

      executeTick: async ({ request, body }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }

        const strategy = resolveStrategyById(body.strategyId);
        if (!strategy) {
          return { status: 400, body: { error: `Strategy ${body.strategyId} not found` } };
        }

        const bars = dataStore.marketDataRepo.getConfirmedBarsInRange({
          instrumentId: body.instrumentId,
          timeframe: "1H",
          fromOpenTs: 0,
          toCloseTs: clock.nowMs()
        });

        if (bars.length === 0) {
          return {
            status: 400,
            body: { error: `No confirmed bars available for ${body.instrumentId}` }
          };
        }

        const latestBar = bars[bars.length - 1];
        if (!latestBar) {
          return {
            status: 400,
            body: { error: `No valid latest bar for ${body.instrumentId}` }
          };
        }

        // Settle funding rates and pass recent funding to tick
        const fundingRates = dataStore.marketDataRepo.getSettledFundingInRange({
          instrumentId: body.instrumentId,
          fromTs: 0,
          toTs: clock.nowMs()
        });

        const tickResult = paperBroker.executeConfirmedBarTick({
          bar: latestBar,
          strategy,
          featureBars: { "1H": bars },
          settledFundingRates: fundingRates
        });

        dataStore.auditRepo.append({
          ts: clock.nowMs(),
          actor: ingress.session.username ?? "system",
          clientIp: ingress.clientIp,
          action: "paper.execute_tick",
          riskClass: "safe",
          configHash: getActiveSnapshot().configHash,
          details: {
            instrumentId: body.instrumentId,
            strategyId: body.strategyId,
            positionsOpened: tickResult.positionsOpened.length,
            positionsClosed: tickResult.positionsClosed.length,
            vetoedCount: tickResult.vetoedProposals.length
          }
        });

        return {
          status: 200,
          body: {
            ok: true,
            positionsOpenedCount: tickResult.positionsOpened.length,
            positionsClosedCount: tickResult.positionsClosed.length,
            trialBalance: tickResult.trialBalance,
            openPositions: [...paperBroker.getOpenPositions()]
          }
        };
      },

      flatten: async ({ request, body }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }

        const closed = await paperBroker.flattenAllPositions(body.reason);
        dataStore.auditRepo.append({
          ts: clock.nowMs(),
          actor: ingress.session.username ?? "system",
          clientIp: ingress.clientIp,
          action: "paper.flatten_all",
          riskClass: "confirm",
          configHash: getActiveSnapshot().configHash,
          details: {
            reason: body.reason,
            flattenedCount: closed.length
          }
        });

        return {
          status: 200,
          body: {
            ok: true,
            flattenedCount: closed.length
          }
        };
      },

      setCircuitBreaker: async ({ request, body }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }

        const current = dataStore.paperAccountRepo.getCircuitBreaker();

        // A Kill Switch locks until a manual, stepped-up reset (audit-3 H9)
        if (isKillSwitchStatus(current.status) && body.status !== current.status) {
          const stepUpDenial = stepUpDenied(
            ingress,
            body,
            `Step-up authentication required to leave ${current.status}`
          );
          if (stepUpDenial) {
            return stepUpDenial;
          }
        }

        // Lock first so no entry can slip in while positions are being flattened. The breaker
        // table is shared by both books; the exchange broker's cached copy is refreshed too.
        const tripping = isKillSwitchStatus(body.status);
        const updated = paperBroker.setCircuitBreaker({
          status: body.status,
          reason: body.reason,
          triggeredAtMs: clock.nowMs(),
          cooldownUntilMs: body.status === "NORMAL" || tripping ? null : clock.nowMs() + 3600_000,
          updatedBy: ingress.session.username ?? "system"
        });
        okxBroker.setCircuitBreaker(updated);

        // Kill Switch Flatten: close every paper and exchange position and verify both are flat
        const killSwitch = tripping ? await runKillSwitchFlatten(body.reason) : undefined;

        dataStore.auditRepo.append({
          ts: clock.nowMs(),
          actor: ingress.session.username ?? "system",
          clientIp: ingress.clientIp,
          action: tripping ? "kill_switch.trip" : "paper.set_circuit_breaker",
          riskClass: "confirm",
          configHash: getActiveSnapshot().configHash,
          details: {
            status: body.status,
            reason: body.reason,
            ...(killSwitch ? { killSwitch } : {})
          }
        });

        return {
          status: 200,
          body: {
            circuitBreaker: updated,
            ...(killSwitch ? { killSwitch } : {})
          }
        };
      }
    },

    promotion: {
      list: async ({ request }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        const promotions = dataStore.promotionRepo.listPromotions();
        return {
          status: 200,
          body: {
            promotions: promotions.map((p) => ({ ...p }))
          }
        };
      },

      evaluate: async ({ request, body }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }

        const active = getActiveSnapshot();
        const evaluator = new PromotionLadderEvaluator(
          active.config.promotionLadder,
          active.config.risk.liveRampMultipliers
        );
        const existingPromo = dataStore.promotionRepo.getPromotion(body.strategyId);
        const currentStage = existingPromo?.currentStage ?? "Research";

        // Find latest experiment for strategy
        const experiments = dataStore.experimentRepo.listExperiments(50);
        const latestExp = experiments.find((e) => e.strategyId === body.strategyId) ?? null;

        // Compute actual days in stage from stage entry timestamp (promotedAtMs) (M-H)
        const nowMs = clock.nowMs();
        const stageStartMs = existingPromo?.promotedAtMs ?? existingPromo?.updatedAtMs ?? nowMs;
        const daysInStage = Math.max(0, (nowMs - stageStartMs) / 86_400_000);

        // Trades and drawdown from the book this stage trades in
        const evidence = stageEvidence(body.strategyId, currentStage, stageStartMs);
        const actualPaperTradesCount = evidence.tradesCount;
        const paperDrawdownPct = evidence.drawdownPct;

        // Resolve and query segregated shadow advisor evaluations (T7 / M-H)
        dataStore.shadowRepo.resolvePendingDecisions({
          marketDataRepo: dataStore.marketDataRepo
        });
        const shadowStats = dataStore.shadowRepo.getShadowStats(body.strategyId);

        const evaluated = evaluator.evaluate({
          strategyId: body.strategyId,
          currentStage,
          latestExperiment: latestExp,
          paperTradesCount: actualPaperTradesCount,
          paperDrawdownPct,
          paperDurationDays: currentStage === "Paper" ? daysInStage : 0,
          shadowDurationDays: currentStage === "Shadow" ? daysInStage : 0,
          shadowTradesCount: shadowStats.resolvedCount,
          shadowExpectancyR: shadowStats.expectancyR,
          asOfMs: nowMs
        });

        const stageChanged = evaluated.currentStage !== existingPromo?.currentStage;
        const promotedAtMs = stageChanged
          ? nowMs
          : (existingPromo?.promotedAtMs ?? existingPromo?.updatedAtMs ?? nowMs);

        const saved = dataStore.promotionRepo.upsertPromotion({
          ...evaluated,
          promotedAtMs
        });

        // Auto-flatten open positions and alert if evaluation detected an automatic demotion
        if (
          evaluated.demotionReason !== null &&
          evaluated.currentStage !== existingPromo?.currentStage
        ) {
          const paperClosed = await paperBroker.flattenAllPositions(
            `Auto-Demotion: ${evaluated.demotionReason}`
          );
          const exchangeClosed = await flattenExchangeOrAlert(
            `Auto-Demotion: ${evaluated.demotionReason}`
          );
          const flattenedCount = paperClosed.length + exchangeClosed.length;

          await notifier.send({
            severity: evaluated.currentStage === "Research" ? "CRITICAL" : "WARNING",
            title: `STRATEGY AUTO-DEMOTION: ${body.strategyId}`,
            body: `Strategy auto-demoted to ${evaluated.currentStage}. Reason: ${evaluated.demotionReason}. Flattened ${flattenedCount} positions.`,
            dedupKey: `demote-${body.strategyId}`
          });
        }

        dataStore.auditRepo.append({
          ts: clock.nowMs(),
          actor: ingress.session.username ?? "system",
          clientIp: ingress.clientIp,
          action: "promotion.evaluate",
          riskClass: "safe",
          configHash: active.configHash,
          details: {
            strategyId: body.strategyId,
            currentStage: saved.currentStage,
            eligibleNextStage: saved.eligibleNextStage,
            replayGatePassed: saved.replayGatePassed,
            autoDemoted: evaluated.demotionReason !== null
          }
        });

        return {
          status: 200,
          body: {
            promotion: saved
          }
        };
      },

      promote: async ({ request, body }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }

        // Enforce Human Gates G2 (Demo, Live-Ramp) and G3 (Live) with step-up verification (AGENTS.md)
        if (
          body.targetStage === "Demo" ||
          body.targetStage === "Live-Ramp" ||
          body.targetStage === "Live"
        ) {
          if (!body.stepUpPassword && !body.stepUpTotpCode) {
            return {
              status: 403,
              body: {
                error:
                  "Step-up credential required for Demo (Gate G2), Live-Ramp (Gate G2), or Live (Gate G3)",
                requiresStepUp: true
              }
            };
          }
          const stepUpDenial = stepUpDenied(
            ingress,
            body,
            "Step-up authentication failed for Demo (Gate G2), Live-Ramp (Gate G2), or Live (Gate G3)"
          );
          if (stepUpDenial) {
            return stepUpDenial;
          }
        }

        const existingPromo = dataStore.promotionRepo.getPromotion(body.strategyId);
        if (!existingPromo) {
          return {
            status: 400,
            body: {
              error: `No promotion record found for strategy ${body.strategyId}. Evaluate strategy first.`
            }
          };
        }

        // Quarantine check (ADR-0021): Synthetic specs can NEVER be promoted to Demo, Live-Ramp, or Live
        if (
          body.targetStage === "Demo" ||
          body.targetStage === "Live-Ramp" ||
          body.targetStage === "Live"
        ) {
          const specRecord =
            dataStore.strategySpecRepo.getSpecByName(body.strategyId) ??
            dataStore.strategySpecRepo.getSpecByHash(body.strategyId);
          if (specRecord?.isSynthetic || body.strategyId.startsWith("synthetic-")) {
            return {
              status: 403,
              body: {
                error: `Strategy ${body.strategyId} is synthetic/quarantined and cannot be promoted to ${body.targetStage}.`
              }
            };
          }
        }

        if (
          body.targetStage === "Demo" ||
          body.targetStage === "Live-Ramp" ||
          body.targetStage === "Live"
        ) {
          const mfaDenial = mfaDenied(
            exchangeGateFor(body.targetStage),
            `promoting a strategy to ${body.targetStage}`
          );
          if (mfaDenial) {
            return mfaDenial;
          }
        }

        const active = getActiveSnapshot();
        const evaluator = new PromotionLadderEvaluator(
          active.config.promotionLadder,
          active.config.risk.liveRampMultipliers
        );
        const experiments = dataStore.experimentRepo.listExperiments(50);
        const latestExp = experiments.find((e) => e.strategyId === body.strategyId) ?? null;

        const nowMs = clock.nowMs();
        const stageStartMs = existingPromo?.promotedAtMs ?? existingPromo?.updatedAtMs ?? nowMs;
        const daysInStage = Math.max(0, (nowMs - stageStartMs) / 86_400_000);

        const evidence = stageEvidence(body.strategyId, existingPromo.currentStage, stageStartMs);
        const actualPaperTradesCount = evidence.tradesCount;
        const paperDrawdownPct = evidence.drawdownPct;

        dataStore.shadowRepo.resolvePendingDecisions({
          marketDataRepo: dataStore.marketDataRepo
        });
        const shadowStats = dataStore.shadowRepo.getShadowStats(body.strategyId);

        // Re-evaluate current eligibility with live data at promote time (T7: do not trust stored eligibleNextStage)
        const currentEvaluation = evaluator.evaluate({
          strategyId: body.strategyId,
          currentStage: existingPromo.currentStage,
          latestExperiment: latestExp,
          paperTradesCount: actualPaperTradesCount,
          paperDrawdownPct,
          paperDurationDays: existingPromo.currentStage === "Paper" ? daysInStage : 0,
          shadowDurationDays: existingPromo.currentStage === "Shadow" ? daysInStage : 0,
          shadowTradesCount: shadowStats.resolvedCount,
          shadowExpectancyR: shadowStats.expectancyR,
          asOfMs: nowMs
        });

        if (!currentEvaluation.replayGatePassed) {
          return {
            status: 400,
            body: {
              error: `Strategy ${body.strategyId} has not passed the quantitative replay gate.`
            }
          };
        }
        if (currentEvaluation.eligibleNextStage !== body.targetStage) {
          return {
            status: 400,
            body: {
              error: `Strategy ${body.strategyId} is not eligible for ${body.targetStage} (live eligibility: ${currentEvaluation.eligibleNextStage ?? "None"}).`
            }
          };
        }

        let rampAllocationPct = 100;
        if (body.targetStage === "Live-Ramp") {
          rampAllocationPct = evaluator.liveRampAllocationPct(actualPaperTradesCount);
        }

        // Evaluate eligible next stage from the newly entered target stage (C9)
        const targetEvaluation = evaluator.evaluate({
          strategyId: body.strategyId,
          currentStage: body.targetStage,
          latestExperiment: latestExp,
          paperTradesCount: 0,
          paperDrawdownPct: 0,
          paperDurationDays: 0,
          shadowDurationDays: 0,
          shadowTradesCount: 0,
          shadowExpectancyR: 0,
          asOfMs: nowMs
        });

        const updatedPromo = dataStore.promotionRepo.upsertPromotion({
          strategyId: body.strategyId,
          currentStage: body.targetStage,
          latestExperimentId: latestExp?.experimentId ?? existingPromo.latestExperimentId,
          replayGatePassed: currentEvaluation.replayGatePassed,
          paperTradesCount: actualPaperTradesCount,
          paperDrawdownPct,
          rampAllocationPct,
          eligibleNextStage: targetEvaluation.eligibleNextStage,
          demotionReason: null,
          promotedAtMs: nowMs,
          updatedAtMs: nowMs
        });

        dataStore.auditRepo.append({
          ts: clock.nowMs(),
          actor: ingress.session.username ?? "system",
          clientIp: ingress.clientIp,
          action: "promotion.promote",
          riskClass: body.targetStage === "Live" ? "locked-in-live" : "confirm",
          configHash: getActiveSnapshot().configHash,
          details: {
            strategyId: body.strategyId,
            promotedTo: body.targetStage
          }
        });

        return {
          status: 200,
          body: { promotion: updatedPromo }
        };
      },

      demote: async ({ request, body }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }

        // Auto-flatten any open positions for that strategy across brokers
        const paperClosed = await paperBroker.flattenAllPositions(`Demotion: ${body.reason}`);
        const exchangeClosed = await flattenExchangeOrAlert(`Demotion: ${body.reason}`);
        const flattenedCount = paperClosed.length + exchangeClosed.length;

        const existingPromo = dataStore.promotionRepo.getPromotion(body.strategyId);

        let eligibleNextStage: PromotionStage | null = null;
        if (body.targetStage === "Live-Ramp") {
          eligibleNextStage = "Live";
        } else if (body.targetStage === "Demo") {
          eligibleNextStage = "Live-Ramp";
        } else if (body.targetStage === "Paper") {
          eligibleNextStage = "Demo";
        } else if (body.targetStage === "Research") {
          eligibleNextStage = existingPromo?.replayGatePassed ? "Paper" : "Replay";
        }

        const updatedPromo = dataStore.promotionRepo.upsertPromotion({
          strategyId: body.strategyId,
          currentStage: body.targetStage,
          latestExperimentId: existingPromo?.latestExperimentId ?? null,
          replayGatePassed: existingPromo?.replayGatePassed ?? false,
          paperTradesCount: existingPromo?.paperTradesCount ?? 0,
          paperDrawdownPct: computeStrategyDrawdownPct(body.strategyId),
          rampAllocationPct: 0,
          eligibleNextStage,
          demotionReason: body.reason,
          updatedAtMs: clock.nowMs()
        });

        await notifier.send({
          severity: body.targetStage === "Research" ? "CRITICAL" : "WARNING",
          title: `STRATEGY DEMOTION: ${body.strategyId}`,
          body: `Strategy demoted to ${body.targetStage}. Reason: ${body.reason}. Flattened ${flattenedCount} positions.`,
          dedupKey: `demote-${body.strategyId}`
        });

        dataStore.auditRepo.append({
          ts: clock.nowMs(),
          actor: ingress.session.username ?? "system",
          clientIp: ingress.clientIp,
          action: "promotion.demote",
          riskClass: "confirm",
          configHash: getActiveSnapshot().configHash,
          details: {
            strategyId: body.strategyId,
            demotedTo: body.targetStage,
            reason: body.reason,
            flattenedCount
          }
        });

        return {
          status: 200,
          body: {
            promotion: updatedPromo,
            flattenedCount
          }
        };
      }
    },

    ai: {
      getStatus: async ({ request }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        const cfg = getActiveSnapshot().config.ai;
        return {
          status: 200,
          body: {
            enabled: cfg.contextAnalystEnabled || cfg.shadowAdvisorEnabled,
            provider: cfg.provider,
            fastModel: cfg.fastModel,
            reasoningModel: cfg.reasoningModel,
            remainingDailyBudgetUsd: llmGateway.getRemainingDailyBudgetUsd(),
            remainingMonthlyBudgetUsd: llmGateway.getRemainingMonthlyBudgetUsd(),
            dailyBudgetUsd: cfg.dailyBudgetUsd,
            monthlyBudgetUsd: cfg.monthlyBudgetUsd
          }
        };
      },

      extractContext: async ({ request, body }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }

        try {
          const feature = await contextAnalyst.analyzeText({
            text: body.text,
            source: body.source,
            asOfMs: clock.nowMs(),
            targetInstruments: [body.instrumentId]
          });

          dataStore.auditRepo.append({
            ts: clock.nowMs(),
            actor: ingress.session.username ?? "system",
            clientIp: ingress.clientIp,
            action: "ai.extract_context",
            riskClass: "safe",
            configHash: getActiveSnapshot().configHash,
            details: {
              featureId: feature.featureId,
              headline: feature.headline,
              directionalBias: feature.directionalBias,
              noveltyScore: feature.noveltyScore,
              trainingContaminated: feature.trainingContaminated
            }
          });

          return {
            status: 200,
            body: { feature }
          };
        } catch (err) {
          return {
            status: 400,
            body: { error: `Context extraction failed: ${String(err)}` }
          };
        }
      },

      shadowEvaluate: async ({ request, body }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }

        const strategy = resolveStrategyById(body.strategyId);
        if (!strategy) {
          return { status: 400, body: { error: `Strategy ${body.strategyId} not found` } };
        }

        const asOfMs = clock.nowMs();
        const bars = dataStore.marketDataRepo.getConfirmedBarsInRange({
          instrumentId: body.instrumentId,
          timeframe: "1H",
          fromOpenTs: 0,
          toCloseTs: asOfMs
        });

        const menu = strategy.evaluate({
          instrumentId: body.instrumentId,
          asOfMs,
          barsByTimeframe: { "1H": bars },
          recentFundingRates: []
        });

        // Evaluate deterministic baseline chooser
        const chooser = new BaselineChooser();
        const baselineChosen = chooser.choose([menu]);

        // Evaluate ShadowAdvisor
        try {
          const shadowResult = await shadowAdvisor.evaluateMenu({
            menu
          });

          const agreement = baselineChosen?.proposalId === shadowResult.chosenProposalId;

          // Record shadow pick with signal bar and dedupe per (strategy, instrument, bar) (T7 / M-H)
          if (shadowResult.chosenProposalId) {
            const chosenProp = menu.proposals.find(
              (p) => p.proposalId === shadowResult.chosenProposalId
            );
            const signalBar = bars[bars.length - 1];
            if (chosenProp && signalBar) {
              dataStore.shadowRepo.recordDecision({
                strategyId: body.strategyId,
                instrumentId: body.instrumentId,
                signalBarOpenTs: signalBar.openTs,
                signalBarCloseTs: signalBar.closeTs,
                proposalId: chosenProp.proposalId,
                side: chosenProp.side,
                entryPrice: chosenProp.entryPrice,
                protectiveStopPrice: chosenProp.protectiveStopPrice,
                takeProfitPrice: chosenProp.takeProfitPrice ?? null,
                createdAtMs: asOfMs
              });

              dataStore.shadowRepo.resolvePendingDecisions({
                marketDataRepo: dataStore.marketDataRepo
              });
            }
          }

          dataStore.auditRepo.append({
            ts: clock.nowMs(),
            actor: ingress.session.username ?? "system",
            clientIp: ingress.clientIp,
            action: "ai.shadow_evaluate",
            riskClass: "safe",
            configHash: getActiveSnapshot().configHash,
            details: {
              strategyId: body.strategyId,
              instrumentId: body.instrumentId,
              candidateCount: menu.proposals.length,
              baselinePick: baselineChosen?.proposalId ?? null,
              shadowPick: shadowResult.chosenProposalId,
              agreement,
              trainingContaminated: shadowResult.trainingContaminated
            }
          });

          return {
            status: 200,
            body: {
              strategyId: body.strategyId,
              instrumentId: body.instrumentId,
              asOfMs,
              candidateCount: menu.proposals.length,
              baselineChosenProposalId: baselineChosen?.proposalId ?? null,
              shadowChosenProposalId: shadowResult.chosenProposalId,
              shadowConfidence: shadowResult.confidence,
              shadowRationale: shadowResult.rationale,
              agreement,
              trainingContaminated: shadowResult.trainingContaminated
            }
          };
        } catch (err) {
          return {
            status: 400,
            body: { error: `Shadow evaluation failed: ${String(err)}` }
          };
        }
      },

      evaluateEventGate: async ({ request, body }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }

        try {
          const asOfMs = clock.nowMs();
          const evaluation = await eventGateAdvisor.evaluateEvent({
            eventText: body.eventText,
            asOfMs,
            affectedInstruments: body.affectedInstruments,
            openPositionsCount: body.openPositionsCount
          });

          dataStore.auditRepo.append({
            ts: asOfMs,
            actor: ingress.session.username ?? "system",
            clientIp: ingress.clientIp,
            action: "ai.evaluate_event_gate",
            riskClass: "safe",
            configHash: getActiveSnapshot().configHash,
            details: {
              recommendation: evaluation.recommendation,
              volatilityRisk: evaluation.volatilityRisk,
              riskScore: evaluation.riskScore,
              trainingContaminated: evaluation.trainingContaminated
            }
          });

          return {
            status: 200,
            body: { evaluation }
          };
        } catch (err) {
          return {
            status: 400,
            body: { error: `Event gate evaluation failed: ${String(err)}` }
          };
        }
      },

      clusterNarratives: async ({ request, body }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }

        try {
          const asOfMs = clock.nowMs();
          const clusters = await narrativeClusterTagger.clusterAnnouncements({
            announcements: body.announcements,
            asOfMs
          });

          dataStore.auditRepo.append({
            ts: asOfMs,
            actor: ingress.session.username ?? "system",
            clientIp: ingress.clientIp,
            action: "ai.cluster_narratives",
            riskClass: "safe",
            configHash: getActiveSnapshot().configHash,
            details: {
              clustersCount: clusters.length,
              trainingContaminated: clusters[0]?.trainingContaminated ?? false
            }
          });

          return {
            status: 200,
            body: { clusters: clusters.map((c) => ({ ...c })) }
          };
        } catch (err) {
          return {
            status: 400,
            body: { error: `Narrative clustering failed: ${String(err)}` }
          };
        }
      },

      analyzeMarkoutForensics: async ({ request, body }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }

        try {
          const asOfMs = clock.nowMs();
          const report = await markoutForensicsAnalyst.analyzeExecution({
            orderId: body.orderId,
            instrumentId: body.instrumentId,
            side: body.side,
            fillPrice: body.fillPrice,
            markoutPrices: body.markoutPrices,
            asOfMs
          });

          dataStore.auditRepo.append({
            ts: asOfMs,
            actor: ingress.session.username ?? "system",
            clientIp: ingress.clientIp,
            action: "ai.analyze_markout_forensics",
            riskClass: "safe",
            configHash: getActiveSnapshot().configHash,
            details: {
              orderId: report.orderId,
              rating: report.executionQualityRating,
              recommendedAggressiveness: report.recommendedAggressiveness,
              adverseSelectionScore: report.adverseSelectionScore,
              trainingContaminated: report.trainingContaminated
            }
          });

          return {
            status: 200,
            body: { report }
          };
        } catch (err) {
          return {
            status: 400,
            body: { error: `Markout forensics analysis failed: ${String(err)}` }
          };
        }
      }
    },

    broker: {
      getStatus: async ({ request }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }

        const openPositions = okxBroker.getOpenPositions();
        const openOrders = okxBroker.getOrders();

        return {
          status: 200,
          body: {
            connected: true,
            venue: "OKX-EEA",
            dms: okxBroker.getDmsStatus(),
            openPositionsCount: openPositions.length,
            openOrdersCount: openOrders.length
          }
        };
      },

      submitOrder: async ({ request, body }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }

        const active = getActiveSnapshot();
        const nowMs = clock.nowMs();
        const strategyId = body.strategyId ?? MANUAL_EXECUTION_STRATEGY_ID;
        const spec = defaultInstrumentSpec(body.instrumentId);
        const { stepUpPassword, stepUpTotpCode, ...orderInput } = body;

        // Exchange orders exist only in exchange Execution Modes (audit-3 C3)
        const mode = active.config.system.executionMode;
        if (!isExchangeExecutionMode(mode)) {
          return {
            status: 403,
            body: { error: `Exchange orders are disabled in the ${mode} Execution Mode` }
          };
        }

        if (!body.reduceOnly) {
          const mfaDenial = mfaDenied(exchangeGateFor(mode), `placing ${mode} orders`);
          if (mfaDenial) {
            return mfaDenial;
          }
          // Human gates G2 (any exchange account) and G3 (real money) require a fresh step-up
          const stepUpDenial = stepUpDenied(
            ingress,
            { stepUpPassword, stepUpTotpCode },
            `Step-up authentication required for exchange orders (Gate ${mode === "Demo" ? "G2" : "G3"})`
          );
          if (stepUpDenial) {
            return stepUpDenial;
          }

          // The strategy's Promotion Ladder stage must authorize this venue; unpromoted manual
          // orders are confined to the Demo account
          const authorizedStages: Partial<Record<ExecutionMode, readonly PromotionStage[]>> = {
            Demo: ["Demo", "Live-Ramp", "Live"],
            "Live-Ramp": ["Live-Ramp", "Live"],
            Live: ["Live"]
          };
          const stage: PromotionStage | null =
            strategyId === MANUAL_EXECUTION_STRATEGY_ID
              ? mode === "Demo"
                ? "Demo"
                : null
              : (dataStore.promotionRepo.getPromotion(strategyId)?.currentStage ?? null);
          if (stage === null || !(authorizedStages[mode] ?? []).includes(stage)) {
            return {
              status: 403,
              body: {
                error: `Promotion Ladder: strategy ${strategyId} (stage ${stage ?? "none"}) is not authorized to trade in ${mode}`
              }
            };
          }
        }

        let evaluatedInitialRiskUsdt: string | undefined;
        if (!body.reduceOnly) {
          // Attached protective stop is mandatory per ADR-0006
          if (!body.protectiveStopPrice || body.protectiveStopPrice.trim() === "") {
            return {
              status: 403,
              body: {
                error: "Orders without mandatory attached protective stop are prohibited (ADR-0006)"
              }
            };
          }

          const proposal: Proposal = {
            proposalId: body.clOrdId ?? `prop-api-${nowMs}`,
            strategyId,
            strategyVersion: "1.0.0",
            instrumentId: body.instrumentId,
            side: body.side,
            entryPrice: body.entryPrice,
            protectiveStopPrice: body.protectiveStopPrice,
            takeProfitPrice: body.takeProfitPrice ?? null,
            convictionScore: 1.0,
            rationale: "Direct API broker order submission",
            tags: ["api", "broker-order"]
          };

          // Aggregate existing exposure across open exchange positions
          const openPositions = okxBroker.getOpenPositions();
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

            if (p.strategyId === strategyId) {
              strategyGrossNotional = strategyGrossNotional.add(pNotional);
              strategyUnrealizedPnl = strategyUnrealizedPnl.add(pUnrealized);
            }
          }

          const dayStartMs = getUtcDayStartMs(nowMs);
          const strategyMetrics = dataStore.exchangeLedgerRepo.getRiskMetrics({
            asOfMs: nowMs,
            strategyId,
            openUnrealizedPnlUsdt: strategyUnrealizedPnl
          });
          const portfolioMetrics = dataStore.exchangeLedgerRepo.getRiskMetrics({
            asOfMs: nowMs,
            strategyId: null,
            openUnrealizedPnlUsdt: totalUnrealizedPnl
          });

          // Never size from equity the venue does not hold: the Venue Book starts from configured
          // capital, so it must agree with the OKX balance before an entry is sized from it
          let venueEquity: ScaledDecimal;
          try {
            venueEquity = await okxBroker.getVenueEquityUsdt();
          } catch (err) {
            return {
              status: 503,
              body: {
                error: `Cannot read the OKX balance, so exchange entries are refused: ${err instanceof Error ? err.message : String(err)}`
              }
            };
          }
          const tolerancePct = active.config.risk.portfolio.venueEquityDriftTolerancePct;
          const allowedBookEquity = venueEquity.add(
            venueEquity
              .mul(ScaledDecimal.fromString(String(tolerancePct)))
              .divFloor(ScaledDecimal.fromString("100"))
          );
          if (portfolioMetrics.currentEquityUsdt.gt(allowedBookEquity)) {
            return {
              status: 409,
              body: {
                error: `Venue Book equity ${portfolioMetrics.currentEquityUsdt.toFixed(2)} USDT exceeds the OKX balance ${venueEquity.toFixed(2)} USDT by more than ${tolerancePct}%; rebase the Venue Book to the venue balance while it is flat`
              }
            };
          }
          const tradesTodayCount = dataStore.exchangeAccountRepo.countFilledOrdersToday({
            sinceMs: dayStartMs,
            strategyId
          });

          const strategyState: StrategyRiskState = {
            strategyId,
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
            circuitBreaker: dataStore.paperAccountRepo.getCircuitBreaker()
          };

          const guardian = new RiskGuardian(active.config.risk);
          const decision = guardian.evaluateProposal({
            proposal,
            instrument: spec,
            strategyState,
            portfolioState,
            asOfMs: nowMs
          });

          if (!decision.approved) {
            if (decision.triggeredCircuitBreaker) {
              dataStore.paperAccountRepo.setCircuitBreaker(decision.triggeredCircuitBreaker);
              await onCircuitBreakerTripped(decision.triggeredCircuitBreaker);
            }
            return {
              status: 403,
              body: { error: `Risk veto [${decision.vetoCode}]: ${decision.vetoReason}` }
            };
          }

          // Live-Ramp trades a fraction of the 1R size, set per strategy at promotion (audit-4 H2)
          const rampPct =
            mode === "Live-Ramp"
              ? (dataStore.promotionRepo.getPromotion(strategyId)?.rampAllocationPct ?? 0)
              : 100;
          const maxLots =
            rampPct >= 100
              ? decision.contracts
              : decision.contracts
                  .mul(ScaledDecimal.fromString(String(rampPct)))
                  .divFloor(ScaledDecimal.fromString("100"))
                  .roundDownToLot(ScaledDecimal.fromString("1"));
          const requestedLots = ScaledDecimal.fromString(String(body.sizeLots));
          if (requestedLots.gt(maxLots)) {
            const sizingBasis =
              rampPct >= 100
                ? "1R risk-sized"
                : `Live-Ramp allocation ${rampPct}% of the 1R risk-sized`;
            return {
              status: 403,
              body: {
                error: `Risk veto [SIZING_VETO]: Requested size (${body.sizeLots}) exceeds ${sizingBasis} maximum (${maxLots.toFixed(0)})`
              }
            };
          }

          // Compute actual initial risk scaled to requested sizeLots
          const entryPx = ScaledDecimal.fromString(body.entryPrice);
          const stopPx = ScaledDecimal.fromString(body.protectiveStopPrice);
          const stopDistance = (
            body.side === "long" ? entryPx.sub(stopPx) : stopPx.sub(entryPx)
          ).abs();
          evaluatedInitialRiskUsdt = requestedLots
            .mul(stopDistance)
            .mul(spec.contractValue)
            .toFixed(2);
        }

        try {
          const order = await okxBroker.submitOrder({
            ...orderInput,
            protectiveStopPrice: body.protectiveStopPrice ?? "",
            strategyId,
            ...(evaluatedInitialRiskUsdt !== undefined
              ? { initialRiskUsdt: evaluatedInitialRiskUsdt }
              : {})
          });

          dataStore.auditRepo.append({
            ts: nowMs,
            actor: ingress.session.username ?? "system",
            clientIp: ingress.clientIp,
            action: "broker.submit_order",
            riskClass: "confirm",
            configHash: active.configHash,
            details: {
              orderId: order.orderId,
              clOrdId: order.clOrdId,
              algoOrderId: order.algoOrderId,
              instrumentId: order.instrumentId,
              strategyId,
              side: order.side,
              protectiveStopPrice: order.protectiveStopPrice
            }
          });

          return {
            status: 200,
            body: { order }
          };
        } catch (err) {
          return {
            status: 400,
            body: { error: err instanceof Error ? err.message : String(err) }
          };
        }
      },

      rebaseVenueCapital: async ({ request, body }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated || !ingress.session.username) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        const active = getActiveSnapshot();
        const mode = active.config.system.executionMode;
        if (!isExchangeExecutionMode(mode)) {
          return {
            status: 403,
            body: { error: `The Venue Book has no venue in the ${mode} Execution Mode` }
          };
        }
        const mfaDenial = mfaDenied(exchangeGateFor(mode), `rebasing ${mode} Venue Book capital`);
        if (mfaDenial) {
          return mfaDenial;
        }
        const stepUpDenial = stepUpDenied(
          ingress,
          body,
          "Step-up authentication required to rebase Venue Book capital"
        );
        if (stepUpDenial) {
          return stepUpDenial;
        }
        // A rebase starts a new equity baseline, which is only honest while nothing is open
        const open = dataStore.exchangeAccountRepo.listOpenPositions().length;
        if (open > 0) {
          return {
            status: 409,
            body: {
              error: `Cannot rebase Venue Book capital with ${open} open position(s); close them first`
            }
          };
        }

        let venueEquity: ScaledDecimal;
        try {
          venueEquity = await okxBroker.getVenueEquityUsdt();
        } catch (err) {
          return {
            status: 503,
            body: {
              error: `Cannot read the OKX balance: ${err instanceof Error ? err.message : String(err)}`
            }
          };
        }

        const nowMs = clock.nowMs();
        const previousEquity = dataStore.exchangeLedgerRepo.getRiskMetrics({
          asOfMs: nowMs
        }).currentEquityUsdt;
        dataStore.exchangeLedgerRepo.rebaseCapital({
          ts: nowMs,
          targetEquityUsdt: venueEquity,
          description: `Rebase Venue Book capital to the ${mode} OKX balance: ${body.reason}`
        });

        dataStore.auditRepo.append({
          ts: nowMs,
          actor: ingress.session.username,
          clientIp: ingress.clientIp,
          action: "broker.rebase_venue_capital",
          riskClass: "locked-in-live",
          configHash: active.configHash,
          details: {
            reason: body.reason,
            executionMode: mode,
            previousEquityUsdt: previousEquity.toFixed(8),
            venueEquityUsdt: venueEquity.toFixed(8)
          }
        });

        return {
          status: 200,
          body: {
            previousEquityUsdt: previousEquity.toFixed(8),
            venueEquityUsdt: venueEquity.toFixed(8)
          }
        };
      },

      reconcile: async ({ request }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }

        const reconciliation = await okxBroker.reconcilePositions();

        dataStore.auditRepo.append({
          ts: clock.nowMs(),
          actor: ingress.session.username ?? "system",
          clientIp: ingress.clientIp,
          action: "broker.reconcile",
          riskClass: "safe",
          configHash: getActiveSnapshot().configHash,
          details: {
            matched: reconciliation.matched,
            localPositionsCount: reconciliation.localPositionsCount,
            exchangePositionsCount: reconciliation.exchangePositionsCount
          }
        });

        return {
          status: 200,
          body: { reconciliation }
        };
      },

      dmsHeartbeat: async ({ request }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }

        try {
          const beat = await okxBroker.sendDmsHeartbeat();

          dataStore.auditRepo.append({
            ts: clock.nowMs(),
            actor: ingress.session.username ?? "system",
            clientIp: ingress.clientIp,
            action: "broker.dms_heartbeat",
            riskClass: "safe",
            configHash: getActiveSnapshot().configHash,
            details: {
              countdownSeconds: beat.countdownSeconds
            }
          });

          return {
            status: 200,
            body: {
              ok: beat.ok,
              countdownSeconds: beat.countdownSeconds,
              dms: okxBroker.getDmsStatus()
            }
          };
        } catch (err) {
          return {
            status: 400,
            body: { error: err instanceof Error ? err.message : String(err) }
          };
        }
      },

      flatten: async ({ request, body }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }

        const flattened = await okxBroker.flattenAllPositions(body.reason);

        dataStore.auditRepo.append({
          ts: clock.nowMs(),
          actor: ingress.session.username ?? "system",
          clientIp: ingress.clientIp,
          action: "broker.emergency_flatten",
          riskClass: "confirm",
          configHash: getActiveSnapshot().configHash,
          details: {
            reason: body.reason,
            flattenedCount: flattened.length
          }
        });

        return {
          status: 200,
          body: {
            flattenedCount: flattened.length,
            positions: flattened.map((p) => ({ ...p }))
          }
        };
      }
    },

    specs: {
      register: async ({ request, body }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }

        const parseResult = StrategySpecV1Schema.safeParse(body);
        if (!parseResult.success) {
          return {
            status: 400,
            body: { error: `Invalid StrategySpecV1: ${parseResult.error.message}` }
          };
        }

        const spec = parseResult.data;
        const specHash = computeSpecHash(spec);
        const isSynthetic = Boolean(spec.synthetic);

        const record = dataStore.strategySpecRepo.saveSpec({
          specHash,
          name: spec.name,
          version: spec.version,
          specJson: JSON.stringify(spec),
          isSynthetic,
          createdAtMs: clock.nowMs()
        });

        dataStore.auditRepo.append({
          ts: clock.nowMs(),
          actor: ingress.session.username ?? "system",
          clientIp: ingress.clientIp,
          action: "specs.register",
          riskClass: "safe",
          configHash: getActiveSnapshot().configHash,
          details: {
            name: record.name,
            specHash: record.specHash,
            isSynthetic: record.isSynthetic
          }
        });

        return {
          status: 200,
          body: {
            specHash: record.specHash,
            name: record.name,
            version: record.version,
            isSynthetic: record.isSynthetic,
            description: spec.description
          }
        };
      },

      list: async ({ request }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }

        const specs = dataStore.strategySpecRepo.listSpecs();
        return {
          status: 200,
          body: {
            specs: specs.map((s) => ({ ...s }))
          }
        };
      },

      getByHash: async ({ request, params }) => {
        const ingress = getIngress(request);
        if (!ingress.session.authenticated) {
          return { status: 401, body: { error: "Authentication required" } };
        }

        const record = dataStore.strategySpecRepo.getSpecByHash(params.hash);
        if (!record) {
          return {
            status: 404,
            body: { error: `Strategy spec with hash ${params.hash} not found` }
          };
        }

        let parsedSpec: Record<string, unknown> = {};
        let descriptionText = "Strategy Specification";
        try {
          const rawParsed = JSON.parse(record.specJson);
          const parsed = StrategySpecV1Schema.parse(rawParsed);
          parsedSpec = rawParsed as Record<string, unknown>;
          descriptionText = describeSpec(parsed);
        } catch {
          descriptionText = `Unparseable spec: ${record.name}`;
        }

        return {
          status: 200,
          body: {
            specHash: record.specHash,
            name: record.name,
            version: record.version,
            isSynthetic: record.isSynthetic,
            createdAtMs: record.createdAtMs,
            spec: parsedSpec,
            descriptionText
          }
        };
      }
    }
  });

  app.register(s.plugin(router));

  // Support both singular /api/v1/broker/order and contract plural /api/v1/broker/orders
  app.post("/api/v1/broker/order", async (req, reply) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/broker/orders",
      headers: req.headers as Record<string, string>,
      payload: req.body as Record<string, unknown>
    });
    return reply.status(res.statusCode).headers(res.headers).send(res.body);
  });

  const webDist = options.webDistPath ?? path.resolve(import.meta.dirname, "../../web/dist");

  if (existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/"
    });

    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
