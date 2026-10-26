# Comprehensive Audit Remediation Report 2 (Round 3)

**Repository**: `Elcarom/psychic-octo-funicular` (Keel Platform)  
**Remediation Campaign**: Round 3 Open Defects & Spec Engine Architecture (Tickets T1 through T6)  
**Initial Baseline Commit**: `691727c`  
**Final Master Commit**: `93d7dcc` (Merged to `main` and pushed to `origin/main`)  
**Status**: All findings fully remediated, verified test-first, dual-subagent reviewed, and merged to `origin/main`.

---

## 1. Remediation Matrix

| Finding / Ticket ID | Severity | Description                                                                              | Remediating Ticket | Main Git Commit SHA | Proving Test Suite                                                                                      |    Status    |
| :------------------ | :------: | :--------------------------------------------------------------------------------------- | :----------------: | :-----------------: | :------------------------------------------------------------------------------------------------------ | :----------: |
| **C2**              | CRITICAL | Scheduler replayed up to 500 historical/quarantined bars on newly enabled strategies     |       **T1**       |      `32670df`      | `packages/api/test/scheduler.test.ts` (`C2: newly enabled... anchors at latest confirmed bar`)          | **RESOLVED** |
| **C1**              | CRITICAL | Holdout seal false positives on in-sample ranges & non-atomic token consumption          |       **T2**       |      `fba2279`      | `packages/replay/test/holdout-seal-2026.test.ts` & `packages/api/test/server.test.ts`                   | **RESOLVED** |
| **C3a**             |  MAJOR   | Incomplete stop confirmation (querying only conditional algo orders, accepting any algo) |       **T3**       |      `aed7d8f`      | `packages/broker/test/okx-broker.test.ts` (`C3a: strict stop confirmation`)                             | **RESOLVED** |
| **C3b**             |  MAJOR   | Missing order/fill history polling; reconciling treats normal exits as drift             |       **T3**       |      `aed7d8f`      | `packages/broker/test/okx-broker.test.ts` (`C3b: reconciles fills from trade history`)                  | **RESOLVED** |
| **C3c**             |  MAJOR   | `flattenAllPositions` posted PnL using bar close instead of real fill price              |       **T3**       |      `aed7d8f`      | `packages/broker/test/okx-broker.test.ts` (`C3c: posts truthful real exit PnL`)                         | **RESOLVED** |
| **C3d**             |  MAJOR   | Fill query failure logged fill price 0 and recorded full entry price as loss             |       **T3**       |      `aed7d8f`      | `packages/broker/test/okx-broker.test.ts` (`C3d: unconfirmed submits marked SUBMITTED`)                 | **RESOLVED** |
| **C3e**             |  MINOR   | `tdMode` and `posSide` omitted from OKX order payload in long/short mode                 |       **T3**       |      `aed7d8f`      | `packages/broker/test/okx-broker.test.ts` (`serializes tdMode and posSide correctly`)                   | **RESOLVED** |
| **S1**              |  MAJOR   | `validateMasterKey` allowed low-entropy keys and placeholder substrings                  |       **T4**       |      `a7da169`      | `packages/api/test/security.test.ts` (`S1: rejects low-entropy keys and placeholders`)                  | **RESOLVED** |
| **D1 / N2**         |  MAJOR   | Phase D empirical results report integrity, sensitivity grid, and trial accounting       |       **T4**       |      `a7da169`      | `docs/research/phase-d-results.md`, `scripts/check-claims.js`                                           | **RESOLVED** |
| **T5**              |   ARCH   | Declarative Strategy Spec V1 AST, canonical hashing, and pure causal interpreter         |       **T5**       |      `81aed57`      | `packages/spec/test/spec-engine.test.ts`, `packages/replay/test/spec-strategy.test.ts`                  | **RESOLVED** |
| **T6**              |   ARCH   | Spec Registry, Monotonic DSR Trial Coupling, and Promotion Quarantine Ladder             |       **T6**       |      `93d7dcc`      | `packages/data/test/strategy-spec-repository.test.ts`, `packages/api/test/specs-and-quarantine.test.ts` | **RESOLVED** |

---

## 2. Summary of Ticket Deliverables

### Ticket T1: Scheduler Anchoring & Quarantine Exclusion (`32670df`)

- **Remediated C2**: In `packages/api/src/scheduler.ts`, when an instrument/strategy pair is first enabled without prior processed history (`lastProcessedCloseTs == null`), the scheduler anchors directly to the latest confirmed bar close timestamp in stored coverage (`latestStoredCloseTs`).
- **Quarantine Invariant**: Explicitly filters out bars with `closeTs >= SEALED_2026_HOLDOUT_START_TS` from scheduler tick processing, preventing historical execution contamination.
- **Verification**: Verified via `packages/api/test/scheduler.test.ts` (asserts 0 ticks processed when 20,000 historical bars are ingested).

### Ticket T2: Replay 2026 Holdout Seal Wiring & Atomic Token Consumption (`fba2279`)

- **Remediated C1**:
  - In `packages/api/src/server.ts`, derives `effectiveToTs` strictly from the requested replay range (`Math.min(body.toTs, latestCloseTs)`), eliminating false-positive holdout rejections when database coverage extends past 2026.
  - In `packages/replay/src/index.ts`, wired atomic token consumption: holdout token is consumed via `experimentRepo.saveExperiment(..., { consumeHoldoutPartition })` only when the experiment record is successfully persisted.
- **Verification**: Verified via `packages/replay/test/holdout-seal-2026.test.ts` and `packages/api/test/server.test.ts`.

### Ticket T3: Broker Truthfulness Remainder (`aed7d8f`)

- **Remediated C3a–e**:
  - **C3a**: Strict attached stop confirmation: queries both `conditional` and `oco` algos, matches exact `algoClOrdId` or parent `ordId`, and fails-closed if unconfirmed.
  - **C3b**: Fills history polling: `reconcilePositions` queries OKX fill history (`/api/v5/trade/fills-history`) to distinguish genuine external stop/TP fills from untracked drift.
  - **C3c**: Truthful exit PnL: `flattenAllPositions` reads verified fill price (`avgPx`) and actual trading fees from OKX execution response before posting journal entries to the ledger.
  - **C3d**: Unconfirmed submit safety: orders pending fill confirmation are recorded with status `SUBMITTED` rather than fabricating `FILLED` at entry price or zero.
  - **C3e**: Explicit margin mode: serializes `tdMode: "isolated"` and `posSide: "net" | "long" | "short"` in order payload.
- **Verification**: 30 comprehensive unit and mock tests passing in `packages/broker/test/okx-broker.test.ts`.

### Ticket T4: Report Integrity, Master Key Hardening, and Claims Verification (`a7da169`)

- **Remediated S1**: `validateMasterKey` in `packages/api/src/security.ts` enforces $\ge 12$ distinct characters (`Set(key).size >= 12`) and case-insensitively rejects placeholder substrings (`your-random`, `change-me`).
- **Remediated D1, N2a–c**: Regenerated `docs/research/phase-d-results.md` from database with per-strategy walk-forward CV, honest funding rate seed disclosure, a 30-scenario funding rate sensitivity grid, and strict disclosure of spent 2025 holdout partitions.
- **Claims Verification Engine**: Created `scripts/check-claims.js` verifying architectural and operational assertions across ADRs 0006–0021.

### Ticket T5: Strategy Spec V1 AST, Canonical Hashing, & Pure Causal Engine (`81aed57`)

- **ADR-0020**: Created `@keel/spec` (`packages/spec`) implementing `StrategySpecV1Schema` (Zod), bounded indicator whitelist (`donchian`, `atr`, `sma`, `stddev`, `zscore`, `momentum`), lookahead-free AST expressions (`NumExpr`, `Condition`), and attached risk rules.
- **Canonical Hashing**: Implemented recursive sorted-key canonical JSON serialization with SHA-256 hash (`computeSpecHash`), proven invariant to JSON key ordering.
- **Deterministic Plain-English Explainer**: Pure function `describeSpec(spec)` generating structured human-readable text for auditability without LLMs.
- **Causal Interpreter & Golden Parity**: Implemented `SpecStrategy` implementing `@keel/core` `Strategy` port. Verified 1:1 proposal and replay parity against `DonchianTrendStrategy`, `VolNormalizedMeanReversionStrategy`, and `VolNormalizedMomentumStrategy`.

### Ticket T6: Spec Registry, Monotonic Trial Coupling, and Promotion Quarantine (`93d7dcc`)

- **ADR-0021**:
  - Implemented `StrategySpecRepository` in `packages/data/src/spec-repository.ts` backed by SQLite WAL tables `strategy_specs` and `strategy_spec_names`.
  - **Monotonic DSR Trial Coupling**: Registering a unique `specHash` automatically records a trial into `experimentRepo.recordTrial`, ensuring researchers cannot evade trial penalties.
  - **Permanent Promotion Quarantine**: `POST /api/v1/promotion/promote` strictly rejects promotion of synthetic/quarantined strategies (`synthetic: true` or `synthetic-*`) to `Demo`, `Live-Ramp`, or `Live` with `403 Forbidden`.
  - **API Contract**: `@ts-rest` contract endpoints `POST /api/v1/specs`, `GET /api/v1/specs`, `GET /api/v1/specs/:hash`.
  - **Web Dashboard View**: Added dedicated "Strategy Specifications & AST Registry" panel in `packages/web/src/App.tsx` with specs table, quarantine status badges, and interactive plain-English AST audit inspection.

---

## 3. Retrospective (`/retro`)

### What Went Exceptionally Well

1. **Test-Driven Discipline (TDD)**:
   - For every defect (C1, C2, C3a–d, S1, T5, T6), a failing test was written first, observed failing with clear stack traces, and then fixed cleanly.
2. **Dual-Subagent Independent Review Cadence**:
   - Spawning parallel Standards Reviewer and Spec Reviewer subagents on every ticket caught critical subtleties before merge:
     - T5: Standards reviewer identified missing AST evaluator `shift` lookups and unhandled `channel_bound` stop logic.
     - T6: Standards reviewer identified an accidental duplicate JSX block in `App.tsx` and formatting issues before merging.
3. **Automated Documentation Claims Verification**:
   - `scripts/check-claims.js` verified 47 distinct architectural claims across tests on every CI run, preventing documentation drift.
4. **Architectural Purity & Separation of Concerns**:
   - Zero `any` in domain code; exact `ScaledDecimal` accounting maintained across ledger, paper, broker, and risk.
   - Zero AI on the money path; pure deterministic AST execution and auditability.

### What Was Challenging

1. **Windows Subshell Environment Variables**:
   - Running subcommands under PowerShell required explicit PATH prefixing (`$env:PATH = "C:\Program Files\nodejs;$env:PATH"`) to resolve Node and pnpm reliably.
2. **Monorepo Layering Boundaries**:
   - Balancing `@keel/spec` dependencies required strict boundary awareness: `@keel/spec` depends only on `@keel/core` and `@keel/strategy`, keeping it clean and portable, while integration tests with `ReplayEngine` live in `@keel/replay`.

### Recommendations for Future Platform Milestones

1. **Out-of-Process LLM Authoring Pipeline**:
   - Build the LLM strategy generation harness as an external client interacting exclusively via `POST /api/v1/specs`. The server-side deterministic core, schema validator, and trial counter will safely govern incoming proposals without code execution.
2. **Expanded AST Indicator Library**:
   - Gradually extend `StrategySpecV1` with additional bounded causal indicators (e.g., EMA, RSI, Bollinger Bands) following the exact golden parity pattern established in ADR-0020.
3. **Live Gate G2/G3 Runbook Verification**:
   - Before taking any exchange account live, execute the interactive human-gate runbook (`docs/runbooks/go-live-checklist.md`) with production TOTP keys and dedicated hardware credentials.
