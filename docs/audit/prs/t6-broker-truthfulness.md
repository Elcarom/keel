# Pull Request: Ticket T6 — Exchange Broker Truthfulness, Fill Polling, & Order Lifecycle Remediation (M-B, M-C, M-D, M-E)

## Summary of Changes

### 1. Canonical OKX V5 `attachAlgoOrds` Schema (M-E)

- In `packages/broker/src/index.ts`:
  - Retained confirmed OKX V5 fields: `attachAlgoClOrdId`, `slTriggerPx`, `slOrdPx: "-1"`, `slTriggerPxType: "mark"`, `tpTriggerPx`, `tpOrdPx: "-1"`, `tpTriggerPxType: "mark"`.
  - Dropped unverified inner fields `reduceOnly` and `closeFraction` from `attachAlgoOrds` to avoid API schema rejection (`code: "51000"`). Root order payload retains `reduceOnly`.
- Updated `docs/research/okx-v5-semantics.md` with explicit confirmed vs unverified parameter breakdown.

### 2. True Order Fill Ingestion & Honest Execution Status (M-B)

- In `submitOrder`:
  - Queries `GET /api/v5/trade/order` to retrieve real volume-weighted `avgPx`, `fillPx`, `accFillSz`, and exchange fee.
  - If fill details cannot be confirmed from the exchange report or are not in `"filled"` state, order status is recorded as `"SUBMITTED"` rather than fabricating `"FILLED"` at the signal price.

### 3. Explicit Algo Cancellation on Emergency Flatten (M-C)

- In `flattenAllPositions`:
  - Explicitly queries active conditional and OCO algo orders and calls `POST /api/v5/trade/cancel-algo-orders` to cancel resting stops and take-profits from the order book.
  - Clears DMS countdown timer via `cancel-all-after` with `timeOut: "0"` in coordination with algo order cancellation.
  - Enforces response checking (`code === "0"` and `sCode === "0"`). If any flatten order fails, the position remains `OPEN` and emits a `CRITICAL` alert.

### 4. Credential-Guarded DMS Heartbeats (M-D)

- In `sendDmsHeartbeat`:
  - Returns `{ ok: false, countdownSeconds: 0, status: "not_configured" }` when credentials are unconfigured; `getDmsStatus()` reports `healthy: false`.

### 5. Multi-Type Algo Reconciliation & Dual Mode Position Matching

- In `reconcilePositions`:
  - Queries both `ordType=conditional` and `ordType=oco` to comprehensively account for attached bracket protective stops.
  - Supports both net mode (`posSide === "net"`, signed quantity) and long/short mode (`posSide === "long"` / `"short"`).

---

## Verification

- `packages/broker/test/okx-broker.test.ts` (25 tests):
  - `M-E: attachAlgoOrds includes confirmed fields and excludes unverified reduceOnly/closeFraction`: confirms inner payload adheres strictly to OKX V5.
  - `M-B: submitOrder marks status SUBMITTED when fill details cannot be confirmed`: verifies unconfirmed fills do not fabricate `"FILLED"`.
  - `M-C: flattenAllPositions explicitly cancels attached algo orders on exchange`: verifies `cancel-algo-orders` call is dispatched.
  - `Reconciliation: queries both conditional and oco ordTypes and matches long/short and net mode positions`: verifies multi-type algo queries and position matching.
- Workspace test suite: 20 test files, 139 tests passing.
- Static checks: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean.
