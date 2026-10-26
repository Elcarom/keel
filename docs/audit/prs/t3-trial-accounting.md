# Pull Request: Ticket T3 — Trial Accounting, Immutable Experiments, and Holdout Seal (R2, R4)

## Summary of Changes

### 1. Monotonic Research Trial Counter (R2)

- Added persisted table `research_trials` to SQLite schema (`MARKET_SCHEMA_SQL`):
  - Primary key: `(strategy_id, parameter_hash, instrument_id, timeframe)`.
  - Durably records distinct research experiment trials; monotonic count never decreases across server restarts.
- Extended `ExperimentRepository` interface with `recordTrial` and `getTrialCount`.
- Wired server replay route (`POST /api/v1/replay/run`) to record each trial and supply `numTrials` to `ReplayEngine.run`, resolving N2b DSR trial deflation distortion.

### 2. Immutable Experiment Records & Persisted Sequence (R2)

- Added `sequence INTEGER PRIMARY KEY AUTOINCREMENT` and `experiment_id TEXT UNIQUE NOT NULL` to `experiments` table.
- Replaced `INSERT OR REPLACE` with immutable plain `INSERT INTO experiments`, preventing historical tampering or silent overwrites. Attempting to insert a duplicate `experimentId` throws a constraint violation.
- Added automatic migration column for `sequence` in existing databases.

### 3. Sealed 2026 Holdout Partition & Single-Use Authorization Token (R4)

- Exported exact constants from `@keel/core`:
  - `SEALED_2026_HOLDOUT_START_TS = 1_767_225_600_000` (2026-01-01 00:00:00 UTC)
  - `SEALED_2026_HOLDOUT_END_TS = 1_782_863_999_000` (2026-06-30 23:59:59 UTC)
- Added persistent table `holdout_tokens` with single-use consumption semantics:
  - Methods: `createHoldoutToken`, `consumeHoldoutToken`, `hasUnusedHoldoutToken`.
- Enforced rejection in `ReplayEngine.run`:
  - Access at or after `SEALED_2026_HOLDOUT_START_TS` is strictly rejected unless `allowHoldoutAccess: true` AND a valid token is consumed from the database.
- Enforced rejection in walk-forward cross-validation folds:
  - `computePurgedWalkForwardOosExpectancy` immediately rejects if any confirmed bar has `openTs >= SEALED_2026_HOLDOUT_START_TS`.
- Enforced rejection in API server route (`replay.runBacktest`):
  - Requests reaching the 2026 holdout require an unused holdout token in the database.

### 4. Verification

- `packages/data/test/trial-accounting-and-holdout.test.ts`:
  - Verifies trial counting monotonicity across store restarts.
  - Verifies immutable plain INSERT throwing on duplicate experiment ID.
  - Verifies single-use holdout token creation and consumption.
  - Verifies exact constant exports per ADR-0011.
- `packages/replay/test/holdout-seal-2026.test.ts`:
  - Verifies `ReplayEngine.run` rejection when `allowHoldoutAccess` is false.
  - Verifies `ReplayEngine.run` rejection when no token exists in the database.
  - Verifies single-use token consumption and subsequent rejection on second attempt.
  - Verifies walk-forward fold rejection on confirmed bars extending into 2026 holdout.
- `packages/api/test/server.test.ts`:
  - Verifies server route records trials and passes incremented `numTrials`.
- All 19 test suites and 127 tests pass; 100% typecheck and ESLint clean.
