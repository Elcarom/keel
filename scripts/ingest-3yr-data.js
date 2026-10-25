import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SystemClock, TIMEFRAME_DURATION_MS } from "../packages/core/dist/index.js";
import { createSqliteDataStore, OkxPublicIngestor } from "../packages/data/dist/index.js";

const DB_PATH = join(process.cwd(), "data", "keel-empirical.sqlite");
const store = createSqliteDataStore({
  dbPath: DB_PATH,
  clock: new SystemClock()
});

const marketDataRepo = store.marketDataRepo;

const FROM_OPEN_TS = 1672531200000; // 2023-01-01 00:00:00 UTC
const TO_OPEN_TS = 1767222000000; // 2025-12-31 23:00:00 UTC (last 1H bar of 2025)
const EXPECTED_BARS = (TO_OPEN_TS - FROM_OPEN_TS) / 3600000 + 1; // 26,304 bars

console.log(
  `Starting multi-year data ingestion: 2023-01-01 to 2025-12-31 UTC (${EXPECTED_BARS} bars per instrument)`
);

const ingestor = new OkxPublicIngestor({
  marketDataRepo,
  requestDelayMs: 60 // ~16 requests/sec, well within OKX 20 req/2s rate limit
});

async function run() {
  for (const instrumentId of ["BTC-USDT-SWAP", "ETH-USDT-SWAP"]) {
    console.log(`\n--- Ingesting 1H bars for ${instrumentId} ---`);
    const t0 = Date.now();
    const res = await ingestor.ingestRange({
      instrumentId,
      timeframe: "1H",
      fromOpenTs: FROM_OPEN_TS,
      toOpenTs: TO_OPEN_TS
    });
    console.log(
      `Completed ${instrumentId}: inserted ${res.insertedCount} bars in ${((Date.now() - t0) / 1000).toFixed(1)}s`
    );

    // Verify zero missing intervals
    const gaps = marketDataRepo.detectGaps({
      instrumentId,
      timeframe: "1H",
      fromOpenTs: FROM_OPEN_TS,
      toOpenTs: TO_OPEN_TS
    });
    console.log(`Gap verification for ${instrumentId}: ${gaps.length} gaps detected.`);
    if (gaps.length > 0) {
      console.error("Detected gaps:", gaps);
      throw new Error(`Data integrity failure: ${gaps.length} gaps detected in ${instrumentId}`);
    }

    // Ingest real 8-hour settled funding rates across the 3 years via OKX public API
    console.log(`Populating 8H settled funding rates for ${instrumentId}...`);
    const dt8H = 8 * 3600 * 1000;
    const startFundingTs = FROM_OPEN_TS + dt8H;
    const endFundingTs = TO_OPEN_TS + 3600000;
    const insertedFunding = await ingestor.ingestFundingRates({
      instrumentId,
      fromFundingTs: startFundingTs,
      toFundingTs: endFundingTs
    });
    console.log(`Persisted ${insertedFunding} funding records for ${instrumentId}`);

    // Verify funding coverage and continuity
    const fundingGaps = marketDataRepo.detectFundingGaps({
      instrumentId,
      fromFundingTs: startFundingTs,
      toFundingTs: endFundingTs
    });
    console.log(
      `Funding gap verification for ${instrumentId}: ${fundingGaps.length} gaps detected.`
    );
    if (fundingGaps.length > 0) {
      console.error("Detected funding gaps:", fundingGaps);
      throw new Error(
        `Funding data integrity failure: ${fundingGaps.length} gaps detected in ${instrumentId}`
      );
    }
  }

  // Compute coverage metadata
  const coverage = marketDataRepo.listInstrumentsWithCoverage();
  console.log("\nDatabase Coverage Summary:");
  console.table(
    coverage.map((c) => ({
      instrumentId: c.instrumentId,
      bars1H: c.barCounts["1H"],
      fundingCount: c.fundingCount,
      earliest: new Date(c.earliestOpenTs).toISOString(),
      latest: new Date(c.latestCloseTs).toISOString()
    }))
  );

  store.close();
  console.log("\nData ingestion successfully completed and verified!");
}

run().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
