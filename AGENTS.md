# AGENTS.md

## Overview

Self-hosted systematic crypto-derivatives research and execution platform.
Read [`GLOSSARY.md`](./GLOSSARY.md) before writing code, specs, or issues, and check [`docs/adr/`](./docs/adr/) for architectural decisions.

## Never Do

- **Never use `any` in domain code** or raw floating-point numbers for money/balance/quantity accounting.
- **Never copy code from `./reference/beebots/`**. It is read-only inspiration; re-derive everything and write tests first.
- **Never allow AI on the money path**: the risk engine, broker/executor, ledger, reconciliation, and stop logic are strictly deterministic with zero LLM calls.
- **Never compute signals on unconfirmed (forming) bars** or leak future data (strictly enforce as-of timestamps).
- **Never place live or demo exchange orders without exchange-side protective stops attached.**
- **Never skip human gates**:
  - **G1**: End of grilling, before writing application code.
  - **G2**: Before any code that places orders on a real exchange account (even demo).
  - **G3**: Before any real-money capability is reachable from the UI.

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues for `Elcarom/psychic-octo-funicular` via the `gh` CLI. See [`docs/agents/issue-tracker.md`](./docs/agents/issue-tracker.md).

### Triage labels

Uses the five default canonical triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See [`docs/agents/triage-labels.md`](./docs/agents/triage-labels.md).

### Domain docs

Single-context layout with [`GLOSSARY.md`](./GLOSSARY.md) at the repo root and ADRs in `docs/adr/`. See [`docs/agents/domain.md`](./docs/agents/domain.md).

