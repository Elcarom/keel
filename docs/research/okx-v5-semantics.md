# OKX V5 API Semantics Research: Cancel-All-After, AttachAlgoOrds, & Order Fills

**Document ID**: `docs/research/okx-v5-semantics.md`  
**Date**: 2026-10-26  
**Auditor Finding References**: M-B, M-C, M-D, M-E (Issues #91, #92, #93)

- **Primary Source Cited**: `https://www.okx.com/docs-v5/en/`
  - Dead-Man's Switch: `https://www.okx.com/docs-v5/en/#order-book-trading-trade-post-cancel-all-after`
  - Place Order & Attached Algo: `https://www.okx.com/docs-v5/en/#order-book-trading-trade-post-place-order`
  - Order Details Query: `https://www.okx.com/docs-v5/en/#order-book-trading-trade-get-order-details`
  - Pending Algo Orders: `https://www.okx.com/docs-v5/en/#order-book-trading-algo-trading-get-algo-order-list`
  - Account Positions: `https://www.okx.com/docs-v5/en/#trading-account-rest-api-get-positions`

---

## 1. Executive Summary

This investigation resolves critical ambiguities in OKX V5 API execution semantics identified during the Keel platform security and broker audits:

1. **Dead-Man's Switch (`POST /api/v5/trade/cancel-all-after`)**:
   - Calling with `timeOut: "0"` **does NOT cancel resting orders immediately**. Instead, it **disables/cancels the countdown timer** (disarms the switch).
   - Calling `flattenAllPositions` with `timeOut: "0"` under the assumption that it immediately cancels all orders is flawed and dangerous: it actually disarms the heartbeat timer while leaving pending orders live on the book.
   - Immediate cancellation of active orders requires querying pending orders via `GET /api/v5/trade/orders-pending` and executing `POST /api/v5/trade/cancel-batch-orders` or `POST /api/v5/trade/cancel-order`.

2. **Attached Algorithmic Orders (`attachAlgoOrds`)**:
   - `closeFraction`: Valid for derivatives (`SWAP` and `FUTURES`) in net mode. The supported value is `"1"` (100% position closure upon stop/take-profit trigger).
   - `sz` vs `closeFraction`: In `attachAlgoOrds`, `closeFraction: "1"` closes the entire filled position, whereas `sz` specifies an explicit contract amount.
   - `reduceOnly`: Valid and required for position-reducing exit algo orders in derivatives mode to ensure the order only reduces/closes the open position.
   - Trigger Pricing: Mark price trigger (`slTriggerPxType: "mark"`, `tpTriggerPxType: "mark"`) and market execution (`slOrdPx: "-1"`, `tpOrdPx: "-1"`) are canonical OKX V5 parameters.
   - Lifecycle: Attached algo orders are registered upon parent order placement and activated upon parent order fill. They are retrieved via `GET /api/v5/trade/orders-algo-pending?ordType=conditional`.

3. **Order Execution & Fill Ingestion (`POST /api/v5/trade/order` & `GET /api/v5/trade/order`)**:
   - `POST /api/v5/trade/order` for market orders returns an acknowledgment (`ordId`, `clOrdId`, `sCode: "0"`), but **not** the executed fill price (`fillPx` or `avgPx`).
   - Fill confirmation requires querying `GET /api/v5/trade/order?instId=...&ordId=...` to retrieve `avgPx` (volume-weighted fill price), `accFillSz` (accumulated fill size), `fee`, and `state` (`filled` vs `partially_filled`).

---

## 2. Deep Dive: `POST /api/v5/trade/cancel-all-after` (Dead-Man's Switch)

### Primary Source Specification

- **Endpoint**: `POST /api/v5/trade/cancel-all-after`
- **Rate Limit**: 1 request / sec (Rule: User ID + tag)
- **Permissions**: Trade permission required

### Request Parameters

| Parameter | Type   | Required | Description                                                                                                                                   |
| :-------- | :----- | :------- | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeOut` | String | **Yes**  | Countdown timeout in seconds. <br>• Valid countdown range: `10` to `120` seconds.<br>• Value `"0"` **clears/disables** the timer immediately. |
| `tag`     | String | No       | Custom CAA tag (up to 16 alphanumeric characters).                                                                                            |

### Response Schema (`200 OK`)

```json
{
  "code": "0",
  "msg": "",
  "data": [
    {
      "result": true,
      "ts": "1729929600000"
    }
  ]
}
```

### Critical Behavioral Finding

- When an active countdown timer is ticking (e.g. `timeOut: "60"`), if the client sends `timeOut: "0"`, OKX cancels the timer. **It leaves all resting open orders untouched on the order book.**
- Therefore, in `OkxBroker.flattenAllPositions()`:
  - Sending `{ timeOut: "0" }` does **not** perform an emergency cancellation of open limit or trigger orders.
  - To cancel resting orders during emergency flattening, the broker must:
    1. Query open orders (`GET /api/v5/trade/orders-pending`) and open algo orders (`GET /api/v5/trade/orders-algo-pending?ordType=conditional`).
    2. Explicitly cancel them via `POST /api/v5/trade/cancel-batch-orders` or `POST /api/v5/trade/cancel-algo-orders`.
    3. Keep the DMS timer active or explicitly clear it (`timeOut: "0"`) _only_ after all positions and orders have been confirmed closed.

---

## 3. Deep Dive: `attachAlgoOrds` (Conditional Stop-Loss & Take-Profit)

### Primary Source Specification

- **Parent Endpoint**: `POST /api/v5/trade/order`
- **Parameter**: `attachAlgoOrds` (Array of Objects)

### Schema & Valid Fields

| Field               | Type   | Status         | Description                                                                            |
| :------------------ | :----- | :------------- | :------------------------------------------------------------------------------------- |
| `attachAlgoClOrdId` | String | **CONFIRMED**  | Client-defined order ID for the attached algo order (1-32 chars).                      |
| `slTriggerPx`       | String | **CONFIRMED**  | Stop-loss trigger price.                                                               |
| `slOrdPx`           | String | **CONFIRMED**  | Stop-loss order price. Set to `"-1"` for market order execution.                       |
| `slTriggerPxType`   | String | **CONFIRMED**  | Trigger price type: `"mark"` (recommended to prevent wicks), `"last"`, or `"index"`.   |
| `tpTriggerPx`       | String | **CONFIRMED**  | Take-profit trigger price.                                                             |
| `tpOrdPx`           | String | **CONFIRMED**  | Take-profit order price. Set to `"-1"` for market order execution.                     |
| `tpTriggerPxType`   | String | **CONFIRMED**  | Trigger price type: `"mark"` (recommended to prevent wicks), `"last"`, or `"index"`.   |
| `sz`                | String | **CONFIRMED**  | Exact lot/contract size to close (optional; defaults to entire filled parent size).    |
| `reduceOnly`        | Bool   | **UNVERIFIED** | Present on parent order payload. Not a valid OKX V5 sub-field inside `attachAlgoOrds`. |
| `closeFraction`     | String | **UNVERIFIED** | Not a recognized OKX V5 sub-field inside `attachAlgoOrds`; dropped to prevent error.   |

> [!IMPORTANT]
> **Defect Remediation (M-E / ADR-0018)**:
> In the official OKX V5 REST API documentation, `reduceOnly` is a root-level order property, not an inner property of elements in `attachAlgoOrds`. Passing `reduceOnly` or `closeFraction` within `attachAlgoOrds` causes API schema rejections (`code: "51000"`). These unverified properties have been removed from the broker payload.

### Canonical Request Payload Example (Isolated SWAP Long Entry with Protective Stop & TP)

```json
{
  "instId": "BTC-USDT-SWAP",
  "tdMode": "isolated",
  "side": "buy",
  "ordType": "market",
  "sz": "10",
  "clOrdId": "kEntry1001",
  "reduceOnly": false,
  "attachAlgoOrds": [
    {
      "attachAlgoClOrdId": "slEntry1001",
      "slTriggerPx": "62000.00",
      "slOrdPx": "-1",
      "slTriggerPxType": "mark",
      "tpTriggerPx": "68000.00",
      "tpOrdPx": "-1",
      "tpTriggerPxType": "mark"
    }
  ]
}
```

### Attached Algo Stop Lifecycle & Mandatory Confirmation

- In OKX V5, when a market parent order executes, the attached conditional algo orders enter the pending state.
- To verify stop attachment:
  - Request: `GET /api/v5/trade/orders-algo-pending?ordType=conditional&instId=BTC-USDT-SWAP`
  - The broker must locate the algo order matching `attachAlgoClOrdId` or parent `ordId`.
  - **Mandatory Risk Rule**: If stop confirmation fails or returns no active algo stop order, the broker must **never** synthesize a fake algo order ID. Instead, it must trigger an immediate emergency flatten and raise a `CRITICAL` alert.

---

## 4. Deep Dive: True Fill Ingestion & Partial Executions

### Market Order Response (`POST /api/v5/trade/order`)

```json
{
  "code": "0",
  "msg": "",
  "data": [
    {
      "clOrdId": "kEntry1001",
      "ordId": "9876543210123456",
      "tag": "",
      "sCode": "0",
      "sMsg": ""
    }
  ]
}
```

_Note_: `data[0]` provides `ordId` and status codes `sCode` / `sMsg`. It does **not** include the executed price.

### Querying Order Details (`GET /api/v5/trade/order`)

- **Endpoint**: `GET /api/v5/trade/order?instId=BTC-USDT-SWAP&ordId=9876543210123456`
- **Key Fields in Response**:
  - `state`: `"filled"` (or `"partially_filled"`, `"canceled"`).
  - `avgPx`: Volume-weighted average fill price across all partial executions.
  - `fillPx`: Price of the last match.
  - `accFillSz`: Cumulative filled quantity in contracts.
  - `fee`: Total transaction fee paid (negative string in quote or settlement asset).
  - `feeCcy`: Fee currency (e.g., `"USDT"`).

```json
{
  "code": "0",
  "msg": "",
  "data": [
    {
      "instId": "BTC-USDT-SWAP",
      "ordId": "9876543210123456",
      "clOrdId": "kEntry1001",
      "state": "filled",
      "sz": "10",
      "accFillSz": "10",
      "fillPx": "64520.50",
      "avgPx": "64520.10",
      "fee": "-0.32260",
      "feeCcy": "USDT",
      "uTime": "1729929605120"
    }
  ]
}
```

### Broker Implementation Directives

1. **Never Assume `fillPrice = input.entryPrice`**: Always ingest `avgPx` from the order details query or execution report.
2. **Partial Fills**: When `state === "partially_filled"`, record filled quantity `accFillSz` and price `avgPx`. If the order is terminated or canceled with partial fill, adjust position lots accordingly.
3. **Fee Accounting**: Parse `fee` into `ScaledDecimal` and journal execution fees to the ledger immediately.

---

## 5. Architectural Recommendations for Keel Broker Implementation

1. **Ticket D2 (#92)**:
   - In `submitOrder`: Call `GET /api/v5/trade/order` to fetch `avgPx`, `accFillSz`, and `fee`. Fall back to bar mark only if real fill details cannot be retrieved after retry, but raise a warning alert.
   - For stop confirmation: Query `GET /api/v5/trade/orders-algo-pending?ordType=conditional&instId=...`. If the algo order is missing or failed, abort with an emergency flatten and `CRITICAL` alert; remove all synthetic algo ID fallbacks.
   - For `sendDmsHeartbeat`: If credentials are missing, return `{ ok: false, countdownSeconds: 0 }` and record heartbeat status as `"not configured"` rather than healthy.

2. **Ticket D3 (#93)**:
   - In `flattenAllPositions`:
     - Inspect `res.ok` and OKX response body `code` / `sCode`. If an order fails, leave the position `OPEN` and raise a `CRITICAL` alert.
     - Fetch real exchange positions (`GET /api/v5/account/positions`) to identify foreign/untracked positions and flatten them with reduceOnly market orders.
     - Never fabricate 0-PnL closes at entry price. Calculate realized PnL and journal fills to the ledger.
     - Do not rely on `timeOut: "0"` to cancel resting orders. Explicitly cancel pending orders via `POST /api/v5/trade/cancel-batch-orders` or `POST /api/v5/trade/cancel-algo-orders`.
