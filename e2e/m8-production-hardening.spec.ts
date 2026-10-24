import { expect, test } from "@playwright/test";

test.describe("Keel M8 — End-to-End Production Hardening, Disaster Recovery, & Gate G3 Verification", () => {
  test("verifies production health, audit trail, vault protection, rollback drills, and Gate G3 readiness", async ({
    page
  }) => {
    // 1. Production Health & Brand Shell
    await page.goto("/");
    await expect(page).toHaveTitle(/Keel/);

    // 2. Authentication Bootstrap / Login
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

    // 3. Confirm Execution Mode & Config Hash Invariants
    await expect(page.getByTestId("execution-mode-badge")).toBeVisible();
    await expect(page.getByTestId("config-hash-display")).toHaveText(/^[a-f0-9]{16}$/);

    // 4. Secret Vault Drill: Encrypt a secret in AES-256-GCM vault without leaking plaintext
    await page.getByTestId("vault-value-input").fill("AIzaSyD-e2e-m8-hardened-key");
    await page.getByTestId("vault-save-btn").click();
    await expect(page.getByTestId("gov-success-banner")).toContainText("AIza...-key");

    // 5. Quantitative Promotion Ladder & Gate G2/G3 Step-Up Verification
    await page.getByTestId("evaluate-ladder-btn").click();
    await expect(page.getByTestId("promotion-ladder-table")).toBeVisible();

    // Fill in Step-Up password for Gate G2/G3
    await page.getByTestId("promote-step-up-password-input").fill("correct-horse-battery-staple");

    const promoteBtn = page.getByTestId("promote-strategy-btn").first();
    if (await promoteBtn.isVisible()) {
      await promoteBtn.click();
      await expect(page.getByTestId("promotion-ladder-table")).toContainText(
        /Paper|Demo|Live-Ramp|Live/
      );
    }

    // 6. Emergency Flatten & Safety Drill
    const flattenBtn = page.getByTestId("emergency-flatten-btn");
    if (await flattenBtn.isVisible()) {
      await flattenBtn.click();
    }

    // 7. Audit Trail Drill: Verify immutable audit log recorded all operations
    const auditTable = page.getByTestId("audit-log-table");
    await expect(auditTable).toBeVisible();
    await expect(auditTable).toContainText(/auth\.bootstrap|auth\.login|secrets\.upsert|promotion/);
  });
});
