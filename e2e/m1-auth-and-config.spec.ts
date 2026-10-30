import { expect, test } from "@playwright/test";

test.describe("Keel M1 — End-to-End Auth Bootstrap, Config Governance, Vault, & Rollback", () => {
  test("bootstraps operator account, updates confirm-class config with step-up, encrypts secret, and rolls back to v1", async ({
    page
  }) => {
    await page.goto("/#/engine-room");

    await expect(page.getByTestId("config-hash-display")).toHaveText(/^[a-f0-9]{16}$/);
    const initialHash = (await page.getByTestId("config-hash-display").textContent())?.trim();
    await expect(page.getByTestId("config-version-display")).toHaveText("v1");

    // 1. First-boot bootstrap flow (or login if already bootstrapped in same run)
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

    await expect(page.getByTestId("governance-cockpit")).toBeVisible();
    await expect(page.getByTestId("authenticated-user-badge")).toHaveText("captain");

    // 2. Toggle confirm-class setting (AI Strategy Lab), preview diff, and save v2
    await page.getByTestId("toggle-strategy-lab").check();
    // The Fleet duties are switched on from the same draft (ADR-0033)
    await page.getByTestId("duty-nightShiftEnabled").check();
    await page.getByTestId("duty-autopilotEnabled").check();
    await page.getByTestId("preview-diff-btn").click();
    await expect(page.getByTestId("diff-preview-box")).toContainText("Highest Risk: confirm");
    await expect(page.getByTestId("diff-preview-box")).toContainText("Step-Up Required: true");

    await page.getByTestId("config-reason-input").fill("Enable Strategy Lab in E2E");
    await page.getByTestId("save-config-btn").click();

    await expect(page.getByTestId("gov-success-banner")).toContainText("Saved Config Version v2");
    await expect(page.getByTestId("config-version-display")).toHaveText("v2");
    await expect(page.getByTestId("duty-nightShiftEnabled")).toBeChecked();
    await expect(page.getByTestId("duty-autopilotEnabled")).toBeChecked();

    const v2Hash = (await page.getByTestId("config-hash-display").textContent())?.trim();
    expect(v2Hash).not.toBe(initialHash);

    // 3. Encrypt and store a secret in the AES-256-GCM vault
    await page.getByTestId("vault-value-input").fill("AIzaSyD-e2e-gemini-key-9999");
    await page.getByTestId("vault-save-btn").click();
    await expect(page.getByTestId("gov-success-banner")).toContainText("AIza...9999");

    // 4. Rollback to v1 and verify ConfigHash returns to initialHash
    await page.getByTestId("rollback-version-1-btn").click();
    await expect(page.getByTestId("gov-success-banner")).toContainText("Rolled back to v1");
    await expect(page.getByTestId("config-version-display")).toHaveText("v3");

    const v3Hash = (await page.getByTestId("config-hash-display").textContent())?.trim();
    expect(v3Hash).toBe(initialHash);

    // 5. Verify Audit Log table contains recorded actions
    await expect(page.getByTestId("audit-log-table")).toContainText("config.rollback");
    await expect(page.getByTestId("audit-log-table")).toContainText("secrets.upsert");
    await expect(page.getByTestId("audit-log-table")).toContainText("config.update");
  });
});
