import { ManualClock, createDefaultConfig, type KeelConfig } from "@keel/core";
import { describe, expect, it } from "vitest";
import { DiscordWebhookNotifier } from "../src/notifications.js";

describe("M1-3 — DiscordWebhookNotifier Severity Routing, Cooldown Deduplication, & Secret Redaction", () => {
  it("routes CRITICAL/WARNING/INFO according to config, deduplicates WARNING within cooldown, and redacts secrets", async () => {
    const clock = new ManualClock(1_730_000_000_000);
    const deliveries: { url: string; body: Record<string, unknown> }[] = [];

    let currentConfig: KeelConfig = {
      ...createDefaultConfig(),
      notifications: {
        discordEnabled: true,
        routeCritical: true,
        routeWarning: true,
        routeInfoDigest: false,
        warningCooldownMinutes: 15
      }
    };

    const notifier = new DiscordWebhookNotifier({
      clock,
      getConfig: () => currentConfig,
      getWebhookUrl: () => "https://discord.com/api/webhooks/123456/abcdef",
      fetchFn: async (url, init) => {
        deliveries.push({
          url,
          body: JSON.parse(String(init.body)) as Record<string, unknown>
        });
        return { ok: true, status: 204 };
      }
    });

    // 1. INFO is suppressed when routeInfoDigest === false
    const infoRes = await notifier.send({
      severity: "INFO",
      title: "Paper fill",
      body: "Filled 1 BTC-USDT-SWAP"
    });
    expect(infoRes.delivered).toBe(false);
    expect(infoRes.suppressedReason).toBe("severity_filtered");
    expect(deliveries).toHaveLength(0);

    // 2. WARNING delivers on first occurrence and redacts sensitive metadata
    const warn1 = await notifier.send({
      severity: "WARNING",
      title: "OKX WebSocket Reconnecting",
      body: "Public books5 stream reconnected",
      dedupKey: "ws:okx:books5",
      metadata: {
        instrumentId: "BTC-USDT-SWAP",
        okxApiKey: "super-secret-okx-key-value"
      }
    });
    expect(warn1.delivered).toBe(true);
    expect(deliveries).toHaveLength(1);
    const payloadStr = JSON.stringify(deliveries[0]?.body);
    expect(payloadStr).not.toContain("super-secret-okx-key-value");
    expect(payloadStr).toContain("[REDACTED]");

    // 3. Duplicate WARNING within 15 minutes is suppressed by cooldown
    clock.advanceMs(5 * 60_000);
    const warn2 = await notifier.send({
      severity: "WARNING",
      title: "OKX WebSocket Reconnecting",
      body: "Public books5 stream reconnected again",
      dedupKey: "ws:okx:books5"
    });
    expect(warn2.delivered).toBe(false);
    expect(warn2.suppressedReason).toBe("cooldown_active");
    expect(deliveries).toHaveLength(1);

    // 4. CRITICAL bypasses cooldown and always fires immediately
    const crit1 = await notifier.send({
      severity: "CRITICAL",
      title: "Portfolio Kill-Switch Triggered",
      body: "Drawdown reached 12.0%",
      dedupKey: "ws:okx:books5"
    });
    expect(crit1.delivered).toBe(true);
    expect(deliveries).toHaveLength(2);

    // 5. After 15 minutes cooldown expires, WARNING fires again
    clock.advanceMs(11 * 60_000);
    const warn3 = await notifier.send({
      severity: "WARNING",
      title: "OKX WebSocket Reconnecting",
      body: "Public books5 stream reconnected after cooldown",
      dedupKey: "ws:okx:books5"
    });
    expect(warn3.delivered).toBe(true);
    expect(deliveries).toHaveLength(3);

    // 6. When discordEnabled is false, all notifications are suppressed
    currentConfig = {
      ...currentConfig,
      notifications: {
        ...currentConfig.notifications,
        discordEnabled: false
      }
    };
    const disabledRes = await notifier.send({
      severity: "CRITICAL",
      title: "Test",
      body: "Should be suppressed"
    });
    expect(disabledRes.delivered).toBe(false);
    expect(disabledRes.suppressedReason).toBe("disabled");
  });
});
