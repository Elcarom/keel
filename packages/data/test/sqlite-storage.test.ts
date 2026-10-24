import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock, createDefaultConfig } from "@keel/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteDataStore } from "../src/index.js";

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
});
