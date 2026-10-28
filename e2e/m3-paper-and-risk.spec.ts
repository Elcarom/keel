import { expect, test } from "@playwright/test";

test.describe("Keel M3 — End-to-End Two-Tier Risk Guardian, Paper Execution, & Double-Entry Ledger", () => {
  test("seeds market bars, verifies balanced double-entry ledger, steps paper execution tick with attached protective stops, trips/re-arms kill-switch, and evaluates promotion ladder", async ({
    page
  }) => {
    await page.goto("/#/engine-room");

    // 1. Authenticate (bootstrap or login) once the auth form has rendered
    await page.getByTestId("bootstrap-username-input").waitFor();
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

    // 2. Verify M3 Paper Cockpit Panel is visible with initial 10,000 USDT capital and BALANCED trial balance
    await expect(page.getByTestId("paper-cockpit-panel")).toBeVisible();
    await expect(page.getByTestId("trial-balance-badge")).toContainText("BALANCED");
    await expect(page.getByTestId("circuit-breaker-badge")).toContainText("CB: NORMAL");
    await expect(page.getByTestId("cash-balance-val")).toContainText("10000.00000000 USDT");

    // 3. Seed confirmed market bars to give strategy sufficient lookback
    await page.getByTestId("seed-market-btn").click();
    await expect(page.getByTestId("gov-success-banner")).toContainText(
      "Seeded confirmed market bars"
    );

    // 4. Step a Paper Execution Tick through RiskGuardian and PaperBroker
    await page.getByTestId("strategy-select").selectOption("donchian-trend-v1");
    await page.getByTestId("execute-paper-tick-btn").click();
    await expect(page.getByTestId("gov-success-banner")).toContainText("Paper tick executed");

    // 5. Verify Ledger remains BALANCED after position entry fees
    await expect(page.getByTestId("trial-balance-badge")).toContainText("BALANCED");

    // 6. Test Manual Kill-Switch trip and re-arm
    await page.getByTestId("trip-kill-switch-btn").click();
    await expect(page.getByTestId("circuit-breaker-badge")).toContainText("CB: MANUAL_KILL_SWITCH");
    await expect(page.getByTestId("gov-success-banner")).toContainText(
      "Circuit breaker updated to MANUAL_KILL_SWITCH"
    );

    // Re-arming after a Kill Switch requires step-up (audit-3 H9)
    await page.getByTestId("promote-step-up-password-input").fill("correct-horse-battery-staple");
    await page.getByTestId("trip-kill-switch-btn").click();
    await expect(page.getByTestId("circuit-breaker-badge")).toContainText("CB: NORMAL");

    // 7. Evaluate Quantitative Promotion Ladder (ADR-0007)
    await page.getByTestId("evaluate-promotion-btn").click();
    await expect(page.getByTestId("gov-success-banner")).toContainText(
      "Strategy donchian-trend-v1 evaluated"
    );
    await expect(page.getByTestId("promotion-ladder-table")).toContainText("donchian-trend-v1");

    // 8. Test Emergency Flatten All
    await page.getByTestId("flatten-positions-btn").click();
    await expect(page.getByTestId("gov-success-banner")).toContainText("Flattened");

    // 9. Verify Immutable Audit Trail captured paper and promotion events
    const auditTable = page.getByTestId("audit-log-table");
    await expect(auditTable).toContainText("paper.execute_tick");
    await expect(auditTable).toContainText("paper.set_circuit_breaker");
    await expect(auditTable).toContainText("promotion.evaluate");
    await expect(auditTable).toContainText("paper.flatten_all");
  });
});
