# ADR-0028: Boats May Trade a Basket of Coins and Read Other Markets

## Status

Accepted. This extends ADR-0025 and ADR-0026.

## Context and Decision

Until now, every Boat traded one coin and its rules could only read that coin. So "BTC leads the alts" could not be written as a rule, and an idea that should hold across similar coins had to be launched once per coin.

- **Baskets.** A Blueprint keeps its `instrumentId` and gains a `basket` of up to four more coins. The same compiled rules run on each coin, holding one position per coin, all inside the one Boat Book. Every position is sized off the Boat's whole equity and carries its own exchange-style protective stop. The Boat Book's existing Risk Engine limits (gross leverage, loss limits) apply across all the coins together.
- **Reference Markets.** Any number reading (`bar_field`) and any indicator may name a `market`. It then reads that market's confirmed 1H bars, aligned hour by hour to the bars of the coin being traded. Each traded bar sees the latest reference bar that closed at or before it, and never one that closed later. If a Reference Market has not posted the current hour, the strategy stands down for that bar. A live Boat waits up to three hours for the missing bar before it carries on without it.
- **A Basket's Sea Trial is one portfolio.** Each coin is replayed on the full stake, as the live Boat sizes each position, and the equity changes are added up hour by hour. Return, Sharpe, the luck adjustment and the worst dip are measured on that combined curve. Statistics each replay can only measure on its own coin, such as cost stress, walk-forward folds, random entries and holding, are averaged across the coins, weighted by trades where trades drive them. Nudged settings are trialled across the whole Basket. The Sibling Market is a coin the Boat neither trades nor reads.

## Considered Options

- **One multi-instrument replay**: rejected for now. It would rewrite the replay engine's single-instrument state machine and its walk-forward folds, while summing independent per-coin runs gives the same profit and loss.
- **Let rules read future bars of slower markets**: rejected. The as-of rule in AGENTS.md admits no exceptions.

## Consequences

- A Basket Boat's Sea Trial takes about as many times longer as the number of coins it trades.
- The combined trial ignores one limit the live Boat has: the shared gross-leverage cap can veto a coin's entry when several coins hold positions at once. Backtests of Baskets are therefore slightly optimistic when many coins trigger together.
- The scheduler ingests every coin a running Boat trades or reads.
- Stored Blueprints from before this change have no `basket`, and they read as single-coin Boats.
