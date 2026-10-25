# 0011. Sealed 2026 Holdout Partition and Quarantine

**Status**: accepted

## Context

The sealed 2025 holdout partition (`2025-01-01 00:00:00 UTC` to `2025-12-31 23:59:59 UTC`, timestamps `1735689600000` to `1767225600000`) was evaluated during the Phase D empirical verification round. Because that dataset was observed and published in `docs/research/phase-d-results.md`, it has been scientifically spent and can no longer serve as an uncorrupted out-of-sample holdout for newly formulated strategy hypotheses.

Without a strictly quarantined forward holdout partition, future research iterations risk subtle look-ahead contamination, parameter snooping, and selection bias.

## Decision

1. **Quarantine Definition for 2026 Holdout**:
   A new sealed holdout partition is established spanning:
   - **Start**: `2026-01-01 00:00:00 UTC` (`1767225600000` ms)
   - **End**: `2026-06-30 23:59:59 UTC` (`1782863999000` ms)
   This partition comprises 6 months of confirmed 1H market bars and settled funding rates.

2. **Codebase Constants & Enforcement**:
   Explicit constants are exported from `@keel/core`:
   - `SEALED_2026_HOLDOUT_START_TS = 1767225600000`
   - `SEALED_2026_HOLDOUT_END_TS = 1782863999000`
   `ReplayEngine.run()` strictly enforces that no calibration, in-sample fitting, or cross-validation fold accesses bars with `openTs >= SEALED_2026_HOLDOUT_START_TS` unless explicit, single-shot post-calibration evaluation is authorized.

3. **Zero Evaluation Mandate**:
   During the remediation of audit defects (Tickets A–E), **zero** simulation runs or strategy evaluations may be executed against data on or after `SEALED_2026_HOLDOUT_START_TS`. All current in-sample model evaluations, property tests, and unit tests are strictly restricted to the pre-2025 in-sample dataset (`2023-01-01` to `2024-12-31 UTC`).
