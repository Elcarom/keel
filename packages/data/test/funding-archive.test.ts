import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { ManualClock } from "@keel/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OkxPublicIngestor,
  createSqliteDataStore,
  readOkxFundingArchive,
  type SqliteDataStore
} from "../src/index.js";
import { plainDecimal } from "../src/okx-archive.js";

const EIGHT_HOURS = 8 * 3600_000;
// 2023-11-01 00:00 UTC, an 8h settlement boundary
const NOV_2023 = 1_698_796_800_000;

/** A one-file zip archive, the way OKX ships its monthly funding CSVs. */
function zipOf(name: string, text: string, deflate = true): Uint8Array {
  const raw = Buffer.from(text, "utf8");
  const body = deflate ? deflateRawSync(raw) : raw;
  const fileName = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(deflate ? 8 : 0, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(deflate ? 8 : 0, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt32LE(0, 42);
  const centralOffset = local.length + fileName.length + body.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + fileName.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, fileName, body, central, fileName, eocd]);
}

function monthCsv(fromTs: number, count: number): string {
  const rows = ["instrument_name,funding_rate,funding_time"];
  for (let i = 0; i < count; i++) {
    rows.push(`BTC-USDT-SWAP,0.0000${String(100 + i)},${String(fromTs + i * EIGHT_HOURS)} `);
  }
  return rows.join("\n");
}

describe("OKX funding archive", () => {
  let tempDir: string;
  let store: SqliteDataStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "keel-funding-archive-"));
    store = createSqliteDataStore({
      dbPath: join(tempDir, "keel.sqlite"),
      clock: new ManualClock(1_790_000_000_000)
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads settled rates from a monthly archive, deflated or stored", () => {
    for (const deflate of [true, false]) {
      const rates = readOkxFundingArchive(
        zipOf("BTC-USDT-SWAP-fundingrates-2023-11.csv", monthCsv(NOV_2023, 3), deflate),
        "BTC-USDT-SWAP"
      );
      expect(rates).toEqual([
        {
          instrumentId: "BTC-USDT-SWAP",
          fundingTs: NOV_2023,
          fundingRate: "0.0000100",
          realizedRate: "0.0000100"
        },
        {
          instrumentId: "BTC-USDT-SWAP",
          fundingTs: NOV_2023 + EIGHT_HOURS,
          fundingRate: "0.0000101",
          realizedRate: "0.0000101"
        },
        {
          instrumentId: "BTC-USDT-SWAP",
          fundingTs: NOV_2023 + 2 * EIGHT_HOURS,
          fundingRate: "0.0000102",
          realizedRate: "0.0000102"
        }
      ]);
    }
  });

  it("rewrites the archive's exponent notation as plain decimals", () => {
    expect(plainDecimal("-8.041148799E-7")).toBe("-0.0000008041148799");
    expect(plainDecimal("1.5e-4")).toBe("0.00015");
    expect(plainDecimal("2.5E+2")).toBe("250");
    expect(plainDecimal("0.0001584810327976")).toBe("0.0001584810327976");
    expect(plainDecimal("-0E-8")).toBe("0");
  });

  it("fills funding older than the history endpoint from the archive, once", async () => {
    const requested: string[] = [];
    const archiveUrl = "https://static.okx.com/cdn/okex/traderecords/swaprates/monthly/x.zip";
    const mockFetch: typeof fetch = (input) => {
      const url = new URL(String(input));
      requested.push(url.pathname);
      if (url.pathname === "/api/v5/public/funding-rate-history") {
        // Like the real endpoint, nothing older than about three months
        return Promise.resolve(Response.json({ code: "0", data: [], msg: "" }));
      }
      if (url.pathname === "/api/v5/public/market-data-history") {
        expect(url.searchParams.get("instFamilyList")).toBe("BTC-USDT");
        return Promise.resolve(
          Response.json({
            code: "0",
            msg: "",
            data: [{ details: [{ groupDetails: [{ url: archiveUrl }] }] }]
          })
        );
      }
      if (String(input) === archiveUrl) {
        const zip = zipOf("BTC-USDT-SWAP-fundingrates-2023-11.csv", monthCsv(NOV_2023, 90));
        return Promise.resolve(new Response(zip));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    const ingestor = new OkxPublicIngestor({
      marketDataRepo: store.marketDataRepo,
      fetchFn: mockFetch
    });
    const window = {
      instrumentId: "BTC-USDT-SWAP",
      fromFundingTs: NOV_2023,
      toFundingTs: NOV_2023 + 29 * EIGHT_HOURS
    };

    expect(await ingestor.ingestFundingRates(window)).toBe(30);
    const stored = store.marketDataRepo.getSettledFundingInRange({
      instrumentId: "BTC-USDT-SWAP",
      fromTs: window.fromFundingTs,
      toTs: window.toFundingTs
    });
    expect(stored).toHaveLength(30);
    expect(store.marketDataRepo.detectFundingGaps(window)).toEqual([]);

    requested.length = 0;
    await ingestor.ingestFundingRates(window);
    expect(requested).toEqual(["/api/v5/public/funding-rate-history"]);
  });
});
