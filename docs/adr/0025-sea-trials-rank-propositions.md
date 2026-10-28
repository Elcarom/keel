# ADR-0025: Propositions Are Ranked by Sea Trials, Not a Single Backtest

## Status

Accepted

## Context and Decision

ADR-0024 ranked Propositions by one in-sample backtest over a year. With thirteen archetypes, ten instruments and a model proposing parameters, picking the best-looking backtest selects for luck. A Proposition is now ranked by a **Sea Trial**:

- **Two years, not one.** The window is the two years before 2024-12-01: in-sample, clear of the sealed holdout. It covers the 2023 range and the 2024 rally.
- **The same idea, nudged.** The main window is re-run 25% shorter and 33% longer, then the trigger (or, for archetypes without one, the stop) tighter and looser. Most nudged versions must stay profitable.
- **The same idea elsewhere.** The unchanged Blueprint is re-run on a fixed Sibling Market, for example SOL on AVAX.
- **Statistics over the trades.** These are doubled costs, purged walk-forward out-of-sample expectancy, eight equal seasons, 1,000 bootstrap reshuffles of the trade sequence, a t-test, a random-entry percentile, risk-adjusted comparison with holding, and the deflated Sharpe ratio. The trial count behind the deflated Sharpe is every Proposition ever drafted, not just the batch.
- **Score and verdict.** Up to 40 points come from headline performance (Sharpe, annualised return, drawdown) and up to 60 from weighted checks. Four checks are critical: enough trades, survives doubled costs, holds up out of sample, and robust to nudged settings. A Proposition failing any of them can be at most "promising", whatever its score.
- **Funding is charged pessimistically.** OKX's public API keeps only about three months of funding history. When a window has none, every open position pays 0.01% per 8h, long or short. The Assessment records whether funding was settled or assumed.
- **New coins are paper-only.** SOL, XRP, DOGE, BNB, ADA, AVAX, LINK and LTC carry OKX's contract specs for paper trading and replay. The exchange broker and the manual exchange-order endpoint refuse them. Widening that list is a Gate G2 change.

## Considered Options

- **Rank by a weighted score alone**: rejected. A fragile idea with one spectacular run would still top the list.
- **Optimise parameters per proposition, then validate**: rejected for now. It multiplies backtests and invites the overfitting the trial exists to catch.
- **Use the strict research gate as the verdict**: rejected as a verdict. It needs 100 trades and a Sharpe of 1, which almost no idea meets, so it could not rank anything. It is still shown.

## Consequences

- A Sea Trial runs six backtests. Replay now serves each bar's snapshot from bars already in memory instead of querying the database per bar, with identical results. Even so, a trial takes several seconds, and the first use of an instrument downloads two years of history.
- Older Assessments have no Sea Trial. They load as before and show the one-year result.
- The random-entry baseline is weak, because random entries pay the same costs. That check is worth few points and only counts for a profitable Proposition.
