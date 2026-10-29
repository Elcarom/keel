import { expect, test } from "@playwright/test";

test.describe("Keel Fleet — design, rank, launch and manage paper boats", () => {
  test("signs in to the Fleet, drafts ranked propositions, launches one and retires it", async ({
    page
  }) => {
    // A fresh database downloads two years of history before the first sea trials
    test.setTimeout(480_000);
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
    // Without a key the Shipyard opens on Inventor via your chat; switch to Blueprints
    await expect(page.getByTestId("designer-source")).toContainText("your own Claude chat");
    await page.getByTestId("mode-blueprint").click();
    await expect(page.getByTestId("designer-source")).toContainText("sample mode");
    await page.getByTestId("brief-styles-toggle").click();
    await page.getByTestId("style-breakout").click();
    await page.getByTestId("style-mean_reversion").click();
    await page.getByTestId("brief-notes").fill("something steady for the e2e run");
    await page.getByTestId("design-submit-btn").click();

    const batch = page.getByTestId("design-batch").first();
    await expect(batch).toBeVisible();
    // Every proposition is backtested and scored before it can be launched
    await expect(batch.getByTestId("proposition-assessing")).toHaveCount(0, { timeout: 420_000 });
    const scores = batch.getByTestId("proposition-score");
    await expect(scores.first()).toBeVisible();
    await expect(batch.getByText("Flagship pick")).toBeVisible();

    // The flagship's sea trial shows every check behind its rank
    const flagship = batch.getByTestId("proposition-card").first();
    await expect(flagship.getByTestId("sea-trial-summary")).toContainText("of 11 checks");
    await flagship.getByTestId("sea-trial-toggle").click();
    await expect(flagship.locator('[data-testid^="check-"]')).toHaveCount(11);
    await expect(flagship.getByTestId("check-robust_parameters")).toContainText("nudged versions");

    // Launch the flagship onto paper trading; live trading is offered but disabled
    await batch.getByTestId("launch-btn").first().click();
    const form = page.getByTestId("launch-form");
    await expect(form.getByText("not in this prototype")).toBeVisible();
    await form.getByTestId("launch-name").fill("E2E Voyager");
    await form.getByTestId("launch-allocation").fill("1500");
    await form.getByTestId("launch-submit-btn").click();
    await expect(page.getByTestId("launch-success-banner")).toContainText("E2E Voyager");

    // The launched proposition leaves the slipway and is filed with the set-aside ones
    await expect(page.getByText("Launched into the fleet")).toHaveCount(0);
    await page.getByTestId("show-filed-propositions").click();
    await expect(page.getByText("Launched into the fleet")).toBeVisible();

    // Fleet: the boat is at sea on paper with its stake
    await page.getByTestId("tab-fleet").click();
    const botCard = page.getByTestId("bot-card").filter({ hasText: "E2E Voyager" });
    await expect(botCard).toBeVisible();
    await expect(botCard).toContainText("At sea");
    await expect(botCard).toContainText("Paper");
    await expect(botCard.getByTestId("boat-health")).toContainText("New");

    // Its own page: the sea trial it passed, and the way back
    await botCard.getByTestId("open-boat-btn").click();
    const boatPage = page.getByTestId("boat-page");
    await expect(boatPage).toContainText("E2E Voyager");
    await expect(boatPage).toContainText("The sea trial it passed");
    await page.getByText("← Back to the fleet").click();

    // The table view lists the same boat; the Logbook shows the unattended duties
    await page.getByTestId("view-table").click();
    await expect(page.getByTestId("fleet-table")).toContainText("E2E Voyager");
    await page.getByTestId("view-cards").click();
    await page.getByTestId("tab-logbook").click();
    await expect(page.getByTestId("duties-panel")).toContainText("Drift watch");
    await page.getByTestId("tab-fleet").click();

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

  test("hands the Inventor prompt to the operator's own Claude chat and imports its answer", async ({
    page
  }) => {
    test.setTimeout(480_000);
    await page.goto("/");
    const bootstrapPanel = page.getByTestId("bootstrap-panel");
    await expect(bootstrapPanel.or(page.getByTestId("login-panel"))).toBeVisible();
    if (await bootstrapPanel.isVisible()) {
      await page.getByTestId("bootstrap-token-input").fill("keel-e2e-bootstrap-token-2026");
    }
    await page.getByTestId("bootstrap-username-input").fill("captain");
    await page.getByTestId("bootstrap-password-input").fill("correct-horse-battery-staple");
    await page.getByTestId("bootstrap-submit-btn").click();
    await page.getByTestId("tab-shipyard").click();

    // Step 1: Keel writes the prompt for the brief
    await page.getByTestId("mode-import").click();
    await expect(page.getByTestId("designer-source")).toContainText("your own Claude chat");
    await page.getByTestId("import-count-10").click();
    await page.getByTestId("brief-notes").fill("session handovers");
    await page.getByTestId("get-inventor-prompt-btn").click();
    await expect(page.getByTestId("inventor-prompt")).toHaveValue(/I want 10 brand-new/);
    await expect(page.getByTestId("inventor-prompt")).toHaveValue(/session handovers/);

    // Step 2: the chat's reply comes back; the broken invention returns with a repair message
    const rule = (op: string, value: number) => ({
      type: "comparison",
      op,
      left: { type: "indicator", id: "heat", output: "rsi" },
      right: { type: "constant", value }
    });
    const invention = {
      name: "Harbour Bell",
      tagline: "Answers the bell when the fast RSI swings too far.",
      rationale: "Sharp hourly extremes revert. It fails in strong trends.",
      instrumentId: "BTC-USDT-SWAP",
      direction: "both",
      indicators: [{ id: "heat", kind: "rsi", period: 7 }],
      longEntry: rule("<", 25),
      shortEntry: rule(">", 75),
      stopAtrMultiple: 2,
      rewardMultiple: 1.5
    };
    const broken = { ...invention, name: "Bilge Pump", longEntry: rule("<", 25), indicators: [] };
    await page
      .getByTestId("import-text")
      .fill("```json\n" + JSON.stringify({ propositions: [invention, broken] }) + "\n```");
    await page.getByTestId("import-submit-btn").click();
    await expect(page.getByTestId("import-success-banner")).toContainText("1 invention is");
    await expect(page.getByTestId("import-rejections")).toContainText("Bilge Pump");
    await expect(page.getByTestId("repair-prompt")).toHaveValue(/Keel rejected 1 of your/);

    const batch = page.getByTestId("design-batch").first();
    await expect(batch).toContainText("imported from your Claude chat");
    await expect(batch.getByText("✦ Invented in your Claude chat")).toBeVisible();
    await expect(batch.getByTestId("proposition-assessing")).toHaveCount(0, { timeout: 420_000 });
    await expect(batch.getByTestId("sea-trial-summary")).toContainText("of 11 checks");
  });
});
