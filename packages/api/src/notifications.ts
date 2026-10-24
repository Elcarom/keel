import type {
  Clock,
  KeelConfig,
  NotificationChannel,
  NotificationDeliveryResult,
  NotificationMessage,
  NotificationSeverity
} from "@keel/core";
import { redactLogObject } from "./redact.js";

export interface WebhookFetchInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface WebhookFetchResponse {
  readonly ok: boolean;
  readonly status: number;
}

export type WebhookFetchFn = (url: string, init: WebhookFetchInit) => Promise<WebhookFetchResponse>;

export interface DiscordWebhookNotifierOptions {
  readonly clock: Clock;
  readonly getConfig: () => KeelConfig;
  readonly getWebhookUrl: () => string | null;
  readonly fetchFn?: WebhookFetchFn | undefined;
}

const SEVERITY_COLORS: Record<NotificationSeverity, number> = {
  CRITICAL: 0xdc2626, // Signal Crimson
  WARNING: 0xf59e0b, //Signal Amber
  INFO: 0x0d9488 // Harbor Teal
};

/**
 * Discord Webhook NotificationChannel adapter with severity routing,
 * WARNING cooldown deduplication, and automatic secret redaction.
 */
export class DiscordWebhookNotifier implements NotificationChannel {
  private readonly clock: Clock;
  private readonly getConfig: () => KeelConfig;
  private readonly getWebhookUrl: () => string | null;
  private readonly fetchFn: WebhookFetchFn;
  private readonly lastWarningByKey = new Map<string, number>();

  public constructor(options: DiscordWebhookNotifierOptions) {
    this.clock = options.clock;
    this.getConfig = options.getConfig;
    this.getWebhookUrl = options.getWebhookUrl;
    this.fetchFn =
      options.fetchFn ??
      (async (url, init) => {
        const res = await fetch(url, init);
        return { ok: res.ok, status: res.status };
      });
  }

  public async send(message: NotificationMessage): Promise<NotificationDeliveryResult> {
    const config = this.getConfig();
    const notifCfg = config.notifications;

    if (!notifCfg.discordEnabled) {
      return { delivered: false, suppressedReason: "disabled" };
    }

    if (message.severity === "CRITICAL" && !notifCfg.routeCritical) {
      return { delivered: false, suppressedReason: "severity_filtered" };
    }
    if (message.severity === "WARNING" && !notifCfg.routeWarning) {
      return { delivered: false, suppressedReason: "severity_filtered" };
    }
    if (message.severity === "INFO" && !notifCfg.routeInfoDigest) {
      return { delivered: false, suppressedReason: "severity_filtered" };
    }

    const nowMs = this.clock.nowMs();
    if (message.severity === "WARNING") {
      const dedupKey = message.dedupKey ?? message.title;
      const cooldownMs = notifCfg.warningCooldownMinutes * 60_000;
      const prevTs = this.lastWarningByKey.get(dedupKey);
      if (prevTs !== undefined && nowMs - prevTs < cooldownMs) {
        return { delivered: false, suppressedReason: "cooldown_active" };
      }
      this.lastWarningByKey.set(dedupKey, nowMs);
    }

    const webhookUrl = this.getWebhookUrl();
    if (!webhookUrl || webhookUrl.trim().length === 0) {
      return { delivered: false, suppressedReason: "missing_webhook" };
    }

    const redactedMetadata = message.metadata ? redactLogObject(message.metadata) : undefined;

    const fields = redactedMetadata
      ? Object.entries(redactedMetadata).map(([name, val]) => ({
          name,
          value: String(val),
          inline: true
        }))
      : [];

    const discordPayload = {
      username: "Keel Telemetry",
      embeds: [
        {
          title: `[${message.severity}] ${message.title}`,
          description: message.body,
          color: SEVERITY_COLORS[message.severity],
          timestamp: new Date(nowMs).toISOString(),
          fields
        }
      ]
    };

    try {
      const response = await this.fetchFn(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(discordPayload)
      });
      if (!response.ok) {
        return {
          delivered: false,
          error: `Discord webhook returned HTTP ${response.status}`
        };
      }
      return { delivered: true };
    } catch (err) {
      return {
        delivered: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }
}
