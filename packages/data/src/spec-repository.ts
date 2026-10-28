import type { DatabaseSync } from "node:sqlite";
import type {
  Clock,
  ExperimentRepository,
  SaveStrategySpecInput,
  StrategySpecNameRecord,
  StrategySpecRecord,
  StrategySpecRepository
} from "@keel/core";

export const SPEC_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS strategy_specs (
  spec_hash TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  spec_json TEXT NOT NULL,
  is_synthetic INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS strategy_spec_names (
  name TEXT PRIMARY KEY,
  active_spec_hash TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  FOREIGN KEY (active_spec_hash) REFERENCES strategy_specs(spec_hash)
);
`;

export function createStrategySpecRepository(
  db: DatabaseSync,
  clock: Clock,
  experimentRepo?: ExperimentRepository
): StrategySpecRepository {
  return {
    saveSpec(input: SaveStrategySpecInput): StrategySpecRecord {
      const isSyntheticNum = input.isSynthetic ? 1 : 0;
      const createdAtMs = input.createdAtMs ?? clock.nowMs();

      const existing = db
        .prepare(`SELECT * FROM strategy_specs WHERE spec_hash = ?`)
        .get(input.specHash) as Record<string, unknown> | undefined;

      if (!existing) {
        db.prepare(
          `INSERT INTO strategy_specs (spec_hash, name, version, spec_json, is_synthetic, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          input.specHash,
          input.name,
          input.version,
          input.specJson,
          isSyntheticNum,
          createdAtMs
        );

        if (experimentRepo) {
          experimentRepo.recordTrial({
            strategyId: input.name,
            parameterHash: input.specHash,
            instrumentId: "GLOBAL",
            timeframe: "1H",
            recordedAtMs: createdAtMs
          });
        }
      }

      db.prepare(
        `INSERT INTO strategy_spec_names (name, active_spec_hash, updated_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET active_spec_hash = excluded.active_spec_hash, updated_at_ms = excluded.updated_at_ms`
      ).run(input.name, input.specHash, createdAtMs);

      return {
        specHash: input.specHash,
        name: input.name,
        version: input.version,
        specJson: input.specJson,
        isSynthetic: Boolean(isSyntheticNum),
        createdAtMs: existing ? Number(existing["created_at_ms"]) : createdAtMs
      };
    },

    getSpecByHash(specHash: string): StrategySpecRecord | null {
      const row = db.prepare(`SELECT * FROM strategy_specs WHERE spec_hash = ?`).get(specHash) as
        Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        specHash: String(row["spec_hash"]),
        name: String(row["name"]),
        version: Number(row["version"]),
        specJson: String(row["spec_json"]),
        isSynthetic: Number(row["is_synthetic"]) === 1,
        createdAtMs: Number(row["created_at_ms"])
      };
    },

    getSpecByName(name: string): StrategySpecRecord | null {
      const row = db
        .prepare(
          `SELECT s.* FROM strategy_specs s
           JOIN strategy_spec_names n ON s.spec_hash = n.active_spec_hash
           WHERE n.name = ?`
        )
        .get(name) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        specHash: String(row["spec_hash"]),
        name: String(row["name"]),
        version: Number(row["version"]),
        specJson: String(row["spec_json"]),
        isSynthetic: Number(row["is_synthetic"]) === 1,
        createdAtMs: Number(row["created_at_ms"])
      };
    },

    listSpecs(limit = 100): readonly StrategySpecRecord[] {
      const rows = db
        .prepare(`SELECT * FROM strategy_specs ORDER BY created_at_ms DESC LIMIT ?`)
        .all(limit) as Record<string, unknown>[];
      return rows.map((row) => ({
        specHash: String(row["spec_hash"]),
        name: String(row["name"]),
        version: Number(row["version"]),
        specJson: String(row["spec_json"]),
        isSynthetic: Number(row["is_synthetic"]) === 1,
        createdAtMs: Number(row["created_at_ms"])
      }));
    },

    setActiveSpec(
      name: string,
      specHash: string,
      updatedAtMs = clock.nowMs()
    ): StrategySpecNameRecord {
      db.prepare(
        `INSERT INTO strategy_spec_names (name, active_spec_hash, updated_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET active_spec_hash = excluded.active_spec_hash, updated_at_ms = excluded.updated_at_ms`
      ).run(name, specHash, updatedAtMs);
      return {
        name,
        activeSpecHash: specHash,
        updatedAtMs
      };
    }
  };
}
