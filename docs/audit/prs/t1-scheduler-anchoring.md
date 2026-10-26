# PR: T1 Scheduler Anchoring and 2026 Quarantine Exclusion (C2)

## Summary

Remediates defect **C2** from the audit:

- Introduced `scheduler_anchors` table (`instrument_id`, `strategy_id`, `anchor_close_ts`, `created_at_ms`) in `@keel/data` and wired `getSchedulerAnchor` / `setSchedulerAnchor` into `PaperAccountRepository`.
- On first step for any newly enabled `(instrument, strategy)`, the scheduler anchors at the latest confirmed bar at the time of enabling (`nowMs`), recording both anchor and processed bar timestamps.
- Bars at or before the anchor are never evaluated by the scheduler or paper broker.
- Bars with `openTs >= SEALED_2026_HOLDOUT_START_TS` are excluded from scheduler evaluation unless they represent the live present (`closeTs` within 2 hours of `clock.nowMs()`), and are advanced forward to prevent execution loops.

## Tests Added & Verified

- `packages/api/test/scheduler.test.ts`:
  - `C2: newly enabled (instrument, strategy) anchors at latest confirmed bar and excludes quarantined 2026 bars (zero ticks on 20,000 history bars)`: seeds 20,000 confirmed bars spanning past 2026-01-01 into SQLite, enables a new strategy, and proves zero ticks are executed on history while properly persisting the anchor.
  - Backlog tests updated with explicit anchor initialization to verify chronological catch-up on bars arriving after strategy enablement.

## Verification

- `pnpm test`: 21 test files, 143 tests passing.
- `pnpm typecheck`: Clean across all workspace packages.
- `pnpm lint`: Clean with 0 errors and 0 warnings.
- `pnpm format:check`: Clean across all files.
