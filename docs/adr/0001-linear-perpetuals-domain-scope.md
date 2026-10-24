# 0001. Scope Core Domain to Multi-Venue Linear Quote-Settled Perpetuals

**Status**: accepted

We scope the core domain model (`core`, `ledger`, `risk`, `broker`) to linear, quote-settled (`USDT`/`USDC`) perpetual swaps using isolated margin and one-way (net) position mode, with OKX EEA as the first `Venue` adapter behind a venue-agnostic `Broker` port. We explicitly exclude Spot, Inverse (coin-margined) contracts, and Options from the domain model because inventory accounting, non-linear payout convexity, and multi-leg Greeks would complicate the deterministic ledger and risk invariants without serving our systematic perpetuals workflow.

## Consequences

- `Instrument` metadata normalizes linear contract specifications across venues (`contractValue`, `lotSize`, `tickSize`, `minOrderSize`, `maxLeverage`, `settlementCurrency`) so a second linear perps venue (e.g. Hyperliquid, Bybit, or Binance) requires only a new `Broker` and market-data adapter.
- All P&L, margin, fee, and settled funding calculations in `ledger` and `risk` operate in a single linear quote currency per portfolio using exact decimal/fixed-point arithmetic.

