# ADR-0016: Benchmark Distribution Gate, Replay Hardening, & Research Report Integrity

## Status

Accepted

## Context

A second independent audit identified critical statistical and governance defects in research evaluation, gating thresholds, and reporting:

1. **Random Entry Baseline Distribution (M-G / R3)**:
   - ADR-0009 stipulated that passing the Replay Gate required beating Buy & Hold and Random Entry baselines.
   - The prior implementation evaluated only a single seeded path (`seed = 1337`), leaving the baseline noisy and vulnerable to seed luck.
   - The gate required beating the single-seed Sharpe rather than demonstrating statistical outperformance against a full distribution.
2. **Strategy-Specific Walk-Forward CV (N2c)**:
   - The Phase D evaluation script passed `candidateStrategies` containing all three baseline strategies to `computePurgedWalkForwardOosExpectancy`.
   - On each fold, the chooser selected the identical best-performing candidate across all rows, reporting identical walk-forward OOS expectancies (-0.09 BTC, -0.14 ETH) regardless of which strategy row was being displayed.
3. **Funding Rate Evidence Disclosure (N2a)**:
   - Phase D documentation previously claimed simulations used "settled 8H funding rates" from OKX. In reality, historical funding rates prior to recent months were not served by OKX's public API, and the database was seeded with a constant 0.0001 funding rate.
4. **Promotion Ladder Configuration Hardening (M-G)**:
   - `PromotionLadderConfigSchema` and `ReplayEngine` fallback defaults previously allowed operators or callers to loosen gating parameters down to statistical noise (`replayMinSharpe: 0.2`, `replayMinDeflatedSharpeConfidence: 0.5`, `replayMinTrades: 5`).

## Decision

1. **Multi-Path Random Entry Distribution ($\ge 200$ Monte Carlo Paths)**:
   - `computeRandomEntryBaseline` executes $\ge 200$ deterministic seeded random paths over the bar series.
   - To ensure fast $O(1)$ intra-bar simulation, settled funding rates are pre-indexed across the range rather than querying SQLite per bar.
   - Collects the empirical distribution of returns, Sharpe ratios, and max drawdowns.
   - Computes median return %, median Sharpe ratio, 75th percentile Sharpe ratio (`p75SharpeRatio`), and the strategy's empirical percentile rank (`percentileRank`).
2. **Hardened Replay Gate (M-G / R3)**:
   - `replayGatePassed` strictly requires:
     - `dsrMetrics.sharpeRatio > buyAndHold.sharpeRatio`
     - `dsrMetrics.sharpeRatio > randomEntry.p75SharpeRatio` (must strictly beat the 75th percentile of random noise)
     - `dsrMetrics.sharpeRatio >= minSharpe` (minimum floor 0.8, default 1.0)
     - `dsrMetrics.deflatedSharpeRatio >= minDsr` (minimum floor 0.8, default 0.9)
     - `simulation.trades.length >= minTrades` (minimum floor 100, default 150)
     - `oosResult.oosExpectancyR >= 0` and `simulation.stressNetExpectancyR > 0` under 2x cost stress.
3. **Honest Strategy-Specific Out-of-Sample CV (N2c)**:
   - When evaluating an individual strategy, `candidateStrategies` is omitted so each strategy is evaluated strictly on its own purged walk-forward folds without conflating candidate models.
4. **Automated Report Integrity & Data Disclosures (R3 / N2a)**:
   - `scripts/run-phase-d-evaluation.js` dynamically generates `docs/research/phase-d-results.md` directly from the database and current git repository.
   - Automatically records git commit SHA, dataset snapshot ID, configuration hash, exact bar counts, and funding event totals.
   - Detects synthetic vs empirical settled funding rates and provides transparent disclosure.
   - Strictly enforces in-sample evaluation only (`2023-01-01` to `2024-12-31` UTC). No code or script touches data on or after `2025-01-01` UTC.

## Consequences

- Replay Gate provides mathematically rigorous protection against data mining and overfitting.
- Walk-forward cross validation reports honest, per-strategy out-of-sample metrics.
- Research reports are fully reproducible, script-generated artifacts with audit trails.
- Naive baseline strategies remain strictly blocked from promotion across all instruments.
