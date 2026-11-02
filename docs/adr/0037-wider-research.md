# ADR-0037: Wider Research: Ideas Already Tried, a Focus per Round, and a Quicker Pace

## Status

Accepted. Amends ADR-0033 (the night shift) and ADR-0036 (full autonomy).

## Context

Around the clock, the night shift still drew up too few ideas, and too many of them were alike. Each round sent Claude the same request and showed it only the last 15 failures, so it had no memory of what it had already tried. It kept returning to the textbook staples (an RSI dip, a moving-average cross, a channel breakout), and many ideas were near-copies of earlier ones. A round asked for 4 ideas at most every 30 minutes, although a sea trial takes about 15 seconds an idea.

## Decision

- **Ideas already tried.** Each round shows Claude the last 40 new ideas, newest first. Each line gives the idea's name, coin and tagline, the ingredients it was built from (for example funding, a pair, a higher timeframe, a time limit), and whether it passed. Claude is told never to offer any of them again, or a near-variant. As ADR-0035 requires, it is never told which checks an idea failed or by how much.
- **A focus per round.** Keel keeps twelve research themes, one per ingredient: funding and crowding, lead and lag between markets, relative value, an edge shared across coins, sessions and the calendar, volatility regimes, volume shocks, the hour inside the day, exits that know when it is over, asymmetry, letting winners run, and short, timed trades. Each round takes the theme the last 40 ideas used least, and ties go round in turn. Claude builds at least half the round's ideas around it, and the rest may go anywhere new. Upgrades have no focus. Choosing the theme is plain bookkeeping over the rules already drawn up: no model chooses it.
- **A push for originality.** The Shipwright prompt now says the staples may serve only as a filter inside a bigger idea, and asks for range across coins, horizons, directions and structures within each round.
- **A quicker pace.** A round asks for 6 ideas by default (up to 8), with at least 10 minutes between rounds. Once per database, a saved config still on the old defaults (4 ideas, 30 minutes) moves to the new ones. A value the operator chose is kept.

## Consequences

- About three times as many ideas reach a sea trial each hour, and each round explores ground the recent ones did not.
- Each round uses more of the Claude subscription. Under the plan's usage limits the gap or the count can be turned down in the Engine Room.
- More ideas means more backtests on the same two years. The luck adjustment already counts every backtest (ADR-0035), so the bar to seaworthy rises as the search widens. More ideas will be tried, but no more will pass by luck.
