# Keel

**Keel** is a self-hosted lab for systematic crypto-perpetuals strategies, run as one container on your own server: Unraid, or any Docker host. A keel keeps a ship steady, and the whole product follows the sea:

- **The Shipyard** drafts strategy **Propositions**. Claude can fill one of 13 reviewed **Blueprints**, invent brand-new entry rules in **Inventor Mode**, or you can import inventions from your own Claude chat with no API fees. Every Proposition then faces a **Sea Trial** before it is ranked: two years of hourly data, doubled costs, walk-forward, nudged settings and a sibling market.
- **The Fleet** is where launched **Boats** paper-trade. Each Boat runs one Proposition on one coin, a **Basket** of up to five, or a **Pair Boat** that holds one coin against another, from its own **Boat Book** and stake.
- **The Treasury** holds the paper **Wallets** that fund the Fleet.
- **The Engine Room** holds configuration, the secret vault, the Kill Switch, the research tools and the budget-capped Gemini advisory layer.

The money path never asks a model anything. It uses fixed-point `ScaledDecimal` accounting, stop-distance `1R` sizing, two-tier risk caps, exchange-side **Protective Stops** and an OKX **Dead-Man's Switch**, all strictly deterministic. Claude drafts rules; Keel's compiled rules and Risk Engine trade them.

---

## Core Principles

1. **Measurement before freedom**: Every strategy and AI capability starts in replay or forward shadow mode, and earns authority only by passing quantitative out-of-sample gates ([ADR-0007](./docs/adr/0007-promotion-ladder-gates-and-contamination-free-ai-eval.md), [ADR-0025](./docs/adr/0025-sea-trials-rank-propositions.md)).
2. **The money path is deterministic**: Risk, ledger, broker, reconciliation and stops contain no AI calls and no raw floating-point balance maths ([ADR-0008](./docs/adr/0008-monorepo-stack-decimal-math-and-worker-sandbox.md)).
3. **No look-ahead or repainting**: Signals use **Confirmed Bars** (`confirm === "1"`) only. Every other market or context feature is read strictly as of the same moment ([ADR-0028](./docs/adr/0028-baskets-and-reference-markets.md)).
4. **Safe by default**: Keel ships in `Paper` Execution Mode. Real-money capabilities require passing human gates **G1**, **G2** and **G3** ([docs/runbooks/go-live-checklist.md](./docs/runbooks/go-live-checklist.md)).

---

## Documentation Map

- **Domain Glossary**: [`GLOSSARY.md`](./GLOSSARY.md)
- **Architecture Decision Records**: [`docs/adr/`](./docs/adr/)
  - [0001. Scope Core Domain to Multi-Venue Linear Quote-Settled Perpetuals](./docs/adr/0001-linear-perpetuals-domain-scope.md)
  - [0002. Stop-Distance Risk Sizing (1R) and Two-Tier Portfolio Risk Caps](./docs/adr/0002-stop-based-r-sizing-and-two-tier-risk-caps.md)
  - [0003. Cloudflare Tunnel Ingress with Defense-in-Depth Authentication](./docs/adr/0003-cloudflare-tunnel-and-defense-in-depth-auth.md)
  - [0004. Single-Container SQLite (WAL) Behind Repository Interfaces](./docs/adr/0004-sqlite-wal-behind-repository-ports.md)
  - [0005. Shared Typed API Contract via ts-rest, Fastify, and Zod](./docs/adr/0005-ts-rest-fastify-zod-api-contract.md)
  - [0006. Atomic Attached Protective Stops and OKX Cancel-All-After Dead-Man's Switch](./docs/adr/0006-okx-attached-protective-stops-and-dead-mans-switch.md)
  - [0007. Quantitative Promotion-Ladder Gates and Contamination-Free AI Evaluation](./docs/adr/0007-promotion-ladder-gates-and-contamination-free-ai-eval.md)
  - [0008. Monorepo Stack, Fixed-Point Decimal Accounting, and Isolated Worker Sandbox](./docs/adr/0008-monorepo-stack-decimal-math-and-worker-sandbox.md)
  - [0009. Backtest Realism, Sealed Holdout Split, and Statistical Validation](./docs/adr/0009-backtest-realism-holdout-split-and-statistical-validation.md)
  - [0010. Unified Risk Routing, State Persistence, and Verifiable Exchange Reconciliation](./docs/adr/0010-unified-risk-routing-and-verifiable-exchange-reconciliation.md)
  - [0011. Sealed 2026 Holdout Partition and Quarantine](./docs/adr/0011-sealed-2026-holdout-partition-and-quarantine.md)
  - [0012. Research Trial Accounting, Baseline Gates, and Scheduler Safety](./docs/adr/0012-research-trial-accounting-baseline-gates-and-scheduler-safety.md)
  - [ADR-0013: Security Vault Hardening, Persistent Login Throttling, & Versioned Cryptographic Formats](./docs/adr/0013-security-vault-hardening-login-throttling-and-versioned-formats.md)
  - [ADR-0014: Shared Execution Model, Adverse Exit Slippage, & Cost Stress Parity](./docs/adr/0014-shared-execution-model-adverse-exit-slippage-and-cost-stress-parity.md)
  - [ADR-0015: Persisted Research Trial Counter, Immutable Experiment History, & Sealed 2026 Holdout Enforcement](./docs/adr/0015-research-trial-counter-immutable-experiments-and-holdout-seal.md)
  - [ADR-0016: Benchmark Distribution Gate, Replay Hardening, & Research Report Integrity](./docs/adr/0016-benchmark-distribution-gate-and-report-integrity.md)
  - [ADR-0017: Scheduler Bar Catch-Up, Explicit Opt-In Defaults, & Read-Only Risk Metrics (R6, N1)](./docs/adr/0017-scheduler-bar-catch-up-and-read-only-risk-metrics.md)
  - [ADR-0018: Exchange Broker Truthfulness, Fill Polling, & Order Lifecycle Remediation (M-B, M-C, M-D, M-E)](./docs/adr/0018-broker-truthfulness-and-exchange-contract-remediation.md)
  - [ADR-0019: Shadow Stage Resolution, Deduplicated Picks, & Runtime Promotion Re-Check (T7 / M-H)](./docs/adr/0019-shadow-stage-resolution-and-runtime-promotion-recheck.md)
  - [ADR-0020: Strategy Spec V1 AST, Canonical Hash, and Pure Causal Interpreter](./docs/adr/0020-strategy-spec-v1-ast-and-canonical-hash.md)
  - [ADR-0021: Strategy Spec Registry, Monotonic Trial Coupling, and Promotion Quarantine](./docs/adr/0021-spec-registry-and-quarantine-promotion.md)
  - [ADR-0022: Separate Paper and Exchange Trading Books](./docs/adr/0022-separate-paper-and-exchange-trading-books.md)
  - [ADR-0023: Exchange Execution Is Operator-Initiated](./docs/adr/0023-exchange-execution-is-operator-initiated.md)
  - [ADR-0024: Fleet Bots Are Compiled from LLM-Drafted Blueprints and Trade Their Own Books](./docs/adr/0024-fleet-bots-from-llm-blueprints.md)
  - [ADR-0025: Propositions Are Ranked by Sea Trials, Not a Single Backtest](./docs/adr/0025-sea-trials-rank-propositions.md)
  - [ADR-0026: Claude May Invent Entry Rules, Within the Spec Language](./docs/adr/0026-claude-invents-entry-rules.md)
  - [ADR-0027: Inventions May Arrive as a File From the Operator's Own Claude Chat](./docs/adr/0027-imported-inventions.md)
  - [ADR-0028: Boats May Trade a Basket of Coins and Read Other Markets](./docs/adr/0028-baskets-and-reference-markets.md)
  - [ADR-0029: Exit Rules, Time Stops and Trailing Stops](./docs/adr/0029-exits-and-position-management.md)
  - [ADR-0030: Unattended Fleet Duties and the Diversity Guard](./docs/adr/0030-fleet-duties-and-diversity.md)
  - [ADR-0031: Higher-Timeframe Bars and Funding in the Rule Language](./docs/adr/0031-higher-timeframes-and-funding.md)
  - [ADR-0032: Pair Boats Hold One Coin Against Another](./docs/adr/0032-pair-boats.md)
- **Unraid Deployment Guide**: [`docs/unraid.md`](./docs/unraid.md)
- **Operational Runbooks**:
  - [`docs/runbooks/go-live-checklist.md`](./docs/runbooks/go-live-checklist.md)
  - [`docs/runbooks/incident-response.md`](./docs/runbooks/incident-response.md)
  - [`docs/runbooks/restore-from-backup.md`](./docs/runbooks/restore-from-backup.md)

---

## Setting sail

Keel is one container. It serves the dashboard and the API on port `8080`, runs as a non-root user (`PUID=99`, `PGID=100`) with `tini` as PID 1, and keeps everything in two folders. On your LAN you reach it at `http://<server-ip>:8080`; for the wider world, put a Cloudflare Tunnel in front (step 5).

### 1. Make a berth

Create the two folders Keel keeps its state in:

```bash
# Unraid
mkdir -p /mnt/user/appdata/keel/data /mnt/user/appdata/keel/backups
chown -R 99:100 /mnt/user/appdata/keel

# Any other Docker host
mkdir -p ./keel-data ./keel-backups
sudo chown -R 99:100 ./keel-data ./keel-backups
```

- `/data` holds the SQLite database (`keel.db`), the encrypted vault and the market history.
- `/backups` holds point-in-time snapshots of the database.

### 2. Launch it

**Docker Compose (recommended, including Unraid's Compose Manager).** Copy [`docker-compose.yml`](./docker-compose.yml) and [`.env.example`](./.env.example), renamed to `.env`, into one folder. Then set the master key in `.env`:

```bash
KEEL_MASTER_KEY=<paste the output of: openssl rand -base64 48>
```

Keep that key in your password manager: without it the vault can't be decrypted. Then:

```bash
docker compose up -d
```

The compose file defaults are set for a home server:

| Setting                    | Default | What it does                                                                                                                         |
| :------------------------- | :------ | :----------------------------------------------------------------------------------------------------------------------------------- |
| `KEEL_PORT`                | `8080`  | The host port. Change it if 8080 is taken; the container always listens on 8080 inside                                               |
| `KEEL_ALLOW_INSECURE_HTTP` | `true`  | Lets you sign in over plain `http://` on your LAN. Requests over HTTPS still get `Secure` cookies. Set `false` if you only use HTTPS |
| `KEEL_ENABLE_SCHEDULER`    | `true`  | Fetches new hourly bars and steps the Fleet. Without it, boats never trade                                                           |
| `ANTHROPIC_API_KEY`        | blank   | Optional: lets Claude design boats. You can store it in the vault instead, or skip it and use **⇅ Inventor via your chat**           |

**Unraid template.** Copy [`deploy/unraid/keel-template.xml`](./deploy/unraid/keel-template.xml) to `/boot/config/plugins/dockerMan/templates-user/my-keel.xml`, then choose **Docker → Add Container → Keel**. Fill in the master key, check the paths and port, and click **Apply**. See [`docs/unraid.md`](./docs/unraid.md) for the details, including moving from the old `psychic-octo-funicular` image name.

**Plain `docker run`:**

```bash
docker run -d --name keel --restart unless-stopped \
  -e KEEL_MASTER_KEY="<your key>" \
  -e KEEL_ALLOW_INSECURE_HTTP=true -e KEEL_ENABLE_SCHEDULER=true \
  -e DATA_DIR=/data -e BACKUPS_DIR=/backups \
  -p 8080:8080 \
  -v /mnt/user/appdata/keel/data:/data \
  -v /mnt/user/appdata/keel/backups:/backups \
  ghcr.io/elcarom/keel:latest
```

### 3. First time aboard

Keel has no open setup screen. On its first start it prints a one-time token:

```bash
docker logs keel
# [KEEL BOOTSTRAP] One-time admin bootstrap token: 3f9c…  (48 hex characters)
```

Open `http://<server-ip>:8080` (or your tunnel's address). Paste the token, choose a username and a password of 10 or more characters, and enrol the authenticator-app (TOTP) secret Keel shows you. The token stops working the moment the first account exists.

### 4. Stow the keys

In the **Engine Room**, under **Secrets**, store what you use. Every secret is encrypted at rest with AES-256-GCM and never sent back over the API.

| Secret                                       | What for                                                                                                                             |
| :------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------- |
| `anthropicApiKey`                            | Claude designs and invents boats in the Shipyard. Optional: without it you get samples, and **⇅ Inventor via your chat** still works |
| `discordWebhookUrl`                          | Alerts, plus the Fleet's daily digest                                                                                                |
| `geminiApiKey`                               | The Engine Room's advisory AI layer                                                                                                  |
| `okxApiKey`, `okxSecretKey`, `okxPassphrase` | OKX exchange access, for later. **Trade and Read only, withdrawals disabled.** Fleet boats trade on paper and never use them         |

### 5. Open waters: a Cloudflare Tunnel

To reach Keel from outside your home, put it behind Cloudflare Zero Trust ([ADR-0003](./docs/adr/0003-cloudflare-tunnel-and-defense-in-depth-auth.md)):

1. In **Networks → Tunnels**, add a public hostname such as `keel.yourdomain.com`, pointing at `http://<server-ip>:8080` (or `http://keel:8080` on a shared Docker network).
2. Add a Cloudflare Access policy (your identity provider or an email code) so only you reach the sign-in page.
3. Keel reads `CF-Connecting-IP` and `X-Forwarded-Proto` for its audit log and to keep cookies `Secure` over HTTPS. A 15-second heartbeat on `/api/v1/stream/heartbeat` keeps Cloudflare from closing live views.

If Keel is only ever reached through the tunnel, set `KEEL_ALLOW_INSECURE_HTTP=false`.

---

## A tour of the ship

- **Shipyard:** draw up a brief and Keel drafts Propositions. Each one faces a two-year **Sea Trial**, on real OKX prices and settled funding, and is ranked: seaworthy, promising, choppy or sinks. Pair Boats are trialled on both coins at once. Tick up to three to compare them side by side. A Proposition that trades almost exactly like one you already have is flagged as a **Lookalike**.
- **Fleet:** your boats at sea, as cards or a table, each with a health badge (New, On course or Drifting). Open a boat to see its equity against what its Sea Trial expected, coin by coin.
- **Treasury:** the paper wallets that fund the boats.
- **Logbook:** recent trades across the Fleet, and what the unattended duties have done.
- **Engine Room:** settings, secrets, research tools, the Kill Switch and the audit trail, with a section bar to jump between them.

### Unattended duties

Fixed rules run after every scheduler step, on paper only. A model never decides what to launch, dock or fund ([ADR-0030](./docs/adr/0030-fleet-duties-and-diversity.md)). Switch them in **Engine Room → Settings**:

| Duty         | Starts | What it does                                                                                                             |
| :----------- | :----- | :----------------------------------------------------------------------------------------------------------------------- |
| Drift watch  | on     | Docks a boat doing clearly worse than its Sea Trial expected                                                             |
| Daily digest | on     | Sends a Discord summary of every boat once a day                                                                         |
| Autopilot    | off    | Launches seaworthy, original Propositions, funded only from a wallet named **Autopilot**, whose balance is its whole cap |
| Night shift  | off    | Drafts a new brief daily or weekly (needs an Anthropic key)                                                              |
| Rebalancing  | off    | Evens out the stakes of a wallet's flat boats every Monday                                                               |

---

## Keeping watch

- `GET /healthz` reports that the process is up, `GET /readyz` reports the Execution Mode, and `GET /metrics` serves Prometheus telemetry.
- On shutdown, `tini` passes `SIGTERM` to Keel, which stops the scheduler, flushes SQLite and applies its shutdown policy (`hold` or `flatten`). On a real exchange account, open positions keep their exchange-side Protective Stops, and OKX's 60-second Dead-Man's Switch cancels any resting entries ([ADR-0006](./docs/adr/0006-okx-attached-protective-stops-and-dead-mans-switch.md)).

### Every environment variable

| Variable                                          | Default                                                  | Purpose                                                                         |
| :------------------------------------------------ | :------------------------------------------------------- | :------------------------------------------------------------------------------ |
| `KEEL_MASTER_KEY`                                 | _(required)_                                             | Vault master key: at least 32 characters, 12 of them distinct                   |
| `PORT` / `HOST`                                   | `8080` / `0.0.0.0`                                       | Listen address inside the container                                             |
| `DATA_DIR` or `KEEL_DB_PATH`                      | in-memory                                                | Where SQLite lives. Without either, everything is lost on restart               |
| `BACKUPS_DIR` or `KEEL_BACKUPS_DIR`               | unset                                                    | Where backups go                                                                |
| `LOG_LEVEL`                                       | `info`                                                   | Pino log level                                                                  |
| `KEEL_ALLOW_INSECURE_HTTP`                        | `false` (`true` in the compose file and Unraid template) | Sign-in over plain HTTP on a trusted LAN                                        |
| `KEEL_ENABLE_SCHEDULER`                           | `false` (`true` in the compose file and Unraid template) | Hourly bars and Fleet steps                                                     |
| `KEEL_BOOTSTRAP_TOKEN`                            | generated                                                | Sets the one-time first-admin token instead of generating one                   |
| `KEEL_CF_ACCESS_SECRET`                           | unset                                                    | Cloudflare Access JWT signing secret                                            |
| `KEEL_AI_SIMULATE_RESPONSES`                      | `false`                                                  | Deterministic simulated AI answers and Shipyard samples (used by the e2e suite) |
| `ANTHROPIC_API_KEY`                               | unset                                                    | Used when the vault has no `anthropicApiKey`; a blank value counts as unset     |
| `KEEL_GEMINI_API_KEY`, `KEEL_DISCORD_WEBHOOK_URL` | unset                                                    | Used when the vault has no `geminiApiKey` or `discordWebhookUrl`                |

OKX keys have no environment fallback: they live only in the vault.

---

## In the dry dock

```bash
pnpm install        # Install workspace dependencies
pnpm build          # Build every package
pnpm typecheck      # Strict TypeScript across packages
pnpm lint           # ESLint, no `any` in domain code
pnpm format:check   # Prettier
pnpm test           # Vitest unit and fast-check property suites
pnpm test:e2e       # Playwright end-to-end tests
pnpm check-claims   # Every documented claim maps to a passing test
```

To build the image yourself: `docker build -t keel .`
