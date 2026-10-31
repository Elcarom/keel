import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncType;
};
import {
  ConfigRiskClassSchema,
  KeelConfigSchema,
  SecretKeyNameSchema,
  computeConfigHash,
  createDefaultConfig,
  type AdminSessionRecord,
  type AdminUserRecord,
  type AuthRateLimitRecord,
  type AuditEventRecord,
  type AuditRepository,
  type AuthRepository,
  type BackupRecord,
  type Clock,
  type ConfigRepository,
  type ConfigSnapshotRecord,
  type EncryptedSecretRecord,
  type ExperimentRepository,
  type KeelConfig,
  type LedgerRepository,
  type MarketDataRepository,
  type NewAuditEventInput,
  type PaperAccountRepository,
  type PromotionRepository,
  type RollbackConfigInput,
  type SaveConfigSnapshotInput,
  type SecretKeyName,
  type SecretVaultRepository,
  type ShadowRepository,
  type FleetRepository,
  type StrategySpecRepository
} from "@keel/core";
import {
  MARKET_SCHEMA_SQL,
  OkxPublicIngestor,
  createExperimentRepository,
  createMarketDataRepository,
  seedSyntheticMarketSeries,
  type FetchOkxHistoryCandlesFn,
  type FetchOkxHistoryFundingFn,
  type OkxPublicIngestorOptions
} from "./market.js";
import { FLEET_SCHEMA_SQL, createFleetRepository } from "./fleet-repository.js";
import {
  PAPER_SCHEMA_SQL,
  botBook,
  bookSchemaSql,
  dropBookSql,
  createLedgerRepository,
  createPaperAccountRepository,
  createPromotionRepository,
  createShadowRepository
} from "./paper.js";
import { readOkxFundingArchive } from "./okx-archive.js";
import { SPEC_SCHEMA_SQL, createStrategySpecRepository } from "./spec-repository.js";

export {
  OkxPublicIngestor,
  botBook,
  bookSchemaSql,
  dropBookSql,
  createFleetRepository,
  createLedgerRepository,
  createPaperAccountRepository,
  createPromotionRepository,
  createShadowRepository,
  createStrategySpecRepository,
  SPEC_SCHEMA_SQL,
  seedSyntheticMarketSeries,
  readOkxFundingArchive,
  type FetchOkxHistoryCandlesFn,
  type FetchOkxHistoryFundingFn,
  type OkxPublicIngestorOptions
};

export interface SqliteDataStoreOptions {
  readonly dbPath: string;
  readonly clock: Clock;
  readonly backupsDir?: string | undefined;
  readonly maxBackupsToKeep?: number | undefined;
  readonly initialConfig?: KeelConfig | undefined;
  readonly initialPaperCapitalUsdt?: string | undefined;
}

export interface SqlitePragmaStatus {
  readonly journalMode: string;
  readonly synchronous: number;
  readonly foreignKeys: number;
}

export interface BackupService {
  createBackup(): BackupRecord;
  listBackups(): readonly BackupRecord[];
}

export interface SqliteDataStore extends BackupService {
  readonly configRepo: ConfigRepository;
  readonly auditRepo: AuditRepository;
  readonly secretVaultRepo: SecretVaultRepository;
  readonly authRepo: AuthRepository;
  readonly marketDataRepo: MarketDataRepository;
  readonly experimentRepo: ExperimentRepository;
  readonly ledgerRepo: LedgerRepository;
  readonly paperAccountRepo: PaperAccountRepository;
  /** Real-venue book: positions, orders and ledger kept apart from paper simulation (audit-3 C2). */
  readonly exchangeLedgerRepo: LedgerRepository;
  readonly exchangeAccountRepo: PaperAccountRepository;
  readonly promotionRepo: PromotionRepository;
  readonly shadowRepo: ShadowRepository;
  readonly strategySpecRepo: StrategySpecRepository;
  readonly fleetRepo: FleetRepository;
  readonly backupService: BackupService;
  readonly rawDb: DatabaseSyncType;
  getPragmaStatus(): SqlitePragmaStatus;
  checkpointWal(): { busy: number; log: number; checkpointed: number };
  close(): void;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS config_snapshots (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  config_hash TEXT NOT NULL,
  config_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  highest_risk_class TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_config_snapshots_created ON config_snapshots(created_at_ms DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  client_ip TEXT NOT NULL,
  action TEXT NOT NULL,
  risk_class TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  details_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_ts ON audit_events(ts DESC, id DESC);

CREATE TABLE IF NOT EXISTS secret_vault (
  key_name TEXT PRIMARY KEY,
  ciphertext_base64 TEXT NOT NULL,
  iv_base64 TEXT NOT NULL,
  auth_tag_base64 TEXT NOT NULL,
  masked_preview TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL UNIQUE,
  password_hash_hex TEXT NOT NULL,
  password_salt_hex TEXT NOT NULL,
  totp_secret_base32 TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_step INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  session_id_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  client_ip TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  last_step_up_at_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at_ms);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  first_attempt_ms INTEGER NOT NULL,
  locked_until_ms INTEGER NOT NULL
);
`;

function mapConfigRow(row: Record<string, unknown>): ConfigSnapshotRecord {
  const rawConfig = JSON.parse(String(row["config_json"])) as unknown;
  return {
    version: Number(row["version"]),
    configHash: String(row["config_hash"]),
    config: KeelConfigSchema.parse(rawConfig),
    actor: String(row["actor"]),
    reason: String(row["reason"]),
    highestRiskClass: ConfigRiskClassSchema.parse(String(row["highest_risk_class"])),
    createdAtMs: Number(row["created_at_ms"])
  };
}

function mapAuditRow(row: Record<string, unknown>): AuditEventRecord {
  const detailsParsed = JSON.parse(String(row["details_json"])) as Record<string, unknown>;
  return {
    id: Number(row["id"]),
    ts: Number(row["ts"]),
    actor: String(row["actor"]),
    clientIp: String(row["client_ip"]),
    action: String(row["action"]),
    riskClass: ConfigRiskClassSchema.parse(String(row["risk_class"])),
    configHash: String(row["config_hash"]),
    details: detailsParsed
  };
}

function mapSecretRow(row: Record<string, unknown>): EncryptedSecretRecord {
  return {
    keyName: SecretKeyNameSchema.parse(String(row["key_name"])),
    ciphertextBase64: String(row["ciphertext_base64"]),
    ivBase64: String(row["iv_base64"]),
    authTagBase64: String(row["auth_tag_base64"]),
    maskedPreview: String(row["masked_preview"]),
    updatedAtMs: Number(row["updated_at_ms"]),
    updatedBy: String(row["updated_by"])
  };
}

export function createSqliteDataStore(options: SqliteDataStoreOptions): SqliteDataStore {
  if (options.dbPath !== ":memory:") {
    mkdirSync(dirname(options.dbPath), { recursive: true });
  }
  const backupsDir = options.backupsDir ?? join(dirname(options.dbPath), "backups");
  const maxBackupsToKeep = options.maxBackupsToKeep ?? 14;

  const db = new DatabaseSync(options.dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA mmap_size = 268435456;
  `);
  db.exec(SCHEMA_SQL);
  db.exec(MARKET_SCHEMA_SQL);
  try {
    db.exec("ALTER TABLE experiments ADD COLUMN num_trials INTEGER NOT NULL DEFAULT 1");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE experiments ADD COLUMN sequence INTEGER");
  } catch {
    // Column already exists
  }
  db.exec(bookSchemaSql("paper"));
  db.exec(bookSchemaSql("exchange"));
  db.exec(PAPER_SCHEMA_SQL);
  db.exec(SPEC_SCHEMA_SQL);
  db.exec(FLEET_SCHEMA_SQL);
  for (const table of ["fleet_bots", "fleet_propositions"]) {
    try {
      // A boat's design was once called its Blueprint (ADR-0034)
      db.exec(`ALTER TABLE ${table} RENAME COLUMN blueprint_json TO rig_json`);
    } catch {
      // Column already renamed
    }
  }
  try {
    db.exec("ALTER TABLE admin_users ADD COLUMN totp_last_step INTEGER");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE strategy_promotions ADD COLUMN promoted_at_ms INTEGER");
  } catch {
    // Column already exists
  }
  try {
    // Rows promoted before the ramp was persisted get the most conservative Live-Ramp tier
    db.exec(
      "ALTER TABLE strategy_promotions ADD COLUMN ramp_allocation_pct REAL NOT NULL DEFAULT 10"
    );
  } catch {
    // Column already exists
  }

  const marketDataRepo = createMarketDataRepository(db);
  const experimentRepo = createExperimentRepository(db, options.clock);
  const strategySpecRepo = createStrategySpecRepository(db, options.clock, experimentRepo);
  const ledgerRepo = createLedgerRepository(
    db,
    options.initialPaperCapitalUsdt ?? "10000.00000000"
  );
  const paperAccountRepo = createPaperAccountRepository(db, options.clock);
  const exchangeLedgerRepo = createLedgerRepository(
    db,
    options.initialPaperCapitalUsdt ?? "10000.00000000",
    "exchange"
  );
  const exchangeAccountRepo = createPaperAccountRepository(db, options.clock, "exchange");
  const promotionRepo = createPromotionRepository(db);
  const shadowRepo = createShadowRepository(db);
  const fleetRepo = createFleetRepository(db);

  // Seed default version 1 config if empty
  const existingCountRow = db.prepare("SELECT COUNT(*) AS cnt FROM config_snapshots").get();
  const existingCount = Number(existingCountRow?.["cnt"] ?? 0);
  if (existingCount === 0) {
    const seedConfig = options.initialConfig ?? createDefaultConfig();
    const seedHash = computeConfigHash(seedConfig);
    db.prepare(
      `INSERT INTO config_snapshots (config_hash, config_json, actor, reason, highest_risk_class, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      seedHash,
      JSON.stringify(seedConfig),
      "system:bootstrap",
      "Initial configuration seed",
      "safe",
      options.clock.nowMs()
    );
  }

  const configRepo: ConfigRepository = {
    getActiveConfig(): ConfigSnapshotRecord {
      const row = db
        .prepare(
          "SELECT version, config_hash, config_json, actor, reason, highest_risk_class, created_at_ms FROM config_snapshots ORDER BY version DESC LIMIT 1"
        )
        .get();
      if (!row) {
        throw new Error("No active configuration snapshot found in SQLite");
      }
      return mapConfigRow(row);
    },

    saveConfigSnapshot(input: SaveConfigSnapshotInput): ConfigSnapshotRecord {
      const validated = KeelConfigSchema.parse(input.config);
      const hash = computeConfigHash(validated);
      const res = db
        .prepare(
          `INSERT INTO config_snapshots (config_hash, config_json, actor, reason, highest_risk_class, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          hash,
          JSON.stringify(validated),
          input.actor,
          input.reason,
          input.highestRiskClass,
          input.createdAtMs
        );
      const insertedVersion = Number(res.lastInsertRowid);
      const saved = this.getVersion(insertedVersion);
      if (!saved) {
        throw new Error(`Failed to load newly saved config version ${insertedVersion}`);
      }
      return saved;
    },

    getHistory(limit = 50): readonly ConfigSnapshotRecord[] {
      const rows = db
        .prepare(
          "SELECT version, config_hash, config_json, actor, reason, highest_risk_class, created_at_ms FROM config_snapshots ORDER BY version DESC LIMIT ?"
        )
        .all(limit);
      return rows.map(mapConfigRow);
    },

    getVersion(version: number): ConfigSnapshotRecord | null {
      const row = db
        .prepare(
          "SELECT version, config_hash, config_json, actor, reason, highest_risk_class, created_at_ms FROM config_snapshots WHERE version = ?"
        )
        .get(version);
      return row ? mapConfigRow(row) : null;
    },

    rollbackToVersion(input: RollbackConfigInput): ConfigSnapshotRecord {
      const target = this.getVersion(input.targetVersion);
      if (!target) {
        throw new Error(`Target configuration version ${input.targetVersion} does not exist`);
      }
      return this.saveConfigSnapshot({
        config: target.config,
        actor: input.actor,
        reason: input.reason,
        highestRiskClass: "confirm",
        createdAtMs: input.createdAtMs
      });
    }
  };

  const auditRepo: AuditRepository = {
    append(event: NewAuditEventInput): AuditEventRecord {
      const res = db
        .prepare(
          `INSERT INTO audit_events (ts, actor, client_ip, action, risk_class, config_hash, details_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          event.ts,
          event.actor,
          event.clientIp,
          event.action,
          event.riskClass,
          event.configHash,
          JSON.stringify(event.details)
        );
      return {
        id: Number(res.lastInsertRowid),
        ...event
      };
    },

    listRecent(limit = 100): readonly AuditEventRecord[] {
      const rows = db
        .prepare(
          "SELECT id, ts, actor, client_ip, action, risk_class, config_hash, details_json FROM audit_events ORDER BY ts DESC, id DESC LIMIT ?"
        )
        .all(limit);
      return rows.map(mapAuditRow);
    },

    countShadowEvaluations(strategyId: string): number {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM audit_events
           WHERE action = 'ai.shadow_evaluate'
             AND json_extract(details_json, '$.strategyId') = ?
             AND json_extract(details_json, '$.shadowPick') IS NOT NULL`
        )
        .get(strategyId);
      return Number((row as Record<string, unknown> | undefined)?.["cnt"] ?? 0);
    }
  };

  const secretVaultRepo: SecretVaultRepository = {
    upsertSecret(record: EncryptedSecretRecord): void {
      db.prepare(
        `INSERT INTO secret_vault (key_name, ciphertext_base64, iv_base64, auth_tag_base64, masked_preview, updated_at_ms, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key_name) DO UPDATE SET
           ciphertext_base64 = excluded.ciphertext_base64,
           iv_base64 = excluded.iv_base64,
           auth_tag_base64 = excluded.auth_tag_base64,
           masked_preview = excluded.masked_preview,
           updated_at_ms = excluded.updated_at_ms,
           updated_by = excluded.updated_by`
      ).run(
        record.keyName,
        record.ciphertextBase64,
        record.ivBase64,
        record.authTagBase64,
        record.maskedPreview,
        record.updatedAtMs,
        record.updatedBy
      );
    },

    getSecret(keyName: SecretKeyName): EncryptedSecretRecord | null {
      const row = db
        .prepare(
          "SELECT key_name, ciphertext_base64, iv_base64, auth_tag_base64, masked_preview, updated_at_ms, updated_by FROM secret_vault WHERE key_name = ?"
        )
        .get(keyName);
      return row ? mapSecretRow(row) : null;
    },

    listSecrets(): readonly EncryptedSecretRecord[] {
      const rows = db
        .prepare(
          "SELECT key_name, ciphertext_base64, iv_base64, auth_tag_base64, masked_preview, updated_at_ms, updated_by FROM secret_vault ORDER BY key_name ASC"
        )
        .all();
      return rows.map(mapSecretRow);
    }
  };

  const authRepo: AuthRepository = {
    getAdminUser(): AdminUserRecord | null {
      const row = db
        .prepare(
          "SELECT username, password_hash_hex, password_salt_hex, totp_secret_base32, totp_enabled, created_at_ms, updated_at_ms FROM admin_users WHERE id = 1"
        )
        .get();
      if (!row) {
        return null;
      }
      return {
        username: String(row["username"]),
        passwordHashHex: String(row["password_hash_hex"]),
        passwordSaltHex: String(row["password_salt_hex"]),
        totpSecretBase32:
          row["totp_secret_base32"] !== null && row["totp_secret_base32"] !== undefined
            ? String(row["totp_secret_base32"])
            : null,
        totpEnabled: Number(row["totp_enabled"]) === 1,
        createdAtMs: Number(row["created_at_ms"]),
        updatedAtMs: Number(row["updated_at_ms"])
      };
    },

    upsertAdminUser(user: AdminUserRecord): void {
      db.prepare(
        `INSERT INTO admin_users (id, username, password_hash_hex, password_salt_hex, totp_secret_base32, totp_enabled, created_at_ms, updated_at_ms)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           username = excluded.username,
           password_hash_hex = excluded.password_hash_hex,
           password_salt_hex = excluded.password_salt_hex,
           totp_secret_base32 = excluded.totp_secret_base32,
           totp_enabled = excluded.totp_enabled,
           updated_at_ms = excluded.updated_at_ms`
      ).run(
        user.username,
        user.passwordHashHex,
        user.passwordSaltHex,
        user.totpSecretBase32,
        user.totpEnabled ? 1 : 0,
        user.createdAtMs,
        user.updatedAtMs
      );
    },

    createSession(session: AdminSessionRecord): void {
      db.prepare(
        `INSERT INTO admin_sessions (session_id_hash, username, client_ip, created_at_ms, expires_at_ms, last_step_up_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        session.sessionIdHash,
        session.username,
        session.clientIp,
        session.createdAtMs,
        session.expiresAtMs,
        session.lastStepUpAtMs
      );
    },

    getSession(sessionIdHash: string): AdminSessionRecord | null {
      const row = db
        .prepare(
          "SELECT session_id_hash, username, client_ip, created_at_ms, expires_at_ms, last_step_up_at_ms FROM admin_sessions WHERE session_id_hash = ?"
        )
        .get(sessionIdHash);
      if (!row) {
        return null;
      }
      return {
        sessionIdHash: String(row["session_id_hash"]),
        username: String(row["username"]),
        clientIp: String(row["client_ip"]),
        createdAtMs: Number(row["created_at_ms"]),
        expiresAtMs: Number(row["expires_at_ms"]),
        lastStepUpAtMs:
          row["last_step_up_at_ms"] !== null && row["last_step_up_at_ms"] !== undefined
            ? Number(row["last_step_up_at_ms"])
            : null
      };
    },

    updateSessionStepUp(sessionIdHash: string, stepUpAtMs: number): void {
      db.prepare("UPDATE admin_sessions SET last_step_up_at_ms = ? WHERE session_id_hash = ?").run(
        stepUpAtMs,
        sessionIdHash
      );
    },

    deleteSession(sessionIdHash: string): void {
      db.prepare("DELETE FROM admin_sessions WHERE session_id_hash = ?").run(sessionIdHash);
    },

    pruneExpiredSessions(nowMs: number): number {
      const res = db.prepare("DELETE FROM admin_sessions WHERE expires_at_ms <= ?").run(nowMs);
      return Number(res.changes);
    },

    consumeTotpStep(step: number): boolean {
      const result = db
        .prepare(
          `UPDATE admin_users SET totp_last_step = ?
           WHERE id = 1 AND (totp_last_step IS NULL OR totp_last_step < ?)`
        )
        .run(step, step);
      return Number(result.changes) === 1;
    },

    getRateLimit(key: string): AuthRateLimitRecord | null {
      const row = db
        .prepare(
          "SELECT key, attempts, first_attempt_ms, locked_until_ms FROM auth_rate_limits WHERE key = ?"
        )
        .get(key);
      if (!row) {
        return null;
      }
      return {
        key: String(row["key"]),
        attempts: Number(row["attempts"]),
        firstAttemptMs: Number(row["first_attempt_ms"]),
        lockedUntilMs: Number(row["locked_until_ms"])
      };
    },

    recordRateLimitAttempt(key: string, nowMs: number, windowMs: number): AuthRateLimitRecord {
      const existing = this.getRateLimit(key);
      let attempts = 1;
      let firstAttemptMs = nowMs;
      let lockedUntilMs = 0;

      if (existing && nowMs - existing.firstAttemptMs <= windowMs) {
        attempts = existing.attempts + 1;
        firstAttemptMs = existing.firstAttemptMs;
        if (attempts >= 5) {
          // 5 failed attempts -> exponential backoff up to 15 minutes (900 seconds)
          const backoffMs = Math.min(15 * 60 * 1000, 60 * 1000 * Math.pow(2, attempts - 5));
          lockedUntilMs = nowMs + backoffMs;
        }
      }

      db.prepare(
        `INSERT INTO auth_rate_limits (key, attempts, first_attempt_ms, locked_until_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           attempts = excluded.attempts,
           first_attempt_ms = excluded.first_attempt_ms,
           locked_until_ms = excluded.locked_until_ms`
      ).run(key, attempts, firstAttemptMs, lockedUntilMs);

      return { key, attempts, firstAttemptMs, lockedUntilMs };
    },

    resetRateLimit(key: string): void {
      db.prepare("DELETE FROM auth_rate_limits WHERE key = ?").run(key);
    }
  };

  let backupSequence = 0;

  const backupService: BackupService = {
    createBackup(): BackupRecord {
      mkdirSync(backupsDir, { recursive: true });
      const nowMs = options.clock.nowMs();
      backupSequence += 1;
      const fileName = `keel-backup-${nowMs}-${String(backupSequence).padStart(3, "0")}.sqlite`;
      const filePath = join(backupsDir, fileName);
      const escapedPath = filePath.replace(/'/g, "''");

      db.exec(`VACUUM INTO '${escapedPath}'`);

      // Verify integrity of the backup snapshot
      const verifyDb = new DatabaseSync(filePath, { readOnly: true });
      let integrityOk = false;
      try {
        const checkRow = verifyDb.prepare("PRAGMA integrity_check").get();
        integrityOk = String(checkRow?.["integrity_check"] ?? "") === "ok";
      } finally {
        verifyDb.close();
      }

      const st = statSync(filePath);

      // Prune older backups beyond maxBackupsToKeep
      const allFiles = readdirSync(backupsDir)
        .filter((f) => f.startsWith("keel-backup-") && f.endsWith(".sqlite"))
        .sort()
        .reverse();

      for (const staleFile of allFiles.slice(maxBackupsToKeep)) {
        rmSync(join(backupsDir, staleFile), { force: true });
      }

      return {
        fileName,
        filePath,
        sizeBytes: st.size,
        createdAtMs: nowMs,
        integrityOk
      };
    },

    listBackups(): readonly BackupRecord[] {
      mkdirSync(backupsDir, { recursive: true });
      const files = readdirSync(backupsDir)
        .filter((f) => f.startsWith("keel-backup-") && f.endsWith(".sqlite"))
        .sort()
        .reverse();

      return files.map((fileName) => {
        const filePath = join(backupsDir, fileName);
        const st = statSync(filePath);
        const match = /^keel-backup-(\d+)-/.exec(fileName);
        const createdAtMs = match?.[1] ? Number(match[1]) : Math.trunc(st.mtimeMs);
        return {
          fileName,
          filePath,
          sizeBytes: st.size,
          createdAtMs,
          integrityOk: true
        };
      });
    }
  };

  return {
    configRepo,
    auditRepo,
    secretVaultRepo,
    authRepo,
    marketDataRepo,
    experimentRepo,
    ledgerRepo,
    paperAccountRepo,
    exchangeLedgerRepo,
    exchangeAccountRepo,
    promotionRepo,
    shadowRepo,
    fleetRepo,
    strategySpecRepo,
    backupService,
    rawDb: db,

    getPragmaStatus(): SqlitePragmaStatus {
      const jm = db.prepare("PRAGMA journal_mode").get();
      const sync = db.prepare("PRAGMA synchronous").get();
      const fk = db.prepare("PRAGMA foreign_keys").get();
      return {
        journalMode: String(jm?.["journal_mode"] ?? ""),
        synchronous: Number(sync?.["synchronous"] ?? 0),
        foreignKeys: Number(fk?.["foreign_keys"] ?? 0)
      };
    },

    createBackup(): BackupRecord {
      return backupService.createBackup();
    },

    listBackups(): readonly BackupRecord[] {
      return backupService.listBackups();
    },

    checkpointWal(): { busy: number; log: number; checkpointed: number } {
      if (options.dbPath === ":memory:") {
        return { busy: 0, log: 0, checkpointed: 0 };
      }
      const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      return {
        busy: Number(row?.["busy"] ?? 0),
        log: Number(row?.["log"] ?? 0),
        checkpointed: Number(row?.["checkpointed"] ?? 0)
      };
    },

    close(): void {
      try {
        this.checkpointWal();
      } catch {
        // Ignore checkpoint error if already closed
      }
      db.close();
    }
  };
}
