import type { DatabaseSync } from "node:sqlite";
import {
  AssessmentSchema,
  BotBlueprintSchema,
  BotStatusSchema,
  DesignBriefSchema,
  DesignSourceSchema,
  PropositionStatusSchema,
  ScaledDecimal,
  type BotRecord,
  type DesignBatchRecord,
  type FleetRepository,
  type PropositionRecord,
  type WalletEntryRecord,
  type WalletRecord
} from "@keel/core";

export const FLEET_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS fleet_wallets (
  wallet_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fleet_wallet_entries (
  entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  amount_usdt TEXT NOT NULL,
  reason TEXT NOT NULL,
  bot_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_fleet_wallet_entries_wallet ON fleet_wallet_entries(wallet_id);

CREATE TABLE IF NOT EXISTS fleet_bots (
  bot_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tagline TEXT NOT NULL,
  blueprint_json TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  allocation_usdt TEXT NOT NULL,
  status TEXT NOT NULL,
  status_reason TEXT,
  created_at_ms INTEGER NOT NULL,
  retired_at_ms INTEGER,
  proposition_id TEXT,
  backtest_json TEXT
);

CREATE TABLE IF NOT EXISTS fleet_design_batches (
  batch_id TEXT PRIMARY KEY,
  created_at_ms INTEGER NOT NULL,
  brief_json TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS fleet_propositions (
  proposition_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  source TEXT NOT NULL,
  blueprint_json TEXT NOT NULL,
  status TEXT NOT NULL,
  assessment_json TEXT,
  rank INTEGER,
  error TEXT,
  bot_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_fleet_propositions_batch ON fleet_propositions(batch_id);

CREATE TABLE IF NOT EXISTS fleet_backtest_data (
  instrument_id TEXT PRIMARY KEY,
  source TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  return String(row[key]);
}

function nullableStr(row: Row, key: string): string | null {
  const v = row[key];
  return v === null || v === undefined ? null : String(v);
}

function nullableNum(row: Row, key: string): number | null {
  const v = row[key];
  return v === null || v === undefined ? null : Number(v);
}

function mapWallet(row: Row): WalletRecord {
  return {
    walletId: str(row, "wallet_id"),
    name: str(row, "name"),
    kind: "paper",
    createdAtMs: Number(row["created_at_ms"])
  };
}

function mapBot(row: Row): BotRecord {
  const backtest = nullableStr(row, "backtest_json");
  return {
    botId: str(row, "bot_id"),
    name: str(row, "name"),
    tagline: str(row, "tagline"),
    blueprint: BotBlueprintSchema.parse(JSON.parse(str(row, "blueprint_json"))),
    walletId: str(row, "wallet_id"),
    allocationUsdt: str(row, "allocation_usdt"),
    status: BotStatusSchema.parse(str(row, "status")),
    statusReason: nullableStr(row, "status_reason"),
    createdAtMs: Number(row["created_at_ms"]),
    retiredAtMs: nullableNum(row, "retired_at_ms"),
    propositionId: nullableStr(row, "proposition_id"),
    backtest: backtest === null ? null : AssessmentSchema.parse(JSON.parse(backtest))
  };
}

function mapBatch(row: Row): DesignBatchRecord {
  return {
    batchId: str(row, "batch_id"),
    createdAtMs: Number(row["created_at_ms"]),
    brief: DesignBriefSchema.parse(JSON.parse(str(row, "brief_json"))),
    source: DesignSourceSchema.parse(str(row, "source")),
    note: nullableStr(row, "note")
  };
}

function mapProposition(row: Row): PropositionRecord {
  const assessment = nullableStr(row, "assessment_json");
  return {
    propositionId: str(row, "proposition_id"),
    batchId: str(row, "batch_id"),
    createdAtMs: Number(row["created_at_ms"]),
    source: DesignSourceSchema.parse(str(row, "source")),
    blueprint: BotBlueprintSchema.parse(JSON.parse(str(row, "blueprint_json"))),
    status: PropositionStatusSchema.parse(str(row, "status")),
    assessment: assessment === null ? null : AssessmentSchema.parse(JSON.parse(assessment)),
    rank: nullableNum(row, "rank"),
    error: nullableStr(row, "error"),
    botId: nullableStr(row, "bot_id")
  };
}

export function createFleetRepository(db: DatabaseSync): FleetRepository {
  return {
    createWallet(wallet: WalletRecord): WalletRecord {
      db.prepare(
        `INSERT INTO fleet_wallets (wallet_id, name, kind, created_at_ms) VALUES (?, ?, ?, ?)`
      ).run(wallet.walletId, wallet.name, wallet.kind, wallet.createdAtMs);
      return wallet;
    },

    getWallet(walletId: string): WalletRecord | null {
      const row = db.prepare(`SELECT * FROM fleet_wallets WHERE wallet_id = ?`).get(walletId);
      return row ? mapWallet(row) : null;
    },

    listWallets(): readonly WalletRecord[] {
      return db
        .prepare(`SELECT * FROM fleet_wallets ORDER BY created_at_ms ASC`)
        .all()
        .map(mapWallet);
    },

    appendWalletEntry(entry: WalletEntryRecord): void {
      db.prepare(
        `INSERT INTO fleet_wallet_entries (wallet_id, ts, amount_usdt, reason, bot_id)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        entry.walletId,
        entry.ts,
        ScaledDecimal.fromString(entry.amountUsdt).toFixed(8),
        entry.reason,
        entry.botId
      );
    },

    getWalletBalanceUsdt(walletId: string): string {
      const rows = db
        .prepare(`SELECT amount_usdt FROM fleet_wallet_entries WHERE wallet_id = ?`)
        .all(walletId);
      return rows
        .reduce(
          (sum, row) => sum.add(ScaledDecimal.fromString(str(row, "amount_usdt"))),
          ScaledDecimal.zero()
        )
        .toFixed(8);
    },

    saveBot(bot: BotRecord): BotRecord {
      db.prepare(
        `INSERT INTO fleet_bots (
          bot_id, name, tagline, blueprint_json, wallet_id, allocation_usdt, status, status_reason,
          created_at_ms, retired_at_ms, proposition_id, backtest_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(bot_id) DO UPDATE SET
          name = excluded.name,
          tagline = excluded.tagline,
          status = excluded.status,
          status_reason = excluded.status_reason,
          retired_at_ms = excluded.retired_at_ms`
      ).run(
        bot.botId,
        bot.name,
        bot.tagline,
        JSON.stringify(bot.blueprint),
        bot.walletId,
        bot.allocationUsdt,
        bot.status,
        bot.statusReason,
        bot.createdAtMs,
        bot.retiredAtMs,
        bot.propositionId,
        bot.backtest === null ? null : JSON.stringify(bot.backtest)
      );
      return bot;
    },

    getBot(botId: string): BotRecord | null {
      const row = db.prepare(`SELECT * FROM fleet_bots WHERE bot_id = ?`).get(botId);
      return row ? mapBot(row) : null;
    },

    listBots(): readonly BotRecord[] {
      return db.prepare(`SELECT * FROM fleet_bots ORDER BY created_at_ms ASC`).all().map(mapBot);
    },

    deleteBot(botId: string): void {
      db.prepare(`DELETE FROM fleet_bots WHERE bot_id = ?`).run(botId);
    },

    saveBatch(batch: DesignBatchRecord): DesignBatchRecord {
      db.prepare(
        `INSERT INTO fleet_design_batches (batch_id, created_at_ms, brief_json, source, note)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        batch.batchId,
        batch.createdAtMs,
        JSON.stringify(batch.brief),
        batch.source,
        batch.note
      );
      return batch;
    },

    listBatches(limit: number): readonly DesignBatchRecord[] {
      return db
        .prepare(`SELECT * FROM fleet_design_batches ORDER BY created_at_ms DESC LIMIT ?`)
        .all(limit)
        .map(mapBatch);
    },

    saveProposition(p: PropositionRecord): PropositionRecord {
      db.prepare(
        `INSERT INTO fleet_propositions (
          proposition_id, batch_id, created_at_ms, source, blueprint_json, status,
          assessment_json, rank, error, bot_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(proposition_id) DO UPDATE SET
          status = excluded.status,
          assessment_json = excluded.assessment_json,
          rank = excluded.rank,
          error = excluded.error,
          bot_id = excluded.bot_id`
      ).run(
        p.propositionId,
        p.batchId,
        p.createdAtMs,
        p.source,
        JSON.stringify(p.blueprint),
        p.status,
        p.assessment === null ? null : JSON.stringify(p.assessment),
        p.rank,
        p.error,
        p.botId
      );
      return p;
    },

    getProposition(propositionId: string): PropositionRecord | null {
      const row = db
        .prepare(`SELECT * FROM fleet_propositions WHERE proposition_id = ?`)
        .get(propositionId);
      return row ? mapProposition(row) : null;
    },

    listPropositions(batchId: string): readonly PropositionRecord[] {
      return db
        .prepare(
          `SELECT * FROM fleet_propositions WHERE batch_id = ? ORDER BY created_at_ms ASC, rowid ASC`
        )
        .all(batchId)
        .map(mapProposition);
    },

    countPropositions(): number {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM fleet_propositions`).get();
      return row ? Number(row["n"]) : 0;
    },

    // Keyed by instrument and window start, so a longer window is filled afresh
    getBacktestDataSource(instrumentId: string, windowFromTs: number): "okx" | "synthetic" | null {
      const row = db
        .prepare(`SELECT source FROM fleet_backtest_data WHERE instrument_id = ?`)
        .get(`${instrumentId}@${windowFromTs}`);
      if (!row) return null;
      return str(row, "source") === "okx" ? "okx" : "synthetic";
    },

    setBacktestDataSource(
      instrumentId: string,
      windowFromTs: number,
      source: "okx" | "synthetic"
    ): void {
      db.prepare(
        `INSERT INTO fleet_backtest_data (instrument_id, source) VALUES (?, ?)
         ON CONFLICT(instrument_id) DO UPDATE SET source = excluded.source`
      ).run(`${instrumentId}@${windowFromTs}`, source);
    }
  };
}
