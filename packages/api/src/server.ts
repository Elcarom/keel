import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import {
  SystemClock,
  computeConfigHash,
  createDefaultConfig,
  keelApiContract,
  type Clock,
  type KeelConfig
} from "@keel/core";
import { initServer } from "@ts-rest/fastify";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { PINO_REDACT_PATHS } from "./redact.js";

export interface KeelServerOptions {
  readonly config?: KeelConfig;
  readonly clock?: Clock;
  readonly webDistPath?: string;
  readonly logger?: boolean;
}

function resolveClientIp(
  req: FastifyRequest,
  trustCloudflare: boolean
): {
  readonly clientIp: string;
  readonly cloudflareTunnelActive: boolean;
} {
  if (trustCloudflare) {
    const cfIp = req.headers["cf-connecting-ip"];
    if (typeof cfIp === "string" && cfIp.trim().length > 0) {
      return { clientIp: cfIp.trim(), cloudflareTunnelActive: true };
    }
  }
  return { clientIp: req.ip, cloudflareTunnelActive: false };
}

export async function createKeelServer(options: KeelServerOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? createDefaultConfig();
  const clock = options.clock ?? new SystemClock();
  const startedAtMs = clock.nowMs();
  const configHash = computeConfigHash(config);

  const app = Fastify({
    trustProxy: config.system.trustCloudflareHeaders,
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

  app.get("/healthz", async () => {
    return {
      status: "ok",
      appName: "Keel",
      timestampMs: clock.nowMs()
    };
  });

  app.get("/readyz", async () => {
    return {
      ready: true,
      executionMode: config.system.executionMode
    };
  });

  app.get("/metrics", async (_req, reply) => {
    const uptimeSeconds = Math.max(0, Math.floor((clock.nowMs() - startedAtMs) / 1000));
    const lines = [
      "# HELP keel_up Whether the Keel process is healthy (1 = up).",
      "# TYPE keel_up gauge",
      "keel_up 1",
      "# HELP keel_uptime_seconds Process uptime in seconds.",
      "# TYPE keel_uptime_seconds gauge",
      `keel_uptime_seconds ${uptimeSeconds}`,
      "# HELP keel_execution_mode_info Active execution mode label.",
      "# TYPE keel_execution_mode_info gauge",
      `keel_execution_mode_info{mode="${config.system.executionMode}"} 1`
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
      const payload = JSON.stringify({
        timestampMs: clock.nowMs(),
        executionMode: config.system.executionMode,
        configHash: configHash.slice(0, 12)
      });
      reply.raw.write(`event: heartbeat\ndata: ${payload}\n\n`);
    };

    writeBeat();
    const timer = setInterval(writeBeat, config.system.sseHeartbeatMs);

    req.raw.on("close", () => {
      clearInterval(timer);
    });
  });

  const s = initServer();
  const router = s.router(keelApiContract, {
    system: {
      getStatus: async ({ request }) => {
        const nowMs = clock.nowMs();
        const uptimeSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
        const { clientIp, cloudflareTunnelActive } = resolveClientIp(
          request,
          config.system.trustCloudflareHeaders
        );
        return {
          status: 200,
          body: {
            appName: "Keel",
            version: "0.1.0",
            executionMode: config.system.executionMode,
            configHash,
            serverTimeMs: nowMs,
            serverTimeIso: clock.isoNow(),
            uptimeSeconds,
            cloudflareTunnelActive,
            clientIp,
            status: "ok"
          }
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
