import { expect, test } from "@playwright/test";

test.describe("Keel — Engine Room", () => {
  test("signs in, switches on the fleet's autonomy, links Discord, pulls the Kill Switch and restores settings", async ({
    page
  }) => {
    await page.goto("/#/engine-room");

    // 1. First-boot setup, or sign-in when an earlier test already set up the account
    const bootstrapPanel = page.getByTestId("bootstrap-panel");
    await expect(bootstrapPanel.or(page.getByTestId("login-panel"))).toBeVisible();
    if (await bootstrapPanel.isVisible()) {
      await page.getByTestId("bootstrap-token-input").fill("keel-e2e-bootstrap-token-2026");
    }
    await page.getByTestId("bootstrap-username-input").fill("captain");
    await page.getByTestId("bootstrap-password-input").fill("correct-horse-battery-staple");
    await page.getByTestId("bootstrap-submit-btn").click();
    await expect(page.getByTestId("governance-cockpit")).toBeVisible();
    await expect(page.getByTestId("authenticated-user-badge")).toHaveText("captain");
    await expect(page.getByTestId("claude-status")).toContainText("Claude is not linked");

    // 2. Switch on the Night Shift and the Autopilot (ADR-0033) and save a new version
    const startVersion = Number(
      (await page.getByTestId("config-version-display").textContent())?.replace("v", "")
    );
    await page.getByTestId("duty-nightShiftEnabled").check();
    await page.getByTestId("duty-autopilotEnabled").check();
    await page.getByTestId("save-config-btn").click();
    await expect(page.getByTestId("gov-success-banner")).toContainText(
      `settings are now version ${startVersion + 1}`
    );
    await expect(page.getByTestId("duty-nightShiftEnabled")).toBeChecked();
    await expect(page.getByTestId("duty-autopilotEnabled")).toBeChecked();

    // 3. Store the Discord webhook in the vault; only a masked preview comes back
    await page
      .getByTestId("secret-input-discordWebhookUrl")
      .fill("https://discord.com/api/webhooks/e2e/secret-9999");
    await page.getByTestId("secret-save-discordWebhookUrl").click();
    await expect(page.getByTestId("gov-success-banner")).toContainText("discordWebhookUrl");
    await expect(page.getByTestId("secret-status-discordWebhookUrl")).toContainText("Stored");

    // 4. Pull the Kill Switch, then reset it
    await page.getByTestId("kill-switch-btn").click();
    await expect(page.getByTestId("kill-switch-status")).toContainText("Kill Switch on");
    await page.getByTestId("kill-switch-btn").click();
    await expect(page.getByTestId("kill-switch-status")).toContainText("Kill Switch off");

    // 5. Restore the settings from before, saved as a new version
    await page.getByText("Earlier versions").click();
    await page.getByTestId(`rollback-version-${startVersion}-btn`).click();
    await expect(page.getByTestId("gov-success-banner")).toContainText(`Restored v${startVersion}`);
    await expect(page.getByTestId("duty-autopilotEnabled")).not.toBeChecked();

    // 6. Every step is in the audit trail
    const audit = page.getByTestId("audit-log-table");
    await expect(audit).toContainText("config.update");
    await expect(audit).toContainText("secrets.upsert");
    await expect(audit).toContainText("config.rollback");
  });
});
