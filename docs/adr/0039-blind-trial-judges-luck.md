# ADR-0039: The Blind Trial Judges Luck

## Status

Accepted. Amends ADR-0035 (the luck adjustment and the Blind Trial's rule) and ADR-0038.

## Context

The "more skill than luck" check deflates a design's Sharpe ratio by the best result that luck alone would give among every try on the same history. ADR-0035 made it critical and counted six backtests per idea ever drafted. Since research went around the clock (ADR-0037), the Fleet drafts hundreds of ideas a day. With tens of thousands of tries, a design needs a Sharpe ratio of about 2.7 over four years to reach the 90% confidence required. Almost no systematic crypto strategy reaches that after costs, so almost nothing became viable, whatever its quality.

The bar grows with the logarithm of the count. Counting more fairly lowers it only a little: from about 2.7 to about 2.3. Lowering the confidence to 80% does even less. The other ways to hold the bar down, drafting fewer ideas or never trying new ones, work against an autonomous search for an edge.

The Fleet already has the honest test of luck: the Blind Trial. It is one replay on a year that no Sea Trial and no Shipwright prompt ever sees, under a rule fixed in advance, with a budget of looks. Luck found in-sample does not carry over to unseen data.

## Decision

- **The luck adjustment scores but does not block.** "More skill than luck" stays in every Sea Trial with its 6 points, but it is no longer a critical check. A design that clears the other critical checks with a score of at least 65 earns its Blind Trial even when the adjustment fails.
- **The Blind Trial asks for the gate's Sharpe ratio.** Over the unseen year a design must now earn at least the research gate's Sharpe ratio (1 by default), along with half the gate's trades, a positive average trade with every cost doubled, and a worst dip within 25%. A positive average trade alone is too easy a bar for the many more designs that now reach it.
- **Distinct ideas, not backtests.** The luck adjustment counts one try per idea ever drafted. Ideas whose weekly curves move together, at the Lookalike correlation (0.8) or more over the last two years, count once. The nudged versions and the sibling market check an idea and are never chosen among, so they no longer count. An idea with no curve to compare counts in full. Past 2,000 comparable ideas, a fixed sample is clustered and scaled up, which can only overcount.

## Consequences

- Many more designs reach a Blind Trial, so the budget of 100 (`fleet.blindTrialLimit`) runs out sooner. Once it is spent, designs top out at promising until the owner raises it. Each look leaks a little of 2025 into which designs launch, and the stricter rule offsets that.
- A design launched by the Autopilot has passed a test on data its search never saw. The drift watch and the sequential test of live trades (ADR-0035) still retire one whose edge does not hold.
- Earlier propositions keep their verdicts and are not trialled again; the Autopilot's scrap clears those that cannot sail. The change applies to every Sea Trial from now on.
