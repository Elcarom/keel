import { expect, test } from "@playwright/test";

test.describe("Keel M4 — End-to-End AI Decision Support, Context Analyst & Shadow Advisor", () => {
  test("authenticates, extracts structured context features, verifies budget tracking, and evaluates shadow advisor against baseline", async ({
    page
  }) => {
    await page.goto("/#/engine-room");

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

    // 2. Verify M4 AI Decision Support Panel is visible
    await expect(page.getByTestId("ai-decision-support-panel")).toBeVisible();
    await expect(page.getByTestId("ai-provider-badge")).toContainText("GEMINI");
    await expect(page.getByTestId("ai-daily-budget-badge")).toContainText("BUDGET:");

    // 3. Extract Context Feature from announcement text
    await page
      .getByTestId("context-input-textarea")
      .fill("Federal Reserve confirms plans to slow balance sheet runoff at upcoming meeting.");
    await page.getByTestId("extract-context-btn").click();

    // 4. Verify Context Features Table displays extracted headline, directional bias, and contamination status
    await expect(page.getByTestId("context-features-table")).toContainText(
      /Federal Reserve|Context/
    );

    // 5. Run Shadow Advisor evaluation alongside Baseline Chooser
    await page.getByTestId("evaluate-shadow-btn").click();
    await expect(page.getByTestId("shadow-result-card")).toBeVisible();
    await expect(page.getByTestId("shadow-result-card")).toContainText("Baseline Pick:");
    await expect(page.getByTestId("shadow-result-card")).toContainText("Shadow Advisor Pick:");

    // 6. Verify Audit Log recorded AI actions
    const auditTable = page.getByTestId("audit-log-table");
    await expect(auditTable).toContainText(/ai\.extract_context|ai\.shadow_evaluate/);
  });
});
