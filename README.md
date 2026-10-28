# Keel (`@keel/*`)

**Keel** is a self-hosted systematic crypto-derivatives research lab and execution platform built for single-container deployment on Unraid behind a Cloudflare Tunnel.

It pairs a strictly deterministic money path (fixed-point `ScaledDecimal` accounting, stop-distance `1R` sizing, two-tier portfolio risk caps, atomic exchange-side **Protective Stops**, and an OKX **Dead-Man's Switch**) with a measurable, budget-capped **Gemini AI layer** (**Shadow Advisor**, **Context Analyst**, **Strategy Lab**, **Post-Trade Analyst**, **Risk & Ops Copilot**, and **EventGateAdvisor**) governed by a six-stage **Promotion Ladder**.

---

## Core Principles

1. **Measurement before freedom**: Every strategy and AI capability starts in replay or forward shadow mode and earns authority only through quantitative out-of-sample gates ([ADR-0007](./docs/adr/0007-promotion-ladder-gates-and-contamination-free-ai-eval.md)).
2. **The money path is deterministic**: `@keel/risk`, `@keel/ledger`, and `@keel/broker` contain zero AI calls and zero raw floating-point balance math ([ADR-0008](./docs/adr/0008-monorepo-stack-decimal-math-and-worker-sandbox.md)).
3. **No look-ahead or repainting**: Signals use **Confirmed Bars** (`confirm === "1"`) only, and all external context features enforce strict `As-Of Timestamps` (`max(publishedAt, ingestedAt)`).
4. **Safe by default**: Ships in `Paper` Execution Mode by default. Real-money capabilities require passing human gates **G1**, **G2**, and **G3** ([docs/runbooks/go-live-checklist.md](./docs/runbooks/go-live-checklist.md)).

---

## Documentation Map

- **Domain Glossary**: [`GLOSSARY.md`](./GLOSSARY.md)
- **Architecture Decision Records**: [`docs/adr/`](./docs/adr/)
  - [ADR-0001: Linear Perpetuals Domain Scope](./docs/adr/0001-linear-perpetuals-domain-scope.md)
  - [ADR-0002: Stop-Distance Risk Sizing (1R) & Two-Tier Portfolio Caps](./docs/adr/0002-stop-based-r-sizing-and-two-tier-risk-caps.md)
  - [ADR-0003: Cloudflare Tunnel Ingress & Defense-in-Depth Auth](./docs/adr/0003-cloudflare-tunnel-and-defense-in-depth-auth.md)
  - [ADR-0004: Single-Container SQLite (WAL) Behind Repository Ports](./docs/adr/0004-sqlite-wal-behind-repository-ports.md)
  - [ADR-0005: Shared Typed API Contract via ts-rest, Fastify, and Zod](./docs/adr/0005-ts-rest-fastify-zod-api-contract.md)
  - [ADR-0006: Atomic Attached Protective Stops & OKX Dead-Man's Switch](./docs/adr/0006-okx-attached-protective-stops-and-dead-mans-switch.md)
  - [ADR-0007: Promotion-Ladder Gates & Contamination-Free AI Evaluation](./docs/adr/0007-promotion-ladder-gates-and-contamination-free-ai-eval.md)
  - [ADR-0008: Monorepo Stack, Fixed-Point Decimal Math, & Worker Sandbox](./docs/adr/0008-monorepo-stack-decimal-math-and-worker-sandbox.md)
- **Unraid Deployment Guide**: [`docs/unraid.md`](./docs/unraid.md)
- **Operational Runbooks**:
  - [`docs/runbooks/go-live-checklist.md`](./docs/runbooks/go-live-checklist.md)
  - [`docs/runbooks/incident-response.md`](./docs/runbooks/incident-response.md)
  - [`docs/runbooks/restore-from-backup.md`](./docs/runbooks/restore-from-backup.md)

---

## Deployment Guide

Keel is packaged as a single self-contained Docker container hosting both the Fastify API and the compiled React dashboard on port `8080`. It runs under a non-root user (`PUID=99`, `PGID=100`, `UMASK=022`) using `tini` as PID 1 and is designed to sit behind a **Cloudflare Tunnel (`cloudflared`)** on Unraid or any standard Linux host.

### 1. Host Directory & Permission Setup

Prepare persistent host storage for application data and SQLite backups:

```bash
# On Unraid:
mkdir -p /mnt/user/appdata/keel/data /mnt/user/appdata/keel/backups
chown -R 99:100 /mnt/user/appdata/keel
chmod 755 /mnt/user/appdata/keel/data /mnt/user/appdata/keel/backups

# On Generic Linux / Docker Host:
mkdir -p ./keel-data ./keel-backups
sudo chown -R 99:100 ./keel-data ./keel-backups
```

- `/data`: Holds the SQLite WAL database (`keel.db`), AES-256-GCM master vault key (`secret.key`, mode `0600`), and historical market data snapshots.
- `/backups`: Holds atomic point-in-time SQLite snapshots generated via `VACUUM INTO`.

---

### 2. Deployment Methods

#### Method A: Docker Compose (Recommended for Unraid / Docker Compose Manager)

Use the repository's [`docker-compose.yml`](./docker-compose.yml):

```yaml
name: keel

services:
  keel:
    image: ghcr.io/elcarom/psychic-octo-funicular:latest
    container_name: keel
    restart: unless-stopped
    environment:
      - PUID=99
      - PGID=100
      - UMASK=022
      - PORT=8080
      - DATA_DIR=/data
      - BACKUPS_DIR=/backups
      - LOG_LEVEL=info
      - KEEL_MASTER_KEY=${KEEL_MASTER_KEY:?KEEL_MASTER_KEY must be set (generate with: openssl rand -base64 48)}
    ports:
      - "8080:8080"
    volumes:
      - /mnt/user/appdata/keel/data:/data
      - /mnt/user/appdata/keel/backups:/backups
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

Run:

```bash
docker compose up -d
```

#### Method B: Unraid Community Apps XML Template

1. Copy [`deploy/unraid/keel-template.xml`](./deploy/unraid/keel-template.xml) to `/boot/config/plugins/dockerMan/templates-user/my-keel.xml` on your Unraid flash drive.
2. In the Unraid WebGUI, navigate to **Docker → Add Container** and select **Keel** from the Template dropdown.
3. Confirm `/data`, `/backups`, and port `8080` paths, then click **Apply**.

#### Method C: Docker Run CLI

```bash
docker run -d \
  --name keel \
  --restart unless-stopped \
  -e PUID=99 \
  -e PGID=100 \
  -e UMASK=022 \
  -e PORT=8080 \
  -e DATA_DIR=/data \
  -e BACKUPS_DIR=/backups \
  -e KEEL_MASTER_KEY="$(openssl rand -base64 48)" \
  -p 8080:8080 \
  -v /mnt/user/appdata/keel/data:/data \
  -v /mnt/user/appdata/keel/backups:/backups \
  ghcr.io/elcarom/psychic-octo-funicular:latest
```

#### Environment Variables

| Variable                                          | Default            | Purpose                                                                                                                                                                                                                                   |
| :------------------------------------------------ | :----------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KEEL_MASTER_KEY`                                 | _(required)_       | Vault master key: at least 32 characters and 12 distinct characters. The vault refuses to run without it                                                                                                                                  |
| `PORT` / `HOST`                                   | `8080` / `0.0.0.0` | Listen address                                                                                                                                                                                                                            |
| `DATA_DIR` or `KEEL_DB_PATH`                      | in-memory          | SQLite location. Without either, all state is lost on restart                                                                                                                                                                             |
| `BACKUPS_DIR` or `KEEL_BACKUPS_DIR`               | unset              | Directory for SQLite backups                                                                                                                                                                                                              |
| `LOG_LEVEL`                                       | `info`             | Pino log level                                                                                                                                                                                                                            |
| `KEEL_ALLOW_INSECURE_HTTP`                        | `false`            | `true` lets you sign in over plain `http://` on a trusted LAN. Without it, browsers drop the `Secure` session cookie and sign-in silently fails. HTTPS requests still get `Secure` cookies. Leave it `false` behind the Cloudflare Tunnel |
| `KEEL_ENABLE_SCHEDULER`                           | `false`            | `true` fetches new hourly bars and steps strategies and Fleet boats; without it boats never trade (the Unraid template turns it on). The dead-man's switch heartbeat runs in exchange modes either way                                    |
| `KEEL_BOOTSTRAP_TOKEN`                            | generated          | One-time token for the first admin bootstrap                                                                                                                                                                                              |
| `KEEL_CF_ACCESS_SECRET`                           | unset              | Cloudflare Access JWT signing secret, when Cloudflare headers are trusted                                                                                                                                                                 |
| `KEEL_AI_SIMULATE_RESPONSES`                      | `false`            | `true` makes the AI layer return deterministic simulated responses instead of calling Gemini, and makes the Shipyard draft sample propositions instead of calling Claude (used by the e2e suite)                                          |
| `KEEL_GEMINI_API_KEY`, `KEEL_DISCORD_WEBHOOK_URL` | unset              | Fallbacks used only when the vault has no `geminiApiKey` / `discordWebhookUrl`                                                                                                                                                            |
| `ANTHROPIC_API_KEY`                               | unset              | Fallback used only when the vault has no `anthropicApiKey`. Lets Claude design boats in the Shipyard; without a key it drafts sample propositions                                                                                         |

OKX trading keys have no environment fallback: store them in the vault (section 5).

---

### 3. Cloudflare Tunnel Ingress Setup

Keel is architected to sit securely behind **Cloudflare Zero Trust (`cloudflared`)** ([ADR-0003](./docs/adr/0003-cloudflare-tunnel-and-defense-in-depth-auth.md)):

1. In your **Cloudflare Zero Trust Dashboard**, navigate to **Networks → Tunnels** and select your tunnel.
2. Add a **Public Hostname** (e.g. `keel.yourdomain.com`):
   - **Service**: `HTTP`
   - **URL**: `<unraid-lan-ip>:8080` (or `keel:8080` if sharing a Docker network with `cloudflared`).
3. **Defense-in-Depth**:
   - Keel honors `CF-Connecting-IP` and `X-Forwarded-Proto` for audit logging and secure cookie enforcement.
   - Keel emits an automated **15-second Server-Sent Events (SSE) heartbeat** on `/api/v1/stream/heartbeat` to prevent Cloudflare's 100-second edge read timeout from disconnecting live dashboard charts.
   - Attach a Cloudflare Access policy with identity provider + email OTP for edge filtering.

---

### 4. First-Boot Admin Bootstrap

Keel never exposes an unauthenticated configuration or setup screen. On initial start against an empty `/data` directory:

1. Inspect container logs:
   ```bash
   docker logs keel
   ```
2. Locate the one-time bootstrap token generated in stdout:
   ```text
   ================================================================================
   [KEEL BOOTSTRAP] Initial Admin Setup Token:
   keel-bootstrap-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ================================================================================
   ```
3. Open `https://keel.yourdomain.com` in your browser.
4. Enter the one-time token, choose your master admin username and password (`Argon2id`), and enroll your RFC 6238 TOTP authenticator app.
5. The bootstrap token is immediately invalidated upon first account initialization.

---

### 5. Configuring Secrets in the Vault

Once logged into the Mission Control dashboard:

1. Navigate to the **AES-256-GCM Secret Vault** section.
2. Store your credentials safely:
   - `geminiApiKey`: Google Gemini API key for the advisory AI layer.
   - `okxApiKey`, `okxSecretKey`, `okxPassphrase`: OKX V5 API key (requires **Trade** and **Read** permissions only; **Withdrawal MUST be disabled**).
   - `discordWebhookUrl`: Discord webhook for `CRITICAL` kill-switch/stop-failure alerts and `WARNING` notifications.
3. All secrets are encrypted at rest under `/data/secret.key` using AES-256-GCM with PBKDF2 salt and authentication tag. Plaintext is never stored in SQLite or exposed over the API.

---

### 6. Production Health & Graceful Shutdown

- **Health Checks**:
  - `GET /healthz`: Process status and heartbeat timestamp.
  - `GET /readyz`: Execution mode readiness (`Paper`, `Demo`, `Live-Ramp`, `Live`).
  - `GET /metrics`: Prometheus telemetry (uptime, execution mode, circuit breaker status).
- **Graceful Shutdown**:
  - `tini` forwards `SIGTERM` signals to Keel.
  - Upon shutdown, Keel stops unattended background ingest-and-tick scheduler loops cleanly, flushes the SQLite WAL, and executes container shutdown policies (`hold` or `flatten`). In `Demo` and `Live` modes, open positions remain safeguarded by exchange-resident mark-price **Protective Stops** (`attachAlgoOrds`), while the 60-second OKX **Dead-Man's Switch** (`cancel-all-after`) automatically cancels any resting entry orders ([ADR-0006](./docs/adr/0006-okx-attached-protective-stops-and-dead-mans-switch.md)).

---

## Development Commands

```bash
pnpm install        # Install workspace dependencies
pnpm build          # Build @keel/core, @keel/api, and @keel/web
pnpm typecheck      # Strict TypeScript check across all packages
pnpm lint           # ESLint strict check (zero `any` in domain code)
pnpm format:check   # Prettier formatting verification
pnpm test           # Run Vitest unit & fast-check property suites
pnpm test:e2e       # Run Playwright end-to-end browser tests
```
