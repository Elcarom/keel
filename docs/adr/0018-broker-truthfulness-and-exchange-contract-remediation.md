# ADR-0018: Exchange Broker Truthfulness, Fill Polling, & Order Lifecycle Remediation (M-B, M-C, M-D, M-E)

## Status

Accepted

## Context

Auditing of the exchange broker implementation (`packages/broker/src/index.ts`) revealed critical truthfulness and protocol defects:

1. **Unverified Order Fill Assumptions (M-B)**:
   - When placing market entry orders via `POST /api/v5/trade/order`, OKX returns acknowledgement IDs but never the executed fill price (`fillPx` or `avgPx`).
   - The broker previously assumed `fillPrice = input.entryPrice` and unconditionally marked orders `status: "FILLED"`.
   - If the fill query timed out or failed, synthetic fill values were preserved without operator notification.
2. **Dead-Man's Switch vs Resting Order Cancellation (M-C)**:
   - In `flattenAllPositions`, sending `cancel-all-after` with `timeOut: "0"` disarmed/cancelled the heartbeat countdown timer, but did **not** cancel active resting limit or conditional algo orders.
   - Resting protective stops and take-profits were left active on the book during emergency flattening.
3. **Unverified Fields inside `attachAlgoOrds` (M-E)**:
   - `attachAlgoOrds` previously contained `reduceOnly: true` and `closeFraction: "1"`.
   - In OKX V5 REST API specifications, `reduceOnly` belongs to the parent order payload and `closeFraction` is not supported inside `attachAlgoOrds`, exposing orders to API schema rejection (`code: "51000"`).
4. **Heartbeat State Without Credentials (M-D)**:
   - An unlinked broker instance with unconfigured credentials previously recorded a healthy heartbeat without communicating with OKX.
5. **Reconciliation Completeness**:
   - `reconcilePositions` previously queried only `ordType=conditional`, omitting `oco` and other trigger algos, and lacked comprehensive handling for net versus long/short position modes.

## Decision

1. **True Fill Ingestion & Explicit SUBMITTED Status (M-B)**:
   - `submitOrder` queries `GET /api/v5/trade/order` to retrieve the executed volume-weighted `avgPx`, `fillPx`, `accFillSz`, and actual fees.
   - If fill confirmation cannot be confirmed from the exchange report (e.g. state is not `"filled"` or price is `"0"`), the order is explicitly marked `status: "SUBMITTED"` rather than fabricating a `"FILLED"` state at the signal price.
2. **Explicit Algo Order Cancellation on Flatten (M-C)**:
   - During `flattenAllPositions`, the broker queries all pending conditional and OCO algo orders and dispatches `POST /api/v5/trade/cancel-algo-orders` to cancel resting protective stops and take-profits immediately.
   - Clears the dead-man switch timer via `POST /api/v5/trade/cancel-all-after` with `timeOut: "0"` only after order cancellations are issued.
   - Verifies response codes and `sCode` on all market reduceOnly orders. If any order fails, the position remains `OPEN` and a `CRITICAL` alert is dispatched.
3. **Canonical OKX V5 `attachAlgoOrds` Schema (M-E)**:
   - Elements inside `attachAlgoOrds` strictly include confirmed OKX V5 fields: `attachAlgoClOrdId`, `slTriggerPx`, `slOrdPx: "-1"`, `slTriggerPxType: "mark"`, `tpTriggerPx`, `tpOrdPx: "-1"`, and `tpTriggerPxType: "mark"`.
   - Unverified inner fields (`reduceOnly`, `closeFraction`) are removed. Parent order payload retains root-level `reduceOnly`.
4. **Credential Guarded DMS Heartbeats (M-D)**:
   - `sendDmsHeartbeat` returns `{ ok: false, countdownSeconds: 0, status: "not_configured" }` and `getDmsStatus()` reports `healthy: false` when credentials are not configured.
5. **Multi-Type Algo & Dual Mode Reconciliation**:
   - `reconcilePositions` queries both `ordType=conditional` and `ordType=oco` to account for all resting stops and bracket take-profits.
   - Evaluates positions across both `posSide === "net"` (signed position quantity) and long/short modes (`posSide === "long"` or `"short"`).

## Consequences

- The broker never assumes fill prices, reports honest execution states (`SUBMITTED` vs `FILLED`), and accounts for real exchange fees.
- Emergency position flattening explicitly removes all resting algo triggers from the exchange.
- Attached orders strictly adhere to verified OKX V5 REST schemas, eliminating exchange rejection risk.
- Exchange reconciliation accurately accounts for all bracket orders and account position modes.
