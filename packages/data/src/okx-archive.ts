import { inflateRawSync } from "node:zlib";
import type { SettledFundingRate } from "@keel/core";

/**
 * OKX's funding-rate-history endpoint only reaches back about three months. Older settled
 * rates come from OKX's own monthly archive: a listing endpoint names one zip per month, each
 * holding a CSV of `instrument_name,funding_rate,funding_time`.
 */

/** OKX refuses archive listings spanning more than 10 months. */
const ARCHIVE_LISTING_SPAN_MS = 270 * 24 * 3600 * 1000;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_ENTRY_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

/** The first file in a zip archive, through its central directory (stored or deflated). */
function firstZipEntry(zip: Uint8Array): Buffer {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip archive");
  const central = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(central) !== CENTRAL_ENTRY_SIGNATURE) {
    throw new Error("Zip central directory is malformed");
  }
  const method = buf.readUInt16LE(central + 10);
  const compressedSize = buf.readUInt32LE(central + 20);
  const local = buf.readUInt32LE(central + 42);
  if (buf.readUInt32LE(local) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error("Zip local header is malformed");
  }
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const body = buf.subarray(start, start + compressedSize);
  if (method === 0) return body;
  if (method === 8) return inflateRawSync(body);
  throw new Error(`Unsupported zip compression method ${method}`);
}

/** Rewrites exponent notation (`-8.041148799E-7`, which the archives use) as a plain decimal. */
export function plainDecimal(text: string): string {
  const m = /^([+-]?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(text.trim());
  if (!m) return text.trim();
  const [, sign = "", whole = "", frac = "", exp = "0"] = m;
  const digits = whole + frac;
  const point = whole.length + Number(exp);
  let out: string;
  if (point <= 0) out = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + "0".repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  out = out.replace(/^0+(?=\d)/, "");
  if (out.includes(".")) out = out.replace(/\.?0+$/, "");
  return `${sign === "-" && /[1-9]/.test(out) ? "-" : ""}${out}`;
}

/** Parses one OKX monthly funding archive into settled rates for `instrumentId`. */
export function readOkxFundingArchive(zip: Uint8Array, instrumentId: string): SettledFundingRate[] {
  const lines = firstZipEntry(zip).toString("utf8").split(/\r?\n/);
  const header = (lines[0] ?? "").split(",").map((h) => h.trim());
  const rateCol = header.indexOf("funding_rate");
  const timeCol = header.indexOf("funding_time");
  const instCol = header.indexOf("instrument_name");
  if (rateCol < 0 || timeCol < 0) throw new Error("Funding archive has no rate or time column");

  const rates: SettledFundingRate[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",").map((c) => c.trim());
    const rate = cells[rateCol] ? plainDecimal(cells[rateCol]) : undefined;
    const time = Number(cells[timeCol]);
    if (!rate || !Number.isFinite(time) || time <= 0) continue;
    if (instCol >= 0 && cells[instCol] !== instrumentId) continue;
    // The archive records the settled rate only, which is also what was realised
    rates.push({ instrumentId, fundingTs: time, fundingRate: rate, realizedRate: rate });
  }
  return rates;
}

/** Fetches through OKX's public rate limit, backing off on HTTP 429. */
async function fetchPolitely(fetchFn: typeof fetch, url: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(url);
    if (res.status !== 429 || attempt >= 4) return res;
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
}

/** Lists the archive zips covering [fromTs, toTs] and reads every one. */
export async function fetchOkxFundingArchive(input: {
  readonly instrumentId: string;
  readonly fromTs: number;
  readonly toTs: number;
  readonly fetchFn: typeof fetch;
}): Promise<SettledFundingRate[]> {
  const family = input.instrumentId.replace(/-SWAP$/, "");
  const urls = new Set<string>();
  for (let begin = input.fromTs; begin <= input.toTs; begin += ARCHIVE_LISTING_SPAN_MS) {
    const end = Math.min(input.toTs, begin + ARCHIVE_LISTING_SPAN_MS - 1);
    const url =
      `https://www.okx.com/api/v5/public/market-data-history?module=3&instType=SWAP` +
      `&instFamilyList=${encodeURIComponent(family)}&dateAggrType=monthly&begin=${begin}&end=${end}`;
    const res = await fetchPolitely(input.fetchFn, url);
    if (!res.ok) throw new Error(`OKX market-data-history HTTP ${res.status}`);
    const body = (await res.json()) as {
      code?: string;
      msg?: string;
      data?: Array<{ details?: Array<{ groupDetails?: Array<{ url?: string }> }> }>;
    };
    if (body.code !== undefined && body.code !== "0") {
      throw new Error(`OKX market-data-history ${body.code}: ${body.msg ?? ""}`);
    }
    for (const listing of body.data ?? []) {
      for (const detail of listing.details ?? []) {
        for (const group of detail.groupDetails ?? []) {
          if (group.url) urls.add(group.url);
        }
      }
    }
  }

  const rates: SettledFundingRate[] = [];
  for (const url of urls) {
    const res = await fetchPolitely(input.fetchFn, url);
    if (!res.ok) throw new Error(`OKX funding archive HTTP ${res.status}`);
    const zip = new Uint8Array(await res.arrayBuffer());
    for (const r of readOkxFundingArchive(zip, input.instrumentId)) {
      if (r.fundingTs >= input.fromTs && r.fundingTs <= input.toTs) rates.push(r);
    }
  }
  return rates;
}
