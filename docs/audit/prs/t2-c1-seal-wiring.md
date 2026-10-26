# PR: T2 — Replay 2026 Holdout Seal Wiring & Atomic Token Consumption (C1)

## Summary

Remediates defect C1 where:

1. `server.ts` derived `reaches2026Holdout` from stored coverage (`latestCloseTs >= SEALED_2026_HOLDOUT_START_TS`) rather than from the requested/effective range `[effectiveFromTs, effectiveToTs]`. Consequently, once live bars were ingested into 2026, in-sample replays were erroneously rejected unless a holdout token existed.
2. The server previously self-granted `allowHoldoutAccess = reaches2026Holdout || ...`.
3. `ReplayEngine.run` previously consumed the single-use holdout token at the start of `run()` before data lookup or simulation execution. Any error during simulation consumed the single-use token prematurely.

## Changes

- **`@keel/core`**:
  - Updated `replay.runBacktest` request schema in `packages/core/src/contract.ts` to accept `fromTs`, `toTs`, and `allowHoldoutAccess: z.boolean().default(false).optional()`.
  - Added `SaveExperimentOptions` interface to `packages/core/src/ports.ts` with `consumeHoldoutPartition?: string` and `nowMs?: number`.
  - Updated `ExperimentRepository.saveExperiment` interface to accept `SaveExperimentOptions`.
  - Re-exported `SaveExperimentOptions` in `packages/core/src/index.ts`.
- **`@keel/data`**:
  - Implemented transactional `saveExperiment` in `createExperimentRepository` (`packages/data/src/market.ts`) using `BEGIN IMMEDIATE` / `COMMIT`.
  - When `options?.consumeHoldoutPartition` is provided, selects the next unused token, consumes it with `UPDATE holdout_tokens`, and inserts the experiment atomically in the same transaction. If no unused token exists, throws an error and rolls back.
- **`@keel/replay`**:
  - Updated `ReplayEngine.run`: checks holdout access authorization and token availability upfront without consuming the token.
  - Passes `{ consumeHoldoutPartition: "2026_holdout", nowMs: this.clock.nowMs() }` to `saveExperiment` only when `touches2026Holdout` is true.
  - Ensures failed runs (e.g. strategy throws, invalid bounds) do not consume the single-use token.
- **`@keel/api`**:
  - Updated `server.ts`: derives `reaches2026Holdout` strictly from `effectiveFromTs >= SEALED_2026_HOLDOUT_START_TS || effectiveToTs >= SEALED_2026_HOLDOUT_START_TS`.
  - Default `effectiveToTs` truncates to `SEALED_HOLDOUT_START_TS` for in-sample coverage.
  - Server never self-grants `allowHoldoutAccess = true`; it strictly passes `Boolean(body.allowHoldoutAccess)`.
  - If `reaches2026Holdout`, requires explicit `body.allowHoldoutAccess === true` AND an unused token in the repository.

## Verification

- Added test in `packages/replay/test/holdout-seal-2026.test.ts` proving that a failure during replay simulation does not consume the single-use token, and that successful execution consumes the token atomically with experiment persistence.
- Added test in `packages/api/test/server.test.ts` proving that an in-sample replay succeeds without a holdout token even when stored coverage extends past 2026-01-01, and that requests reaching into 2026 without `allowHoldoutAccess` or without a token are strictly rejected with status 400.
- Full test suite passing (21 test files, 144 tests).
- Strict typecheck, lint, and Prettier formatting verified.
