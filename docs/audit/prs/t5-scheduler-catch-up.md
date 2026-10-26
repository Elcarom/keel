# Pull Request: Ticket T5 — Scheduler Bar Catch-Up, Explicit Opt-In Defaults, & Read-Only Risk Metrics (R6, N1)

## Summary of Changes

### 1. Chronological Bar Catch-Up Capped at 500 Bars per Step (R6)

- Modified `UnattendedScheduler.stepOnce` in `packages/api/src/scheduler.ts`:
  - Retrieves `lastProcessedCloseTs` for each `(instrumentId, strategyId)` from `paperAccountRepo`.
  - Queries all unprocessed confirmed bars in ascending chronological order (`fromOpenTs: lastProcessedCloseTs ?? 0` to `toCloseTs: nowMs`).
  - Caps execution at 500 bars per scheduler step (`.slice(0, 500)`).
  - Evaluates each unprocessed bar sequentially, including feature bars, exits, gap-aware fills, settled funding rates, and strategy signals.
  - Automatically resumes remaining unprocessed bars on the subsequent step without skipping or duplicating bars.

### 2. Strategy-Segregated Position Evaluation

- In `packages/api/src/paper-broker.ts` (`executeConfirmedBarTick`):
  - Filters open position exit and funding evaluation: `if (strategyId && pos.strategyId !== strategyId) continue`.
  - Prevents cross-strategy position interference or double-ticking when multiple strategies trade on the same instrument.

### 3. Explicit Opt-In Default Strategies (R6)

- Defaulted `UnattendedSchedulerOptions.strategies` to `[]` (empty array).
- Zero strategy ticks or paper trades occur unless strategies are explicitly opted in by configuration or options.

### 4. Read-Only `getRiskMetrics` & Explicit `recordEquitySnapshot` Split (R6)

- Removed mutating `INSERT INTO ledger_equity_snapshots` from `LedgerRepository.getRiskMetrics`.
- Added explicit method `recordEquitySnapshot(params: { ts, strategyId?, equityUsdt })` to `LedgerRepository` in `@keel/core` and implementation in `@keel/data`.
- Extended `getRiskMetrics` to query historical snapshots for true `dayStartEquityUsdt` and `weekStartEquityUsdt`.
- Added post-tick equity snapshot recording in `PaperBroker.executeConfirmedBarTick` and `UnattendedScheduler.stepOnce`.

---

## Verification

- `packages/api/test/scheduler.test.ts`:
  - `R6: default scheduler strategy list is empty (explicit opt-in)`: confirms 0 ticks when strategies list is omitted.
  - `R6: processes all unprocessed confirmed bars chronologically capped at 500 per step spanning missing bars`: seeds 10 missing confirmed bars and verifies all 10 are processed in sequence.
  - `R6: caps processing at 500 unprocessed bars per step and resumes on subsequent step`: seeds 505 missing bars, verifies step 1 processes 500 bars and step 2 processes the remaining 5 bars.
- `packages/data/test/ledger-and-paper.test.ts`:
  - `R6 / Pre-made decision: getRiskMetrics is strictly read-only and requires explicit recordEquitySnapshot`: verifies `getRiskMetrics` produces 0 snapshot table inserts, and explicit `recordEquitySnapshot` persists peak equity.
- Workspace test suite: 20 test files, 135 tests passing.
- Static checks: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
