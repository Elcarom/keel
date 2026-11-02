# ADR-0036: Full Autonomy by Default

## Status

Accepted. Amends ADR-0030 and ADR-0033 (the Fleet's duties and the Autopilot).

## Context

The operator wants the Fleet to run itself. Claude should always be looking for an edge: drafting new ideas, dropping the ones that fail, launching the ones that pass, and improving or replacing the boats at sea, with as little operator input as possible.

The loop already existed, but four things still needed the operator:

1. The night shift, the Autopilot and stake rebalancing were off by default.
2. The Autopilot waited for the operator to open a wallet named "Autopilot".
3. The drift watch docked a failing boat until the operator set sail again, so its stake and its place in the fleet stayed tied up.
4. A database saved before the defaults changed kept its old switches.

## Decision

- **On by default.** The night shift (around the clock), the Autopilot, the drift watch, stake rebalancing and the digest all start on.
- **The Autopilot opens its own wallet.** If no wallet has the Autopilot's name, it opens a paper wallet with 10,000 USDT and says so on Discord.
- **The Autopilot retires what fails.** A boat in the Autopilot's wallet that the drift watch catches is retired, not docked. Its stake goes back to the wallet and its place goes to the next seaworthy idea. A boat the operator launched in another wallet is still only docked, for the operator to decide.
- **The Autopilot scraps what can never sail.** Before it launches anything, it discards every settled proposition the Autopilot could never launch: one whose sea trial could not run, one that is not seaworthy, one without a passed Blind Trial on OKX history, and one under the Autopilot's minimum score. A seaworthy lookalike stays on the slipway, since it may sail once its twin leaves. A scrapped idea keeps its verdict, so the night shift still learns from it.
- **Existing databases switch over once.** On start-up, a one-off migration saves a new config version with the night shift (around the clock), the Autopilot and rebalancing on. Every other setting is kept. A new database keeps whatever config it is seeded with. The operator can turn any duty off again, and the migration never runs a second time.

## Consequences

- Nothing about what may launch has changed. Only a seaworthy proposition with a passed Blind Trial (ADR-0035) sails, and everything stays on paper. Real-money gates G2 and G3 are untouched.
- Around the clock, the night shift spends Claude subscription usage on every round. `fleet.nightShiftGapMinutes` sets the least time between rounds.
- The operator's one remaining job is linking Claude (a subscription token or an API key). Without it the night shift has no one to ask.
