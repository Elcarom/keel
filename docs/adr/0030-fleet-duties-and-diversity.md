# ADR-0030: Unattended Fleet Duties and the Diversity Guard

## Status

Accepted. ADR-0033 extends the Autopilot and the night shift.

## Context and Decision

The owner wants the Fleet to run with less attention, and to fill with genuinely different ideas. After every Fleet step, the scheduler now runs five **Fleet Duties**:

| Duty        | Rule                                                                                                                                                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drift watch | Docks a running boat whose worst dip exceeds 1.5× its sea trial's 95th-percentile resampled dip (at least 5%), or whose win rate falls more than two standard errors below its backtest after 20 trades.                                                                           |
| Autopilot   | Launches the highest-scoring proposition that is seaworthy, scores at least the minimum score set in config, and is not a lookalike of any boat. Its stake is the set share of the Autopilot wallet's total value, never more than the wallet has, so the wallet is the whole cap. |
| Night shift | Draws up a Shipyard brief across all ten markets, daily or on Mondays, but only with an Anthropic key, so it never just repeats samples.                                                                                                                                           |
| Rebalance   | Every Monday, evens out the stakes of each wallet's flat running boats. Money moves through the wallet, which nets to zero, and each boat's ledger records the capital flow (`rebaseCapital`), so its loss limits restart from the new stake.                                      |
| Digest      | Once a day, sends every boat's results to Discord.                                                                                                                                                                                                                                 |

- **Rules decide; models do not.** The night shift asks the Bot Designer for ideas. Everything that launches, docks or moves money is a fixed rule over sea-trial and paper numbers.
- **Everything is paper-only.** All settings live in `KeelConfigSchema.fleet`. Autopilot and rebalancing are `confirm`-class; the rest are `safe`.
- **Diversity guard.** Every sea trial records its equity on a fixed weekly grid. A proposition whose week-on-week equity changes correlate at 0.8 or more with a boat, or with another open proposition, is marked a **Lookalike**. The Shipyard shows it, and the Autopilot never launches one. Claude is also told what the fleet already sails (styles, coins and holding times) and asked to fill the gaps.

## Considered Options

- **Let Claude choose what to launch**: rejected. It would put a model on the decision to commit money, and AGENTS.md forbids AI on the money path.
- **Penalise lookalikes in the score**: rejected. A lookalike can be the better of two versions, so the operator should see both and choose.

## Consequences

- Duty runs are recorded in `fleet_duties` and shown in the Logbook.
- The `allocation_usdt` column of a boat may now change after launch, but only through a rebalance.
