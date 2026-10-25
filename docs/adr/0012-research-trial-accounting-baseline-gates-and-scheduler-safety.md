# 0012. Research Trial Accounting, Baseline Gates, and Scheduler Safety

**Status**: accepted

## Context

A second independent audit identified three critical integrity flaws in execution, statistical gating, and system configuration:

1. **Unattended Scheduler Default & Paper Ledger Corruption (N1)**:
   `packages/api/src/cli.ts` defaulted `enableScheduler` to `true` whenever `process.env["KEEL_ENABLE_SCHEDULER"] !== "false"`. On server startup, the scheduler ticked repeatedly every 60s against the same latest confirmed bar. In `paper-broker.ts`, this lack of per-bar idempotency resulted in multiple positions opening on repeat ticks and false protective stop exits triggered against pre-entry bars, corrupting ledger trade counts, fee tallies, and drawdown tracking.
2. **Deflated Sharpe Ratio Multi-Testing Trial Dependency (N2b)**:
   `ReplayEngine` derived `numTrials` for Deflated Sharpe Ratio (DSR) calculation from `experiments.count()`. Consequently, DSR varied depending on test execution sequence and database state rather than reflecting the true parameter grid size of the hypothesis under test.
3. **Un-Enforced Baseline Gates & Permissive Configuration Floors (M-G)**:
   ADR-0009 stipulated that Replay Gate promotion required outperforming Buy & Hold and Random Entry baselines. However, `replayGatePassed` in `@keel/replay` computed the baselines but failed to enforce them in the boolean gate check. Furthermore, `PromotionLadderConfigSchema` allowed operators to loosen `replayMinSharpe` to 0.2, DSR confidence to 0.5, and minimum trades to 30, permitting statistical noise to pass gates.

## Decision

1. **Explicit Opt-In for Unattended Scheduler & Per-Bar Idempotency**:
   - `enableScheduler` defaults to `false`. Autonomous market data polling and strategy ticks are disabled unless explicitly activated via `KEEL_ENABLE_SCHEDULER="true"` in the environment or server options.
   - The scheduler and paper broker persist the last processed confirmed bar `closeTs` per `(instrumentId, strategyId)` in SQLite. Repeat ticks on the same bar are skipped as no-ops.
   - Position exits and protective stops are evaluated only against bars with `openTs >= position.openedAtMs`, eliminating false stops against the entry bar's pre-entry range.
2. **Explicit Research Trial Universe Accounting**:
   - `ReplayEngineInput` and `ExperimentRecord` require an explicit `numTrials` parameter representing the total number of parameter/model combinations evaluated across the active research campaign (defaulting to the campaign's declared grid size, minimum 1).
   - DSR calculation is strictly decoupled from database table row counts, guaranteeing bit-for-bit reproducible, order-independent DSR values.
3. **Mandatory Baseline Outperformance Gate**:
   - `replayGatePassed` strictly requires that candidate strategy annualized Sharpe ratio exceeds both the Buy & Hold baseline Sharpe and the Random Entry baseline Sharpe under identical cost stress (`sharpeRatio > buyAndHold.sharpeRatio && sharpeRatio > randomEntry.sharpeRatio`).
4. **Hardened Configuration Floors**:
   - `PromotionLadderConfigSchema` raises validation floors in Zod to prevent noise promotion:
     - `replayMinSharpe`: minimum floor `0.80`, default `1.0`
     - `replayMinDeflatedSharpeConfidence`: minimum floor `0.80`, default `0.90`
     - `replayMinTrades`: minimum floor `100`, default `150`
