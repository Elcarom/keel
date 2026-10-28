import { join } from "node:path";
import { createDefaultConfig } from "@keel/core";
import { createKeelServer } from "./server.js";

async function main(): Promise<void> {
  const config = createDefaultConfig();
  const port = Number(process.env["PORT"] ?? config.system.port);
  const host = process.env["HOST"] ?? "0.0.0.0";
  const dbPath =
    process.env["KEEL_DB_PATH"] ??
    (process.env["DATA_DIR"] ? join(process.env["DATA_DIR"], "keel.sqlite") : ":memory:");
  const backupsDir = process.env["KEEL_BACKUPS_DIR"] ?? process.env["BACKUPS_DIR"];

  const app = await createKeelServer({
    config: {
      ...config,
      system: {
        ...config.system,
        port
      },
      ai: {
        ...config.ai,
        simulateResponses: process.env["KEEL_AI_SIMULATE_RESPONSES"] === "true"
      }
    },
    dbPath,
    backupsDir,
    enableScheduler: process.env["KEEL_ENABLE_SCHEDULER"] === "true",
    allowInsecureHttp: process.env["KEEL_ALLOW_INSECURE_HTTP"] === "true",
    logger: true
  });

  if (process.env["KEEL_ALLOW_INSECURE_HTTP"] === "true") {
    app.log.warn(
      "KEEL_ALLOW_INSECURE_HTTP=true: session cookies are sent over plain HTTP. Use only on a trusted LAN for testing; expose Keel through HTTPS (Cloudflare Tunnel) otherwise."
    );
  }

  const shutdown = async (signal: string) => {
    app.log.info(
      {
        signal,
        shutdownPolicy: config.system.shutdownPolicy,
        executionMode: config.system.executionMode
      },
      "Keel received shutdown signal; executing graceful stop policy and WAL checkpoint"
    );
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ port, host });
}

void main();
