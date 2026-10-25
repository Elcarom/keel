import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock, TIMEFRAME_DURATION_MS } from "@keel/core";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OkxPublicIngestor,
  createSqliteDataStore,
  seedSyntheticMarketSeries,
  type SqliteDataStore
} from "../src/index.js";

describe("M2-1 — ConfirmedMarketStore, confirm==='1' Gate, Gap Healer, Lookback Assertion, & DataSnapshotId", () => {
  let tempDir: string;
  let clock: ManualClock;
  let store: SqliteDataStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "keel-market-test-"));
    clock = new ManualClock(1_730_000_000_000);
    store = createSqliteDataStore({
      dbPath: join(tempDir, "keel.sqlite"),
      clock
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects forming bars (confirm !== '1') and strictly enforces closeTs <= asOfMs (no-lookahead property)", () => {
    const baseOpenTs = 1_730_000_000_000;
    const dt = TIMEFRAME_DURATION_MS["1H"];

    const res = store.marketDataRepo.ingestOkxCandles({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      candles: [
        {
          openTs: baseOpenTs,
          open: "65000.00",
          high: "65500.00",
          low: "64800.00",
          close: "65200.00",
          volumeContracts: "1200",
          volumeQuote: "78240000",
          confirm: "1"
        },
        {
          openTs: baseOpenTs + dt,
          open: "65200.00",
          high: "65900.00",
          low: "65100.00",
          close: "65750.00",
          volumeContracts: "1450",
          volumeQuote: "95337500",
          confirm: "1"
        },
        {
          // Forming (unconfirmed) bar must NEVER be stored
          openTs: baseOpenTs + 2 * dt,
          open: "65750.00",
          high: "66000.00",
          low: "65600.00",
          close: "65950.00",
          volumeContracts: "400",
          volumeQuote: "26380000",
          confirm: "0"
        }
      ]
    });

    expect(res.insertedCount).toBe(2);
    expect(res.skippedUnconfirmedCount).toBe(1);

    // Property test: for any arbitrary asOfMs, no returned bar ever has closeTs > asOfMs
    fc.assert(
      fc.property(fc.integer({ min: baseOpenTs - dt, max: baseOpenTs + 4 * dt }), (asOfMs) => {
        const bars = store.marketDataRepo.getConfirmedBarsAsOf({
          instrumentId: "BTC-USDT-SWAP",
          timeframe: "1H",
          asOfMs
        });
        return bars.every((b) => b.closeTs <= asOfMs && b.confirm === "1");
      }),
      { numRuns: 50 }
    );
  });

  it("detects missing bar gaps and heals them via OkxPublicIngestor", async () => {
    const baseOpenTs = 1_730_000_000_000;
    const dt = TIMEFRAME_DURATION_MS["15m"];

    // Insert bars 0, 1, and 5 (leaving 2, 3, 4 missing)
    store.marketDataRepo.ingestOkxCandles({
      instrumentId: "ETH-USDT-SWAP",
      timeframe: "15m",
      candles: [0, 1, 5].map((idx) => ({
        openTs: baseOpenTs + idx * dt,
        open: "2500.00",
        high: "2520.00",
        low: "2490.00",
        close: "2510.00",
        volumeContracts: "500",
        volumeQuote: "1255000",
        confirm: "1"
      }))
    });

    const gapsBefore = store.marketDataRepo.detectGaps({
      instrumentId: "ETH-USDT-SWAP",
      timeframe: "15m",
      fromOpenTs: baseOpenTs,
      toOpenTs: baseOpenTs + 5 * dt
    });
    expect(gapsBefore).toEqual([
      {
        instrumentId: "ETH-USDT-SWAP",
        timeframe: "15m",
        missingFromOpenTs: baseOpenTs + 2 * dt,
        missingToOpenTs: baseOpenTs + 4 * dt,
        missingBarCount: 3
      }
    ]);

    const ingestor = new OkxPublicIngestor({
      marketDataRepo: store.marketDataRepo,
      fetchHistoryCandles: async ({ fromOpenTs, toOpenTs }) => {
        const out = [];
        for (let t = fromOpenTs; t <= toOpenTs; t += dt) {
          out.push({
            openTs: t,
            open: "2510.00",
            high: "2530.00",
            low: "2500.00",
            close: "2520.00",
            volumeContracts: "600",
            volumeQuote: "1512000",
            confirm: "1"
          });
        }
        return out;
      }
    });

    const healedCount = await ingestor.healGaps({
      instrumentId: "ETH-USDT-SWAP",
      timeframe: "15m",
      fromOpenTs: baseOpenTs,
      toOpenTs: baseOpenTs + 5 * dt
    });
    expect(healedCount).toBe(3);

    const gapsAfter = store.marketDataRepo.detectGaps({
      instrumentId: "ETH-USDT-SWAP",
      timeframe: "15m",
      fromOpenTs: baseOpenTs,
      toOpenTs: baseOpenTs + 5 * dt
    });
    expect(gapsAfter).toHaveLength(0);
  });

  it("enforces LookbackRequirement assertions and computes deterministic DataSnapshotId", () => {
    const endMs = 1_730_000_000_000;
    const snapshotMeta = seedSyntheticMarketSeries({
      marketDataRepo: store.marketDataRepo,
      instrumentId: "BTC-USDT-SWAP",
      endCloseTs: endMs,
      barCount1H: 240
    });

    expect(snapshotMeta.snapshotId).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshotMeta.barCount).toBeGreaterThan(240);
    expect(snapshotMeta.fundingCount).toBeGreaterThan(0);

    // Satisfied lookback (e.g. 60 1H bars and 20 4H bars)
    const validCheck = store.marketDataRepo.assertLookbackSatisfied({
      instrumentId: "BTC-USDT-SWAP",
      asOfMs: endMs,
      requirements: { "1H": 60, "4H": 20 }
    });
    expect(validCheck.satisfied).toBe(true);
    expect(validCheck.deficits).toHaveLength(0);

    // Unsatisfied lookback (requiring 360 1D bars when only 10 days seeded)
    const deficitCheck = store.marketDataRepo.assertLookbackSatisfied({
      instrumentId: "BTC-USDT-SWAP",
      asOfMs: endMs,
      requirements: { "1D": 360 }
    });
    expect(deficitCheck.satisfied).toBe(false);
    expect(deficitCheck.deficits[0]?.timeframe).toBe("1D");
    expect(deficitCheck.deficits[0]?.requiredBars).toBe(360);

    // Recomputing DataSnapshotMetadata produces the exact same content hash
    const recomputed = store.marketDataRepo.computeDataSnapshot({
      instrumentIds: ["BTC-USDT-SWAP"],
      fromTs: snapshotMeta.fromTs,
      toTs: snapshotMeta.toTs
    });
    expect(recomputed.snapshotId).toBe(snapshotMeta.snapshotId);
  });

  it("ingests full date ranges and funding rates via OkxPublicIngestor with mock fetch", async () => {
    const dt1H = TIMEFRAME_DURATION_MS["1H"];
    const dt8H = 8 * dt1H;
    const baseOpenTs = Math.floor(1_700_000_000_000 / dt8H) * dt8H;
    const barCount = 150; // Needs 2 pages of 100 limit

    // Mock fetch that responds to OKX history-candles and funding-rate-history
    const mockFetch: typeof fetch = async (input) => {
      const urlStr = String(input);
      const parsedUrl = new URL(urlStr);

      if (parsedUrl.pathname === "/api/v5/market/history-candles") {
        const afterParam = parsedUrl.searchParams.get("after");
        const cursorMs = afterParam ? Number(afterParam) : baseOpenTs + barCount * dt1H;
        // Generate up to 100 bars backwards from cursorMs - dt1H
        const data: string[][] = [];
        for (let i = 0; i < 100; i++) {
          const barOpenTs = cursorMs - (i + 1) * dt1H;
          if (barOpenTs < baseOpenTs) break;
          data.push([
            String(barOpenTs),
            "60000.0",
            "60500.0",
            "59500.0",
            "60200.0",
            "100.0",
            "1.0",
            "6020000.0",
            "1"
          ]);
        }
        return new Response(JSON.stringify({ code: "0", data, msg: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (parsedUrl.pathname === "/api/v5/public/funding-rate-history") {
        const afterParam = parsedUrl.searchParams.get("after");
        const cursorMs = afterParam
          ? Number(afterParam)
          : Math.floor((baseOpenTs + barCount * dt1H) / dt8H) * dt8H + dt8H;
        const latestAlignedFunding = Math.floor((cursorMs - 1) / dt8H) * dt8H;
        const data = [];
        for (let i = 0; i < 20; i++) {
          const fundingTime = latestAlignedFunding - i * dt8H;
          if (fundingTime < baseOpenTs) break;
          data.push({
            instId: "BTC-USDT-SWAP",
            instType: "SWAP",
            fundingTime: String(fundingTime),
            fundingRate: "0.0001",
            realizedRate: "0.0001",
            method: "current_period",
            formulaType: "withRate"
          });
        }
        return new Response(JSON.stringify({ code: "0", data, msg: "" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      return new Response("Not found", { status: 404 });
    };

    const ingestor = new OkxPublicIngestor({
      marketDataRepo: store.marketDataRepo,
      fetchFn: mockFetch
    });

    const candleRes = await ingestor.ingestRange({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      fromOpenTs: baseOpenTs,
      toOpenTs: baseOpenTs + (barCount - 1) * dt1H
    });

    expect(candleRes.insertedCount).toBe(barCount);
    expect(candleRes.gapsDetected).toBe(1);

    // Re-ingesting range detects 0 gaps
    const reingestRes = await ingestor.ingestRange({
      instrumentId: "BTC-USDT-SWAP",
      timeframe: "1H",
      fromOpenTs: baseOpenTs,
      toOpenTs: baseOpenTs + (barCount - 1) * dt1H
    });
    expect(reingestRes.insertedCount).toBe(0);
    expect(reingestRes.gapsDetected).toBe(0);

    // Ingest funding rates
    const fundingInserted = await ingestor.ingestFundingRates({
      instrumentId: "BTC-USDT-SWAP",
      fromFundingTs: baseOpenTs,
      toFundingTs: baseOpenTs + (barCount - 1) * dt1H
    });
    expect(fundingInserted).toBeGreaterThan(0);

    // Verify detectFundingGaps reports 0 gaps when coverage is complete
    const fundingGaps = store.marketDataRepo.detectFundingGaps({
      instrumentId: "BTC-USDT-SWAP",
      fromFundingTs: baseOpenTs + 8 * dt1H,
      toFundingTs: baseOpenTs + 24 * dt1H
    });
    expect(fundingGaps).toHaveLength(0);

    // Verify detectFundingGaps reports missing intervals if unpopulated
    const missingGaps = store.marketDataRepo.detectFundingGaps({
      instrumentId: "ETH-USDT-SWAP",
      fromFundingTs: baseOpenTs,
      toFundingTs: baseOpenTs + 24 * dt1H
    });
    expect(missingGaps.length).toBeGreaterThanOrEqual(1);
  });
});
