import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock, createDefaultConfig } from "@keel/core";
import { createSqliteDataStore } from "@keel/data";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKeelServer } from "../src/index.js";

describe("M7 Promotion Ladder, Human Gates G2/G3, & Demotion Auto-Flattening (ADR-0007)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "keel-promo-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("enforces step-up authentication for G2 (Demo, Live-Ramp) and G3 (Live) and rejects unvetted promotions", async () => {
    const clock = new ManualClock(1_730_000_000_000);
    const config = createDefaultConfig();
    const dataStore = createSqliteDataStore({
      dbPath: ":memory:",
      clock,
      initialConfig: config
    });

    let bootstrapToken = "";
    const app = await createKeelServer({
      config,
      clock,
      dataStore,
      onBootstrapToken: (t) => {
        bootstrapToken = t;
      }
    });

    // 1. Bootstrap operator
    const bootRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/bootstrap",
      headers: {
        "cf-connecting-ip": "203.0.113.42",
        "x-forwarded-proto": "https"
      },
      payload: {
        bootstrapToken,
        username: "captain",
        password: "correct-horse-battery-staple"
      }
    });
    expect(bootRes.statusCode).toBe(200);
    const setCookie = String(bootRes.headers["set-cookie"] ?? "");
    const cookieHeader = setCookie.split(";")[0] ?? "";

    // 2. Attempt promoting without prior evaluation -> 400
    const unvettedRes = await app.inject({
      method: "POST",
      url: "/api/v1/promotion/promote",
      headers: { cookie: cookieHeader },
      payload: {
        strategyId: "donchian-trend",
        targetStage: "Live-Ramp",
        stepUpPassword: "correct-horse-battery-staple"
      }
    });
    expect(unvettedRes.statusCode).toBe(400);

    // 3. Seed an experiment and promotion record where strategy passed replay gate and is eligible for Paper -> Demo
    dataStore.promotionRepo.upsertPromotion({
      strategyId: "donchian-trend",
      currentStage: "Paper",
      latestExperimentId: "exp-1",
      replayGatePassed: true,
      paperTradesCount: 25,
      paperDrawdownPct: 1.5,
      rampAllocationPct: 100,
      eligibleNextStage: "Demo",
      demotionReason: null,
      updatedAtMs: clock.nowMs()
    });

    // 4. Attempt promoting to Demo (Gate G2) without password -> 403 step-up required
    const noPassRes = await app.inject({
      method: "POST",
      url: "/api/v1/promotion/promote",
      headers: { cookie: cookieHeader },
      payload: {
        strategyId: "donchian-trend",
        targetStage: "Demo"
      }
    });
    expect(noPassRes.statusCode).toBe(403);

    // 5. Promote to Demo with correct step-up password -> 200
    const demoPromoRes = await app.inject({
      method: "POST",
      url: "/api/v1/promotion/promote",
      headers: { cookie: cookieHeader },
      payload: {
        strategyId: "donchian-trend",
        targetStage: "Demo",
        stepUpPassword: "correct-horse-battery-staple"
      }
    });
    expect(demoPromoRes.statusCode).toBe(200);
    const promoBody = demoPromoRes.json() as {
      promotion: { currentStage: string; eligibleNextStage: string };
    };
    expect(promoBody.promotion.currentStage).toBe("Demo");
    expect(promoBody.promotion.eligibleNextStage).toBe("Live-Ramp");

    await app.close();
  });

  it("automatically flattens positions and emits alerts when evaluation detects drawdown demotion breach", async () => {
    const clock = new ManualClock(1_730_000_000_000);
    const config = createDefaultConfig();
    const dataStore = createSqliteDataStore({
      dbPath: ":memory:",
      clock,
      initialConfig: config
    });

    let bootstrapToken = "";
    const app = await createKeelServer({
      config,
      clock,
      dataStore,
      onBootstrapToken: (t) => {
        bootstrapToken = t;
      }
    });

    // Bootstrap operator
    const bootRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/bootstrap",
      headers: {
        "cf-connecting-ip": "203.0.113.42",
        "x-forwarded-proto": "https"
      },
      payload: {
        bootstrapToken,
        username: "captain",
        password: "correct-horse-battery-staple"
      }
    });
    expect(bootRes.statusCode).toBe(200);
    const setCookie = String(bootRes.headers["set-cookie"] ?? "");
    const cookieHeader = setCookie.split(";")[0] ?? "";

    // Seed strategy in Live-Ramp with drawdown breaching 3% threshold
    dataStore.promotionRepo.upsertPromotion({
      strategyId: "donchian-trend",
      currentStage: "Live-Ramp",
      latestExperimentId: "exp-1",
      replayGatePassed: true,
      paperTradesCount: 30,
      paperDrawdownPct: 4.2, // > 3.0% threshold
      rampAllocationPct: 25,
      eligibleNextStage: "Live",
      demotionReason: null,
      updatedAtMs: clock.nowMs()
    });

    // Evaluate promotion ladder -> triggers automatic demotion to Demo & auto-flattening
    const evalRes = await app.inject({
      method: "POST",
      url: "/api/v1/promotion/evaluate",
      headers: { cookie: cookieHeader },
      payload: {
        strategyId: "donchian-trend"
      }
    });

    expect(evalRes.statusCode).toBe(200);
    const evalBody = evalRes.json() as {
      promotion: { currentStage: string; demotionReason: string | null };
    };
    expect(evalBody.promotion.currentStage).toBe("Demo");
    expect(evalBody.promotion.demotionReason).toContain("exceeded 3% limit");

    await app.close();
  });
});
