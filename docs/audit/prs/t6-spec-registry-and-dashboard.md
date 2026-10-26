# PR: T6 — Strategy Spec Registry, Promotion Quarantine, API Endpoints, and Dashboard View

## Summary

This PR completes Ticket T6, providing persistent storage, discovery, API access, and governance controls for the Strategy Spec system:

1. **Strategy Spec Repository (`StrategySpecRepository`)**:
   - Stores specifications in SQLite WAL: `strategy_specs` (hash, name, version, spec_json, is_synthetic, created_at_ms) and `strategy_spec_names` (name, active_spec_hash, updated_at_ms).
   - Invariant: When a new unique specification is registered, the repository automatically increments the monotonic `research_trials` counter (`experimentRepo.recordTrial`).
   - Idempotent: Re-registering identical hashes does not duplicate trials.

2. **Promotion Quarantine Invariant (ADR-0021)**:
   - Evaluated at runtime in `POST /api/v1/promotion/promote`.
   - Strategies with `synthetic: true` (or prefixed with `synthetic-`) are strictly blocked with `403 Forbidden` from ever being promoted to `Demo`, `Live-Ramp`, or `Live`.

3. **REST API Contract & Endpoints (`@ts-rest`)**:
   - `POST /api/v1/specs`: Validates `StrategySpecV1Schema`, calculates canonical SHA-256 hash, stores spec, increments trial counter, and returns 200.
   - `GET /api/v1/specs`: Lists all registered strategy specifications with metadata.
   - `GET /api/v1/specs/:hash`: Returns full specification JSON and deterministic plain-English AST audit text (`describeSpec`).

4. **Synthetic Fixture Definition**:
   - Exports `SYNTHETIC_DONCHIAN_FIXTURE_SPEC` (`synthetic: true`) in `@keel/spec`.

5. **Web Dashboard Specs & AST Registry View (`packages/web`)**:
   - Added dedicated "Strategy Specifications & AST Registry" panel in `App.tsx`.
   - Displays all registered specs, canonical hashes, quarantine badges (`SYNTHETIC / QUARANTINED` vs `PRODUCTION CANDIDATE`), and interactive plain-English AST audit inspector.

## Changes

- **`packages/core`**:
  - Added `StrategySpecRecordSchema`, `StrategySpecNameRecordSchema`, `SaveStrategySpecInput`, and `StrategySpecRepository` to `ports.ts`.
  - Added `specs.register`, `specs.list`, and `specs.getByHash` to `keelApiContract` in `contract.ts`.
- **`packages/data`**:
  - Implemented `SPEC_SCHEMA_SQL` and `createStrategySpecRepository` in `src/spec-repository.ts`.
  - Integrated `strategySpecRepo` in `SqliteDataStore`.
  - Added unit test suite `test/strategy-spec-repository.test.ts`.
- **`packages/api`**:
  - Added `@keel/spec` dependency in `package.json`.
  - Implemented `specs` contract handlers in `server.ts`.
  - Enforced promotion quarantine in `promotion.promote`.
  - Added test suite `test/specs-and-quarantine.test.ts`.
- **`packages/web`**:
  - Added specs state, API polling, and Strategy Specifications & AST Registry panel in `src/App.tsx`.
- **`packages/spec`**:
  - Exported `SYNTHETIC_DONCHIAN_FIXTURE_SPEC`.
- **`docs/adr/0021-spec-registry-and-quarantine-promotion.md`**:
  - Documented registry architecture, trial accounting coupling, and quarantine invariants.
- **`docs/audit/assumptions.md`**:
  - Added assumption `A-T6`.
- **`docs/claims.json`**:
  - Added `CLAIM-ADR-0021-SPEC-REGISTRY-TRIALS` and `CLAIM-ADR-0021-SYNTHETIC-QUARANTINE`.

## Verification

- `pnpm test`: 25 test files, 164 tests passed.
- `pnpm check-claims`: All 47 claims verified.
- `pnpm typecheck`: Clean across all packages.
- `pnpm lint`: Clean with 0 warnings.
- `pnpm format:check`: All files match Prettier style.
- `pnpm build`: Clean build across monorepo including Vite frontend.
