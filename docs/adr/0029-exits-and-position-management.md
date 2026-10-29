# ADR-0029: Exit Rules, Time Stops and Trailing Stops

## Status

Accepted. This extends ADR-0006, ADR-0014 and ADR-0026.

## Context and Decision

Until now every strategy left a trade the same way: a fixed ATR stop or a fixed take-profit. So trend riders, session trades and reversion trades were all forced to exit alike. Strategies can now manage an open position:

- **One hook, two engines.** A strategy may implement `manage`. The replay and the paper broker both call it on every confirmed bar while a position is open, after the stop and target were checked. It returns one of two answers:
  - hold, optionally with a proposed stop
  - exit, with a reason
- **Exits fill at the bar's close, with adverse slippage.** The decision is made on a confirmed bar. Crypto trades around the clock, so the next bar opens at that close, and Keel uses the same market-exit costing as a flatten.
- **Stops only move towards safety.** The broker, not the strategy, applies a proposed stop, and only when it is strictly tighter (`isTighterStop`). A strategy can never loosen a stop.
- **Three exits in the Spec language:**
  - `rules.longExit` and `rules.shortExit`: conditions with their own budget of 16 nodes, so exits never crowd out entries.
  - `risk.timeStopBars`: close after that many hours.
  - `risk.trailingStop`: ratchet the stop that many ATRs behind each close.
- **New indicators:** ADX with ±DI, Bollinger bands, percentile rank, and the correlation or beta of the traded coin against another market.

## Consequences

- The exchange broker does not yet act on `manage`. Fleet boats are paper-only, and gate G2 stays closed for exchange execution, so this gap cannot reach a real account.
- Nudged sea-trial variants scale exit thresholds like entry thresholds.
