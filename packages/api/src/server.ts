import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import {
  CONFIG_FIELD_REGISTRY,
  PromotionLadderEvaluator,
  RiskGuardian,
  ScaledDecimal,
  SEALED_HOLDOUT_START_TS,
  SystemClock,
  createDefaultConfig,
  defaultInstrumentSpec,
  diffConfigs,
  getUtcDayStartMs,
  keelApiContract,
  type Clock,
  type ExchangeBroker,
  type KeelConfig,
  type LookbackValidationResult,
  type LlmGateway,
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
  ContextAnalyst,
  EventGateAdvisor,
  GeminiLlmGateway,
  MarkoutForensicsAnalyst,
  NarrativeClusterTagger,
  ShadowAdvisor
} from "@keel/ai";
import { OkxBroker } from "@keel/broker";
import { ReplayEngine } from "@keel/replay";
import { BaselineChooser, DEFAULT_STRATEGIES, resolveStrategyById } from "@keel/strategy";
import { initServer } from "@ts-rest/fastify";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { DiscordWebhookNotifier, type WebhookFetchFn } from "./notifications.js";
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
  readonly schedulerIntervalMs?: number | undefined;
  readonly scheduler?: UnattendedScheduler | undefined;
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
    getRiskConfig: () => getActiveSnapshot().config.risk
  });

  const llmGateway =
    options.llmGateway ??
    new GeminiLlmGateway({
      clock,
      getConfig: () => getActiveSnapshot().config.ai,
      getApiKey: () => getSecretSafe("geminiApiKey") ?? process.env["KEEL_GEMINI_API_KEY"] ?? null
    });

  const contextAnalyst = new ContextAnalyst(llmGateway);
  const shadowAdvisor = new ShadowAdvisor(llmGateway);
  const eventGateAdvisor = new EventGateAdvisor(llmGateway);
  const narrativeClusterTagger = new NarrativeClusterTagger(llmGateway);
  const markoutForensicsAnalyst = new MarkoutForensicsAnalyst(llmGateway);

  const okxBroker =
    options.exchangeBroker ??
    new OkxBroker({
      clock,
      getRiskConfig: () => getActiveSnapshot().config.risk,
      getCredentials: () => {
        const apiKey = getSecretSafe("okxApiKey") ?? process.env["OKX_API_KEY"] ?? null;
        const secretKey = getSecretSafe("okxSecretKey") ?? process.env["OKX_API_SECRET"] ?? null;
        const passphrase =
          getSecretSafe("okxPassphrase") ?? process.env["OKX_API_PASSPHRASE"] ?? null;

        if (!apiKey || !secretKey || !passphrase) {
          return null;
        }

        return { apiKey, secretKey, passphrase };
      },
      isDemo: getActiveSnapshot().config.system.executionMode !== "Live",
      notificationChannel: notifier,
      accountRepo: dataStore.paperAccountRepo,
      ledgerRepo: dataStore.ledgerRepo,
      marketDataRepo: dataStore.marketDataRepo
    });

  if (okxBroker instanceof OkxBroker) {
    okxBroker.setRepositories({
      accountRepo: dataStore.paperAccountRepo,
      ledgerRepo: dataStore.ledgerRepo,
      marketDataRepo: dataStore.marketDataRepo
    });
  }

  const scheduler =
    options.scheduler ??
    new UnattendedScheduler({
      clock,
      dataStore,
      paperBroker,
      exchangeBroker: okxBroker,
      ingestor: new OkxPublicIngestor({
        marketDataRepo: dataStore.marketDataRepo
      }),
      getRiskConfig: () => getActiveSnapshot().config.risk,
      getSystemConfig: () => getActiveSnapshot().config.system,
      notificationChannel: notifier,
      intervalMs: options.schedulerIntervalMs
    });

  if (options.enableScheduler === true) {
    scheduler.start();
  }

  const getUptimeSeconds = (): number =>
    Math.max(0, Math.floor((clock.nowMs() - startedAtMs) / 1000));

  const app = Fastify({
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

  app.addHook("onClose", async () => {
    scheduler.stop();
    const active = getActiveSnapshot();
    if (active.config.system.shutdownPolicy === "flatten") {
      await paperBroker.flattenAllPositions("Container shutdown with shutdownPolicy=flatten");
      await okxBroker.flattenAllPositions("Container shutdown with shutdownPolicy=flatten");
    }
    dataStore.close();
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

  const computeStrategyDrawdownPct = (strategyId: string): number => {
    const openPositions = dataStore.paperAccountRepo.listOpenPositions();
    let openUnrealized = ScaledDecimal.zero();
    for (const pos of openPositions) {
      if (pos.strategyId === strategyId) {
        openUnrealized = openUnrealized.add(ScaledDecimal.fromString(pos.unrealizedPnlUsdt));
      }
    }
    const riskMetrics = dataStore.ledgerRepo.getRiskMetrics({
      asOfMs: clock.nowMs(),
      strategyId,
      openUnrealizedPnlUsdt: openUnrealized
    });
    return Number(riskMetrics.drawdownPct.toFixed(4));
  };

  const s = initServer();
  const router = s.router(keelApiContract, {
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
            formatSessionCookieHeader(loginRes.sessionToken, ingress.forwardedProto)
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
            formatSessionCookieHeader(loginRes.sessionToken, ingress.forwardedProto)
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
          const stepUpOk = authManager.verifyStepUp({
            sessionToken: ingress.sessionToken,
            password: body.stepUpPassword,
            totpCode: body.stepUpTotpCode
          });
          if (!stepUpOk) {
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
            return {
              status: 403,
              body: {
                error: "Step-up authentication (password or TOTP code) required for this change",
                requiresStepUp: true
              }
            };
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

        const stepUpOk = authManager.verifyStepUp({
          sessionToken: ingress.sessionToken,
          password: body.stepUpPassword,
          totpCode: body.stepUpTotpCode
        });
        if (!stepUpOk) {
          return {
            status: 403,
            body: {
              error: "Step-up authentication required for configuration rollback",
              requiresStepUp: true
            }
          };
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
        const stepUpOk = authManager.verifyStepUp({
          sessionToken: ingress.sessionToken,
          password: body.stepUpPassword,
          totpCode: body.stepUpTotpCode
        });
        if (!stepUpOk) {
          return {
            status: 403,
            body: {
              error: "Step-up authentication required to update vault secrets",
              requiresStepUp: true
            }
          };
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
        const snapshot = seedSyntheticMarketSeries({
          marketDataRepo: dataStore.marketDataRepo,
          instrumentId: body.instrumentId,
          endCloseTs: clock.nowMs(),
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
        const effectiveToTs =
          coverage.earliestOpenTs < SEALED_HOLDOUT_START_TS
            ? Math.min(coverage.latestCloseTs, SEALED_HOLDOUT_START_TS)
            : coverage.latestCloseTs;
        const allowHoldoutAccess = coverage.earliestOpenTs >= SEALED_HOLDOUT_START_TS;

        const experiment = replayEngine.run({
          instrumentId: body.instrumentId,
          timeframe: body.timeframe,
          strategy,
          fromTs: coverage.earliestOpenTs,
          toTs: effectiveToTs,
          allowHoldoutAccess,
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

        const updated = paperBroker.setCircuitBreaker({
          status: body.status,
          reason: body.reason,
          triggeredAtMs: clock.nowMs(),
          cooldownUntilMs: body.status === "NORMAL" ? null : clock.nowMs() + 3600_000,
          updatedBy: ingress.session.username ?? "system"
        });

        dataStore.auditRepo.append({
          ts: clock.nowMs(),
          actor: ingress.session.username ?? "system",
          clientIp: ingress.clientIp,
          action: "paper.set_circuit_breaker",
          riskClass: "confirm",
          configHash: getActiveSnapshot().configHash,
          details: {
            status: body.status,
            reason: body.reason
          }
        });

        return {
          status: 200,
          body: {
            circuitBreaker: updated
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
        const evaluator = new PromotionLadderEvaluator(active.config.promotionLadder);
        const existingPromo = dataStore.promotionRepo.getPromotion(body.strategyId);
        const currentStage = existingPromo?.currentStage ?? "Research";

        // Find latest experiment for strategy
        const experiments = dataStore.experimentRepo.listExperiments(50);
        const latestExp = experiments.find((e) => e.strategyId === body.strategyId) ?? null;

        // Compute actual paper trades count and drawdown from ledger
        const allPositions = dataStore.paperAccountRepo.listAllPositions();
        const strategyPositions = allPositions.filter(
          (p) => p.strategyId === body.strategyId && p.status === "CLOSED"
        );
        const actualPaperTradesCount = strategyPositions.length;
        const paperDrawdownPct = computeStrategyDrawdownPct(body.strategyId);

        // Compute actual days in stage from stage entry timestamp (promotedAtMs) (M-H)
        const nowMs = clock.nowMs();
        const stageStartMs = existingPromo?.promotedAtMs ?? existingPromo?.updatedAtMs ?? nowMs;
        const daysInStage = Math.max(0, (nowMs - stageStartMs) / 86_400_000);

        // Segregate shadow advisor evaluations from paper execution records (M-H)
        const actualShadowTradesCount = dataStore.auditRepo.countShadowEvaluations(body.strategyId);

        const evaluated = evaluator.evaluate({
          strategyId: body.strategyId,
          currentStage,
          latestExperiment: latestExp,
          paperTradesCount: actualPaperTradesCount,
          paperDrawdownPct,
          paperDurationDays: currentStage === "Paper" ? daysInStage : 0,
          shadowDurationDays: currentStage === "Shadow" ? daysInStage : 0,
          shadowTradesCount: actualShadowTradesCount,
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
          const exchangeClosed = await okxBroker.flattenAllPositions(
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
          const stepUpOk = authManager.verifyStepUp({
            sessionToken: ingress.sessionToken,
            password: body.stepUpPassword,
            totpCode: body.stepUpTotpCode
          });
          if (!stepUpOk) {
            return {
              status: 403,
              body: {
                error:
                  "Step-up authentication failed for Demo (Gate G2), Live-Ramp (Gate G2), or Live (Gate G3)",
                requiresStepUp: true
              }
            };
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
        if (!existingPromo.replayGatePassed) {
          return {
            status: 400,
            body: {
              error: `Strategy ${body.strategyId} has not passed the quantitative replay gate.`
            }
          };
        }
        if (existingPromo.eligibleNextStage !== body.targetStage) {
          return {
            status: 400,
            body: {
              error: `Strategy ${body.strategyId} is not eligible for ${body.targetStage} (eligible: ${existingPromo.eligibleNextStage ?? "None"}).`
            }
          };
        }

        let rampAllocationPct = 100;
        if (body.targetStage === "Live-Ramp") {
          rampAllocationPct =
            existingPromo.paperTradesCount >= 40
              ? 50
              : existingPromo.paperTradesCount >= 20
                ? 25
                : 10;
        }

        // Re-evaluate eligibility for the newly assigned stage to prevent skipping gates (C9)
        const active = getActiveSnapshot();
        const evaluator = new PromotionLadderEvaluator(active.config.promotionLadder);
        const experiments = dataStore.experimentRepo.listExperiments(50);
        const latestExp = experiments.find((e) => e.strategyId === body.strategyId) ?? null;
        const allPositions = dataStore.paperAccountRepo.listAllPositions();
        const strategyPositions = allPositions.filter(
          (p) => p.strategyId === body.strategyId && p.status === "CLOSED"
        );
        const actualPaperTradesCount = strategyPositions.length;
        const paperDrawdownPct = computeStrategyDrawdownPct(body.strategyId);

        const nowMs = clock.nowMs();

        // Segregate shadow advisor evaluations from paper execution records (M-H)
        const actualShadowTradesCount = dataStore.auditRepo.countShadowEvaluations(body.strategyId);

        const evaluated = evaluator.evaluate({
          strategyId: body.strategyId,
          currentStage: body.targetStage,
          latestExperiment: latestExp,
          paperTradesCount: actualPaperTradesCount,
          paperDrawdownPct,
          paperDurationDays: 0,
          shadowDurationDays: 0,
          shadowTradesCount: actualShadowTradesCount,
          asOfMs: nowMs
        });

        const updatedPromo = dataStore.promotionRepo.upsertPromotion({
          strategyId: body.strategyId,
          currentStage: body.targetStage,
          latestExperimentId: existingPromo.latestExperimentId,
          replayGatePassed: existingPromo.replayGatePassed,
          paperTradesCount: actualPaperTradesCount,
          paperDrawdownPct,
          rampAllocationPct,
          eligibleNextStage: evaluated.eligibleNextStage,
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
        const exchangeClosed = await okxBroker.flattenAllPositions(`Demotion: ${body.reason}`);
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
        const strategyId = body.strategyId ?? "manual-execution";
        const spec = defaultInstrumentSpec(body.instrumentId);

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
          const strategyMetrics = dataStore.ledgerRepo.getRiskMetrics({
            asOfMs: nowMs,
            strategyId,
            openUnrealizedPnlUsdt: strategyUnrealizedPnl
          });
          const portfolioMetrics = dataStore.ledgerRepo.getRiskMetrics({
            asOfMs: nowMs,
            strategyId: null,
            openUnrealizedPnlUsdt: totalUnrealizedPnl
          });
          const tradesTodayCount = dataStore.paperAccountRepo.countFilledOrdersToday({
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
            }
            return {
              status: 403,
              body: { error: `Risk veto [${decision.vetoCode}]: ${decision.vetoReason}` }
            };
          }

          const requestedLots = ScaledDecimal.fromString(String(body.sizeLots));
          if (requestedLots.gt(decision.contracts)) {
            return {
              status: 403,
              body: {
                error: `Risk veto [SIZING_VETO]: Requested size (${body.sizeLots}) exceeds 1R risk-sized maximum (${decision.contracts.toFixed(0)})`
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
            ...body,
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
