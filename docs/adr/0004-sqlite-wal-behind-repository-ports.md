# 0004. Single-Container SQLite (WAL) Behind Repository Interfaces

**Status**: accepted

We use **SQLite in WAL mode (`better-sqlite3` + Drizzle ORM)** behind explicit repository interfaces (`MarketDataRepository`, `LedgerRepository`, `AuditRepository`, `ExperimentRepository`, `ConfigRepository`) for both operational state (orders, fills, ledger, audit tables, config versions, AI logs) and the 3-year historical bar and settled-funding store. We reject running a separate Postgres container or maintaining a dual SQLite + DuckDB/Parquet primary store.

## Context & Trade-offs

- **Data volume fits comfortably in memory-mapped SQLite**: 20 instruments across `15m`, `1H`, `4H`, and `1D` over 3 years is `~2.78M` candle rows and `~65k` settled funding rows (`~220 MB` on disk). With a composite clustered index on `(instrument_id, timeframe, open_ts)` and `mmap_size = 256MB`, in-process synchronous reads scan a 3-year instrument series in `<15ms` without IPC or socket overhead.
- **Single-file atomic backups on Unraid**: Online backups to the mounted `/backups` volume use SQLite's native `VACUUM INTO` / `.backup()` API, guaranteeing a consistent point-in-time snapshot of both market data and ledger state in one file.
- **Escape hatch preserved**: Because domain and application packages depend only on repository interfaces, a Postgres or DuckDB adapter can be swapped in later if tick-level L2 archival grows beyond tens of gigabytes.

