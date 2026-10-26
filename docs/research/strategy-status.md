# Strategy Evaluation Status: In-Sample & Holdout Assessment

**Date**: 2026-10-26  
**Status**: REJECTED FOR PROMOTION

---

## 1. Summary

In accordance with Keel research governance, ADR-0009, ADR-0012, ADR-0014, and ADR-0016, all three candidate strategies have been evaluated against historical data (2023-01-01 to 2024-12-31 UTC in-sample with settled 8H funding rates, next-bar open execution, gap slippage, 200-path random entry baseline distribution, and 2x cost stress):

1. **`donchian-trend-v1`** (Donchian Breakout Trend Following)
   - In-Sample Net PnL (BTC): -$1,133.22 USDT (Sharpe: -0.22, DSR: 0.122, WF OOS Avg R: -0.03)
   - In-Sample Net PnL (ETH): -$5,392.32 USDT (Sharpe: -1.92, DSR: 0.000, WF OOS Avg R: -0.19)
   - Replay Gate: **FAILED** (Underperforms Buy & Hold and fails minimum Sharpe/expectancy thresholds)

2. **`vol-mean-reversion-v1`** (Volatility Normalized Mean Reversion)
   - In-Sample Net PnL (BTC): -$8,204.64 USDT (Sharpe: -3.85, DSR: 0.000, WF OOS Avg R: -0.20)
   - In-Sample Net PnL (ETH): -$7,437.89 USDT (Sharpe: -3.03, DSR: 0.000, WF OOS Avg R: -0.16)
   - Replay Gate: **FAILED** (Severe trend break drawdown and negative expectancy)

3. **`vol-momentum-v1`** (Volatility Normalized Momentum)
   - In-Sample Net PnL (BTC): -$1,620.87 USDT (Sharpe: -0.47, DSR: 0.066, WF OOS Avg R: -0.06)
   - In-Sample Net PnL (ETH): -$1,681.44 USDT (Sharpe: -0.52, DSR: 0.057, WF OOS Avg R: -0.02)
   - Replay Gate: **FAILED** (Negative expectancy after trading costs and funding drag)

---

## 2. Research Conclusion & Operational Directive

- **No Edge Demonstrated**: None of the three candidate strategies demonstrates a positive statistical edge under realistic cost and slippage constraints.
- **Strict Promotion Block**: In compliance with Keel core tenets, thresholds are never weakened to fabricate passing scores. All candidate strategies are **STRICTLY PROHIBITED** from promotion to forward paper, demo, or live capital.
- **Sealed Holdout Isolation**: The 2025 sealed holdout remains spent and un-evaluated during remediation. The 2026 partition (`2026-01-01` to `2026-06-30` UTC) remains completely quarantined and un-evaluated (ADR-0011).
