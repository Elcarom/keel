# Comprehensive Audit Remediation Report

**Repository**: `Elcarom/psychic-octo-funicular` (Keel Platform)  
**Remediation Campaign**: Tickets T1 through T7  
**Initial Commit**: `900f5d2`  
**Final Commit**: `f3dcb21` (Merge T7 into `main`)  
**Status**: All findings fully remediated, verified, standards-reviewed, spec-reviewed, and merged.

---

## 1. Remediation Matrix

| Finding ID  | Severity | Description                                                                                        | Remediating Ticket |    Git Commit SHA     | Primary Test Suite                                                 |    Status    |
| :---------- | :------: | :------------------------------------------------------------------------------------------------- | :----------------: | :-------------------: | :----------------------------------------------------------------- | :----------: |
| **N1**      | CRITICAL | Scheduler corrupts paper ledger via tick duplicate positions & spurious stop exits                 |       **T5**       |       `a170d38`       | `packages/api/test/scheduler.test.ts`                              | **RESOLVED** |
| **N2a**     | CRITICAL | Phase D constant 0.0001 funding rate seeding misrepresented as settled rates                       |       **T4**       |       `121baeb`       | `scripts/run-phase-d-evaluation.js`                                | **RESOLVED** |
| **N2b**     | CRITICAL | DSR trial count linked to experiments table row count and run order                                |  **T3** / **T4**   | `aea1a1b` / `121baeb` | `packages/replay/test/replay-engine.test.ts`                       | **RESOLVED** |
| **N2c**     | CRITICAL | Walk-forward OOS results identical across strategies due to candidate contamination                |       **T4**       |       `121baeb`       | `packages/replay/test/benchmark-distribution.test.ts`              | **RESOLVED** |
| **M-A**     |  MAJOR   | Paper broker optimistic fills vs Replay next-bar open with adverse slippage                        |       **T2**       |       `58ebee1`       | `packages/core/test/execution-parity.test.ts`                      | **RESOLVED** |
| **M-B**     |  MAJOR   | Exchange broker `submitOrder` fabricates `FILLED` status and signal entry price                    |       **T6**       |       `9628653`       | `packages/broker/test/okx-broker.test.ts`                          | **RESOLVED** |
| **M-C**     |  MAJOR   | `flattenAllPositions` swallows errors, leaves resting algo stops active, ignores foreign positions |       **T6**       |       `9628653`       | `packages/broker/test/okx-broker.test.ts`                          | **RESOLVED** |
| **M-D**     |  MAJOR   | `sendDmsHeartbeat` records healthy heartbeat without valid credentials                             |       **T6**       |       `9628653`       | `packages/broker/test/okx-broker.test.ts`                          | **RESOLVED** |
| **M-E**     |  MAJOR   | `attachAlgoOrds` includes unverified OKX fields (`reduceOnly`, `closeFraction`)                    |       **T6**       |       `9628653`       | `packages/broker/test/okx-broker.test.ts`                          | **RESOLVED** |
| **M-F**     |  MAJOR   | Exchange-path risk state built from paper ledger; broker never posts to ledger                     |  **T6** / **T5**   | `9628653` / `a170d38` | `packages/broker/test/okx-broker.test.ts`                          | **RESOLVED** |
| **M-G**     |  MAJOR   | Replay gate omits Buy&Hold and Random Entry baselines; loose config floors                         |       **T4**       |       `121baeb`       | `packages/replay/test/benchmark-distribution.test.ts`              | **RESOLVED** |
| **M-H**     |  MAJOR   | Shadow stats read from paper ledger; `daysInStage` measured from first ledger entry                |       **T7**       |       `6dad054`       | `packages/api/test/promotion.test.ts`, `shadow-repository.test.ts` | **RESOLVED** |
| **M-I**     |  MAJOR   | Spent 2025 holdout requires unspent 2026 holdout partition with strict quarantine                  |       **T3**       |       `aea1a1b`       | `packages/replay/test/holdout-seal-2026.test.ts`                   | **RESOLVED** |
| **Minor 1** |  MINOR   | Double-counted entry slippage & missing stop exit adverse slippage in replay                       |       **T2**       |       `58ebee1`       | `packages/core/test/execution-parity.test.ts`                      | **RESOLVED** |
| **Minor 2** |  MINOR   | Ledger HWM only sees current MTM equity; day/week start uses realized cash                         |       **T5**       |       `a170d38`       | `packages/api/test/scheduler.test.ts`                              | **RESOLVED** |
| **Minor 3** |  MINOR   | Argon2id m=4096 KiB below OWASP; vault key plain SHA-256 without KDF                               |       **T1**       |       `3f6f9f6`       | `packages/api/test/security.test.ts`                               | **RESOLVED** |
| **Minor 4** |  MINOR   | Gemini API key in URL query string; silent fallback to simulation                                  |       **T1**       |       `3f6f9f6`       | `packages/ai/test/ai-gateway.test.ts`                              | **RESOLVED** |

---

## 2. Summary of Ticket Deliverables

### Ticket T1: Security Boundary Hardening (`3f6f9f6`)

- **ADR-0013**: Strict startup master key validation (`KEEL_MASTER_KEY` $\ge 32$ chars, non-default), SQLite-backed persistent login throttling with exponential backoff up to 15m returning HTTP 429, versioned Argon2id envelopes (`argon2id$v=1$...`), and versioned AES-256-GCM ciphertexts with transparent legacy migration.

### Ticket T2: Replay Realism & Execution Parity (`58ebee1`)

- **ADR-0014**: Unified execution core in `@keel/core/execution.ts` implementing `computeNextBarOpenEntry` and `evaluateIntrabarExit`. Enforces adverse slippage on market stop exits and liquidation, eliminates double-counted entry slippage, scales both fees and slippage by the cost stress multiplier, and guarantees bit-for-bit execution parity between PaperBroker and ReplayEngine.

### Ticket T3: Research Trial Accounting & 2026 Holdout Seal (`aea1a1b`)

- **ADR-0015**: Introduced `research_trials` table tracking distinct `(strategy_id, parameter_hash, instrument_id, timeframe)` trials monotonically. Converted `experiments` to append-only `INSERT` with autoincrementing `sequence`. Quarantined 2026 data (`SEALED_2026_HOLDOUT_START_TS` = `1767225600000`) requiring single-use cryptographic tokens in `holdout_tokens`.

### Ticket T4: Report Integrity & Benchmark Distribution Gates (`121baeb`)

- **ADR-0016**: Hardened `replayGatePassed` to require outperforming Buy & Hold Sharpe and beating the 75th percentile of a $\ge 200$-path Monte Carlo random entry distribution. Enforces isolated single-strategy walk-forward evaluation (eliminating candidate contamination). Re-derived and regenerated `docs/research/phase-d-results.md` directly from in-sample SQLite data, confirming all strategies FAILED the quantitative replay gate.

### Ticket T5: Scheduler Catch-up & Read-Only Risk Metrics (`a170d38`)

- **ADR-0017**: Implemented chronological backlog processing in `UnattendedScheduler.stepOnce` (capped at 500 unprocessed confirmed bars per step) with bar idempotency, settled funding accrual, and gap-aware intrabar fills. Default scheduler strategy list made strictly empty `[]` (explicit opt-in). Split `LedgerRepository.getRiskMetrics` into a strictly read-only query and decoupled `recordEquitySnapshot`.

### Ticket T6: Exchange Broker Truthfulness & Order Lifecycle (`9628653`)

- **ADR-0018**: In `OkxBroker`: polls real fill volume-weighted price (`avgPx`) and fees from `GET /api/v5/trade/order`, recording status as `SUBMITTED` when unconfirmed. Verifies `sCode` on emergency flattening, explicitly cancels resting conditional and OCO algo orders via `POST /api/v5/trade/cancel-algo-orders`, and posts real exit PnL/fees to the ledger. Strictly cleans `attachAlgoOrds` to confirmed OKX V5 REST parameters. Guards DMS heartbeat when credentials are absent.

### Ticket T7: Shadow Gate Resolution & Runtime Promotion Re-Check (`6dad054`)

- **ADR-0019**: Dedicated `shadow_decisions` repository with deduplication per `(strategy, instrument, bar)`. Pending shadow proposals are marked to market against subsequent confirmed bars using next-bar open entry and gap-aware intrabar exits into empirical unit risk ($R$). Requires non-negative resolved expectancy ($R \ge 0$) and at least `shadowMinTrades` resolved outcomes for `Paper` promotion. Hardens `POST /api/v1/promotion/promote` to re-evaluate all gate criteria at runtime against live database state rather than trusting stored values.

---

## 3. Architecture & Standards Retrospective

1. **Deterministic Financial Safety**:
   - Zero floating point numbers are used in financial accounting; all money, prices, fees, funding, and quantities strictly use `ScaledDecimal`.
   - Zero AI models or LLM calls exist on the money path (risk engine, order execution, ledger, reconciliation, and stop tracking are 100% deterministic).
   - Human gates G1, G2, and G3 are strictly enforced in application code and cannot be bypassed.
2. **Holdout Quarantine**:
   - Out-of-sample holdout partitions (2025 and 2026) remain quarantined. All replay and backtest evaluations strictly operate in-sample (`2023-01-01` to `2024-12-31` UTC).
3. **Repository Cleanliness**:
   - 21 test files, 142 tests passing (`pnpm test`).
   - Strict TypeScript check (`pnpm typecheck`) clean with 0 errors across 9 workspace packages.
   - Strict ESLint check (`pnpm lint`) clean with 0 warnings and 0 errors (`no-explicit-any` enforced).
   - Prettier formatting check (`pnpm format:check`) clean across all files.
