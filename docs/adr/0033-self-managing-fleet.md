# ADR-0033: A Self-Managing Fleet, Researched by Claude on the Owner's Subscription

## Status

Accepted. This extends ADR-0030 and ADR-0027.

## Context and Decision

The owner wants Claude to keep looking for better strategies in the background, test them, rank them against the boats already sailing, and launch, replace or upgrade boats with no hand on the wheel. They want this on their Claude subscription, not a per-token API key.

- **Claude through the official CLI.** The image ships the Claude Code CLI, pinned to one version. The owner runs `claude setup-token` once and stores the token in the vault as `claudeCodeToken`, or sets `CLAUDE_CODE_OAUTH_TOKEN`. The designer then calls `claude -p` with:
  - no tools, no MCP servers and no saved session;
  - the prompt on stdin, and one JSON answer back;
  - an environment holding only the token, so an API key can never bill the call instead.

  When no token is set, the API key is used as before. The subscription is not billed per call, so Keel records no spend; the night shift's once-a-night schedule keeps usage within the plan's limits.

- **The night shift researches.** Each night at the set hour, Keel sends Claude:
  - every boat's sea trial set against its live paper record;
  - the ideas that sank, ran choppy or failed in the last 30 days;
  - the boats that left the fleet, and why.

  Claude drafts new ideas for the fleet's gaps. Then, for each of the weakest proven boats (one by default), it drafts an **Upgrade**: the same idea, improved. The night shift does not try to improve the same boat again within 14 days. Every draft faces the usual sea trial.

- **Every boat has a Standing.** Before launch, a boat's only evidence is its sea trial. After launch, its live paper results matter more each day. The Standing starts at the sea-trial score. Over the boat's first 90 days at sea, it moves linearly to a live score of `50 + 50·tanh(Sharpe / 2)`, where Sharpe is the annualised Sharpe ratio of its daily equity. A boat is **proven**, and so open to replacement, after 14 days at sea.
- **Fixed rules decide.** The Autopilot manages only the boats in its own wallet. It acts in this order:
  1. An Upgrade whose sea-trial score beats its proven boat's Standing by the margin (10 points) replaces that boat. It may trade much like the boat it replaces; that is the point of an Upgrade.
  2. While the wallet holds fewer running boats than the fleet size (8), the best seaworthy, original proposition is launched, as before.
  3. In a full fleet, the weakest proven boat is retired if a seaworthy, original proposition beats its Standing by the margin. The proposition then sails with the wallet's usual stake.

  At most one boat is replaced a day. An Upgrade whose boat still sails never launches beside it. The retired boat's reason names its replacement and both scores.

## Considered Options

- **Let Claude decide what to launch or replace**: rejected, as in ADR-0030. Retiring a boat closes its positions and launching one commits stake: both are on the money path, so a fixed rule decides.
- **Drive claude.ai with the owner's login**: rejected again (ADR-0027). The CLI is Anthropic's own client for a subscription, and `setup-token` exists for unattended use.
- **Compare a proposition with a boat on live results alone**: rejected. A new boat has no live results, and a few weeks of paper trading are mostly noise. The sea trial carries the boat until its own record can.
- **Research continuously**: rejected for now. It would exhaust the plan's usage limits that the owner also uses by hand.

## Consequences

- A sea-trial score is a backtest and tends to flatter. The margin, the 14-day wait and the one-swap-a-day limit stop the fleet churning on that optimism. They are settings (`confirm`-class), so the owner can tighten them.
- Boats the operator launches into other wallets are never retired by the Autopilot. To put a boat under its management, launch it into the Autopilot wallet.
- A subscription token is a secret like any other: it lives in the encrypted vault. The CLI writes its own state under `/data/claude-code`.
- Everything stays paper-only, and gate G2 stays closed.
