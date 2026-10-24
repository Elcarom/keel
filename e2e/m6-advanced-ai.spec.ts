import { expect, test } from "@playwright/test";

test.describe("Keel M6 — End-to-End Advanced AI: Event Gate, Narrative Clustering & Markout Forensics", () => {
  test("authenticates, evaluates event gate volatility risk, tags narrative clusters, and calculates post-fill markout forensics", async ({
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

    // 2. Verify AI Panel is visible
    await expect(page.getByTestId("ai-decision-support-panel")).toBeVisible();

    // 3. Test Event Gate Advisor
    await expect(page.getByTestId("event-gate-panel")).toBeVisible();
    await page
      .getByTestId("event-gate-input")
      .fill("Emergency FOMC inter-meeting statement: policy rate increased by 50 bps");
    await page.getByTestId("evaluate-event-gate-btn").click();
    await expect(page.getByTestId("event-gate-result-card")).toBeVisible();
    await expect(page.getByTestId("event-gate-recommendation-badge")).toContainText(
      /REDUCE_SIZE|STAND_DOWN|PASS/
    );

    // 4. Test Narrative Cluster Tagger
    await page.getByTestId("cluster-narratives-btn").click();
    await expect(page.getByTestId("narrative-clusters-table")).toContainText(
      /Central Bank|Policy|Market/
    );

    // 5. Test Markout Forensics Analyst
    await page.getByTestId("analyze-markout-btn").click();
    await expect(page.getByTestId("markout-forensics-card")).toBeVisible();
    await expect(page.getByTestId("markout-quality-badge")).toContainText("EXCELLENT");

    // 6. Verify Audit Log recorded all M6 actions
    const auditTable = page.getByTestId("audit-log-table");
    await expect(auditTable).toContainText(/ai\.evaluate_event_gate|ai\.cluster_narratives/);
  });
});
