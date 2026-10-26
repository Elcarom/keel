import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock, createDefaultConfig } from "@keel/core";
import { createSqliteDataStore } from "@keel/data";
import { DONCHIAN_TREND_V1_SPEC, SYNTHETIC_DONCHIAN_FIXTURE_SPEC } from "@keel/spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKeelServer } from "../src/index.js";

describe("T6: Strategy Spec API & Promotion Quarantine (ADR-0020, ADR-0021)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "keel-spec-api-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function setupApp() {
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

    return { app, dataStore, cookieHeader, clock };
  }

  it("POST /api/v1/specs registers valid spec, increments trials, and serves via GET", async () => {
    const { app, dataStore, cookieHeader } = await setupApp();

    expect(dataStore.experimentRepo.getTrialCount()).toBe(0);

    // 1. Unauthenticated -> 401
    const unauth = await app.inject({
      method: "POST",
      url: "/api/v1/specs",
      payload: DONCHIAN_TREND_V1_SPEC
    });
    expect(unauth.statusCode).toBe(401);

    // 2. Invalid spec -> 400
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/specs",
      headers: {
        cookie: cookieHeader,
        "cf-connecting-ip": "203.0.113.42",
        "x-forwarded-proto": "https"
      },
      payload: { name: "invalid-spec", version: 99 }
    });
    expect(invalid.statusCode).toBe(400);

    // 3. Register valid DONCHIAN_TREND_V1_SPEC -> 200
    const regRes = await app.inject({
      method: "POST",
      url: "/api/v1/specs",
      headers: {
        cookie: cookieHeader,
        "cf-connecting-ip": "203.0.113.42",
        "x-forwarded-proto": "https"
      },
      payload: DONCHIAN_TREND_V1_SPEC
    });
    expect(regRes.statusCode).toBe(200);
    const regJson = regRes.json();
    expect(regJson.name).toBe("donchian-trend-v1");
    expect(regJson.version).toBe(1);
    expect(regJson.isSynthetic).toBe(false);
    expect(typeof regJson.specHash).toBe("string");
    expect(regJson.specHash).toHaveLength(64);

    // Research trial count automatically incremented!
    expect(dataStore.experimentRepo.getTrialCount()).toBe(1);

    // 4. List specs -> 200
    const listRes = await app.inject({
      method: "GET",
      url: "/api/v1/specs",
      headers: {
        cookie: cookieHeader,
        "cf-connecting-ip": "203.0.113.42",
        "x-forwarded-proto": "https"
      }
    });
    expect(listRes.statusCode).toBe(200);
    const listJson = listRes.json();
    expect(listJson.specs).toHaveLength(1);
    expect(listJson.specs[0].specHash).toBe(regJson.specHash);

    // 5. Get by hash -> 200
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/specs/${regJson.specHash}`,
      headers: {
        cookie: cookieHeader,
        "cf-connecting-ip": "203.0.113.42",
        "x-forwarded-proto": "https"
      }
    });
    expect(getRes.statusCode).toBe(200);
    const getJson = getRes.json();
    expect(getJson.specHash).toBe(regJson.specHash);
    expect(getJson.descriptionText).toContain("donchian-trend-v1");
    expect(getJson.descriptionText).toContain("Donchian");
  });

  it("strictly rejects promotion of synthetic/quarantined specs to Demo or Live with 403 (ADR-0021)", async () => {
    const { app, dataStore, cookieHeader, clock } = await setupApp();

    // Register synthetic fixture spec
    const regRes = await app.inject({
      method: "POST",
      url: "/api/v1/specs",
      headers: {
        cookie: cookieHeader,
        "cf-connecting-ip": "203.0.113.42",
        "x-forwarded-proto": "https"
      },
      payload: SYNTHETIC_DONCHIAN_FIXTURE_SPEC
    });
    expect(regRes.statusCode).toBe(200);
    expect(regRes.json().isSynthetic).toBe(true);

    // Seed a promotion record for synthetic strategy
    dataStore.promotionRepo.upsertPromotion({
      strategyId: "synthetic-donchian-fixture",
      currentStage: "Paper",
      latestExperimentId: "exp-synthetic-1",
      replayGatePassed: true,
      paperTradesCount: 150,
      paperDrawdownPct: 0.02,
      rampAllocationPct: 100,
      eligibleNextStage: "Demo",
      demotionReason: null,
      promotedAtMs: clock.nowMs() - 86_400_000 * 45,
      updatedAtMs: clock.nowMs()
    });

    // Attempt promoting to Demo (Gate G2) -> MUST be rejected with 403 Forbidden!
    const promoDemoRes = await app.inject({
      method: "POST",
      url: "/api/v1/promotion/promote",
      headers: {
        cookie: cookieHeader,
        "cf-connecting-ip": "203.0.113.42",
        "x-forwarded-proto": "https"
      },
      payload: {
        strategyId: "synthetic-donchian-fixture",
        targetStage: "Demo",
        stepUpPassword: "correct-horse-battery-staple"
      }
    });
    expect(promoDemoRes.statusCode).toBe(403);
    expect(promoDemoRes.json().error).toContain("synthetic/quarantined");

    // Attempt promoting to Live (Gate G3) -> MUST be rejected with 403 Forbidden!
    const promoLiveRes = await app.inject({
      method: "POST",
      url: "/api/v1/promotion/promote",
      headers: {
        cookie: cookieHeader,
        "cf-connecting-ip": "203.0.113.42",
        "x-forwarded-proto": "https"
      },
      payload: {
        strategyId: "synthetic-donchian-fixture",
        targetStage: "Live",
        stepUpPassword: "correct-horse-battery-staple"
      }
    });
    expect(promoLiveRes.statusCode).toBe(403);
    expect(promoLiveRes.json().error).toContain("synthetic/quarantined");
  });
});
