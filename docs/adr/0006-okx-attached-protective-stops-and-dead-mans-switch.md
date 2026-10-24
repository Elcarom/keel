# 0006. Atomic Attached Protective Stops and OKX Cancel-All-After Dead-Man's Switch

**Status**: accepted

Every live or demo opening order on OKX must atomically include an exchange-resident conditional stop-loss (`attachAlgoOrds` on `POST /api/v5/trade/order` with `slTriggerPx`, `slOrdPx = -1` market, `slTriggerPxType = mark`, `reduceOnly = true`, `closeFraction = 1`), and the broker adapter continuously maintains OKX's native Dead-Man's Switch (`POST /api/v5/trade/cancel-all-after` with a 60-second countdown refreshed every 15 seconds).

## Consequences

- **No naked positions**: An entry order cannot be submitted without its protective stop attached in the same request. When ratcheting a stop in the position's favor, the adapter amends the existing exchange algo order (`POST /api/v5/trade/amend-algos`) rather than cancelling first, so there is zero window without exchange-side protection. If an attached stop is ever missing during periodic reconciliation, the engine immediately places a replacement stop or flattens the position at market and fires a `CRITICAL` alert.
- **Crash behavior**: If the Unraid container crashes, hangs, or loses network connectivity for >60 seconds, OKX's `cancel-all-after` automatically cancels all resting unexecuted entry/add limit orders while leaving the position-attached mark-price Protective Stops active on the exchange.
