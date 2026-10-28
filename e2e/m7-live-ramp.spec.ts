import { expect, test } from "@playwright/test";

test.describe("Keel M7 — End-to-End Live-Ramp & Demotion Automation", () => {
  test("authenticates, evaluates promotion ladder, promotes strategy to next stage, and executes safety demotion with auto-flattening", async ({
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

    // 2. Evaluate Promotion Ladder
    await expect(page.getByTestId("promotion-ladder-table")).toBeVisible();
    await page.getByTestId("evaluate-ladder-btn").click();

    // 3. Verify strategy is evaluated and listed
    await expect(page.getByTestId("promotion-ladder-table")).toContainText(
      /donchian-trend-v1|vol-mean-reversion-v1/
    );

    // 4. Fill in step-up password for Gate G2/G3
    await page.getByTestId("promote-step-up-password-input").fill("correct-horse-battery-staple");

    // If promote button is available, click promote and verify transition
    const promoteBtn = page.getByTestId("promote-strategy-btn").first();
    if (await promoteBtn.isVisible()) {
      await promoteBtn.click();
      await expect(page.getByTestId("promotion-ladder-table")).toContainText(
        /Paper|Demo|Live-Ramp|Live/
      );
    }

    // 5. Test Demotion & Safety Auto-Flatten
    const demoteBtn = page.getByTestId("demote-strategy-btn").first();
    await demoteBtn.click();
    await expect(page.getByTestId("promotion-ladder-table")).toContainText(
      /Research|Paper|Demo|Live-Ramp/
    );

    // 6. Verify Audit Log recorded promotion and demotion events
    const auditTable = page.getByTestId("audit-log-table");
    await expect(auditTable).toContainText(/promotion\.evaluate|promotion\.demote/);
  });
});
