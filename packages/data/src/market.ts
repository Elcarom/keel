import type { DatabaseSync } from "node:sqlite";
import {
  ALL_BAR_TIMEFRAMES,
  BarTimeframeSchema,
  ExperimentRecordSchema,
  ScaledDecimal,
  TIMEFRAME_DURATION_MS,
  sha256Hex,
  type BarTimeframe,
  type ConfirmedBar,
  type DataSnapshotMetadata,
  type ExperimentRecord,
  type ExperimentRepository,
  type FeatureSnapshot,
  type LookbackDeficit,
  type LookbackValidationResult,
  type MarketDataRepository,
  type MarketGapRange,
  type RawOkxCandlePayload,
  type SettledFundingRate
} from "@keel/core";

export const MARKET_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS confirmed_bars (
  instrument_id TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  open_ts INTEGER NOT NULL,
  close_ts INTEGER NOT NULL,
  open TEXT NOT NULL,
  high TEXT NOT NULL,
  low TEXT NOT NULL,
  close TEXT NOT NULL,
  volume_contracts TEXT NOT NULL,
  volume_quote TEXT NOT NULL,
  PRIMARY KEY (instrument_id, timeframe, open_ts)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_confirmed_bars_as_of
  ON confirmed_bars(instrument_id, timeframe, close_ts ASC);

CREATE TABLE IF NOT EXISTS settled_funding_rates (
  instrument_id TEXT NOT NULL,
  funding_ts INTEGER NOT NULL,
  funding_rate TEXT NOT NULL,
  realized_rate TEXT NOT NULL,
  PRIMARY KEY (instrument_id, funding_ts)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_settled_funding_ts
  ON settled_funding_rates(instrument_id, funding_ts ASC);

CREATE TABLE IF NOT EXISTS experiments (
  experiment_id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  data_snapshot_id TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  from_ts INTEGER NOT NULL,
  to_ts INTEGER NOT NULL,
  total_trades INTEGER NOT NULL,
  win_rate REAL NOT NULL,
  avg_r REAL NOT NULL,
  net_pnl_usdt TEXT NOT NULL,
  total_fees_usdt TEXT NOT NULL,
  total_funding_usdt TEXT NOT NULL,
  max_drawdown_pct REAL NOT NULL,
  sharpe_ratio REAL NOT NULL,
  deflated_sharpe_ratio REAL NOT NULL,
  stress_net_expectancy_r REAL NOT NULL,
  walk_forward_oos_avg_r REAL NOT NULL,
  replay_gate_passed INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  buy_and_hold_return_pct REAL NOT NULL DEFAULT 0,
  buy_and_hold_sharpe_ratio REAL NOT NULL DEFAULT 0,
  random_entry_return_pct REAL NOT NULL DEFAULT 0,
  random_entry_sharpe_ratio REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_experiments_created
  ON experiments(created_at_ms DESC);
`;

function mapConfirmedBarRow(row: Record<string, unknown>): ConfirmedBar {
  return {
    instrumentId: String(row["instrument_id"]),
    timeframe: BarTimeframeSchema.parse(String(row["timeframe"])),
    openTs: Number(row["open_ts"]),
    closeTs: Number(row["close_ts"]),
    open: String(row["open"]),
    high: String(row["high"]),
    low: String(row["low"]),
    close: String(row["close"]),
    volumeContracts: String(row["volume_contracts"]),
    volumeQuote: String(row["volume_quote"]),
    confirm: "1"
  };
}

function mapFundingRow(row: Record<string, unknown>): SettledFundingRate {
  return {
    instrumentId: String(row["instrument_id"]),
    fundingTs: Number(row["funding_ts"]),
    fundingRate: String(row["funding_rate"]),
    realizedRate: String(row["realized_rate"])
  };
}

function mapExperimentRow(row: Record<string, unknown>): ExperimentRecord {
  return ExperimentRecordSchema.parse({
    experimentId: String(row["experiment_id"]),
    strategyId: String(row["strategy_id"]),
    strategyVersion: String(row["strategy_version"]),
    instrumentId: String(row["instrument_id"]),
    timeframe: String(row["timeframe"]),
    dataSnapshotId: String(row["data_snapshot_id"]),
    configHash: String(row["config_hash"]),
    fromTs: Number(row["from_ts"]),
    toTs: Number(row["to_ts"]),
    totalTrades: Number(row["total_trades"]),
    winRate: Number(row["win_rate"]),
    avgR: Number(row["avg_r"]),
    netPnlUsdt: String(row["net_pnl_usdt"]),
    totalFeesUsdt: String(row["total_fees_usdt"]),
    totalFundingUsdt: String(row["total_funding_usdt"]),
    maxDrawdownPct: Number(row["max_drawdown_pct"]),
    sharpeRatio: Number(row["sharpe_ratio"]),
    deflatedSharpeRatio: Number(row["deflated_sharpe_ratio"]),
    stressNetExpectancyR: Number(row["stress_net_expectancy_r"]),
    walkForwardOutOfSampleAvgR: Number(row["walk_forward_oos_avg_r"]),
    replayGatePassed: Number(row["replay_gate_passed"]) === 1,
    createdAtMs: Number(row["created_at_ms"]),
    buyAndHoldReturnPct: Number(row["buy_and_hold_return_pct"] ?? 0),
    buyAndHoldSharpeRatio: Number(row["buy_and_hold_sharpe_ratio"] ?? 0),
    randomEntryReturnPct: Number(row["random_entry_return_pct"] ?? 0),
    randomEntrySharpeRatio: Number(row["random_entry_sharpe_ratio"] ?? 0)
  });
}

export function createMarketDataRepository(db: DatabaseSync): MarketDataRepository {
  const insertBarStmt = db.prepare(`
    INSERT INTO confirmed_bars (
      instrument_id, timeframe, open_ts, close_ts, open, high, low, close, volume_contracts, volume_quote
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(instrument_id, timeframe, open_ts) DO UPDATE SET
      close_ts = excluded.close_ts,
      open = excluded.open,
      high = excluded.high,
      low = excluded.low,
      close = excluded.close,
      volume_contracts = excluded.volume_contracts,
      volume_quote = excluded.volume_quote
  `);

  const insertFundingStmt = db.prepare(`
    INSERT INTO settled_funding_rates (
      instrument_id, funding_ts, funding_rate, realized_rate
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(instrument_id, funding_ts) DO UPDATE SET
      funding_rate = excluded.funding_rate,
      realized_rate = excluded.realized_rate
  `);

  return {
    ingestOkxCandles(input): { insertedCount: number; skippedUnconfirmedCount: number } {
      const durationMs = TIMEFRAME_DURATION_MS[input.timeframe];
      let insertedCount = 0;
      let skippedUnconfirmedCount = 0;

      db.exec("BEGIN TRANSACTION");
      try {
        for (const candle of input.candles) {
          // Strict confirm === "1" gate: forming bars are never stored
          if (candle.confirm !== "1") {
            skippedUnconfirmedCount += 1;
            continue;
          }
          const openTs = Number(candle.openTs);
          if (!Number.isInteger(openTs) || openTs < 0) {
            throw new Error(`Invalid candle openTs: ${String(candle.openTs)}`);
          }
          const closeTs = openTs + durationMs;

          // Validate decimal representations via ScaledDecimal
          const openStr = ScaledDecimal.fromString(candle.open).toString();
          const highStr = ScaledDecimal.fromString(candle.high).toString();
          const lowStr = ScaledDecimal.fromString(candle.low).toString();
          const closeStr = ScaledDecimal.fromString(candle.close).toString();
          const volContractsStr = ScaledDecimal.fromString(candle.volumeContracts).toString();
          const volQuoteStr = ScaledDecimal.fromString(candle.volumeQuote).toString();

          insertBarStmt.run(
            input.instrumentId,
            input.timeframe,
            openTs,
            closeTs,
            openStr,
            highStr,
            lowStr,
            closeStr,
            volContractsStr,
            volQuoteStr
          );
          insertedCount += 1;
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }

      return { insertedCount, skippedUnconfirmedCount };
    },

    ingestSettledFunding(rates: readonly SettledFundingRate[]): number {
      let count = 0;
      db.exec("BEGIN TRANSACTION");
      try {
        for (const r of rates) {
          const fundingRate = ScaledDecimal.fromString(r.fundingRate).toString();
          const realizedRate = ScaledDecimal.fromString(r.realizedRate).toString();
          insertFundingStmt.run(r.instrumentId, r.fundingTs, fundingRate, realizedRate);
          count += 1;
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return count;
    },

    getConfirmedBarsAsOf(input): readonly ConfirmedBar[] {
      if (input.limit !== undefined) {
        const rows = db
          .prepare(
            `SELECT instrument_id, timeframe, open_ts, close_ts, open, high, low, close, volume_contracts, volume_quote
             FROM confirmed_bars
             WHERE instrument_id = ? AND timeframe = ? AND close_ts <= ?
             ORDER BY open_ts DESC
             LIMIT ?`
          )
          .all(input.instrumentId, input.timeframe, input.asOfMs, input.limit);
        return rows.reverse().map(mapConfirmedBarRow);
      }

      const rows = db
        .prepare(
          `SELECT instrument_id, timeframe, open_ts, close_ts, open, high, low, close, volume_contracts, volume_quote
           FROM confirmed_bars
           WHERE instrument_id = ? AND timeframe = ? AND close_ts <= ?
           ORDER BY open_ts ASC`
        )
        .all(input.instrumentId, input.timeframe, input.asOfMs);
      return rows.map(mapConfirmedBarRow);
    },

    getConfirmedBarsInRange(input): readonly ConfirmedBar[] {
      const rows = db
        .prepare(
          `SELECT instrument_id, timeframe, open_ts, close_ts, open, high, low, close, volume_contracts, volume_quote
           FROM confirmed_bars
           WHERE instrument_id = ? AND timeframe = ? AND open_ts >= ? AND close_ts <= ?
           ORDER BY open_ts ASC`
        )
        .all(input.instrumentId, input.timeframe, input.fromOpenTs, input.toCloseTs);
      return rows.map(mapConfirmedBarRow);
    },

    getSettledFundingAsOf(input): readonly SettledFundingRate[] {
      const limit = input.limit ?? 100;
      const rows = db
        .prepare(
          `SELECT instrument_id, funding_ts, funding_rate, realized_rate
           FROM settled_funding_rates
           WHERE instrument_id = ? AND funding_ts <= ?
           ORDER BY funding_ts DESC
           LIMIT ?`
        )
        .all(input.instrumentId, input.asOfMs, limit);
      return rows.reverse().map(mapFundingRow);
    },

    getSettledFundingInRange(input): readonly SettledFundingRate[] {
      const rows = db
        .prepare(
          `SELECT instrument_id, funding_ts, funding_rate, realized_rate
           FROM settled_funding_rates
           WHERE instrument_id = ? AND funding_ts >= ? AND funding_ts <= ?
           ORDER BY funding_ts ASC`
        )
        .all(input.instrumentId, input.fromTs, input.toTs);
      return rows.map(mapFundingRow);
    },

    detectGaps(input): readonly MarketGapRange[] {
      const dt = TIMEFRAME_DURATION_MS[input.timeframe];
      const rows = db
        .prepare(
          `SELECT open_ts
           FROM confirmed_bars
           WHERE instrument_id = ? AND timeframe = ? AND open_ts >= ? AND open_ts <= ?
           ORDER BY open_ts ASC`
        )
        .all(input.instrumentId, input.timeframe, input.fromOpenTs, input.toOpenTs);

      const presentSet = new Set(rows.map((r) => Number(r["open_ts"])));
      const gaps: MarketGapRange[] = [];
      let currentMissingStart: number | null = null;
      let currentMissingEnd: number | null = null;
      let currentMissingCount = 0;

      for (let t = input.fromOpenTs; t <= input.toOpenTs; t += dt) {
        if (!presentSet.has(t)) {
          if (currentMissingStart === null) {
            currentMissingStart = t;
          }
          currentMissingEnd = t;
          currentMissingCount += 1;
        } else if (currentMissingStart !== null && currentMissingEnd !== null) {
          gaps.push({
            instrumentId: input.instrumentId,
            timeframe: input.timeframe,
            missingFromOpenTs: currentMissingStart,
            missingToOpenTs: currentMissingEnd,
            missingBarCount: currentMissingCount
          });
          currentMissingStart = null;
          currentMissingEnd = null;
          currentMissingCount = 0;
        }
      }

      if (currentMissingStart !== null && currentMissingEnd !== null) {
        gaps.push({
          instrumentId: input.instrumentId,
          timeframe: input.timeframe,
          missingFromOpenTs: currentMissingStart,
          missingToOpenTs: currentMissingEnd,
          missingBarCount: currentMissingCount
        });
      }

      return gaps;
    },

    assertLookbackSatisfied(input): LookbackValidationResult {
      const deficits: LookbackDeficit[] = [];

      for (const tf of ALL_BAR_TIMEFRAMES) {
        const requiredBars = input.requirements[tf];
        if (!requiredBars || requiredBars <= 0) {
          continue;
        }
        const bars = this.getConfirmedBarsAsOf({
          instrumentId: input.instrumentId,
          timeframe: tf,
          asOfMs: input.asOfMs,
          limit: requiredBars
        });

        const dt = TIMEFRAME_DURATION_MS[tf];
        let hasGaps = false;
        for (let i = 1; i < bars.length; i++) {
          const prev = bars[i - 1];
          const curr = bars[i];
          if (prev && curr && curr.openTs - prev.openTs !== dt) {
            hasGaps = true;
            break;
          }
        }
        const latestBar = bars[bars.length - 1];
        if (latestBar && input.asOfMs - latestBar.closeTs >= dt) {
          hasGaps = true;
        }

        if (bars.length < requiredBars || hasGaps) {
          deficits.push({
            timeframe: tf,
            requiredBars,
            availableBars: bars.length,
            hasGaps
          });
        }
      }

      return {
        instrumentId: input.instrumentId,
        asOfMs: input.asOfMs,
        satisfied: deficits.length === 0,
        deficits
      };
    },

    buildFeatureSnapshot(input): FeatureSnapshot {
      const barsByTimeframe: Partial<Record<BarTimeframe, readonly ConfirmedBar[]>> = {};
      for (const tf of ALL_BAR_TIMEFRAMES) {
        const required = input.requirements[tf];
        if (required && required > 0) {
          barsByTimeframe[tf] = this.getConfirmedBarsAsOf({
            instrumentId: input.instrumentId,
            timeframe: tf,
            asOfMs: input.asOfMs,
            limit: required
          });
        }
      }
      const recentFundingRates = this.getSettledFundingAsOf({
        instrumentId: input.instrumentId,
        asOfMs: input.asOfMs,
        limit: 30
      });

      return {
        instrumentId: input.instrumentId,
        asOfMs: input.asOfMs,
        barsByTimeframe,
        recentFundingRates
      };
    },

    computeDataSnapshot(input): DataSnapshotMetadata {
      const sortedInstruments = [...input.instrumentIds].sort();
      const digestParts: string[] = [];
      let totalBarCount = 0;
      let totalFundingCount = 0;

      for (const instId of sortedInstruments) {
        for (const tf of ALL_BAR_TIMEFRAMES) {
          const bars = this.getConfirmedBarsInRange({
            instrumentId: instId,
            timeframe: tf,
            fromOpenTs: input.fromTs,
            toCloseTs: input.toTs
          });
          totalBarCount += bars.length;
          for (const b of bars) {
            digestParts.push(
              `B:${b.instrumentId}:${b.timeframe}:${b.openTs}:${b.closeTs}:${b.open}:${b.high}:${b.low}:${b.close}:${b.volumeContracts}:${b.volumeQuote}`
            );
          }
        }

        const fundings = this.getSettledFundingInRange({
          instrumentId: instId,
          fromTs: input.fromTs,
          toTs: input.toTs
        });
        totalFundingCount += fundings.length;
        for (const f of fundings) {
          digestParts.push(`F:${f.instrumentId}:${f.fundingTs}:${f.fundingRate}:${f.realizedRate}`);
        }
      }

      const snapshotId = sha256Hex(digestParts.join("\n"));
      return {
        snapshotId,
        instrumentIds: sortedInstruments,
        fromTs: input.fromTs,
        toTs: input.toTs,
        barCount: totalBarCount,
        fundingCount: totalFundingCount
      };
    },

    listInstrumentsWithCoverage() {
      const instRows = db
        .prepare("SELECT DISTINCT instrument_id FROM confirmed_bars ORDER BY instrument_id ASC")
        .all();

      return instRows.map((row) => {
        const instrumentId = String(row["instrument_id"]);
        const barCounts: Record<BarTimeframe, number> = {
          "15m": 0,
          "1H": 0,
          "4H": 0,
          "1D": 0
        };
        for (const tf of ALL_BAR_TIMEFRAMES) {
          const cRow = db
            .prepare(
              "SELECT COUNT(*) AS cnt FROM confirmed_bars WHERE instrument_id = ? AND timeframe = ?"
            )
            .get(instrumentId, tf);
          barCounts[tf] = Number(cRow?.["cnt"] ?? 0);
        }

        const rangeRow = db
          .prepare(
            "SELECT MIN(open_ts) AS min_open, MAX(close_ts) AS max_close FROM confirmed_bars WHERE instrument_id = ?"
          )
          .get(instrumentId);
        const fRow = db
          .prepare("SELECT COUNT(*) AS cnt FROM settled_funding_rates WHERE instrument_id = ?")
          .get(instrumentId);

        return {
          instrumentId,
          barCounts,
          fundingCount: Number(fRow?.["cnt"] ?? 0),
          earliestOpenTs:
            rangeRow?.["min_open"] !== null && rangeRow?.["min_open"] !== undefined
              ? Number(rangeRow["min_open"])
              : null,
          latestCloseTs:
            rangeRow?.["max_close"] !== null && rangeRow?.["max_close"] !== undefined
              ? Number(rangeRow["max_close"])
              : null
        };
      });
    }
  };
}

export function createExperimentRepository(db: DatabaseSync): ExperimentRepository {
  return {
    saveExperiment(record: ExperimentRecord): ExperimentRecord {
      const validated = ExperimentRecordSchema.parse(record);
      db.prepare(
        `INSERT INTO experiments (
          experiment_id, strategy_id, strategy_version, instrument_id, timeframe,
          data_snapshot_id, config_hash, from_ts, to_ts, total_trades, win_rate,
          avg_r, net_pnl_usdt, total_fees_usdt, total_funding_usdt, max_drawdown_pct,
          sharpe_ratio, deflated_sharpe_ratio, stress_net_expectancy_r,
          walk_forward_oos_avg_r, replay_gate_passed, created_at_ms,
          buy_and_hold_return_pct, buy_and_hold_sharpe_ratio,
          random_entry_return_pct, random_entry_sharpe_ratio
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        validated.experimentId,
        validated.strategyId,
        validated.strategyVersion,
        validated.instrumentId,
        validated.timeframe,
        validated.dataSnapshotId,
        validated.configHash,
        validated.fromTs,
        validated.toTs,
        validated.totalTrades,
        validated.winRate,
        validated.avgR,
        validated.netPnlUsdt,
        validated.totalFeesUsdt,
        validated.totalFundingUsdt,
        validated.maxDrawdownPct,
        validated.sharpeRatio,
        validated.deflatedSharpeRatio,
        validated.stressNetExpectancyR,
        validated.walkForwardOutOfSampleAvgR,
        validated.replayGatePassed ? 1 : 0,
        validated.createdAtMs,
        validated.buyAndHoldReturnPct,
        validated.buyAndHoldSharpeRatio,
        validated.randomEntryReturnPct,
        validated.randomEntrySharpeRatio
      );
      return validated;
    },

    listExperiments(limit = 50): readonly ExperimentRecord[] {
      const rows = db
        .prepare("SELECT * FROM experiments ORDER BY created_at_ms DESC LIMIT ?")
        .all(limit);
      return rows.map(mapExperimentRow);
    },

    getExperiment(experimentId: string): ExperimentRecord | null {
      const row = db.prepare("SELECT * FROM experiments WHERE experiment_id = ?").get(experimentId);
      return row ? mapExperimentRow(row) : null;
    }
  };
}

export type FetchOkxHistoryCandlesFn = (input: {
  instrumentId: string;
  timeframe: BarTimeframe;
  fromOpenTs: number;
  toOpenTs: number;
}) => Promise<readonly RawOkxCandlePayload[]>;

export type FetchOkxHistoryFundingFn = (input: {
  instrumentId: string;
  fromFundingTs: number;
  toFundingTs: number;
}) => Promise<readonly SettledFundingRate[]>;

export interface OkxPublicIngestorOptions {
  readonly marketDataRepo: MarketDataRepository;
  readonly fetchHistoryCandles?: FetchOkxHistoryCandlesFn | undefined;
  readonly fetchHistoryFunding?: FetchOkxHistoryFundingFn | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly requestDelayMs?: number | undefined;
}

/**
 * OKX V5 Public market data ingestor & gap healer enforcing `confirm === "1"`.
 */
export class OkxPublicIngestor {
  private readonly marketDataRepo: MarketDataRepository;
  private readonly fetchHistoryCandles: FetchOkxHistoryCandlesFn;
  private readonly fetchHistoryFunding: FetchOkxHistoryFundingFn;

  public constructor(options: OkxPublicIngestorOptions) {
    this.marketDataRepo = options.marketDataRepo;
    const fetchFunc = options.fetchFn ?? fetch;

    this.fetchHistoryCandles =
      options.fetchHistoryCandles ??
      (async ({ instrumentId, timeframe, fromOpenTs, toOpenTs }) => {
        const dt = TIMEFRAME_DURATION_MS[timeframe];
        const collected: RawOkxCandlePayload[] = [];
        let cursorAfterMs = toOpenTs + dt;
        while (cursorAfterMs > fromOpenTs) {
          const url = `https://www.okx.com/api/v5/market/history-candles?instId=${encodeURIComponent(instrumentId)}&bar=${encodeURIComponent(timeframe)}&after=${cursorAfterMs}&limit=100`;
          const res = await fetchFunc(url);
          if (!res.ok) {
            throw new Error(`OKX history-candles HTTP ${res.status}`);
          }
          const body = (await res.json()) as { data?: string[][] };
          const rows = body.data ?? [];
          if (rows.length === 0) break;
          let minTsInPage = cursorAfterMs;
          for (const arr of rows) {
            const openTs = Number(arr[0] ?? 0);
            if (openTs < minTsInPage) minTsInPage = openTs;
            if (openTs >= fromOpenTs && openTs <= toOpenTs) {
              collected.push({
                openTs,
                open: arr[1] ?? "0",
                high: arr[2] ?? "0",
                low: arr[3] ?? "0",
                close: arr[4] ?? "0",
                volumeContracts: arr[5] ?? "0",
                volumeQuote: arr[7] ?? "0",
                confirm: arr[8] ?? "0"
              });
            }
          }
          if (minTsInPage >= cursorAfterMs) break;
          cursorAfterMs = minTsInPage;
          if (rows.length < 100 || minTsInPage <= fromOpenTs) break;
          if (options.requestDelayMs && options.requestDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, options.requestDelayMs));
          }
        }
        return collected;
      });

    this.fetchHistoryFunding =
      options.fetchHistoryFunding ??
      (async ({ instrumentId, fromFundingTs, toFundingTs }) => {
        const dt8H = 8 * 3600 * 1000;
        const collected: SettledFundingRate[] = [];
        let cursorAfterMs = toFundingTs + dt8H;
        while (cursorAfterMs > fromFundingTs) {
          const url = `https://www.okx.com/api/v5/public/funding-rate-history?instId=${encodeURIComponent(instrumentId)}&after=${cursorAfterMs}&limit=100`;
          const res = await fetchFunc(url);
          if (!res.ok) {
            throw new Error(`OKX funding-rate-history HTTP ${res.status}`);
          }
          const body = (await res.json()) as {
            data?: Array<{
              instId: string;
              fundingTime: string;
              fundingRate: string;
              realizedRate?: string;
            }>;
          };
          const rows = body.data ?? [];
          if (rows.length === 0) break;
          let minTsInPage = cursorAfterMs;
          for (const row of rows) {
            const fundingTs = Number(row.fundingTime);
            if (fundingTs < minTsInPage) minTsInPage = fundingTs;
            if (fundingTs >= fromFundingTs && fundingTs <= toFundingTs) {
              collected.push({
                instrumentId: row.instId,
                fundingTs,
                fundingRate: row.fundingRate,
                realizedRate: row.realizedRate ?? row.fundingRate
              });
            }
          }
          if (minTsInPage >= cursorAfterMs) break;
          cursorAfterMs = minTsInPage;
          if (rows.length < 100 || minTsInPage <= fromFundingTs) break;
          if (options.requestDelayMs && options.requestDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, options.requestDelayMs));
          }
        }
        return collected;
      });
  }

  public async healGaps(input: {
    instrumentId: string;
    timeframe: BarTimeframe;
    fromOpenTs: number;
    toOpenTs: number;
  }): Promise<number> {
    const res = await this.ingestRange(input);
    return res.insertedCount;
  }

  public async ingestRange(input: {
    instrumentId: string;
    timeframe: BarTimeframe;
    fromOpenTs: number;
    toOpenTs: number;
  }): Promise<{ insertedCount: number; gapsDetected: number }> {
    const gaps = this.marketDataRepo.detectGaps(input);
    let totalInserted = 0;

    for (const gap of gaps) {
      const candles = await this.fetchHistoryCandles({
        instrumentId: gap.instrumentId,
        timeframe: gap.timeframe,
        fromOpenTs: gap.missingFromOpenTs,
        toOpenTs: gap.missingToOpenTs
      });
      const res = this.marketDataRepo.ingestOkxCandles({
        instrumentId: gap.instrumentId,
        timeframe: gap.timeframe,
        candles
      });
      totalInserted += res.insertedCount;
    }

    return {
      insertedCount: totalInserted,
      gapsDetected: gaps.length
    };
  }

  public async ingestFundingRates(input: {
    instrumentId: string;
    fromFundingTs: number;
    toFundingTs: number;
  }): Promise<number> {
    const rates = await this.fetchHistoryFunding(input);
    return this.marketDataRepo.ingestSettledFunding(rates);
  }
}

/**
 * Seeds a deterministic multi-regime series of confirmed `15m`, `1H`, `4H`, and `1D`
 * bars and 8h settled funding rates for offline Replay backtesting and verification.
 */
export function seedSyntheticMarketSeries(input: {
  marketDataRepo: MarketDataRepository;
  instrumentId: string;
  endCloseTs: number;
  barCount1H?: number | undefined;
}): DataSnapshotMetadata {
  const count1H = input.barCount1H ?? 720;
  const dt1H = TIMEFRAME_DURATION_MS["1H"];
  const alignedEndMs = Math.floor(input.endCloseTs / dt1H) * dt1H;
  const startOpenTs = alignedEndMs - count1H * dt1H;

  const basePrice = input.instrumentId.startsWith("ETH") ? 2500 : 60000;
  const dt15m = TIMEFRAME_DURATION_MS["15m"];
  const candles15m: RawOkxCandlePayload[] = [];
  const candles1H: RawOkxCandlePayload[] = [];
  const candles4H: RawOkxCandlePayload[] = [];
  const candles1D: RawOkxCandlePayload[] = [];
  const fundingRates: SettledFundingRate[] = [];

  let price = basePrice;

  for (let i = 0; i < count1H; i++) {
    const openTs = startOpenTs + i * dt1H;
    // Deterministic multi-regime wave (strong trend + mean-reverting oscillation)
    const trendComponent = Math.sin(i / 28) * (basePrice * 0.008);
    const cycleComponent = Math.cos(i / 7) * (basePrice * 0.003);
    const delta = trendComponent + cycleComponent;

    const open = price;
    const close = Math.max(basePrice * 0.4, open + delta);
    const rangePad = basePrice * 0.004;
    const high = Math.max(open, close) + rangePad;
    const low = Math.max(basePrice * 0.2, Math.min(open, close) - rangePad);
    price = close;

    for (let q = 0; q < 4; q++) {
      const qOpen = open + ((close - open) * q) / 4;
      const qClose = open + ((close - open) * (q + 1)) / 4;
      const qHigh = Math.max(qOpen, qClose) + rangePad * 0.35;
      const qLow = Math.max(basePrice * 0.2, Math.min(qOpen, qClose) - rangePad * 0.35);
      candles15m.push({
        openTs: openTs + q * dt15m,
        open: qOpen.toFixed(2),
        high: qHigh.toFixed(2),
        low: qLow.toFixed(2),
        close: qClose.toFixed(2),
        volumeContracts: "250.00",
        volumeQuote: (250 * qClose).toFixed(2),
        confirm: "1"
      });
    }

    candles1H.push({
      openTs,
      open: open.toFixed(2),
      high: high.toFixed(2),
      low: low.toFixed(2),
      close: close.toFixed(2),
      volumeContracts: (1000 + (i % 17) * 50).toFixed(2),
      volumeQuote: ((1000 + (i % 17) * 50) * close).toFixed(2),
      confirm: "1"
    });

    // Aggregate 4H bars every 4 hours
    if (i % 4 === 3) {
      const slice4 = candles1H.slice(i - 3, i + 1);
      const o4 = slice4[0]?.open ?? open.toFixed(2);
      const c4 = slice4[slice4.length - 1]?.close ?? close.toFixed(2);
      const h4 = Math.max(...slice4.map((s) => Number(s.high))).toFixed(2);
      const l4 = Math.min(...slice4.map((s) => Number(s.low))).toFixed(2);
      candles4H.push({
        openTs: startOpenTs + (i - 3) * dt1H,
        open: o4,
        high: h4,
        low: l4,
        close: c4,
        volumeContracts: "4500.00",
        volumeQuote: (4500 * Number(c4)).toFixed(2),
        confirm: "1"
      });
    }

    // Aggregate 1D bars every 24 hours
    if (i % 24 === 23) {
      const slice24 = candles1H.slice(i - 23, i + 1);
      const o24 = slice24[0]?.open ?? open.toFixed(2);
      const c24 = slice24[slice24.length - 1]?.close ?? close.toFixed(2);
      const h24 = Math.max(...slice24.map((s) => Number(s.high))).toFixed(2);
      const l24 = Math.min(...slice24.map((s) => Number(s.low))).toFixed(2);
      candles1D.push({
        openTs: startOpenTs + (i - 23) * dt1H,
        open: o24,
        high: h24,
        low: l24,
        close: c24,
        volumeContracts: "25000.00",
        volumeQuote: (25000 * Number(c24)).toFixed(2),
        confirm: "1"
      });
    }

    // 8-hour settled funding slots
    const closeTs = openTs + dt1H;
    if (closeTs % (8 * dt1H) === 0) {
      const rate = (0.0001 + Math.sin(i / 24) * 0.00005).toFixed(8);
      fundingRates.push({
        instrumentId: input.instrumentId,
        fundingTs: closeTs,
        fundingRate: rate,
        realizedRate: rate
      });
    }
  }

  input.marketDataRepo.ingestOkxCandles({
    instrumentId: input.instrumentId,
    timeframe: "15m",
    candles: candles15m
  });
  input.marketDataRepo.ingestOkxCandles({
    instrumentId: input.instrumentId,
    timeframe: "1H",
    candles: candles1H
  });
  input.marketDataRepo.ingestOkxCandles({
    instrumentId: input.instrumentId,
    timeframe: "4H",
    candles: candles4H
  });
  input.marketDataRepo.ingestOkxCandles({
    instrumentId: input.instrumentId,
    timeframe: "1D",
    candles: candles1D
  });
  input.marketDataRepo.ingestSettledFunding(fundingRates);

  return input.marketDataRepo.computeDataSnapshot({
    instrumentIds: [input.instrumentId],
    fromTs: startOpenTs,
    toTs: alignedEndMs
  });
}
