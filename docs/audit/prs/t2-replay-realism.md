# Pull Request: Ticket T2 — Replay Realism, Shared Execution Parity, & Adverse Exit Slippage (R1)

## Summary of Changes

### 1. Unified Execution Seam (`@keel/core/src/execution.ts`)

- **Adverse Stop Slippage (R1)**: Updated `evaluateIntrabarExit` to accept `slippageBps`.
  - Protective stops trigger market orders: gap-aware raw stop fill (`min(open, stop)` for long, `max(open, stop)` for short) has adverse slippage applied (moving fill down for long, up for short).
  - Take-profit orders remain passive maker limit fills: executed at gap-aware limit price with ZERO adverse slippage.
- **Market Exit Pricing**: Added `computeMarketExitPrice` for emergency exits, end-of-replay closes, and position flattens with adverse market slippage.
- **Cost Stress Scaling (R1)**: Added `computeTradePnL`. Under cost stress (e.g. 2.0x), the extra stress penalty scales BOTH fees and total slippage:
  `extraStressCost = (costStressMultiplier - 1.0) * (totalFees + totalSlippage)`.

### 2. Parity in Replay and Paper Broker (M-A Alignment)

- `packages/replay/src/index.ts`:
  - `ReplayEngine.run` utilizes `evaluateIntrabarExit` with `slippageBps`.
  - Trade PnL and 2.0x cost-stressed PnL are evaluated via shared `computeTradePnL`.
  - End-of-replay positions are closed with adverse slippage via `computeMarketExitPrice`.
  - Unused `extraStressMultiplierDec` was removed.
- `packages/api/src/paper-broker.ts`:
  - `PaperBroker.executeConfirmedBarTick` passes `slippageBps` to `evaluateIntrabarExit`.
  - `PaperBroker.flattenAllPositions` computes adverse market exit prices using `computeMarketExitPrice`.

### 3. Verification & Parity Test

- Dedicated test suite in `packages/core/test/execution-parity.test.ts`:
  - Validates adverse slippage on stops and zero slippage on take-profits.
  - Validates cost stress multiplier scaling both fees and slippage.
  - Validates bit-for-bit execution parity between Replay and Paper broker models.
- All 119 tests across 17 test suites pass.
