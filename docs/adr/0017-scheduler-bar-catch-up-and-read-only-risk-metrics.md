# ADR-0017: Scheduler Bar Catch-Up, Explicit Opt-In Defaults, & Read-Only Risk Metrics (R6, N1)

## Status

Accepted

## Context

Independent audits identified reliability, idempotency, and side-effect defects in the paper ledger and background scheduler:

1. **Scheduler Bar Skipping & Defective Re-Ticking (N1 / R6)**:
   - When the scheduler ticked every 60 seconds, it previously queried only the single latest confirmed bar (`limit: 1`).
   - If multiple confirmed bars had closed while the scheduler was offline or during network ingestion lag, intermediate bars were never evaluated, skipping exits, funding settlement, and signal generation.
   - Conversely, on the same bar, repeated executions lacked strategy-specific position segregation, allowing repeated evaluation of pre-entry highs/lows against new stops.
2. **Implicit Strategy Opt-In**:
   - `UnattendedScheduler` options previously defaulted `strategies` to `["donchian-trend-v1"]`, automatically running paper trades without explicit operator configuration.
3. **Mutating Side-Effects in Query Methods**:
   - `LedgerRepository.getRiskMetrics` was previously inserting mark-to-market equity snapshots into `ledger_equity_snapshots` during read queries.
   - Calling a `get...` query altered database state and snapshot counts.
   - Furthermore, `dayStartEquityUsdt` and `weekStartEquityUsdt` were computed strictly from historical cash journals rather than leveraging intra-period mark-to-market equity snapshots.

## Decision

1. **Chronological Unprocessed Bar Catch-Up (R6)**:
   - For each configured `(instrument, strategy)`, the scheduler retrieves `lastProcessedCloseTs` from `paper_processed_bars`.
   - Fetches all unprocessed confirmed bars in ascending chronological order (`ORDER BY open_ts ASC`), starting from `lastProcessedCloseTs` (or 0 if uninitialized) up to `nowMs`.
   - Caps processing at 500 bars per step (`.slice(0, 500)`). If more than 500 unprocessed bars exist, the first 500 are processed in sequence and the remainder resume on subsequent steps without skipping or duplicate ticks.
   - For each bar, retrieves the corresponding feature bars and settled funding rates up to `bar.closeTs`, ensuring gap-aware stops, limit take-profits, and 8-hour funding payments are applied in exact historical sequence.
2. **Strategy-Segregated Position Evaluation**:
   - `executeConfirmedBarTick` filters open positions by `pos.strategyId === strategyId`, preventing cross-strategy interference or duplicate exit evaluation when multiple strategies trade the same instrument.
3. **Empty Default Scheduler Strategies (Explicit Opt-In)**:
   - `UnattendedSchedulerOptions.strategies` defaults to `[]` (empty array). An operator or test must explicitly opt in to active strategies.
4. **Read-Only `getRiskMetrics` & Explicit `recordEquitySnapshot`**:
   - Stripped all `INSERT` statements from `LedgerRepository.getRiskMetrics`, restoring strict read-only query semantics.
   - Added `recordEquitySnapshot(params: { ts, strategyId?, equityUsdt })` to `LedgerRepository` port.
   - Updated `getRiskMetrics` to query `ledger_equity_snapshots` at or before `dayStartMs` and `weekStartMs` to capture true intra-period mark-to-market equity baselines.
   - Paper broker ticks and scheduler steps explicitly record snapshots after updating mark-to-market equity.

## Consequences

- Unattended paper execution reliably catches up after downtime without data gaps or skipped bars.
- Zero positions or signals are generated unless strategies are explicitly opted in.
- All ledger and risk query methods are strictly read-only and idempotent.
- Intra-period high-water mark and daily/weekly drawdowns accurately reflect true mark-to-market peaks.
