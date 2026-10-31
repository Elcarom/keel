import { expect, test } from "@playwright/test";

test.describe("Keel — Engine Room smoke test", () => {
  test("serves the Keel shell and asks the captain to sign in or set up", async ({ page }) => {
    await page.goto("/#/engine-room");

    await expect(page).toHaveTitle(/Keel/);
    await expect(page.getByRole("heading", { name: "Keel" })).toBeVisible();
    await expect(
      page.getByTestId("bootstrap-panel").or(page.getByTestId("login-panel"))
    ).toBeVisible();
  });
});
