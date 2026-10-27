# PR: T1 — Scheduler Anchor to Now & Stale DB Gap Exclusion (A1)

## Summary

This PR resolves defect A1:

- On enabling, the scheduler anchors a newly enabled `(instrument, strategy)` directly to the current scheduler wall-clock time: `anchor_close_ts = floor(clock.nowMs()/1h)*1h` (the close of the most recent fully closed bar).
- Anchor creation no longer relies on whether the database has stored bars. Existing anchors are never moved.
- Bars with `closeTs <= anchor` are never evaluated, regardless of stored coverage.
- If the database is stale (e.g. 30 days behind live time), the ingestor still fetches the gap to update market data coverage, but the scheduler executes zero ticks on all gap bars.
- Preserves the quarantine skip for bars with `closeTs >= SEALED_2026_HOLDOUT_START_TS` unless within 2 hours of `clock.nowMs()`.

## Changes

- **`packages/api/src/scheduler.ts`**:
  - Sets `anchorCloseTs = Math.floor(nowMs / 3600_000) * 3600_000` when `existingAnchor === null`.
  - Records the anchor and processed bar without depending on database coverage.
  - Ensures bars closing at or before `anchorCloseTs` are excluded from tick evaluation.
  - Strengthened 2026 quarantine check to check both `closeTs` and `openTs`.
- **`packages/api/test/scheduler.test.ts`**:
  - Added regression test `A1: newly enabled strategy anchors to floor(clock.nowMs()/1h)*1h and never ticks 30-day stale gap bars`.
- **`docs/audit/assumptions.md`**:
  - Recorded assumption `A-A1`.
- **`docs/claims.json`**:
  - Added claim `CLAIM-A1-SCHEDULER-STALE-GAP-EXCLUSION`.

## Verification

- `pnpm test`: All tests in `packages/api/test/scheduler.test.ts` passing (9/9).
- `node scripts/check-claims.js`: 48/48 claims passing.
