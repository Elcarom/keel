# Phase D: Empirical Backtest & Sealed Holdout Results Report

**Date of Execution**: 2026-10-26T22:52:01.523Z  
**Git Commit SHA**: `aed7d8f8da1aa344d23c6b71166c94d5c2fdbaf7`  
**Dataset Snapshot ID**: `48b5d6a5b022d7fee31b3fc41dc12f219a62a7e0b62a0aaaa693de053cfcabb0`  
**Configuration Hash**: `8f1bfe202e2de789e2154724d5625dd960be009167e7967ee0260187cc3ddc05`  
**Instruments**: `BTC-USDT-SWAP`, `ETH-USDT-SWAP`  
**Sample Span**:

- **In-Sample Calibration & Purged Walk-Forward CV**: 2023-01-01 to 2024-12-31 UTC (2 calendar years)
  - `BTC-USDT-SWAP`: 17544 confirmed 1H bars
  - `ETH-USDT-SWAP`: 17544 confirmed 1H bars
- **Funding Coverage & Totals**:
  - `BTC-USDT-SWAP`: 2193 funding events, total rate sum: `0.219300` (1 distinct rates)
  - `ETH-USDT-SWAP`: 2193 funding events, total rate sum: `0.219300` (1 distinct rates)
  > [!NOTE]
  > **Funding Rate Disclosure (N2a)**: Database settled funding rows currently reflect a constant 0.0001/8h seed. OKX public API does not retain 2023-2024 historical funding rate data. Any claims of real settled empirical funding are explicitly disclaimed.
- **Sealed Out-Of-Sample Holdout (2025-01-01 to 2025-12-31 UTC)**: Spent (historical single-touch record only; never re-evaluated).
- **Quarantined Sealed Partition (2026-01-01 to 2026-06-30 UTC)**: Quarantined under ADR-0011 (zero touches).

---

## 1. Executive Summary

This report delivers the empirical evidence required under **Phase D** and defect remediation (Tickets T2, T3, T4 / ADR-0014, ADR-0015, ADR-0016). All simulations enforce realistic execution mechanics:

- **Zero Lookahead**: Signals evaluated strictly on confirmed bar close; execution occurs at **next-bar open** with adverse slippage penalty (ADR-0014).
- **Intrabar & Gap-Aware Stop Losses**: Adverse slippage applied to stop exits and market flattens; maker take-profits filled at limit without adverse slippage (ADR-0014).
- **2x Cost Stress Multiplier**: Scales both exchange fees and execution slippage: $\text{extraCost} = (\text{multiplier} - 1.0) \times (\text{fees} + \text{slippage})$.
- **Benchmark Distribution Gate**: Replay Gate requires strategy Sharpe to exceed both Buy & Hold Sharpe and the **75th percentile** of $\ge 200$ seeded random entry paths (ADR-0016).
- **Strategy-Specific Walk-Forward CV**: Evaluates each strategy individually across 5 purged and embargoed folds to report honest per-strategy out-of-sample expectancy (fixing N2c).
- **Trial Universe Accounting**: Deflated Sharpe Ratio (DSR) is evaluated against the persisted research trial universe ($N=3$, fixing N2b).

---

## 2. In-Sample Results (2023-01-01 to 2024-12-31 UTC)

| Instrument      | Strategy                | Trades | Win Rate | Net PnL (USDT)  | Avg R | Stress Net R (2x) | Annualized Sharpe | Deflated Sharpe (DSR) | Max MTM DD (%) | Walk-Forward OOS Avg R | Replay Gate |
| :-------------- | :---------------------- | :----: | :------: | :-------------: | :---: | :---------------: | :---------------: | :-------------------: | :------------: | :--------------------: | :---------: |
| `BTC-USDT-SWAP` | `donchian-trend-v1`     |  488   |  31.8%   | $-1133.2241174  | -0.03 |       -0.19       |       -0.22       |         0.122         |     31.0%      |         -0.03          | **FAILED**  |
| `BTC-USDT-SWAP` | `vol-mean-reversion-v1` |  958   |  32.6%   | $-8204.64352977 | -0.23 |       -0.41       |       -3.85       |         0.000         |     82.7%      |         -0.20          | **FAILED**  |
| `BTC-USDT-SWAP` | `vol-momentum-v1`       |  387   |  33.6%   | $-1620.86950258 | -0.05 |       -0.20       |       -0.47       |         0.066         |     32.6%      |         -0.06          | **FAILED**  |
| `ETH-USDT-SWAP` | `donchian-trend-v1`     |  522   |  26.4%   | $-5392.31905904 | -0.19 |       -0.33       |       -1.92       |         0.000         |     58.8%      |         -0.19          | **FAILED**  |
| `ETH-USDT-SWAP` | `vol-mean-reversion-v1` |  962   |  33.5%   | $-7437.89321185 | -0.18 |       -0.33       |       -3.03       |         0.000         |     74.9%      |         -0.16          | **FAILED**  |
| `ETH-USDT-SWAP` | `vol-momentum-v1`       |  360   |  32.8%   | $-1681.44474865 | -0.06 |       -0.18       |       -0.52       |         0.057         |     30.3%      |         -0.02          | **FAILED**  |

### In-Sample Benchmark Comparisons (Buy & Hold and 200-Path Random Entry Distribution)

| Instrument      | Strategy                | Strategy Return (%) | Strategy Sharpe | Buy & Hold Return (%) | Buy & Hold Sharpe | Random Entry Median Ret (%) | Random Entry Median Sharpe | Random Entry 75th %ile Sharpe | Strategy %ile Rank | Gate Status |
| :-------------- | :---------------------- | :-----------------: | :-------------: | :-------------------: | :---------------: | :-------------------------: | :------------------------: | :---------------------------: | :----------------: | :---------: |
| `BTC-USDT-SWAP` | `donchian-trend-v1`     |       -11.3%        |      -0.22      |        402.0%         |       1.81        |           -39.3%            |           -1.63            |             -1.24             |       97.0%        | **FAILED**  |
| `BTC-USDT-SWAP` | `vol-mean-reversion-v1` |       -82.0%        |      -3.85      |        402.0%         |       1.81        |           -39.3%            |           -1.63            |             -1.24             |        0.0%        | **FAILED**  |
| `BTC-USDT-SWAP` | `vol-momentum-v1`       |       -16.2%        |      -0.47      |        402.0%         |       1.81        |           -39.3%            |           -1.63            |             -1.24             |       93.5%        | **FAILED**  |
| `ETH-USDT-SWAP` | `donchian-trend-v1`     |       -53.9%        |      -1.92      |        134.1%         |       0.99        |           -43.3%            |           -1.62            |             -1.11             |       31.0%        | **FAILED**  |
| `ETH-USDT-SWAP` | `vol-mean-reversion-v1` |       -74.4%        |      -3.03      |        134.1%         |       0.99        |           -43.3%            |           -1.62            |             -1.11             |        0.5%        | **FAILED**  |
| `ETH-USDT-SWAP` | `vol-momentum-v1`       |       -16.8%        |      -0.52      |        134.1%         |       0.99        |           -43.3%            |           -1.62            |             -1.11             |       94.0%        | **FAILED**  |

---

## 3. Funding Rate Sensitivity Analysis (5 Scenarios per Instrument/Strategy Pair)

| Instrument      | Strategy                | Scenario            | Funding Paid (USDT) | Net PnL (USDT)  | Sharpe Ratio | Avg R | Gate Status |
| :-------------- | :---------------------- | :------------------ | :-----------------: | :-------------: | :----------: | :---: | :---------: |
| `BTC-USDT-SWAP` | `donchian-trend-v1`     | -0.005% / 8h        |     $19.3910271     | $-1079.13357823 |    -0.21     | -0.02 | **FAILED**  |
| `BTC-USDT-SWAP` | `vol-mean-reversion-v1` | -0.005% / 8h        |    $-3.05000152     | $-8208.91296124 |    -3.85     | -0.23 | **FAILED**  |
| `BTC-USDT-SWAP` | `vol-momentum-v1`       | -0.005% / 8h        |    $35.82498513     | $-1514.58215483 |    -0.43     | -0.05 | **FAILED**  |
| `ETH-USDT-SWAP` | `donchian-trend-v1`     | -0.005% / 8h        |    $15.23805179     | $-5359.92830292 |    -1.91     | -0.19 | **FAILED**  |
| `ETH-USDT-SWAP` | `vol-mean-reversion-v1` | -0.005% / 8h        |    $-11.6099179     | $-7451.49102045 |    -3.04     | -0.18 | **FAILED**  |
| `ETH-USDT-SWAP` | `vol-momentum-v1`       | -0.005% / 8h        |    $32.36525268     | $-1576.08327811 |    -0.48     | -0.06 | **FAILED**  |
| `BTC-USDT-SWAP` | `donchian-trend-v1`     | 0.000% / 8h         |         $0          | $-1097.96429888 |    -0.21     | -0.02 | **FAILED**  |
| `BTC-USDT-SWAP` | `vol-mean-reversion-v1` | 0.000% / 8h         |         $0          | $-8207.62431628 |    -3.85     | -0.23 | **FAILED**  |
| `BTC-USDT-SWAP` | `vol-momentum-v1`       | 0.000% / 8h         |         $0          | $-1549.65271373 |    -0.44     | -0.05 | **FAILED**  |
| `ETH-USDT-SWAP` | `donchian-trend-v1`     | 0.000% / 8h         |         $0          | $-5371.81792057 |    -1.91     | -0.19 | **FAILED**  |
| `ETH-USDT-SWAP` | `vol-mean-reversion-v1` | 0.000% / 8h         |         $0          | $-7447.84821776 |    -3.04     | -0.18 | **FAILED**  |
| `ETH-USDT-SWAP` | `vol-momentum-v1`       | 0.000% / 8h         |         $0          | $-1622.44110183 |    -0.50     | -0.06 | **FAILED**  |
| `BTC-USDT-SWAP` | `donchian-trend-v1`     | +0.005% / 8h        |    $-19.41937959    | $-1115.66059416 |    -0.22     | -0.02 | **FAILED**  |
| `BTC-USDT-SWAP` | `vol-mean-reversion-v1` | +0.005% / 8h        |     $3.01380633     | $-8205.86395565 |    -3.85     | -0.23 | **FAILED**  |
| `BTC-USDT-SWAP` | `vol-momentum-v1`       | +0.005% / 8h        |    $-35.72686829    | $-1585.12974421 |    -0.45     | -0.05 | **FAILED**  |
| `ETH-USDT-SWAP` | `donchian-trend-v1`     | +0.005% / 8h        |    $-15.23116126    | $-5385.06678621 |    -1.92     | -0.19 | **FAILED**  |
| `ETH-USDT-SWAP` | `vol-mean-reversion-v1` | +0.005% / 8h        |    $11.61004663     | $-7443.68850951 |    -3.03     | -0.18 | **FAILED**  |
| `ETH-USDT-SWAP` | `vol-momentum-v1`       | +0.005% / 8h        |    $-32.30510131    | $-1645.17116429 |    -0.51     | -0.06 | **FAILED**  |
| `BTC-USDT-SWAP` | `donchian-trend-v1`     | +0.010% / 8h (Seed) |    $-38.92646533    | $-1133.2241174  |    -0.22     | -0.03 | **FAILED**  |
| `BTC-USDT-SWAP` | `vol-mean-reversion-v1` | +0.010% / 8h (Seed) |     $6.01387219     | $-8204.64352977 |    -3.85     | -0.23 | **FAILED**  |
| `BTC-USDT-SWAP` | `vol-momentum-v1`       | +0.010% / 8h (Seed) |    $-71.3690154     | $-1620.86950258 |    -0.47     | -0.05 | **FAILED**  |
| `ETH-USDT-SWAP` | `donchian-trend-v1`     | +0.010% / 8h (Seed) |    $-30.51614118    | $-5392.31905904 |    -1.92     | -0.19 | **FAILED**  |
| `ETH-USDT-SWAP` | `vol-mean-reversion-v1` | +0.010% / 8h (Seed) |    $23.09908228     | $-7437.89321185 |    -3.03     | -0.18 | **FAILED**  |
| `ETH-USDT-SWAP` | `vol-momentum-v1`       | +0.010% / 8h (Seed) |    $-64.46479214    | $-1681.44474865 |    -0.52     | -0.06 | **FAILED**  |
| `BTC-USDT-SWAP` | `donchian-trend-v1`     | +0.020% / 8h        |    $-77.9467477     | $-1168.84340212 |    -0.23     | -0.03 | **FAILED**  |
| `BTC-USDT-SWAP` | `vol-mean-reversion-v1` | +0.020% / 8h        |     $11.8929212     | $-8202.36148045 |    -3.84     | -0.23 | **FAILED**  |
| `BTC-USDT-SWAP` | `vol-momentum-v1`       | +0.020% / 8h        |   $-142.32176757    | $-1692.0742243  |    -0.49     | -0.06 | **FAILED**  |
| `ETH-USDT-SWAP` | `donchian-trend-v1`     | +0.020% / 8h        |    $-61.01825282    | $-5415.57612464 |    -1.94     | -0.19 | **FAILED**  |
| `ETH-USDT-SWAP` | `vol-mean-reversion-v1` | +0.020% / 8h        |     $46.3588771     | $-7433.75623679 |    -3.02     | -0.18 | **FAILED**  |
| `ETH-USDT-SWAP` | `vol-momentum-v1`       | +0.020% / 8h        |   $-128.39001674    | $-1744.83555906 |    -0.55     | -0.06 | **FAILED**  |

---

## 4. Sealed Holdout (2025-01-01 to 2025-12-31 UTC)

> [!WARNING]
> **NOT REGENERATED**: In strict compliance with AGENTS.md, ADR-0009, and ADR-0011, no code or research evaluation has been run against data on or after 2025-01-01 UTC. The 2025 partition was evaluated exactly once during initial Phase D calibration and is scientifically spent. The historical record below is reproduced from the original un-remediated audit report for historical comparison only. Future out-of-sample validation must use the quarantined 2026 partition under ADR-0011.

| Instrument      | Strategy                | Trades | Win Rate | Net PnL (USDT) | Avg R | Stress Net R (2x) | Annualized Sharpe | Deflated Sharpe (DSR) | Max MTM DD (%) | Outperform Buy & Hold? |
| :-------------- | :---------------------- | :----: | :------: | :------------: | :---: | :---------------: | :---------------: | :-------------------: | :------------: | :--------------------: |
| `BTC-USDT-SWAP` | `donchian-trend-v1`     |  260   |  30.4%   |   $-2182.37    | -0.12 |       -0.30       |       -1.14       |         0.049         |     30.1%      |           NO           |
| `BTC-USDT-SWAP` | `vol-mean-reversion-v1` |  490   |  34.3%   |   $-5937.05    | -0.24 |       -0.44       |       -3.90       |         0.000         |     64.6%      |           NO           |
| `BTC-USDT-SWAP` | `vol-momentum-v1`       |  188   |  32.5%   |   $-1847.81    | -0.14 |       -0.31       |       -1.16       |         0.007         |     26.3%      |           NO           |
| `ETH-USDT-SWAP` | `donchian-trend-v1`     |  269   |  32.7%   |    $753.99     | 0.05  |       -0.05       |       0.47        |         0.161         |     14.5%      |          YES           |
| `ETH-USDT-SWAP` | `vol-mean-reversion-v1` |  478   |  31.6%   |   $-5613.30    | -0.22 |       -0.33       |       -3.75       |         0.000         |     57.6%      |           NO           |
| `ETH-USDT-SWAP` | `vol-momentum-v1`       |  211   |  34.1%   |    $-238.92    | -0.01 |       -0.10       |       -0.07       |         0.042         |     13.1%      |          YES           |

---

## 5. Empirical Findings & Governance Directives

1. **Unanimous Replay Gate Rejection**:
   - Under realistic market execution (next-bar open execution, gap slippage, and 2x cost stress) and the 75th percentile random baseline distribution gate (ADR-0016), **ALL THREE STRATEGIES FAIL THE REPLAY GATE**.
2. **Deflated Sharpe Ratio (DSR) Accounting (N2b)**:
   - DSR is evaluated against the explicit trial count ($N=3$). The candidate strategies achieve low or zero DSR primarily because their in-sample raw annualized Sharpe ratios are non-positive or near-zero under realistic execution friction (fees, adverse slippage, and funding costs). Trial deflation mathematically confirms that none of the candidate strategies exhibit statistically significant outperformance over noise.
3. **Funding Rate Impact**:
   - Sensitivity analysis demonstrates that varying funding rates across $[-0.005\%, +0.020\%]$ per 8h does not alter gate outcomes; all strategies remain rejected across all funding scenarios.
4. **Operational Directive**:
   - As documented in `docs/research/strategy-status.md`, all three strategies are strictly prohibited from promotion to paper, demo, or live capital.
