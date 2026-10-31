import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ManualClock, createDefaultConfig, normalizeRig } from "@keel/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteDataStore, seedSyntheticMarketSeries } from "../src/index.js";

describe("@keel/data — SQLite (WAL) Storage Engine & Repository Ports", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "keel-data-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("initializes WAL pragmas, seeds version 1 config, persists versions, and rolls back atomically", () => {
    const dbPath = join(tempDir, "keel.sqlite");
    const clock = new ManualClock(1_730_000_000_000);
    const store = createSqliteDataStore({ dbPath, clock });

    try {
      const pragmas = store.getPragmaStatus();
      expect(pragmas.journalMode.toLowerCase()).toBe("wal");
      expect(pragmas.foreignKeys).toBe(1);

      const v1 = store.configRepo.getActiveConfig();
      expect(v1.version).toBe(1);
      expect(v1.config.system.executionMode).toBe("Paper");
      expect(v1.actor).toBe("system:bootstrap");

      clock.advanceMs(5_000);
      const nextConfig = {
        ...createDefaultConfig(),
        ai: {
          ...createDefaultConfig().ai,
          dailyBudgetUsd: 0.5
        }
      };

      const v2 = store.configRepo.saveConfigSnapshot({
        config: nextConfig,
        actor: "admin",
        reason: "Tighten daily Gemini cap",
        highestRiskClass: "confirm",
        createdAtMs: clock.nowMs()
      });

      expect(v2.version).toBe(2);
      expect(v2.config.ai.dailyBudgetUsd).toBe(0.5);
      expect(v2.configHash).not.toBe(v1.configHash);

      clock.advanceMs(5_000);
      const v3 = store.configRepo.rollbackToVersion({
        targetVersion: 1,
        actor: "admin",
        reason: "Revert to default budget",
        createdAtMs: clock.nowMs()
      });

      expect(v3.version).toBe(3);
      expect(v3.configHash).toBe(v1.configHash);
      expect(v3.config.ai.dailyBudgetUsd).toBe(0.75);

      const history = store.configRepo.getHistory(10);
      expect(history.map((h) => h.version)).toEqual([3, 2, 1]);
    } finally {
      store.close();
    }
  });

  it("appends immutable audit records and persists encrypted secrets and admin sessions", () => {
    const dbPath = join(tempDir, "keel.sqlite");
    const clock = new ManualClock(1_730_000_000_000);
    const store = createSqliteDataStore({ dbPath, clock });

    try {
      const a1 = store.auditRepo.append({
        ts: clock.nowMs(),
        actor: "admin",
        clientIp: "203.0.113.42",
        action: "auth.bootstrap",
        riskClass: "confirm",
        configHash: store.configRepo.getActiveConfig().configHash,
        details: { totpEnrolled: false }
      });
      expect(a1.id).toBe(1);

      clock.advanceMs(1_000);
      store.auditRepo.append({
        ts: clock.nowMs(),
        actor: "admin",
        clientIp: "203.0.113.42",
        action: "secret.upsert",
        riskClass: "confirm",
        configHash: store.configRepo.getActiveConfig().configHash,
        details: { keyName: "geminiApiKey" }
      });

      const recent = store.auditRepo.listRecent(10);
      expect(recent).toHaveLength(2);
      expect(recent[0]?.action).toBe("secret.upsert");
      expect(recent[1]?.action).toBe("auth.bootstrap");

      // Secret Vault repository
      store.secretVaultRepo.upsertSecret({
        keyName: "geminiApiKey",
        ciphertextBase64: "Y2lwaGVydGV4dA==",
        ivBase64: "aXYxMjM0NTY3ODkw",
        authTagBase64: "dGFnMTIzNDU2Nzg5MA==",
        maskedPreview: "AIza...9xQp",
        updatedAtMs: clock.nowMs(),
        updatedBy: "admin"
      });

      const secret = store.secretVaultRepo.getSecret("geminiApiKey");
      expect(secret?.maskedPreview).toBe("AIza...9xQp");
      expect(store.secretVaultRepo.listSecrets()).toHaveLength(1);

      // Auth repository (admin user + sessions)
      expect(store.authRepo.getAdminUser()).toBeNull();
      store.authRepo.upsertAdminUser({
        username: "captain",
        passwordHashHex: "abcd1234",
        passwordSaltHex: "ef012345",
        totpSecretBase32: "JBSWY3DPEHPK3PXP",
        totpEnabled: true,
        createdAtMs: clock.nowMs(),
        updatedAtMs: clock.nowMs()
      });
      expect(store.authRepo.getAdminUser()?.username).toBe("captain");

      store.authRepo.createSession({
        sessionIdHash: "hash-1",
        username: "captain",
        clientIp: "203.0.113.42",
        createdAtMs: clock.nowMs(),
        expiresAtMs: clock.nowMs() + 60_000,
        lastStepUpAtMs: null
      });
      expect(store.authRepo.getSession("hash-1")?.lastStepUpAtMs).toBeNull();

      clock.advanceMs(5_000);
      store.authRepo.updateSessionStepUp("hash-1", clock.nowMs());
      expect(store.authRepo.getSession("hash-1")?.lastStepUpAtMs).toBe(clock.nowMs());

      clock.advanceMs(120_000);
      const pruned = store.authRepo.pruneExpiredSessions(clock.nowMs());
      expect(pruned).toBe(1);
      expect(store.authRepo.getSession("hash-1")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("performs atomic online VACUUM INTO backups, verifies integrity, and prunes old backups", () => {
    const dbPath = join(tempDir, "keel.sqlite");
    const backupsDir = join(tempDir, "backups");
    const clock = new ManualClock(1_730_000_000_000);
    const store = createSqliteDataStore({ dbPath, clock, backupsDir, maxBackupsToKeep: 2 });

    try {
      const b1 = store.createBackup();
      expect(b1.integrityOk).toBe(true);
      expect(b1.sizeBytes).toBeGreaterThan(0);

      clock.advanceMs(60_000);
      const b2 = store.createBackup();
      expect(b2.integrityOk).toBe(true);

      clock.advanceMs(60_000);
      const b3 = store.createBackup();
      expect(b3.integrityOk).toBe(true);

      const kept = store.backupService.listBackups();
      expect(kept).toHaveLength(2);
      expect(kept.map((b) => b.fileName)).toEqual([b3.fileName, b2.fileName]);

      // Verify wal_checkpoint(TRUNCATE) resets WAL log frames to 0
      const walStats = store.checkpointWal();
      expect(walStats.busy).toBe(0);
      expect(walStats.log).toBe(0);
    } finally {
      store.close();
    }

    const walPath = `${dbPath}-wal`;
    if (existsSync(walPath)) {
      expect(statSync(walPath).size).toBe(0);
    }
  });

  it("keeps a boat's Rig from a database written when it was called a Blueprint", () => {
    const dbPath = join(tempDir, "keel.sqlite");
    const clock = new ManualClock(1_730_000_000_000);
    const rig = normalizeRig({
      name: "Old Salt",
      tagline: "Sailed before the rename.",
      archetype: "momentum",
      instrumentId: "BTC-USDT-SWAP",
      direction: "both",
      lookbackPeriod: 12,
      fastPeriod: 6,
      entryThreshold: 1,
      stopAtrMultiple: 2,
      rewardMultiple: 2,
      rationale: "Impulses persist."
    });
    const first = createSqliteDataStore({ dbPath, clock });
    first.fleetRepo.saveBot({
      botId: "bot-1",
      name: "Old Salt",
      tagline: rig.tagline,
      rig,
      walletId: "wallet-1",
      allocationUsdt: "1000.00000000",
      status: "running",
      statusReason: null,
      createdAtMs: clock.nowMs(),
      retiredAtMs: null,
      propositionId: null,
      backtest: null
    });
    first.close();
    // The column as an older Keel wrote it
    const raw = new DatabaseSync(dbPath);
    raw.exec("ALTER TABLE fleet_bots RENAME COLUMN rig_json TO blueprint_json");
    raw.exec("ALTER TABLE fleet_propositions RENAME COLUMN rig_json TO blueprint_json");
    raw.close();

    const reopened = createSqliteDataStore({ dbPath, clock });
    try {
      expect(reopened.fleetRepo.getBot("bot-1")?.rig).toEqual(rig);
    } finally {
      reopened.close();
    }
  });

  it("purges synthetic series an older Keel wrote under real market ids, once", () => {
    const dbPath = join(tempDir, "keel.sqlite");
    const clock = new ManualClock(1_793_000_000_000);
    const windowFrom = Date.UTC(2022, 11, 2);
    const bars1H = (instrumentId: string) =>
      store.marketDataRepo.getConfirmedBarsInRange({
        instrumentId,
        timeframe: "1H",
        fromOpenTs: 0,
        toCloseTs: Date.UTC(2027, 0, 1)
      }).length;

    let store = createSqliteDataStore({ dbPath, clock });
    const seed = (instrumentId: string, endCloseTs: number) =>
      seedSyntheticMarketSeries({
        marketDataRepo: store.marketDataRepo,
        instrumentId,
        endCloseTs,
        barCount1H: 48
      });
    // The Fleet's old fallback when OKX was unreachable
    seed("BTC-USDT-SWAP", Date.UTC(2024, 11, 1));
    store.fleetRepo.setBacktestDataSource("BTC-USDT-SWAP", windowFrom, "synthetic");
    // The Research Lab's old seed, later taken for OKX history by the Fleet
    seed("SOL-USDT-SWAP", Date.UTC(2024, 11, 1));
    store.fleetRepo.setBacktestDataSource("SOL-USDT-SWAP", windowFrom, "okx");
    store.auditRepo.append({
      ts: clock.nowMs(),
      actor: "operator",
      clientIp: "203.0.113.9",
      action: "market.seed_synthetic",
      riskClass: "safe",
      configHash: "c".repeat(64),
      details: { instrumentId: "SOL-USDT-SWAP", barCount1H: 48 }
    });
    // Untouched: real history, live bars after the in-sample years, and SYN- research series
    seed("ETH-USDT-SWAP", Date.UTC(2024, 11, 1));
    store.fleetRepo.setBacktestDataSource("ETH-USDT-SWAP", windowFrom, "okx");
    seed("BTC-USDT-SWAP", Date.UTC(2026, 9, 1));
    seed("SYN-BTC-USDT-SWAP", Date.UTC(2024, 11, 1));
    store.close();
    // As a database from before the purge existed
    const raw = new DatabaseSync(dbPath);
    raw.exec("DELETE FROM data_migrations");
    raw.close();

    store = createSqliteDataStore({ dbPath, clock });
    try {
      expect(bars1H("BTC-USDT-SWAP")).toBe(48);
      expect(
        store.marketDataRepo.getSettledFundingInRange({
          instrumentId: "BTC-USDT-SWAP",
          fromTs: 0,
          toTs: Date.UTC(2025, 0, 1)
        })
      ).toEqual([]);
      expect(store.fleetRepo.getBacktestDataSource("BTC-USDT-SWAP", windowFrom)).toBeNull();
      expect(bars1H("SOL-USDT-SWAP")).toBe(0);
      expect(store.fleetRepo.getBacktestDataSource("SOL-USDT-SWAP", windowFrom)).toBeNull();
      expect(bars1H("ETH-USDT-SWAP")).toBe(48);
      expect(store.fleetRepo.getBacktestDataSource("ETH-USDT-SWAP", windowFrom)).toBe("okx");
      expect(bars1H("SYN-BTC-USDT-SWAP")).toBe(48);

      // Once only: history fetched afresh after the purge stays
      seed("SOL-USDT-SWAP", Date.UTC(2024, 11, 1));
    } finally {
      store.close();
    }
    store = createSqliteDataStore({ dbPath, clock });
    try {
      expect(bars1H("SOL-USDT-SWAP")).toBe(48);
    } finally {
      store.close();
    }
  });
});
