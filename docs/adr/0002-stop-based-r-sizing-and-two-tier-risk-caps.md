# 0002. Stop-Distance Risk Sizing (1R) and Two-Tier Portfolio Risk Caps

**Status**: accepted

Every opening or adding trade proposal is sized deterministically from its initial protective stop distance so that a stop-out loses at most `1R` (default `0.75%` of strategy equity), calculated as `floor(riskBudgetUsd / (ctVal * |entryPx - stopPx|))` in integer lots. If a single minimum exchange lot (`minOrderSize`) would risk more than `1R`, the Risk Engine vetoes the trade (`min_lot_exceeds_risk_cap`) rather than rounding up. Risk limits are enforced at two tiers: per-strategy caps (`2.0x` gross leverage, `3%` daily loss, `6%` weekly loss, `15%` max drawdown auto-demotion) and portfolio-wide caps across all active strategies (`2.0x` gross leverage, `±1.25x` net directional exposure, `1.0x` single-instrument cap, `4%` daily loss, and `12%` portfolio drawdown global kill switch).

## Consequences

- Strategies must always supply an initial `stopPx` alongside any opening `Proposal`; a proposal without a stop is unsizeable and rejected at the type/schema boundary.
- Small live accounts (`500–2,500 USDT`) during `Live-Ramp` automatically skip instruments whose contract granularity (`ctVal * minSz`) is too coarse for the `1R` budget instead of silently taking oversized tail risk.
- Simultaneous same-direction entries across multiple strategies are bounded by the portfolio net directional exposure cap (`±1.25x`).
