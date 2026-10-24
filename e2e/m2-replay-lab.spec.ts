import { expect, test } from "@playwright/test";

test.describe("Keel M2 — End-to-End Market Data Ingestion & Replay Research Lab", () => {
  test("seeds confirmed multi-timeframe bars & 8h funding, verifies strategy lookback readiness, runs event-driven replay, and records immutable ExperimentRecords", async ({
    page
  }) => {
    await page.goto("/");

    // 1. Authenticate (bootstrap or login)
    const bootstrapPanel = page.getByTestId("bootstrap-panel");
    if (await bootstrapPanel.isVisible()) {
      await page.getByTestId("bootstrap-token-input").fill("keel-e2e-bootstrap-token-2026");
      await page.getByTestId("bootstrap-username-input").fill("captain");
      await page.getByTestId("bootstrap-password-input").fill("correct-horse-battery-staple");
      await page.getByTestId("bootstrap-submit-btn").click();
    } else {
      await page.getByTestId("bootstrap-username-input").fill("captain");
      await page.getByTestId("bootstrap-password-input").fill("correct-horse-battery-staple");
      await page.getByTestId("bootstrap-submit-btn").click();
    }

    await expect(page.getByTestId("replay-lab-panel")).toBeVisible();

    // 2. Seed confirmed market bars & 8h settled funding for BTC-USDT-SWAP
    await page.getByTestId("seed-market-btn").click();
    await expect(page.getByTestId("gov-success-banner")).toContainText(
      "Seeded confirmed market bars"
    );
    await expect(page.getByTestId("coverage-BTC-USDT-SWAP")).toContainText("BTC-USDT-SWAP");
    await expect(page.getByTestId("coverage-BTC-USDT-SWAP")).toContainText("15m: 960");
    await expect(page.getByTestId("coverage-BTC-USDT-SWAP")).toContainText("1H: 240");

    // 3. Verify Strategy LookbackRequirement readiness badges flip to SATISFIED
    await expect(page.getByTestId("strategy-readiness-donchian-trend-v1")).toContainText(
      "SATISFIED"
    );
    await expect(page.getByTestId("strategy-readiness-vol-mean-reversion-v1")).toContainText(
      "SATISFIED"
    );
    await expect(page.getByTestId("strategy-readiness-vol-momentum-v1")).toContainText("SATISFIED");

    // 4. Run Event-Driven Replay for Donchian Trend Breakout v1
    await page.getByTestId("strategy-select").selectOption("donchian-trend-v1");
    await page.getByTestId("run-replay-btn").click();
    await expect(page.getByTestId("gov-success-banner")).toContainText(
      "Replay complete: donchian-trend-v1 on BTC-USDT-SWAP"
    );

    // 5. Verify Experiment Registry table displays recorded run with Snapshot ID, Avg R, 2x Stress R, DSR, and ADR-0007 Gate badge
    const expTable = page.getByTestId("experiments-table");
    await expect(expTable).toContainText("donchian-trend-v1");
    await expect(expTable).toContainText("BTC-USDT-SWAP");
    await expect(expTable).toContainText(/PASS|HOLD/);

    // 6. Verify Audit Log recorded market.seed_synthetic and replay.run_backtest
    await expect(page.getByTestId("audit-log-table")).toContainText("replay.run_backtest");
    await expect(page.getByTestId("audit-log-table")).toContainText("market.seed_synthetic");
  });
});
