# ADR-0024: Fleet Bots Are Compiled from LLM-Drafted Blueprints and Trade Their Own Books

## Status

Accepted

## Context and Decision

The owner asked for a simpler product: a Fleet screen listing every bot with its returns, a Shipyard where Claude proposes several bots from a guided brief, automatic backtesting and ranking of those proposals, and launching a proposal as a bot funded from a wallet. Live trading is out of scope for the prototype.

- **The model drafts Blueprints, never strategies.** Claude returns flat Blueprints: one of five archetypes (breakout, mean reversion, momentum, moving-average crossover, trend pullback) with numeric parameters. Structured outputs cannot express the recursive Strategy Spec condition tree, and a bounded shape is safer anyway. Deterministic code enforces the brief's instruments and direction, clamps every parameter into a reviewed range, and compiles the Blueprint into a Strategy Spec with an ATR protective stop. No model output reaches the money path. The Risk Engine, broker, ledger and stops are unchanged.
- **Every Proposition is backtested before it can launch.** The backtest is the existing Replay engine, run on the year ending 2024-12-01. That window is in-sample, before the sealed holdout, and clear of the 30-day synthetic seed. The batch size counts as the trial count for the deflated Sharpe. When OKX history is unreachable, the window is filled with synthetic bars, and every Assessment says so.
- **Each Bot trades its own Bot Book.** A Bot Book is a third kind of Trading Book: tables named `bot_<id>_*`, created through the existing `bookTables`. Its ledger is seeded with the Bot's stake, so the Risk Engine sizes and limits each Bot against its own equity, as if it were a portfolio. A Bot breaching its own loss limits is paused (flattened at the latest confirmed close) instead of tripping the shared circuit breaker. The shared Kill Switch still halts every Bot, and a Kill Switch Flatten closes their positions too.
- **Bots trade only bars that close after launch.** Launch anchors the Bot at the current hour, and resume skips bars that closed while paused, so no history is ever traded on paper.
- **The original dashboard becomes the Engine Room** at `#/engine-room`, unchanged. The Fleet is the home screen after sign-in.

## Considered Options

- **Let the model write Strategy Specs directly**: rejected. The recursive AST cannot be schema-constrained, invites invalid or degenerate rules, and widens what a prompt injection could express.
- **Run Bots as strategies in the shared Paper Book**: rejected. Sizing and drawdown would follow the pooled equity, not the Bot's stake, so per-Bot returns and wallet accounting would be wrong.
- **Forward paper trading through the Replay engine**: rejected. Replay refuses windows past the sealed holdout without holdout authorisation, and stretching that authorisation for paper trading would blur ADR-0009/0011.

## Consequences

- The Shipyard works without an Anthropic key: it drafts deterministic sample Propositions and labels them as samples.
- Live Bots would need a Venue Book per Bot or per-Bot attribution inside the Venue Book, plus the G2/G3 reviews ADR-0023 describes. The launch form shows Live as unavailable.
- Bot Books add tables per Bot. Deleting a Bot drops them; retiring keeps them, so the logbook stays readable.
- The operator-facing name is **Boat**, not Bot (renamed after the prototype review). Code identifiers, API paths and tables keep `bot`, so existing deployments need no data migration.
