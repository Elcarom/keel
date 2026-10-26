# ADR-0021: Strategy Spec Registry, Monotonic Trial Coupling, and Promotion Quarantine

## Status

Accepted

## Context

With ADR-0020 establishing the declarative `StrategySpecV1` AST and canonical hashing (`specHash`), Keel requires a persistent storage, discovery, and governance mechanism:

1. **Persistent Spec Registry**:
   - Strategy specifications must be stored immutably in SQLite behind a clean port interface (`StrategySpecRepository`).
   - Active strategies must be mappable by name (`strategy_spec_names`) to their active canonical `spec_hash`.
2. **Deflated Sharpe Ratio (DSR) Trial Accounting Monotonicity**:
   - Registering a new unique specification introduces an additional degree of freedom in the researcher's trial universe.
   - To maintain mathematical rigor and avoid selection bias under Harvey & Liu (2014), registering a unique `spec_hash` must automatically record a trial into the monotonic `research_trials` counter (`experimentRepo.recordTrial`).
3. **Promotion Quarantine for Synthetic Strategies**:
   - Research strategies flagged with `synthetic: true` (or prefixed with `synthetic-`) exist exclusively for algorithmic testing, replay benchmarking, and calibration.
   - Under no circumstances may a synthetic strategy be promoted to `Demo`, `Live-Ramp`, or `Live`. The promotion ladder must fail-closed at runtime with `403 Forbidden` if promotion is attempted for any synthetic strategy.
4. **Transparent Governance & Dashboard Observability**:
   - Operators and auditors require an accessible dashboard view displaying all registered strategy specifications, canonical SHA-256 hashes, quarantine status badges, and deterministic plain-English AST explanations.

## Decision

1. **Database Schema (`packages/data/src/spec-repository.ts`)**:
   - Create tables in SQLite WAL:
     ```sql
     CREATE TABLE IF NOT EXISTS strategy_specs (
       spec_hash TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       version INTEGER NOT NULL,
       spec_json TEXT NOT NULL,
       is_synthetic INTEGER NOT NULL DEFAULT 0,
       created_at_ms INTEGER NOT NULL
     );

     CREATE TABLE IF NOT EXISTS strategy_spec_names (
       name TEXT PRIMARY KEY,
       active_spec_hash TEXT NOT NULL,
       updated_at_ms INTEGER NOT NULL,
       FOREIGN KEY (active_spec_hash) REFERENCES strategy_specs(spec_hash)
     );
     ```

2. **Monotonic Research Trial Coupling**:
   - In `StrategySpecRepository.saveSpec`, when inserting a new `spec_hash`, invoke `experimentRepo.recordTrial({ strategyId: input.name, parameterHash: input.specHash, ... })`.
   - Re-registering an identical `spec_hash` is an idempotent no-op that does not double-count trials.

3. **Runtime Promotion Quarantine Enforcement**:
   - In `POST /api/v1/promotion/promote`, before allowing promotion to `Demo`, `Live-Ramp`, or `Live`, look up the strategy specification in `StrategySpecRepository`.
   - If `record.isSynthetic === true` or `strategyId.startsWith("synthetic-")`, reject the request immediately with `403 Forbidden` and error:
     `"Strategy <strategyId> is synthetic/quarantined and cannot be promoted to <targetStage>."`

4. **REST API Contract (`@ts-rest`)**:
   - `POST /api/v1/specs`: Validate spec against `StrategySpecV1Schema`, calculate `specHash`, persist in repository, increment trials, and return 200.
   - `GET /api/v1/specs`: List all registered specifications with metadata.
   - `GET /api/v1/specs/:hash`: Return spec JSON, parsed AST, and deterministic `describeSpec` text.

5. **Dashboard Observability**:
   - Provide read-only "Strategy Specifications & AST Registry" panel in the web interface with interactive AST inspection and quarantine badges.

## Consequences

- Systematic strategies can be registered, versioned, inspected, and audited without code changes.
- Every registered spec trial is monotonically tracked for Deflated Sharpe Ratio calculation.
- Synthetic fixture strategies can never risk capital in demo or live exchange environments.
