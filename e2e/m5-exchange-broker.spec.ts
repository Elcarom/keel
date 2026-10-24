import { expect, test } from "@playwright/test";

test.describe("Keel M5 — End-to-End Exchange Broker Connectivity & Attached Protective Stops", () => {
  test("authenticates, sends DMS heartbeat, submits entry with atomic attached stop, and reconciles positions", async ({
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

    // 2. Verify M5 Exchange Broker Panel is visible
    await expect(page.getByTestId("exchange-broker-panel")).toBeVisible();
    await expect(page.getByTestId("broker-venue-badge")).toContainText("OKX-EEA");

    // 3. Send DMS heartbeat and verify active status
    await page.getByTestId("send-dms-btn").click();
    await expect(page.getByTestId("broker-dms-badge")).toContainText("ACTIVE");

    // 4. Fill and submit protected order
    await page.getByTestId("order-instrument-input").fill("BTC-USDT-SWAP");
    await page.getByTestId("order-side-select").selectOption("long");
    await page.getByTestId("order-size-input").fill("1");
    await page.getByTestId("order-entry-price-input").fill("50000");
    await page.getByTestId("order-stop-price-input").fill("48500");
    await page.getByTestId("submit-exchange-order-btn").click();

    // 5. Verify order placed with attached stop ID and shows in orders table
    await expect(page.getByTestId("exchange-orders-table")).toContainText("BTC-USDT-SWAP");
    await expect(page.getByTestId("exchange-orders-table")).toContainText("algo");

    // 6. Run position reconciliation
    await page.getByTestId("reconcile-positions-btn").click();
    await expect(page.getByTestId("reconciliation-status-badge")).toContainText("MATCHED");

    // 7. Test Emergency Flatten button
    await page.getByTestId("emergency-flatten-btn").click();

    // 8. Verify Audit Log contains broker actions
    const auditTable = page.getByTestId("audit-log-table");
    await expect(auditTable).toContainText(/broker\.submit_order|broker\.dms_heartbeat/);
  });
});
