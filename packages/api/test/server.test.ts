import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_FIELD_REGISTRY,
  ManualClock,
  SEALED_2026_HOLDOUT_START_TS,
  ScaledDecimal,
  computeConfigHash,
  createDefaultConfig
} from "@keel/core";
import { OkxBroker } from "@keel/broker";
import { createSqliteDataStore, seedSyntheticMarketSeries } from "@keel/data";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKeelServer, redactLogObject } from "../src/index.js";
import { createFakeOkx } from "../../broker/test/fake-okx.js";
import { enrollTotp } from "./totp.js";

const TEST_OKX_CREDENTIALS = {
  apiKey: "test-api-key",
  secretKey: "test-secret-key-32-bytes-long-super-secret",
  passphrase: "test-passphrase"
};

describe("@keel/api — Fastify Server, Observability, Auth, Config Governance, Vault, & Audit (M0 + M1)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "keel-api-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("sends browser security headers on every response (audit-4 L2)", async () => {
    const app = await createKeelServer({
      config: createDefaultConfig(),
      clock: new ManualClock(1_730_000_000_000)
    });
    try {
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
      expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
    } finally {
      await app.close();
    }
  });

  it("serves /healthz, /readyz, and Prometheus /metrics", async () => {
    const clock = new ManualClock(1_730_000_000_000);
    const config = createDefaultConfig();
    const app = await createKeelServer({ config, clock });

    const healthRes = await app.inject({ method: "GET", url: "/healthz" });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json()).toEqual({
      status: "ok",
      appName: "Keel",
      timestampMs: 1_730_000_000_000
    });

    const readyRes = await app.inject({ method: "GET", url: "/readyz" });
    expect(readyRes.statusCode).toBe(200);
    expect(readyRes.json()).toEqual({
      ready: true,
      executionMode: "Paper"
    });

    const metricsRes = await app.inject({ method: "GET", url: "/metrics" });
    expect(metricsRes.statusCode).toBe(200);
    expect(metricsRes.headers["content-type"]).toContain("text/plain");
    expect(metricsRes.body).toContain("keel_up 1");
    expect(metricsRes.body).toContain('keel_execution_mode_info{mode="Paper"} 1');

    await app.close();
  });

  it("serves /api/v1/system/status via ts-rest contract and extracts CF-Connecting-IP & X-Forwarded-Proto (ADR-0003, ADR-0005)", async () => {
    const clock = new ManualClock(1_730_000_000_000);
    const config = createDefaultConfig();
    const app = await createKeelServer({ config, clock });

    clock.advanceMs(45_000);

    const statusRes = await app.inject({
      method: "GET",
      url: "/api/v1/system/status",
      headers: {
        "cf-connecting-ip": "203.0.113.42",
        "x-forwarded-proto": "https"
      }
    });

    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json()).toEqual({
      appName: "Keel",
      version: "0.1.0",
      executionMode: "Paper",
      configHash: computeConfigHash(config),
      configVersion: 1,
      serverTimeMs: 1_730_000_045_000,
      serverTimeIso: "2024-10-27T03:34:05.000Z",
      uptimeSeconds: 45,
      cloudflareTunnelActive: true,
      forwardedProto: "https",
      clientIp: "203.0.113.42",
      status: "ok"
    });

    await app.close();
  });

  it("redacts both exact and prefixed credential/token keys from structured log payloads", () => {
    const rawPayload = {
      event: "config_updated",
      apiKey: "okx-live-key-12345",
      okxApiKey: "okx-prefixed-key",
      geminiApiKey: "gemini-prefixed-key",
      secret: "super-secret-value",
      passphrase: "my-passphrase",
      nested: {
        webhookUrl: "https://discord.com/api/webhooks/123/secret-token",
        cfAccessToken: "jwt-token-value",
        safeField: "BTC-USDT-SWAP"
      }
    };

    const redacted = redactLogObject(rawPayload);
    expect(redacted).toEqual({
      event: "config_updated",
      apiKey: "[REDACTED]",
      okxApiKey: "[REDACTED]",
      geminiApiKey: "[REDACTED]",
      secret: "[REDACTED]",
      passphrase: "[REDACTED]",
      nested: {
        webhookUrl: "[REDACTED]",
        cfAccessToken: "[REDACTED]",
        safeField: "BTC-USDT-SWAP"
      }
    });
  });

  it("enforces bootstrap -> session auth -> step-up config mutation -> rollback -> vault -> audit -> backup", async () => {
    const clock = new ManualClock(1_730_000_000_000);
    const dbPath = join(tempDir, "keel.sqlite");
    const backupsDir = join(tempDir, "backups");
    let bootstrapToken = "";

    const app = await createKeelServer({
      clock,
      dbPath,
      backupsDir,
      masterKeyMaterial: "a-secure-master-key-with-at-least-32-chars!",
      onBootstrapToken: (t) => {
        bootstrapToken = t;
      }
    });

    try {
      // 1. Unauthenticated request to /api/v1/config returns 401
      const unauthConfig = await app.inject({ method: "GET", url: "/api/v1/config" });
      expect(unauthConfig.statusCode).toBe(401);

      // 2. Session status reports bootstrapped = false
      const sess0 = await app.inject({ method: "GET", url: "/api/v1/auth/session" });
      expect(sess0.statusCode).toBe(200);
      expect(sess0.json().bootstrapped).toBe(false);

      // 3. Bootstrap admin account with one-time token
      const bootRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/bootstrap",
        headers: {
          "cf-connecting-ip": "203.0.113.42",
          "x-forwarded-proto": "https"
        },
        payload: {
          bootstrapToken,
          username: "captain",
          password: "correct-horse-battery-staple"
        }
      });
      expect(bootRes.statusCode).toBe(200);
      const setCookie = String(bootRes.headers["set-cookie"] ?? "");
      expect(setCookie).toContain("keel_session=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("Secure");
      const cookieHeader = setCookie.split(";")[0] ?? "";

      // 4. Fetch active config & registry with authenticated session cookie
      const cfgRes = await app.inject({
        method: "GET",
        url: "/api/v1/config",
        headers: { cookie: cookieHeader }
      });
      expect(cfgRes.statusCode).toBe(200);
      expect(cfgRes.json().active.version).toBe(1);
      expect(cfgRes.json().registry).toHaveLength(CONFIG_FIELD_REGISTRY.length);

      // 5. Updating a 'confirm'-class setting without step-up credential fails with 403
      const baseCfg = createDefaultConfig();
      const modifiedCfg = {
        ...baseCfg,
        ai: {
          ...baseCfg.ai,
          strategyLabEnabled: true
        }
      };

      const noStepUpRes = await app.inject({
        method: "PUT",
        url: "/api/v1/config",
        headers: { cookie: cookieHeader },
        payload: {
          config: modifiedCfg,
          reason: "Enable AI Strategy Lab"
        }
      });
      expect(noStepUpRes.statusCode).toBe(403);
      expect(noStepUpRes.json().requiresStepUp).toBe(true);

      // 6. Updating with valid stepUpPassword succeeds and increments version to 2
      clock.advanceMs(5_000);
      const updateRes = await app.inject({
        method: "PUT",
        url: "/api/v1/config",
        headers: { cookie: cookieHeader },
        payload: {
          config: modifiedCfg,
          reason: "Enable AI Strategy Lab",
          stepUpPassword: "correct-horse-battery-staple"
        }
      });
      expect(updateRes.statusCode).toBe(200);
      expect(updateRes.json().snapshot.version).toBe(2);
      expect(updateRes.json().snapshot.config.ai.strategyLabEnabled).toBe(true);

      // 7. Upsert secret in AES-256-GCM vault and verify masked response
      const secretRes = await app.inject({
        method: "PUT",
        url: "/api/v1/secrets",
        headers: { cookie: cookieHeader },
        payload: {
          keyName: "geminiApiKey",
          plaintextValue: "AIzaSyD-secret-value-12345",
          stepUpPassword: "correct-horse-battery-staple"
        }
      });
      expect(secretRes.statusCode).toBe(200);
      expect(secretRes.json().secret.maskedPreview).toBe("AIza...2345");

      // 8. Rollback to version 1
      clock.advanceMs(5_000);
      const rollbackRes = await app.inject({
        method: "POST",
        url: "/api/v1/config/rollback",
        headers: { cookie: cookieHeader },
        payload: {
          targetVersion: 1,
          reason: "Restore default budget",
          stepUpPassword: "correct-horse-battery-staple"
        }
      });
      expect(rollbackRes.statusCode).toBe(200);
      expect(rollbackRes.json().snapshot.version).toBe(3);
      expect(rollbackRes.json().snapshot.config.ai.strategyLabEnabled).toBe(false);

      // 9. Trigger on-demand atomic SQLite backup
      const backupRes = await app.inject({
        method: "POST",
        url: "/api/v1/system/backup",
        headers: { cookie: cookieHeader },
        payload: {}
      });
      expect(backupRes.statusCode).toBe(200);
      expect(backupRes.json().backup.integrityOk).toBe(true);

      // 10. Verify locked-in-live config mutation is rejected with 403 when in Live-Ramp mode
      const liveRampCfg = {
        ...createDefaultConfig(),
        system: {
          ...createDefaultConfig().system,
          executionMode: "Live-Ramp" as const
        }
      };
      // Gate G3: real-money modes need an enrolled authenticator (audit-4 H4)
      await enrollTotp(app, cookieHeader, String(bootRes.json().totpSecretBase32), clock);
      const modeUpdateRes = await app.inject({
        method: "PUT",
        url: "/api/v1/config",
        headers: { cookie: cookieHeader },
        payload: {
          config: liveRampCfg,
          reason: "Enter Live-Ramp mode",
          stepUpPassword: "correct-horse-battery-staple"
        }
      });
      expect(modeUpdateRes.statusCode).toBe(200);

      const lockedEditCfg = {
        ...liveRampCfg,
        risk: {
          ...liveRampCfg.risk,
          strategy: {
            ...liveRampCfg.risk.strategy,
            maxGrossLeverage: 2.5
          }
        }
      };
      const blockedRes = await app.inject({
        method: "PUT",
        url: "/api/v1/config",
        headers: { cookie: cookieHeader },
        payload: {
          config: lockedEditCfg,
          reason: "Attempt to alter locked-in-live maxGrossLeverage in Live-Ramp",
          stepUpPassword: "correct-horse-battery-staple"
        }
      });
      expect(blockedRes.statusCode).toBe(403);
      expect(blockedRes.json().blockedPaths).toContain("risk.strategy.maxGrossLeverage");

      // 11. Verify audit trail recorded all governance mutations
      const auditRes = await app.inject({
        method: "GET",
        url: "/api/v1/audit",
        headers: { cookie: cookieHeader }
      });
      expect(auditRes.statusCode).toBe(200);
      const actions = auditRes.json().events.map((e: { action: string }) => e.action);
      expect(actions).toEqual([
        "config.update_blocked",
        "config.update",
        "auth.totp_verify",
        "system.backup",
        "config.rollback",
        "secrets.upsert",
        "config.update",
        "config.update_step_up_failed",
        "auth.bootstrap"
      ]);

      // 12. M2 Market & Replay Research Lab routes
      const summaryBeforeRes = await app.inject({
        method: "GET",
        url: "/api/v1/market/summary",
        headers: { cookie: cookieHeader }
      });
      expect(summaryBeforeRes.statusCode).toBe(200);
      expect(summaryBeforeRes.json().strategies.length).toBe(3);

      const seedRes = await app.inject({
        method: "POST",
        url: "/api/v1/market/seed-synthetic",
        headers: { cookie: cookieHeader },
        payload: {
          instrumentId: "BTC-USDT-SWAP",
          barCount1H: 240
        }
      });
      expect(seedRes.statusCode).toBe(200);
      expect(seedRes.json().snapshot.snapshotId).toMatch(/^[0-9a-f]{64}$/);
      expect(seedRes.json().snapshot.barCount).toBeGreaterThan(240);

      const runReplayRes = await app.inject({
        method: "POST",
        url: "/api/v1/replay/run",
        headers: { cookie: cookieHeader },
        payload: {
          strategyId: "donchian-trend-v1",
          instrumentId: "BTC-USDT-SWAP",
          timeframe: "1H"
        }
      });
      expect(runReplayRes.statusCode).toBe(200);
      expect(runReplayRes.json().experiment.strategyId).toBe("donchian-trend-v1");
      expect(runReplayRes.json().experiment.numTrials).toBe(1);
      expect(runReplayRes.json().experiment.dataSnapshotId).toBe(
        seedRes.json().snapshot.snapshotId
      );

      const runReplay2Res = await app.inject({
        method: "POST",
        url: "/api/v1/replay/run",
        headers: { cookie: cookieHeader },
        payload: {
          strategyId: "vol-mean-reversion-v1",
          instrumentId: "BTC-USDT-SWAP",
          timeframe: "1H"
        }
      });
      expect(runReplay2Res.statusCode).toBe(200);
      expect(runReplay2Res.json().experiment.numTrials).toBe(2);

      const listExpRes = await app.inject({
        method: "GET",
        url: "/api/v1/replay/experiments",
        headers: { cookie: cookieHeader }
      });
      expect(listExpRes.statusCode).toBe(200);
      expect(listExpRes.json().experiments.length).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("anchors synthetic seed data in the in-sample period so a default replay never touches a sealed holdout, even when the clock is in 2026 (ADR-0011)", async () => {
    const clock = new ManualClock(1_793_000_000_000); // 2026-10-27, inside the sealed 2026 partition
    let bootstrapToken = "";
    const app = await createKeelServer({
      clock,
      dbPath: join(tempDir, "keel-seed.sqlite"),
      backupsDir: join(tempDir, "backups"),
      masterKeyMaterial: "a-secure-master-key-with-at-least-32-chars!",
      onBootstrapToken: (t) => {
        bootstrapToken = t;
      }
    });

    try {
      const bootRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/bootstrap",
        headers: { "cf-connecting-ip": "203.0.113.42", "x-forwarded-proto": "https" },
        payload: { bootstrapToken, username: "captain", password: "correct-horse-battery-staple" }
      });
      const cookieHeader = String(bootRes.headers["set-cookie"] ?? "").split(";")[0] ?? "";

      const seedRes = await app.inject({
        method: "POST",
        url: "/api/v1/market/seed-synthetic",
        headers: { cookie: cookieHeader },
        payload: { instrumentId: "BTC-USDT-SWAP", barCount1H: 240 }
      });
      expect(seedRes.statusCode).toBe(200);
      expect(seedRes.json().snapshot.toTs).toBeLessThanOrEqual(1_735_689_600_000); // 2025-01-01

      const runReplayRes = await app.inject({
        method: "POST",
        url: "/api/v1/replay/run",
        headers: { cookie: cookieHeader },
        payload: { strategyId: "donchian-trend-v1", instrumentId: "BTC-USDT-SWAP", timeframe: "1H" }
      });
      expect(runReplayRes.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("routes POST /api/v1/broker/orders through RiskGuardian, rejects risk breaches with 403, and records true strategyId & initialRiskUsdt (C3)", async () => {
    const clock = new ManualClock(1_730_000_000_000);
    const dbPath = join(tempDir, "keel-broker.sqlite");
    let bootstrapToken = "";
    const okxBroker = new OkxBroker({
      clock,
      getCredentials: () => TEST_OKX_CREDENTIALS,
      fetchFn: createFakeOkx().fetchFn
    });
    // Exchange orders need an exchange Execution Mode and a strategy promoted to it (audit-3 C3)
    const baseConfig = createDefaultConfig();
    const demoConfig = {
      ...baseConfig,
      system: { ...baseConfig.system, executionMode: "Demo" as const }
    };
    const dataStore = createSqliteDataStore({ dbPath, clock, initialConfig: demoConfig });
    dataStore.promotionRepo.upsertPromotion({
      strategyId: "donchian-trend-v1",
      currentStage: "Demo",
      latestExperimentId: "exp-1",
      replayGatePassed: true,
      paperTradesCount: 50,
      paperDrawdownPct: 1.0,
      rampAllocationPct: 100,
      eligibleNextStage: null,
      demotionReason: null,
      promotedAtMs: clock.nowMs(),
      updatedAtMs: clock.nowMs()
    });
    const app = await createKeelServer({
      config: demoConfig,
      clock,
      dataStore,
      exchangeBroker: okxBroker,
      onBootstrapToken: (t) => {
        bootstrapToken = t;
      }
    });

    try {
      // 1. Bootstrap and obtain authenticated cookie
      const bootRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/bootstrap",
        headers: {
          "cf-connecting-ip": "203.0.113.1",
          "x-forwarded-proto": "https"
        },
        payload: {
          bootstrapToken,
          username: "risk-officer",
          password: "correct-horse-battery-staple"
        }
      });
      expect(bootRes.statusCode).toBe(200);
      const cookieHeader = String(bootRes.headers["set-cookie"] ?? "").split(";")[0] ?? "";

      // 2. Reject order breaching risk caps (e.g. massive leverage / size beyond 1R risk budget) with 403
      const breachRes = await app.inject({
        method: "POST",
        url: "/api/v1/broker/orders",
        headers: { cookie: cookieHeader },
        payload: {
          instrumentId: "BTC-USDT-SWAP",
          strategyId: "donchian-trend-v1",
          side: "long",
          sizeLots: 10_000, // Massive size exceeding leverage and 1R budget
          entryPrice: "50000.00",
          protectiveStopPrice: "49000.00",
          stepUpPassword: "correct-horse-battery-staple"
        }
      });
      expect(breachRes.statusCode).toBe(403);
      expect(breachRes.json().error).toContain("Risk veto");

      // Verify missing attached stop is rejected with 403 (AC 3)
      const missingStopRes = await app.inject({
        method: "POST",
        url: "/api/v1/broker/orders",
        headers: { cookie: cookieHeader },
        payload: {
          instrumentId: "BTC-USDT-SWAP",
          strategyId: "donchian-trend-v1",
          side: "long",
          sizeLots: 1,
          entryPrice: "50000.00",
          stepUpPassword: "correct-horse-battery-staple"
        }
      });
      expect(missingStopRes.statusCode).toBe(403);
      expect(missingStopRes.json().error).toContain(
        "Orders without mandatory attached protective stop are prohibited"
      );

      // 3. Submit a valid risk-conforming order via singular alias /api/v1/broker/order (AC 1)
      const validRes = await app.inject({
        method: "POST",
        url: "/api/v1/broker/order",
        headers: { cookie: cookieHeader },
        payload: {
          instrumentId: "BTC-USDT-SWAP",
          strategyId: "donchian-trend-v1",
          side: "long",
          sizeLots: 1,
          entryPrice: "50000.00",
          protectiveStopPrice: "49000.00",
          stepUpPassword: "correct-horse-battery-staple"
        }
      });
      expect(validRes.statusCode).toBe(200);

      // 4. Verify that broker position records real strategyId and actual scaled initialRiskUsdt (AC 2)
      const statusRes = await app.inject({
        method: "GET",
        url: "/api/v1/broker/status",
        headers: { cookie: cookieHeader }
      });
      expect(statusRes.statusCode).toBe(200);
      expect(statusRes.json().openPositionsCount).toBe(1);

      // Verify position details from broker status
      const positions = okxBroker.getOpenPositions();
      expect(positions).toHaveLength(1);
      const pos = positions[0];
      expect(pos?.strategyId).toBe("donchian-trend-v1");
      expect(pos?.strategyId).not.toBe("exchange-execution");
      // 1 lot * 1000 stop distance * 0.01 contractValue = 10.00 USDT
      expect(pos?.initialRiskUsdt).toBe("10.00");
      // M-F: exchange positions and fills must record non-zero fees paid
      expect(pos?.feesPaidUsdt).toBeDefined();
      if (pos) {
        expect(ScaledDecimal.fromString(pos.feesPaidUsdt).isPositive()).toBe(true);
      }

      // 5. Exchange fees land in the exchange book; the paper book is untouched (audit-3 C2)
      const paperStatusRes = await app.inject({
        method: "GET",
        url: "/api/v1/paper/status",
        headers: { cookie: cookieHeader }
      });
      expect(paperStatusRes.statusCode).toBe(200);
      const trialBalance = paperStatusRes.json().trialBalance;
      expect(trialBalance.isBalanced).toBe(true);
      expect(ScaledDecimal.fromString(trialBalance.feesExpenseUsdt).isZero()).toBe(true);

      // 6. A paper flatten never closes a real exchange position (audit-3 C2)
      const paperFlattenRes = await app.inject({
        method: "POST",
        url: "/api/v1/paper/flatten",
        headers: { cookie: cookieHeader },
        payload: { reason: "paper drill" }
      });
      expect(paperFlattenRes.statusCode).toBe(200);
      expect(okxBroker.getOpenPositions()).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("C1: in-sample replay succeeds without holdout token even when stored coverage extends into 2026", async () => {
    const clock = new ManualClock(1_730_000_000_000);
    const config = createDefaultConfig();
    let bootstrapToken = "";

    const store = createSqliteDataStore({
      dbPath: join(tempDir, "keel.sqlite"),
      clock,
      initialConfig: config
    });

    // Seed confirmed bars in 2024 (in-sample)
    seedSyntheticMarketSeries({
      marketDataRepo: store.marketDataRepo,
      instrumentId: "BTC-USDT-SWAP",
      endCloseTs: 1_730_000_000_000,
      barCount1H: 200
    });

    // Also seed confirmed bars into 2026 holdout (e.g. live ingested data)
    seedSyntheticMarketSeries({
      marketDataRepo: store.marketDataRepo,
      instrumentId: "BTC-USDT-SWAP",
      endCloseTs: SEALED_2026_HOLDOUT_START_TS + 10 * 3600_000,
      barCount1H: 50
    });

    const app = await createKeelServer({
      config,
      clock,
      dataStore: store,
      masterKeyMaterial: "a-secure-master-key-with-at-least-32-chars!",
      onBootstrapToken: (t) => {
        bootstrapToken = t;
      }
    });

    try {
      // 1. Bootstrap and Login
      const bootRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/bootstrap",
        payload: {
          bootstrapToken,
          username: "captain",
          password: "correct-horse-battery-staple"
        }
      });
      expect(bootRes.statusCode).toBe(200);

      const loginRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: {
          username: "captain",
          password: "correct-horse-battery-staple"
        }
      });
      expect(loginRes.statusCode).toBe(200);
      const cookieHeader = loginRes.headers["set-cookie"] as string;

      // 2. Run backtest without token. The effective range should be truncated to SEALED_HOLDOUT_START_TS,
      // so it must NOT fail with 2026 holdout violation!
      const replayRes = await app.inject({
        method: "POST",
        url: "/api/v1/replay/run",
        headers: { cookie: cookieHeader },
        payload: {
          strategyId: "donchian-trend-v1",
          instrumentId: "BTC-USDT-SWAP",
          timeframe: "1H"
        }
      });

      expect(replayRes.statusCode).toBe(200);
      expect(replayRes.json().experiment).toBeDefined();

      // 4. Request reaching into 2026 without allowHoldoutAccess -> 400
      const outOfBoundsRes = await app.inject({
        method: "POST",
        url: "/api/v1/replay/run",
        headers: { cookie: cookieHeader },
        payload: {
          strategyId: "donchian-trend-v1",
          instrumentId: "BTC-USDT-SWAP",
          timeframe: "1H",
          toTs: SEALED_2026_HOLDOUT_START_TS + 3600_000
        }
      });
      expect(outOfBoundsRes.statusCode).toBe(400);
      expect(outOfBoundsRes.json().error).toMatch(
        /Sealed 2026 holdout violation.*allowHoldoutAccess/i
      );

      // 5. Request reaching into 2026 with allowHoldoutAccess: true but NO token -> 400
      const noTokenRes = await app.inject({
        method: "POST",
        url: "/api/v1/replay/run",
        headers: { cookie: cookieHeader },
        payload: {
          strategyId: "donchian-trend-v1",
          instrumentId: "BTC-USDT-SWAP",
          timeframe: "1H",
          toTs: SEALED_2026_HOLDOUT_START_TS + 3600_000,
          allowHoldoutAccess: true
        }
      });
      expect(noTokenRes.statusCode).toBe(400);
      expect(noTokenRes.json().error).toMatch(/unused holdout token/i);
    } finally {
      await app.close();
    }
  });
});
