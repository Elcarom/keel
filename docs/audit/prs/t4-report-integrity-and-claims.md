# PR: T4 — Report Integrity, Master Key Hardening, and Claims Verification (D1, S1)

## Summary

This PR addresses all requirements under Ticket T4:

1. **Master Key Entropy & Pattern Hardening (S1)**:
   - Validates that `KEEL_MASTER_KEY` contains at least 12 distinct characters to prevent trivial repeat patterns (`Set(masterKey).size >= 12`).
   - Case-insensitively rejects known template placeholder substrings (`your-random`, `change-me`).
   - Updates `README.md` and `docs/runbooks/go-live-checklist.md` to instruct operators to generate production master keys with `openssl rand -base64 48`.
   - Documented in `docs/audit/assumptions.md` (`A-S1`).

2. **Phase D Empirical In-Sample Report Integrity & Sensitivity (D1, N2)**:
   - Evaluates in-sample performance strictly on 2023-01-01 to 2024-12-31 UTC (2 calendar years) with zero lookahead, next-bar open execution, gap slippage, and 2x cost stress.
   - Evaluates strategy-specific walk-forward CV across 5 purged folds to report honest per-strategy out-of-sample expectancy (fixing N2c).
   - Accurately accounts for the research trial universe using `getTrialCount()`, passing `numTrials = max(persistedTrials, 3)` (fixing N2b).
   - Honestly reports settled funding coverage (seed disclosure, fixing N2a) and includes an empirical 5-scenario funding rate sensitivity analysis ($[-0.005\%, +0.020\%]$ per 8h).
   - Accurately states that candidate strategies achieve low/zero DSR primarily because in-sample raw annualized Sharpe is non-positive or near-zero under realistic execution friction.
   - Preserves sealed holdout partitions: marks 2025 as scientifically spent (`NOT REGENERATED`), and leaves 2026 quarantined with 0 touches.

3. **Documentation Claims Checker (`docs/claims.json` & `scripts/check-claims.js`)**:
   - Implements automated claims verification tool `scripts/check-claims.js` and `pnpm check-claims`.
   - Seeds `docs/claims.json` with 43 comprehensive claims covering `README.md`, ADRs 0006–0019, and the go-live checklist.
   - Integrates `pnpm check-claims` into `.github/workflows/ci.yml`.

## Changes

- **`packages/api/src/security.ts` & `packages/api/test/security.test.ts`**:
  - Added character diversity and placeholder substring validation to `validateMasterKey`.
  - Added TDD unit tests verifying rejection of low-entropy keys and placeholder patterns.
- **`packages/replay/src/index.ts`**:
  - Added `randomEntryPaths?: number` to `ReplayRunInput` to allow configurable baseline path counts for sensitivity analysis.
- **`scripts/run-phase-d-evaluation.js`**:
  - Integrated persisted trial count reading from `store.experimentRepo.getTrialCount()`.
  - Added 5-scenario funding rate sensitivity evaluation across all candidate pairs.
  - Formatted funding sensitivity table and updated DSR disclosure in `docs/research/phase-d-results.md`.
- **`scripts/check-claims.js` & `docs/claims.json`**:
  - Created automated claims verification suite covering 43 architectural and operational claims.
- **`README.md` & `docs/runbooks/go-live-checklist.md`**:
  - Hardened key generation documentation to use `openssl rand -base64 48`.
- **`.github/workflows/ci.yml` & `package.json`**:
  - Added `check-claims` npm script and CI step.

## Verification

- `pnpm check-claims`: 43/43 claims passing with 0 failures.
- `pnpm test`: All unit and property tests passing.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`: Passing cleanly.
