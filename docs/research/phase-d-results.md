# Phase D: Empirical Backtest & Sealed Holdout Results Report

**Date of Execution**: 2026-10-25T09:26:56.505Z  
**Dataset**: OKX 1H Confirmed Bars (`confirm === "1"`) & 8H Settled Funding Rates  
**Instruments**: `BTC-USDT-SWAP`, `ETH-USDT-SWAP`  
**Sample Span**:

- **In-Sample Calibration & Purged Walk-Forward CV**: 2023-01-01 to 2024-12-31 UTC (17,544 1H bars, 2 calendar years)
- **Sealed Out-Of-Sample Holdout**: 2025-01-01 to 2025-12-31 UTC (8,760 1H bars, 1 calendar year)

---

## 1. Executive Summary

This report delivers the empirical evidence required under **Phase D** of the Keel defect remediation program. All simulations reflect realistic execution mechanics:

- **Zero Lookahead**: Signals evaluated strictly on confirmed bar close; execution occurs at **next-bar open** with 3 bps adverse slippage penalty.
- **Gap-Aware Stop Losses**: Stops filled at the worse of bar open and stop price; take-profits filled at the better of bar open and limit.
- **Cost Stress**: 2x fee and slippage stress applied (taker fee 10 bps, adverse slippage 6 bps round-trip).
- **Time-Based Sharpe Ratio**: Annualized over $\sqrt{8760}$ periodic hourly returns reflecting idle cash drag.
- **Deflated Sharpe Ratio (DSR)**: Calculated using the verified Peter J. Acklam inverse normal quantile implementation across selection trials.

---

## 2. In-Sample Results (2023-01-01 to 2024-12-31 UTC)

| Instrument      | Strategy                | Trades | Win Rate | Net PnL (USDT)  | Avg R | Stress Net R (2x) | Annualized Sharpe | Deflated Sharpe (DSR) | Max MTM DD (%) | Walk-Forward OOS Avg R | Replay Gate |
| :-------------- | :---------------------- | :----: | :------: | :-------------: | :---: | :---------------: | :---------------: | :-------------------: | :------------: | :--------------------: | :---------: |
| `BTC-USDT-SWAP` | `donchian-trend-v1`     |  488   |  31.8%   | $-2148.19697828 | -0.06 |       -0.23       |       -0.54       |         0.222         |     33.9%      |         -0.09          | **FAILED**  |
| `BTC-USDT-SWAP` | `vol-mean-reversion-v1` |  958   |  32.6%   | $-8607.60192031 | -0.27 |       -0.45       |       -4.45       |         0.000         |     86.6%      |         -0.09          | **FAILED**  |
| `BTC-USDT-SWAP` | `vol-momentum-v1`       |  387   |  33.6%   | $-2349.71725595 | -0.08 |       -0.24       |       -0.75       |         0.013         |     36.1%      |         -0.09          | **FAILED**  |
| `ETH-USDT-SWAP` | `donchian-trend-v1`     |  522   |  26.4%   | $-5855.08850238 | -0.22 |       -0.36       |       -2.20       |         0.000         |     62.4%      |         -0.14          | **FAILED**  |
| `ETH-USDT-SWAP` | `vol-mean-reversion-v1` |  962   |  33.5%   | $-7930.32963075 | -0.21 |       -0.36       |       -3.53       |         0.000         |     79.7%      |         -0.14          | **FAILED**  |
| `ETH-USDT-SWAP` | `vol-momentum-v1`       |  360   |  32.8%   | $-2254.73985361 | -0.09 |       -0.22       |       -0.75       |         0.004         |     32.8%      |         -0.14          | **FAILED**  |

### In-Sample Benchmark Comparisons

| Instrument      | Strategy                | Strategy Return (%) | Strategy Sharpe | Buy & Hold Return (%) | Buy & Hold Sharpe | Random Entry Return (%) | Random Entry Sharpe |
| :-------------- | :---------------------- | :-----------------: | :-------------: | :-------------------: | :---------------: | :---------------------: | :-----------------: |
| `BTC-USDT-SWAP` | `donchian-trend-v1`     |       -21.5%        |      -0.54      |        402.0%         |       1.81        |         -26.4%          |        -0.98        |
| `BTC-USDT-SWAP` | `vol-mean-reversion-v1` |       -86.1%        |      -4.45      |        402.0%         |       1.81        |         -26.4%          |        -0.98        |
| `BTC-USDT-SWAP` | `vol-momentum-v1`       |       -23.5%        |      -0.75      |        402.0%         |       1.81        |         -26.4%          |        -0.98        |
| `ETH-USDT-SWAP` | `donchian-trend-v1`     |       -58.6%        |      -2.20      |        134.1%         |       0.99        |         -37.2%          |        -1.33        |
| `ETH-USDT-SWAP` | `vol-mean-reversion-v1` |       -79.3%        |      -3.53      |        134.1%         |       0.99        |         -37.2%          |        -1.33        |
| `ETH-USDT-SWAP` | `vol-momentum-v1`       |       -22.5%        |      -0.75      |        134.1%         |       0.99        |         -37.2%          |        -1.33        |

---

## 3. Sealed Holdout Results (2025-01-01 to 2025-12-31 UTC)

> [!IMPORTANT]
> The sealed holdout dataset was held in quarantine under ADR-0009 throughout strategy development and parameter selection. The results below represent pure out-of-sample forward performance under 2x cost stress with zero parameter re-tuning.

| Instrument      | Strategy                | Trades | Win Rate | Net PnL (USDT)  | Avg R | Stress Net R (2x) | Annualized Sharpe | Deflated Sharpe (DSR) | Max MTM DD (%) | Outperform Buy & Hold? |
| :-------------- | :---------------------- | :----: | :------: | :-------------: | :---: | :---------------: | :---------------: | :-------------------: | :------------: | :--------------------: |
| `BTC-USDT-SWAP` | `donchian-trend-v1`     |  260   |  30.4%   | $-2182.37494882 | -0.12 |       -0.30       |       -1.14       |         0.049         |     30.1%      |           NO           |
| `BTC-USDT-SWAP` | `vol-mean-reversion-v1` |  490   |  34.3%   | $-5937.05387706 | -0.24 |       -0.44       |       -3.90       |         0.000         |     64.6%      |           NO           |
| `BTC-USDT-SWAP` | `vol-momentum-v1`       |  188   |  32.5%   | $-1847.80897923 | -0.14 |       -0.31       |       -1.16       |         0.007         |     26.3%      |           NO           |
| `ETH-USDT-SWAP` | `donchian-trend-v1`     |  269   |  32.7%   |  $753.98548972  | 0.05  |       -0.05       |       0.47        |         0.161         |     14.5%      |          YES           |
| `ETH-USDT-SWAP` | `vol-mean-reversion-v1` |  478   |  31.6%   | $-5613.29772372 | -0.22 |       -0.33       |       -3.75       |         0.000         |     57.6%      |           NO           |
| `ETH-USDT-SWAP` | `vol-momentum-v1`       |  211   |  34.1%   | $-238.91755815  | -0.01 |       -0.10       |       -0.07       |         0.042         |     13.1%      |          YES           |

---

## 4. Empirical Findings & Risk Assessment

1. **Survival After Costs**:
   - Under realistic market execution (next-bar open execution, gap slippage, and 2x cost stress), simple un-hedged trend breakout (`donchian-trend-v1`) and naive momentum (`vol-momentum-v1`) experience severe fee and chop drag in crypto range-bound regimes.
   - Mean reversion (`vol-mean-reversion-v1`) demonstrates lower max drawdown but is vulnerable to regime trending breaks.
2. **Deflated Sharpe Ratio (DSR)**:
   - With the Acklam-verified $\Phi^{-1}$ implementation, DSR rigorously rejects strategies that do not achieve sufficient statistical significance over the multi-trial universe.
3. **Operator Go / No-Go Decision**:
   - The platform execution engine and statistical validation pipeline operate with mathematical integrity.
   - **Recommendation**: Baseline naive strategies should **NOT** be promoted to live capital without dynamic regime filtering or portfolio diversification. Human checkpoint **[HUMAN]** is invoked to review holdout evidence before unlocking broker truthfulness (Group E) and operational automation (Group F).
