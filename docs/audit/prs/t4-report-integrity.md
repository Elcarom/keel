# Pull Request: Ticket T4 — Report Integrity, Multi-Path Benchmark Gates, and Honest OOS Cross-Validation (R3, M-G, N2)

## Summary of Changes

### 1. Multi-Path Random Entry Benchmark Distribution ($\ge 200$ Paths) (ADR-0016 / M-G / R3)

- Replaced the single-seed random entry baseline with an empirical Monte Carlo distribution across $\ge 200$ seeded paths.
- Computes:
  - Median return percentage and median Sharpe ratio.
  - 75th percentile Sharpe ratio (`p75SharpeRatio`).
  - Empirical percentile rank of the strategy against the distribution (`percentileRank`).
- Optimized simulation performance via settled funding rate pre-indexing and precomputed bar ScaledDecimals, enabling fast evaluation over 17,500+ bars across hundreds of paths.

### 2. Hardened Replay Gate (ADR-0016 / M-G / R3)

- Updated `replayGatePassed` in `packages/replay/src/index.ts`:
  - Requires `dsrMetrics.sharpeRatio > buyAndHold.sharpeRatio`.
  - Requires `dsrMetrics.sharpeRatio > (randomEntry.p75SharpeRatio ?? randomEntry.sharpeRatio)`: strategy must strictly outperform the 75th percentile of the random entry distribution.
  - Hardened default thresholds against operator loosening: `minSharpe` minimum floor 0.8 (default 1.0), `minDsr` minimum floor 0.8 (default 0.9), `minTrades` minimum floor 100 (default 150).

### 3. Honest Strategy-Specific Out-of-Sample Cross Validation (N2c)

- Fixed candidate contamination defect in walk-forward evaluation:
  - Evaluates each strategy individually on its own purged and embargoed folds when `candidateStrategies` is omitted or contains a single candidate.
  - Eliminates candidate leakage that caused identical out-of-sample expectancies (-0.09 BTC, -0.14 ETH) across different strategies in the original audit.

### 4. Transparent Funding Rate Evidence Disclosure (N2a)

- Disclosed that 2023-2024 database settled funding records reflect a constant 0.0001/8h seed due to OKX public API data retention limits.
- Automatically detected and prominently highlighted in the generated research report.

### 5. Automated Reproducible Report Generation (R3)

- `scripts/run-phase-d-evaluation.js` dynamically generates `docs/research/phase-d-results.md` directly from the database and repository:
  - Records Git commit SHA, dataset snapshot ID, configuration hash, exact bar counts, and funding totals.
  - Emits in-sample performance and benchmark comparison tables.
  - Keeps 2025 holdout strictly marked "NOT REGENERATED" with scientific rationale.
  - Unanimously rejects all candidate strategies across both BTC and ETH per Keel research governance.

### 6. Architectural Decision Record & Research Status

- Recorded `docs/adr/0016-benchmark-distribution-gate-and-report-integrity.md`.
- Updated `docs/research/strategy-status.md` with verified in-sample figures confirming all 3 strategies fail and are strictly prohibited from promotion.

---

## Verification

- `packages/replay/test/benchmark-distribution.test.ts` (4 new tests):
  - Verifies $\ge 200$-path baseline returns median, p75 Sharpe, and percentile rank.
  - Verifies `replayGatePassed` requires beating the 75th percentile of random entry.
  - Verifies defensive default thresholds in `ReplayEngine`.
  - Verifies per-strategy walk-forward out-of-sample independence without candidate contamination.
- Full workspace test suite: 20 test files, 131 tests passing.
- Full workspace static checks: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
