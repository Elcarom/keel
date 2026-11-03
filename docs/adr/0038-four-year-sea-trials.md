# ADR-0038: Four-Year Sea Trials

## Status

Accepted. Amends ADR-0025 (Sea Trials) and ADR-0035 (the research gate).

## Context

The "more skill than luck" check (ADR-0035) adjusts a Sharpe ratio for every backtest the Fleet has run on the same history. Since research went around the clock (ADR-0037), that count is in the thousands. On two years of hourly data, a Sharpe of 2 then reaches only about 24% confidence against the 90% required. Among that many tries, the best of them would show a Sharpe of 2 by luck alone. Good ideas were set aside: Racing Hulls scored 83 with a Sharpe of 2.01 and reached 23%.

The confidence grows with the square root of the length of the history. The other options were to count ideas rather than backtests (fairer, but not enough on its own) or to lower the 90% bar (the way lucky curve-fits get through).

## Decision

- **Up to four years.** A sea trial replays the four years before 2024-12-01, from 2020-12-01. That covers the 2021 bull market, the 2022 crash and the 2023–2024 recovery. The 2025 Blind Trial and the sealed 2026 partition are unchanged.
- **As far back as every market has history.** OKX listed SOL in January 2021 and BNB in December 2022. A trial starts on the first full day on which every market it reads has OKX history, including its sibling market: SOL ideas from 2021-01-23, BNB ideas from 2022-12-24, everything else from 2020-12-01. A trial never waits for history that does not exist.
- **Lookalikes compare the weeks two trials share.** Weekly equity is counted back from the window's end, and two curves are correlated over the weeks they share. This lets a four-year trial be compared with a two-year one, including boats trialled before this change.
- **The gate itself is unchanged.** It still needs 150 trades, a Sharpe of 1, 90% luck-adjusted confidence and a worst dip within 25%, and every backtest still counts as a trial.

## Consequences

- A real edge earns about 40% more statistical weight. A Sharpe of 2 that lasts four years clears the luck adjustment where two years could not. An idea that only fitted 2023–2024 now has to survive 2021 and 2022 as well, so luck finds it harder.
- Each sea trial replays about twice as much history, so it takes about twice as long. The first trial on each coin downloads four years of OKX history once.
- Earlier assessments keep their two-year results. Boats already at sea are not re-trialled.
