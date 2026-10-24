import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import {
  CONFIG_FIELD_REGISTRY,
  SystemClock,
  createDefaultConfig,
  diffConfigs,
  keelApiContract,
  type Clock,
  type KeelConfig
} from "@keel/core";
import { createSqliteDataStore } from "@keel/data";
import { initServer } from "@ts-rest/fastify";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { DiscordWebhookNotifier, type WebhookFetchFn } from "./notifications.js";
import { PINO_REDACT_PATHS } from "./redact.js";
import {
  AuthManager,
  SecretVault,
  formatClearSessionCookieHeader,
  formatSessionCookieHeader,
  resolveIngressContext,
  type IngressContext
} from "./security.js";

export interface KeelServerOptions {
  readonly config?: KeelConfig | undefined;
  readonly clock?: Clock | undefined;
  readonly dbPath?: string | undefined;
  readonly backupsDir?: string | undefined;
  readonly masterKeyMaterial?: string | undefined;
  readonly initialBootstrapToken?: string | undefined;
  readonly onBootstrapToken?: ((token: string) => void) | undefined;
  readonly webhookFetchFn?: WebhookFetchFn | undefined;
  readonly webDistPath?: string | undefined;
  readonly logger?: boolean | undefined;
}

export async function createKeelServer(options: KeelServerOptions = {}): Promise<FastifyInstance> {
  const initialConfig = options.config ?? createDefaultConfig();
  const clock = options.clock ?? new SystemClock();
  const startedAtMs = clock.nowMs();
  const dbPath = options.dbPath ?? process.env["KEEL_DB_PATH"] ?? ":memory:";
  const backupsDir = options.backupsDir ?? process.env["KEEL_BACKUPS_DIR"];

  const dataStore = createSqliteDataStore({
    dbPath,
    clock,
    backupsDir,
    initialConfig
  });

  const secretVault = new SecretVault({
    repo: dataStore.secretVaultRepo,
    clock,
    masterKeyMaterial: options.masterKeyMaterial
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

  const notifier = new DiscordWebhookNotifier({
    clock,
    getConfig: () => getActiveSnapshot().config,
    getWebhookUrl: () =>
      secretVault.getDecryptedSecret("discordWebhookUrl") ??
      process.env["KEEL_DISCORD_WEBHOOK_URL"] ??
      null,
    fetchFn: options.webhookFetchFn
  });

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

  app.addHook("onClose", async () => {
    dataStore.close();
  });

  const getIngress = (req: FastifyRequest): IngressContext => {
    const active = getActiveSnapshot();
    return resolveIngressContext({
      headers: req.headers,
      fallbackIp: req.ip,
      config: active.config,
      authManager
    });
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
        const ingress = getIngress(request);
        if (!ingress.session.authenticated || !ingress.session.username) {
          return { status: 401, body: { error: "Authentication required" } };
        }
        const active = getActiveSnapshot();
        const backup = dataStore.createBackup();
        dataStore.auditRepo.append({
          ts: clock.nowMs(),
          actor: ingress.session.username,
          clientIp: ingress.clientIp,
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
    }
  });

  app.register(s.plugin(router));

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
