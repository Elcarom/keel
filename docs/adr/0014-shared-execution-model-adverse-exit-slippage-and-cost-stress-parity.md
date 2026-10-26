# ADR-0014: Shared Execution Model, Adverse Exit Slippage, & Cost Stress Parity

## Status

Accepted

## Context

A second independent quantitative and architectural audit identified discrepancies in trade execution realism:

1. **M-A Paper Broker vs. Replay Disparity**: The paper broker entered and exited without full execution realism parity with `ReplayEngine`.
2. **R1 Stop Adverse Slippage**: Stops trigger market orders upon breach. While take-profit orders are passive maker limits that execute without adverse slippage, stops and market exits experience adverse slippage. Replay previously modeled entry slippage and intrabar gap fills, but applied zero adverse slippage to stop market fills.
3. **Cost Stress Scaling**: In `ReplayEngine.run`, the `costStressMultiplier` (2.0x) only scaled trade fees (`(costStressMultiplier - 1) * tradeFeesUsdt`), neglecting to scale slippage under cost stress.
4. **Double Counting in Benchmarks**: In benchmark paths (`buyAndHold`, `randomEntry`), `totalOneWayCostBps` was treated as an all-in cost fraction while entry slippage was simultaneously applied to prices, double-counting slippage.

## Decision

1. **Unified Execution Seam in `@keel/core/src/execution.ts`**:
   - `computeNextBarOpenEntry`: Computes next-bar open fill with adverse entry slippage, returning `{ entryPrice, effectiveStopPrice, effectiveTpPrice, slippageAmount }`.
   - `evaluateIntrabarExit`: Evaluates intrabar price action against attached protective stops and take-profits.
     - **Protective Stop**: Fills with gap awareness (`min(open, stop)` for longs, `max(open, stop)` for shorts) PLUS adverse exit slippage (`rawPrice * slippageBps / 10_000`).
     - **Take-Profit**: Resting limit order fills with gap awareness (`max(open, tp)` for longs, `min(open, tp)` for shorts) with ZERO adverse slippage.
   - `computeMarketExitPrice`: Evaluates market order / flatten exits with adverse slippage.
   - `computeTradePnL`: Computes standard and cost-stressed PnL. The cost stress multiplier (e.g. 2.0x) scales BOTH fees and total slippage:
     `extraStressCost = (costStressMultiplier - 1.0) * (totalFees + totalSlippage)`.
2. **Replay & Paper Broker Parity**:
   - Both `packages/replay/src/index.ts` and `packages/api/src/paper-broker.ts` utilize these single-source execution functions.
   - A dedicated unit parity test in `@keel/core` verifies that given identical inputs, fill prices, fees, slippage, and PnL are bit-for-bit identical across replay and paper.
3. **Eliminate Double Counting**:
   - Replay fees use `effectiveFeeBps = Math.max(0, totalOneWayCostBps - slippageBps)` so that slippage is reflected via fill prices while exchange fees reflect exchange trading fees.

## Consequences

- Guarantees conservative, non-optimistic paper trading and backtesting that cannot outshine real-world exchange execution.
- Stress testing at 2.0x rigorously tests strategies under adverse liquidity conditions (widened bid-ask spreads and increased market impact).
