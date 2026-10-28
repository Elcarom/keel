import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:8080",
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: {
    command: "node packages/api/dist/cli.js",
    url: "http://127.0.0.1:8080/healthz",
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      KEEL_BOOTSTRAP_TOKEN: "keel-e2e-bootstrap-token-2026",
      // Test-only key: the vault refuses to run without a strong one (ADR-0013)
      KEEL_MASTER_KEY: "keel-e2e-only-vault-key-Qx7mP2vR9tL4wZ8n",
      // Deterministic AI responses so the suite never calls Gemini
      KEEL_AI_SIMULATE_RESPONSES: "true"
    }
  }
});
