import { expect, test } from "@playwright/test";

// The e2e server runs in the default Paper Execution Mode with no OKX credentials, so the
// exchange panel must refuse orders rather than simulate fills (audit-3 C3, H7).
test.describe("Keel M5 — Exchange Broker panel refuses orders outside exchange Execution Modes", () => {
  test("authenticates, shows an idle DMS, and refuses a protected order in Paper mode", async ({
    page
  }) => {
    await page.goto("/");

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

    // 2. Exchange broker panel is visible; without credentials the DMS cannot be armed
    await expect(page.getByTestId("exchange-broker-panel")).toBeVisible();
    await expect(page.getByTestId("broker-venue-badge")).toContainText("OKX-EEA");
    await expect(page.getByTestId("broker-dms-badge")).toContainText("IDLE");

    // 3. A fully specified, stepped-up order is still refused in Paper mode
    await page.getByTestId("order-instrument-input").fill("BTC-USDT-SWAP");
    await page.getByTestId("order-side-select").selectOption("long");
    await page.getByTestId("order-size-input").fill("1");
    await page.getByTestId("order-entry-price-input").fill("50000");
    await page.getByTestId("order-stop-price-input").fill("48500");
    await page.getByTestId("order-step-up-password-input").fill("correct-horse-battery-staple");
    await page.getByTestId("submit-exchange-order-btn").click();

    await expect(page.getByTestId("gov-error-banner")).toContainText("Execution Mode");
    await expect(page.getByTestId("exchange-orders-table")).not.toContainText("BTC-USDT-SWAP");

    // 4. The Venue Book rebase is wired to the API and refused outside exchange Execution Modes
    await page.getByTestId("rebase-venue-capital-btn").click();
    await expect(page.getByTestId("gov-error-banner")).toContainText("no venue in the Paper");
  });
});
