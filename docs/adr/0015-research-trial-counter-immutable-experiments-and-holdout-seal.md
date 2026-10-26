# ADR-0015: Persisted Research Trial Counter, Immutable Experiment History, & Sealed 2026 Holdout Enforcement

## Status

Accepted

## Context

A second independent audit identified three critical statistical and protocol vulnerabilities in research accounting and holdout quarantine:

1. **DSR Trial Count Dependency (N2b / R2)**: `ReplayEngine` derived `numTrials` for Deflated Sharpe Ratio (DSR) from `experiments.count()`, making DSR sequence-dependent (first run had trials=1, inflating DSR).
2. **Experiment Overwriting Vulnerability (R2)**: `createExperimentRepository` used `INSERT OR REPLACE INTO experiments`, allowing previous experiment records to be silently overwritten or modified.
3. **Quarantined 2026 Holdout Protection (R4)**: The sealed 2025 holdout was spent during Phase D verification. ADR-0011 established the 2026 forward holdout partition (`2026-01-01 00:00:00 UTC` to `2026-06-30 23:59:59 UTC`), but the codebase lacked runtime gatekeepers preventing accidental access, fold contamination, or unauthenticated evaluation.

## Decision

1. **Persisted Research Trial Counter (`research_trial_counter`)**:
   - Persist distinct research trials in SQLite table `research_trial_counter`:
     `(trial_key TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, parameter_hash TEXT NOT NULL, instrument_id TEXT NOT NULL, timeframe TEXT NOT NULL, recorded_at_ms INTEGER NOT NULL)`.
   - Key: `${strategyId}:${parameterHash}:${instrumentId}:${timeframe}`.
   - `getTrialCount()` returns the distinct count ever recorded. The counter is strictly monotonic and never decreases.
   - The server replay route records trials and passes `getTrialCount()` as `numTrials` to `ReplayEngine.run()`.
2. **Immutable Experiment Records**:
   - Replace `INSERT OR REPLACE` with plain `INSERT` in `ExperimentRepository.saveExperiment`.
   - Any attempt to overwrite an existing `experimentId` throws a PRIMARY KEY constraint violation, guaranteeing experiment history is strictly append-only.
3. **Quarantined 2026 Holdout Enforcement (R4)**:
   - Export constants from `@keel/core`:
     - `SEALED_2026_HOLDOUT_START_TS = 1767225600000` (2026-01-01 00:00:00 UTC)
     - `SEALED_2026_HOLDOUT_END_TS = 1782863999000` (2026-06-30 23:59:59 UTC)
   - Store single-use authorization tokens in SQLite table `holdout_tokens (token TEXT PRIMARY KEY, partition TEXT NOT NULL, created_at_ms INTEGER NOT NULL, used_at_ms INTEGER)`.
   - `ReplayEngine.run`, walk-forward cross-validation folds, and the API route `POST /api/v1/replay/run` strictly reject any access with `toTs >= SEALED_2026_HOLDOUT_START_TS` or bars in that range unless:
     `allowHoldoutAccess === true` AND a single-use token exists and is consumed.
   - Zero evaluations may be performed on the sealed 2026 holdout dataset; only rejection paths are tested.

## Consequences

- Deflated Sharpe Ratio calculation is rigorous, monotonic, and independent of run order.
- Guarantees complete immutability for all historical backtest and calibration records.
- Protects the 2026 holdout partition against accidental leakage or premature observation.
