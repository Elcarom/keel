import { expect, test } from "@playwright/test";

test.describe("Keel Fleet — design, rank, launch and manage paper bots", () => {
  test("signs in to the Fleet, drafts ranked propositions, launches one and retires it", async ({
    page
  }) => {
    test.setTimeout(240_000);
    await page.goto("/");

    // Sign in (or bootstrap on a fresh database); the Fleet is home afterwards
    const bootstrapPanel = page.getByTestId("bootstrap-panel");
    await expect(bootstrapPanel.or(page.getByTestId("login-panel"))).toBeVisible();
    if (await bootstrapPanel.isVisible()) {
      await page.getByTestId("bootstrap-token-input").fill("keel-e2e-bootstrap-token-2026");
    }
    await page.getByTestId("bootstrap-username-input").fill("captain");
    await page.getByTestId("bootstrap-password-input").fill("correct-horse-battery-staple");
    await page.getByTestId("bootstrap-submit-btn").click();
    await expect(page.getByTestId("fleet-app")).toBeVisible();

    // Shipyard: a guided brief; simulated AI drafts sample propositions
    await page.getByTestId("tab-shipyard").click();
    await expect(page.getByTestId("designer-source")).toContainText("sample mode");
    await page.getByTestId("style-breakout").click();
    await page.getByTestId("style-mean_reversion").click();
    await page.getByTestId("brief-notes").fill("something steady for the e2e run");
    await page.getByTestId("design-submit-btn").click();

    const batch = page.getByTestId("design-batch").first();
    await expect(batch).toBeVisible();
    // Every proposition is backtested and scored before it can be launched
    await expect(batch.getByTestId("proposition-assessing")).toHaveCount(0, { timeout: 200_000 });
    const scores = batch.getByTestId("proposition-score");
    await expect(scores.first()).toBeVisible();
    await expect(batch.getByText("Flagship pick")).toBeVisible();

    // Launch the flagship onto paper trading; live trading is offered but disabled
    await batch.getByTestId("launch-btn").first().click();
    const form = page.getByTestId("launch-form");
    await expect(form.getByText("not in this prototype")).toBeVisible();
    await form.getByTestId("launch-name").fill("E2E Voyager");
    await form.getByTestId("launch-allocation").fill("1500");
    await form.getByTestId("launch-submit-btn").click();
    await expect(page.getByTestId("launch-success-banner")).toContainText("E2E Voyager");

    // Fleet: the bot is at sea on paper with its stake
    await page.getByTestId("tab-fleet").click();
    const botCard = page.getByTestId("bot-card").filter({ hasText: "E2E Voyager" });
    await expect(botCard).toBeVisible();
    await expect(botCard).toContainText("At sea");
    await expect(botCard).toContainText("Paper");

    // Return to harbour, set sail again, then retire
    await botCard.getByTestId("bot-pause-btn").click();
    await expect(botCard).toContainText("In harbour");
    await botCard.getByTestId("bot-resume-btn").click();
    await expect(botCard).toContainText("At sea");
    page.once("dialog", (d) => void d.accept());
    await botCard.getByTestId("bot-retire-btn").click();
    await expect(page.getByText("E2E Voyager has retired.")).toBeVisible();

    // The Engine Room is still one click away
    await page.getByTestId("open-engine-room").click();
    await expect(page.getByTestId("back-to-fleet")).toBeVisible();
  });
});
