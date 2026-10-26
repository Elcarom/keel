# PR: T3 — Broker Truthfulness Remainder (C3a–d)

## Summary

Remediates broker execution defects C3a, C3b, C3c, and C3d:

1. **C3a (Stop Confirmation Single-Pending Shortcut & Algo Types)**:
   - `submitOrder` previously queried only `ordType=conditional` and accepted any algo if `algoData.data?.length === 1`.
   - Now queries both `conditional` and `oco` pending algos and matches strictly by ID equality (`algoClOrdId`, `attachAlgoClOrdId`, or `algoId`). The flawed `length === 1` single-pending shortcut is deleted.

2. **C3b (Fill/Order History Polling on Missing Exchange Position)**:
   - `reconcilePositions` previously treated any local position missing on exchange as drift, immediately triggering emergency flattening for all positions. This corrupted state when a position was closed normally via exchange-side stop or take-profit fill.
   - Now queries `/api/v5/trade/fills?instType=SWAP&instId=...` for matching exit fills before declaring drift. If a matching exit fill exists, it records real realized PnL and exit fee to `LedgerRepository`, updates `PaperAccountRepository` with status `CLOSED`, and does not declare drift.

3. **C3c (Flatten Truthfulness & Real Close Fills)**:
   - `flattenAllPositions` previously posted PnL using the last 1H bar close (or entry price), fabricating PnL and fees.
   - Now queries OKX `GET /api/v5/trade/order` for the close order fill details (`avgPx`, `fee`). Only when the fill is confirmed does it post real realized PnL and exit fees to the ledger and mark the position `CLOSED`. If unconfirmed, the position remains `OPEN`, zero fictional PnL is posted, and a `CRITICAL` alert is emitted.

4. **C3d (Fill Query Failure on Submit)**:
   - `submitOrder` previously set status to `SUBMITTED` and proceeded when the fill query failed.
   - Now treats unconfirmed fill as a critical error: raises a `CRITICAL` alert, executes an emergency flatten to close any unconfirmed position risk, and throws an explicit error.

5. **Margin Mode (`tdMode`) and Position Side (`posSide`) Support**:
   - `ExchangeOrderInputSchema` supports optional `tdMode` (`"isolated"` | `"cross"`) and `posSide` (`"net"` | `"long"` | `"short"`).
   - Defaults to `tdMode: "isolated"`. When flattening foreign exchange positions, inherits `mgnMode` and `posSide` from the exchange position.

## Changes

- **`@keel/core`**:
  - `packages/core/src/ports.ts`: Added `tdMode` and `posSide` to `ExchangeOrderInputSchema`.
- **`@keel/broker`**:
  - `packages/broker/src/index.ts`:
    - Updated `submitOrder`: strict ID matching on stop confirmation, querying both `conditional` and `oco` algos; unconfirmed fill triggers `CRITICAL` alert, emergency flatten, and throws.
    - Updated `reconcilePositions`: polls `/api/v5/trade/fills` before declaring missing positions as drift; resolves normal stop/TP exits truthfully.
    - Updated `flattenAllPositions`: queries `/api/v5/trade/order` for close fill details; confirms real fill price and fees before posting to ledger and closing local positions.
- **`packages/broker/test/okx-broker.test.ts`**:
  - Added unit tests for C3a, C3b, C3c, and C3d.
  - Updated mock handlers in test suite to ensure strict ID matching and fill confirmation across all test cases.
- **Documentation**:
  - `docs/research/okx-v5-semantics.md`: Documented OKX V5 semantics for C3a–d.
  - `docs/audit/assumptions.md`: Added assumption `A-C3`.

## Verification

- `packages/broker/test/okx-broker.test.ts`: All 30 unit tests passing (including C3a strict ID matching, C3b history fill PnL & false-positive protection, C3c unconfirmed close handling, C3d unconfirmed submit handling, and tdMode / posSide payload serialization).
- Full workspace test suite: 21 test files, 149 tests passing.
- Strict `pnpm typecheck`, `pnpm lint`, and `pnpm format:check` passing.
