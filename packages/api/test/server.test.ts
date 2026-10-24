import { ManualClock, computeConfigHash, createDefaultConfig } from "@keel/core";
import { describe, expect, it } from "vitest";
import { createKeelServer, redactLogObject } from "../src/index.js";

describe("@keel/api — Fastify Server, Observability, and Cloudflare Tunnel Contract (M0-3)", () => {
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
});
