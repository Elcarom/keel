# Strategy Evaluation Status: In-Sample & Holdout Assessment

**Date**: 2026-10-26  
**Status**: REJECTED FOR PROMOTION

---

## 1. Summary

In accordance with Keel research governance, ADR-0009, and ADR-0012, all three candidate strategies have been evaluated against historical data (2023-01-01 to 2024-12-31 UTC in-sample with settled 8H funding rates, next-bar open execution, gap slippage, and 2x cost stress):

1. **`donchian-trend-v1`** (Donchian Breakout Trend Following)
   - In-Sample Net PnL (BTC): -$556.62 USDT (Sharpe: -0.06, DSR: 0.175, WF OOS Avg R: -0.02)
   - In-Sample Net PnL (ETH): -$5,093.46 USDT (Sharpe: -1.77, DSR: 0.000, WF OOS Avg R: -0.17)
   - Replay Gate: **FAILED** (Underperforms Buy & Hold and fails minimum Sharpe/expectancy thresholds)

2. **`vol-mean-reversion-v1`** (Volatility Normalized Mean Reversion)
   - In-Sample Net PnL (BTC): -$7,948.31 USDT (Sharpe: -3.57, DSR: 0.000, WF OOS Avg R: -0.19)
   - In-Sample Net PnL (ETH): -$7,130.99 USDT (Sharpe: -2.79, DSR: 0.000, WF OOS Avg R: -0.14)
   - Replay Gate: **FAILED** (Severe trend break drawdown and negative expectancy)

3. **`vol-momentum-v1`** (Volatility Normalized Momentum)
   - In-Sample Net PnL (BTC): -$1,242.29 USDT (Sharpe: -0.33, DSR: 0.094, WF OOS Avg R: -0.04)
   - In-Sample Net PnL (ETH): -$1,378.93 USDT (Sharpe: -0.41, DSR: 0.077, WF OOS Avg R: -0.01)
   - Replay Gate: **FAILED** (Negative expectancy after trading costs and funding drag)

---

## 2. Research Conclusion & Operational Directive

- **No Edge Demonstrated**: None of the three candidate strategies demonstrates a positive statistical edge under realistic cost and slippage constraints.
- **Strict Promotion Block**: In compliance with Keel core tenets, thresholds are never weakened to fabricate passing scores. All candidate strategies are **STRICTLY PROHIBITED** from promotion to forward paper, demo, or live capital.
- **Sealed Holdout Isolation**: The 2025 sealed holdout remains spent and un-evaluated during remediation. The 2026 partition (`2026-01-01` to `2026-06-30` UTC) remains completely quarantined and un-evaluated (ADR-0011).
