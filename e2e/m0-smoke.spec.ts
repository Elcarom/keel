import { expect, test } from "@playwright/test";

test.describe("Keel M0 — End-to-End Dashboard & Health Smoke Test", () => {
  test("renders the Keel brand shell, PAPER execution mode badge, config hash, and live heartbeat", async ({
    page
  }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Keel" })).toBeVisible();
    await expect(page.getByTestId("execution-mode-badge")).toContainText("Paper");
    await expect(page.getByTestId("heartbeat-indicator")).toContainText("HEARTBEAT OK");
    await expect(page.getByTestId("paper-equity-display")).toContainText("10,000.00 USDT");

    const hashText = await page.getByTestId("config-hash-display").textContent();
    expect(hashText?.trim()).toMatch(/^[a-f0-9]{16}$/);

    // Verify theme toggle switches between Night Watch (dark) and Chart Paper (light)
    const toggleBtn = page.getByRole("button", { name: /Chart Paper \(Light\)/i });
    await expect(toggleBtn).toBeVisible();
    await toggleBtn.click();
    await expect(page.getByRole("button", { name: /Night Watch \(Dark\)/i })).toBeVisible();
  });
});
