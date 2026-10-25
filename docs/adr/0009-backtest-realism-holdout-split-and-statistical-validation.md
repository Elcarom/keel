# 0009. Backtest Realism, Sealed Holdout Split, and Statistical Validation

**Status**: accepted

## Context

An independent review of `@keel/replay` identified critical simulation and statistical flaws:

1. Trade entries were simulated at the signal-bar close rather than next-bar open, creating intra-bar look-ahead bias.
2. Stop-loss orders filled at the exact trigger price even when subsequent bars gapped past the stop, understating tail risk.
3. The inverse normal CDF approximation (`inverseNormalCdf`) in Deflated Sharpe Ratio calculation mixed Peter Acklam rational coefficients with Wichura transformation terms, returning incorrect critical values (`Phi^-1(0.9) = 1.025` instead of `1.282`, `Phi^-1(0.99) = 1.28` instead of `2.326`) and granting unwarranted gate passes.
4. The reported walk-forward out-of-sample evaluation lacked a true sealed holdout.
5. `PromotionLadderConfig` declared un-enforced metrics (`replayMaxPbo` and bootstrap confidence intervals) that were not implemented in code.

## Decision

1. **Next-Bar Open Execution & Slippage**:
   Proposals confirmed on bar `t` execute strictly at the open price of bar `t+1`. A configurable execution penalty (slippage in basis points) is deducted from the entry price.
2. **Gap-Aware Stop and Take-Profit Fills**:
   Protective stops simulate adverse market gaps:
   - Long stops fill at `min(bar.open, stopPrice)`.
   - Short stops fill at `max(bar.open, stopPrice)`.
     Take-profit orders execute at `max(bar.open, tpPrice)` for longs and `min(bar.open, tpPrice)` for shorts.
3. **Peter Acklam Inverse Normal CDF & Time-Based Sharpe**:
   Implement the standard Peter J. Acklam algorithm for $\Phi^{-1}(p)$ with zero blended approximations and verify against standard normal quantile fixtures ($\Phi^{-1}(0.975) \approx 1.95996$, $\Phi^{-1}(0.9) \approx 1.28155$, $\Phi^{-1}(0.99) \approx 2.32635$). Sharpe Ratio is computed on periodic mark-to-market returns annualized over 8,760 hours per year.
4. **Partitioned In-Sample and Sealed Holdout**:
   The 3-year historical dataset (2023-01-01 to 2025-12-31 UTC) is partitioned into:
   - **In-Sample Calibration & Purged Walk-Forward**: 2023-01-01 to 2024-12-31 UTC.
   - **Sealed Holdout Period**: 2025-01-01 to 2025-12-31 UTC. The holdout is strictly quarantined and evaluated once in final verification without parameter re-tuning.
5. **Truthful Gate Pruning**:
   Remove un-implemented `replayMaxPbo` and theoretical bootstrap CI claims from `PromotionLadderConfig`, UI schemas, and `docs/runbooks/go-live-checklist.md`. Replay gate validation relies on Purged Cross-Validation, DSR $\ge 0.90$, positive expectancy at 2x cost stress, and benchmark outperformance against Buy & Hold and Random Entry baselines.
