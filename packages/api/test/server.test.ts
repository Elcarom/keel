import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_FIELD_REGISTRY,
  ManualClock,
  computeConfigHash,
  createDefaultConfig
} from "@keel/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKeelServer, redactLogObject } from "../src/index.js";

describe("@keel/api — Fastify Server, Observability, Auth, Config Governance, Vault, & Audit (M0 + M1)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "keel-api-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
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
      expect(runReplayRes.json().experiment.dataSnapshotId).toBe(
        seedRes.json().snapshot.snapshotId
      );

      const listExpRes = await app.inject({
        method: "GET",
        url: "/api/v1/replay/experiments",
        headers: { cookie: cookieHeader }
      });
      expect(listExpRes.statusCode).toBe(200);
      expect(listExpRes.json().experiments.length).toBe(1);
    } finally {
      await app.close();
    }
  });
});
