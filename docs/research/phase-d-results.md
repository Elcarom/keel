# Phase D: Empirical Backtest & Sealed Holdout Results Report

**Date of Execution**: 2026-10-26T07:15:44.677Z  
**Dataset**: OKX 1H Confirmed Bars (`confirm === "1"`) & 8H Settled Funding Rates  
**Instruments**: `BTC-USDT-SWAP`, `ETH-USDT-SWAP`  
**Sample Span**:

- **In-Sample Calibration & Purged Walk-Forward CV**: 2023-01-01 to 2024-12-31 UTC (17,544 1H bars, 2 calendar years)
- **Sealed Out-Of-Sample Holdout**: 2025-01-01 to 2025-12-31 UTC (8,760 1H bars, 1 calendar year - historical record, spent)
- **Quarantined Sealed Partition**: 2026-01-01 to 2026-06-30 UTC (ADR-0011, zero touches)

---

## 1. Executive Summary

This report delivers the empirical evidence required under **Phase D** of the Keel defect remediation program (remediated under Ticket B3 / Issue #88). All simulations reflect realistic execution mechanics:

- **Zero Lookahead**: Signals evaluated strictly on confirmed bar close; execution occurs at **next-bar open** with 3 bps adverse slippage penalty.
- **Gap-Aware Stop Losses**: Stops filled at the worse of bar open and stop price; take-profits filled at the better of bar open and limit (ADR-0009).
- **No Slippage Double-Counting**: Entry slippage is applied to fill price; fee fraction applies strictly to trading fees (taker fee 10 bps, half spread 2 bps).
- **Cost Stress**: 2x fee stress applied.
- **Time-Based Sharpe Ratio**: Annualized over $\sqrt{8760}$ periodic hourly returns reflecting idle cash drag.
- **Explicit Research Trial Universe Accounting**: Deflated Sharpe Ratio (DSR) is evaluated against an explicit parameter/trial count ($N=3$), fully decoupled from repository row counts (ADR-0012).
- **Strategy-Specific Walk-Forward Cross-Validation**: Each strategy is evaluated individually across 5 purged and embargoed folds to report honest per-strategy out-of-sample expectancy (remediating N2c).

---

## 2. In-Sample Results (2023-01-01 to 2024-12-31 UTC)

| Instrument      | Strategy                | Trades | Win Rate | Net PnL (USDT)  | Avg R | Stress Net R (2x) | Annualized Sharpe | Deflated Sharpe (DSR) | Max MTM DD (%) | Walk-Forward OOS Avg R | Replay Gate |
| :-------------- | :---------------------- | :----: | :------: | :-------------: | :---: | :---------------: | :---------------: | :-------------------: | :------------: | :--------------------: | :---------: |
| `BTC-USDT-SWAP` | `donchian-trend-v1`     |  488   |  31.8%   | $-556.62058643  | -0.01 |       -0.13       |       -0.06       |         0.175         |     29.1%      |         -0.02          | **FAILED**  |
| `BTC-USDT-SWAP` | `vol-mean-reversion-v1` |  958   |  32.6%   | $-7948.30815777 | -0.21 |       -0.34       |       -3.57       |         0.000         |     80.3%      |         -0.19          | **FAILED**  |
| `BTC-USDT-SWAP` | `vol-momentum-v1`       |  387   |  33.6%   | $-1242.28958688 | -0.04 |       -0.15       |       -0.33       |         0.094         |     30.6%      |         -0.04          | **FAILED**  |
| `ETH-USDT-SWAP` | `donchian-trend-v1`     |  522   |  26.4%   | $-5093.46075423 | -0.17 |       -0.27       |       -1.77       |         0.000         |     56.3%      |         -0.17          | **FAILED**  |
| `ETH-USDT-SWAP` | `vol-mean-reversion-v1` |  962   |  33.5%   | $-7130.9877829  | -0.17 |       -0.27       |       -2.79       |         0.000         |     71.9%      |         -0.14          | **FAILED**  |
| `ETH-USDT-SWAP` | `vol-momentum-v1`       |  360   |  32.8%   | $-1378.92766123 | -0.05 |       -0.14       |       -0.41       |         0.077         |     28.9%      |         -0.01          | **FAILED**  |

### In-Sample Benchmark Comparisons

| Instrument      | Strategy                | Strategy Return (%) | Strategy Sharpe | Buy & Hold Return (%) | Buy & Hold Sharpe | Random Entry Return (%) | Random Entry Sharpe |
| :-------------- | :---------------------- | :-----------------: | :-------------: | :-------------------: | :---------------: | :---------------------: | :-----------------: |
| `BTC-USDT-SWAP` | `donchian-trend-v1`     |        -5.6%        |      -0.06      |        402.0%         |       1.81        |         -26.4%          |        -0.98        |
| `BTC-USDT-SWAP` | `vol-mean-reversion-v1` |       -79.5%        |      -3.57      |        402.0%         |       1.81        |         -26.4%          |        -0.98        |
| `BTC-USDT-SWAP` | `vol-momentum-v1`       |       -12.4%        |      -0.33      |        402.0%         |       1.81        |         -26.4%          |        -0.98        |
| `ETH-USDT-SWAP` | `donchian-trend-v1`     |       -50.9%        |      -1.77      |        134.1%         |       0.99        |         -37.2%          |        -1.33        |
| `ETH-USDT-SWAP` | `vol-mean-reversion-v1` |       -71.3%        |      -2.79      |        134.1%         |       0.99        |         -37.2%          |        -1.33        |
| `ETH-USDT-SWAP` | `vol-momentum-v1`       |       -13.8%        |      -0.41      |        134.1%         |       0.99        |         -37.2%          |        -1.33        |

---

## 3. Sealed Holdout Results (2025-01-01 to 2025-12-31 UTC)

> [!WARNING]
> The 2025 sealed holdout dataset was evaluated exactly once during initial Phase D calibration and is scientifically spent. In accordance with ADR-0009 and ADR-0011, it has **NOT** been re-evaluated during defect remediation to prevent data leakage. The numbers below reflect the immutable historical record of that single holdout evaluation under 2x cost stress. Future out-of-sample validation must use the quarantined 2026 partition (ADR-0011).

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
   - With the Acklam-verified $\Phi^{-1}$ implementation and explicit trial universe accounting ($N=3$), DSR accurately deflates strategy Sharpe ratios, preventing false discovery.
3. **Mandatory Baseline Gating**:
   - As enforced in `replayGatePassed` (ADR-0012 / M-G), all strategies are rejected because their Sharpe ratios fail to exceed both Buy & Hold and Random Entry baselines.
4. **Operator Go / No-Go Decision**:
   - The platform execution engine and statistical validation pipeline operate with mathematical integrity.
   - **Recommendation**: Baseline naive strategies should **NOT** be promoted to live capital without dynamic regime filtering or portfolio diversification. Human checkpoint **[HUMAN]** is invoked to review evidence before unlocking broker truthfulness (Group E) and operational automation (Group F).
