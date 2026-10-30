# ADR-0032: Pair Boats Hold One Coin Against Another

## Status

Accepted. This extends ADR-0026, ADR-0028 and ADR-0029.

## Context and Decision

Every Boat so far bet on prices moving. Pair trades bet on two related coins moving relative to each other: buy the one that has fallen behind, sell the one that has run ahead, and let the market's own swing cancel out. Doing that safely needs two linked positions and a backtest that simulates them together, on the money path.

- **A pair is a Blueprint with `pairWith`.** Two archetypes use it: `pair_reversion` fades a stretched gap, and `pair_momentum` rides one coin steadily outrunning the other. An Invention may set `pairWith` too, if its entry rules read the second coin. A pair has no Basket and no trailing stop, and it always has a time limit (three lookbacks unless set).
- **One set of rules, mirrored.** The `spread` indicator measures the traded coin's log price against a market: a z-score and a drift. A pair compiles once per Leg. The second Leg's rules are the first's, with the two coins swapped wherever a rule names a market. So a spread stretched one way for the first Leg is stretched the other way for the second, and one Leg buys exactly when the other sells. A "long only" pair only ever buys the first coin, so its second Leg only sells.
- **Equal Legs.** Each Leg's Protective Stop sits the same share of price away: the wider of the two coins' ATR(14) as a percentage, times `stopAtrMultiple`. Stop-risk sizing then gives both Legs the same notional. Each Leg risks one Risk-per-Trade, so a pair whose Legs are both stopped out loses two. A pair leaves on its exit rules or its time limit, and its target is set at 10× the risk so it only guards a runaway Leg.
- **The pair rule.** After every hour, Keel looks at both Legs together:
  - A Leg left open on its own is closed at that hour's close. This covers a partner that was stopped out, hit its target, or was vetoed by the Risk Engine and never filled.
  - Two Legs open on the same side are both closed.
  - Entries go ahead only as a matched pair: both Legs waiting to enter, on opposite sides.
- **One rule, two engines.** `reconcilePairLegs` in `@keel/strategy` holds the rule. The live Boat applies it to its paper book after stepping both Legs through each hour. The pair replay applies it at the same point. Every Leg is still an ordinary position with its own exchange-style Protective Stop, judged by the Risk Engine like any other.
- **A pair's Sea Trial replays both Legs together.** `runPairReplay` steps both Legs bar by bar on one shared equity, with the same fills, costs, funding, stops and exits as a single-market replay. It records each round trip as one trade. A pair is market-neutral, so its benchmark is cash: no return and no Sharpe. The random-entry baseline draws random pair trades of the same count and length. The Sibling Market check runs the same rules on another pair of coins.

## Considered Options

- **Trade the price ratio as one synthetic instrument**: rejected. The backtest would stop and size a ratio that no venue lists, while the live Boat holds two real positions with stops of their own. The two would disagree exactly when it matters.
- **Close the partner only at the next bar**: rejected. It leaves a naked Leg for an hour, and the backtest would have to model that hour too.
- **Halve each Leg's risk so a pair risks one in total**: rejected for now. It would need a pair-aware Risk Engine. Each Leg passes the existing Risk Engine unchanged instead, and the Sea Trial measures the doubled worst case.

## Consequences

- A pair's Sea Trial takes about as long as a two-coin Basket's.
- On the synthetic stand-in series, two coins share one shape, so their spread barely moves and a pair rarely trades. Pairs need real OKX history.
- The exchange broker still does not act on exits or the pair rule. Fleet Boats are paper-only and gate G2 stays closed (ADR-0029).
