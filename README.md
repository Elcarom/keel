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
