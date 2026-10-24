# Runbook: Backup & Restore on Unraid

Keel stores all operational state, configuration versions, audit logs, and historical bars in a single SQLite (WAL) database under `/data/keel.db` (`/mnt/user/appdata/keel/data/keel.db` on Unraid), alongside the encryption key `/data/secret.key` ([ADR-0004](../adr/0004-sqlite-wal-behind-repository-ports.md)).

---

## 1. Creating an Atomic Backup

### From the Dashboard UI

1. Navigate to **System → Backups & Restore**.
2. Click **Create Backup Now**.
3. Keel executes SQLite's atomic `VACUUM INTO '/backups/keel-backup-<timestamp>.db'`, producing a self-contained, consistent single-file snapshot with zero lock contention on live reads.

### From the Unraid Terminal (CLI)

```bash
docker exec keel sqlite3 /data/keel.db "VACUUM INTO '/backups/keel-manual-$(date -u +%Y%m%dT%H%M%SZ).db';"
```

> **Important**: Keep an offline backup of `/mnt/user/appdata/keel/data/secret.key` in your password manager. Without `secret.key`, encrypted exchange and Gemini API keys in a restored database cannot be decrypted (though all ledger, config, and candle data remain intact).

---

## 2. Restoring from a Backup

1. **Stop the Keel container** on Unraid so no process holds open WAL descriptors:
   ```bash
   docker stop keel
   ```
2. **Move the existing database and WAL files aside**:
   ```bash
   cd /mnt/user/appdata/keel/data
   mv keel.db keel.db.pre-restore-$(date -u +%s)
   rm -f keel.db-wal keel.db-shm
   ```
3. **Copy the target backup snapshot into `/data/keel.db` and fix ownership**:
   ```bash
   cp /mnt/user/appdata/keel/backups/keel-backup-<timestamp>.db /mnt/user/appdata/keel/data/keel.db
   chown 99:100 /mnt/user/appdata/keel/data/keel.db
   ```
4. **Verify SQLite integrity before starting**:
   ```bash
   sqlite3 /mnt/user/appdata/keel/data/keel.db "PRAGMA integrity_check;"
   # Must output: ok
   ```
5. **Start the container and verify `/healthz` and reconciliation**:
   ```bash
   docker start keel
   wget -qO- http://127.0.0.1:8080/healthz
   ```
