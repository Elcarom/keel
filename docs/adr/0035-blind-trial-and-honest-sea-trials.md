# ADR-0035: The Blind Trial, the Research Gate for Seaworthy, and Real History Only

## Status

Accepted. Amends ADR-0025 (Sea Trials), ADR-0030 and ADR-0033 (the Autopilot and night shift), and ADR-0014 (one cost model). Records how the 2025 Sealed Holdout (ADR-0009) is used after Phase D.

## Context

An independent audit (October 2026) found that the Shipyard → Sea Trial → Autopilot loop could pick luck and call it an edge:

1. **One sample, with feedback.** Every Sea Trial replays the same two years (2022-12-02 to 2024-12-01). Each night the Shipwright was told which checks each failed idea had missed. That is a sequential search on one sample, and after enough nights some idea passes every check by chance.
2. **No unseen data.** The "Holds up out of sample" check reads later walk-forward folds of that same window. With a single candidate nothing is fitted, so it is in-sample.
3. **Two standards.** The replay engine's research gate (at least 150 trades, Sharpe of at least 1, a deflated Sharpe of at least 0.9, beating holding and the random-entry 75th percentile, a worst dip within 25%) was computed and shown, but "seaworthy" needed only 30 trades and a score. The deflated Sharpe, the one control for the number of ideas tried, was not critical, and it counted ideas, not backtests.
4. **Synthetic data under real names.** When OKX was unreachable, the Fleet wrote a sine-wave series under the real market id, recorded the coin as "synthetic" for good, and its funding as "settled". The Autopilot never checked the data source. The Research Lab's seed wrote the same kind of series under real ids too, where a later Sea Trial would take it for OKX history.
5. **Paper paid more than the backtest.** The paper broker charged slippage once on the fill price and again as part of its fee: 13 bps a side against the replay's 10.

## Decision

- **The Blind Trial.** A design that clears every critical check, with a score of at least 65, is replayed once on 2025, the Sealed Holdout. No Sea Trial and no Shipwright prompt ever reads that year. The rule is fixed before any design sees it: at least half the gate's trade minimum, a positive average trade with every cost doubled, and a worst dip within 25%. Only the outcome (passed, failed, skipped, budget spent) is stored. The year's numbers are never kept, shown or sent to Claude. Only a passed Blind Trial makes a design **seaworthy**. A design that earned one and failed it is choppy.
- **A budget of blind looks.** Each Blind Trial leaks a little of 2025 into the Fleet's choices: whether a design launched is visible to the night shift. So the Fleet may run at most `fleet.blindTrialLimit` of them (100 by default, a confirm-class setting). Once they are spent, designs top out at promising until the operator knowingly raises the limit.
- **The research gate decides seaworthy.** The critical checks are now enough trades (the gate's minimum), survives doubled costs, holds up on later folds, robust to nudged settings, more skill than luck (the gate's deflated Sharpe), and a new **Clears the research gate** check (Sharpe, beating holding, beating the random-entry 75th percentile, and the worst dip). The gate's bars come from the Promotion Ladder settings, which the replay engine also uses. The walk-forward check is relabelled "Holds up on later folds", because it is not unseen data; the Blind Trial is.
- **Every backtest is a trial.** The luck adjustment counts six backtests per idea ever drafted (the main run, four nudges and the sibling market), not one per idea.
- **The night shift learns less.** Failed ideas reach Claude by name and "did not pass its sea trial" only, never which checks failed or by how much. The Shipwright prompt now states the gate, the round-trip cost, and that funding history is partial.
- **Real history only.** A Sea Trial whose OKX history is unreachable, or covers less than 95% of its window, waits as "assessing" and retries every hour. It is never run on a stand-in. Nothing is recorded until a fetch succeeds. The Research Lab's synthetic seed writes under a `SYN-` id (for example `SYN-BTC-USDT-SWAP`), which sizes like its market but can never be read as it. On start-up, a one-off migration deletes every pre-2025 bar and funding row of each market that a Fleet fallback or a Research Lab seed wrote over, and forgets that its window was charted. Older propositions trialled on synthetic data cannot be launched.
- **Funding gaps pay the assumed rate.** Every 8-hour settlement missing from the stored history pays the assumed 0.01%. Before, the assumed rate applied only when the whole window had none. A Sea Trial reports funding as settled only when OKX's history covers 95% of the window.
- **One cost model.** `DEFAULT_EXECUTION_COSTS` (a 5 bp taker fee, 2 bp half-spread and 3 bp slippage) serves the replay, the pair replay and the paper broker. Fee and half-spread are charged on notional, and slippage only moves the fill price. The paper/replay parity test now compares fees as well as gross P&L.
- **Live trades are tested against the trial.** Every closed trade's net R is kept. The Drift Watch adds a sequential test: a CUSUM of Wald's log-likelihood ratio for "no edge" against "the trial's average R", with the spread recovered from the trial's t-statistic. It docks a boat at Wald's 1% boundary. Standing is now the trial score moved by a t-statistic of live R against the trial's, by up to 50 points, instead of a blend with a 90-day Sharpe ratio. A boat on course keeps its trial's score, so it compares with propositions on one scale.
- **A basket's random-entry percentile** is its weakest coin's, not the average of its coins' percentiles.

## Consequences

- Few designs, possibly none, will be seaworthy. That is the honest result until an edge exists. The Autopilot launches nothing that has not passed a Blind Trial, including older seaworthy verdicts from before this ADR.
- The 2025 holdout was spent on Phase D's three hand-written strategies. For the Fleet it is unseen, and this ADR spends it on the Fleet under a budget. The 2026 partition stays sealed.
- Without network access a Sea Trial cannot finish. Tests serve a seeded random walk through the ingestor's history hook, so they exercise the real-data path.
- Telling a +0.2R edge from none takes well over a hundred trades, so the expectancy test is slow by nature. The drawdown and win-rate checks stay for faster alarms.
- Still open from the audit: replaying baskets through the portfolio risk checks, computing basket statistics on the combined curve, and modelling take-profit queue position.
