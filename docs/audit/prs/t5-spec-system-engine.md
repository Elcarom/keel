# PR: T5 — Strategy Spec V1 AST, Canonical Hashing, & Pure Causal Engine

## Summary

This PR delivers Ticket T5, establishing the deterministic, portable strategy specification system (`@keel/spec`) and pure causal interpreter:

1. **Strategy Spec V1 Schema & AST (`StrategySpecV1Schema`)**:
   - Strongly typed Zod schema with bounded indicator library (`donchian`, `atr`, `sma`, `stddev`, `zscore`, `momentum`), AST expressions (`NumExpr`, `Condition`), risk models (`stopModel`, `takeProfit`), and execution configurations.
   - Enforces lookahead safety: indicators are strictly causal, computed over confirmed bars only.
   - Includes boolean `synthetic: boolean` flag distinguishing research benchmark specs from production trading candidates.

2. **Canonical Spec Hashing (`computeSpecHash`)**:
   - Implements deterministic JSON key sorting recursively across all nested objects and arrays.
   - Serializes to canonical JSON and computes SHA-256 hash.
   - Proven invariant to key insertion order in JSON representations.

3. **Plain-English Generator (`describeSpec`)**:
   - Generates deterministic, unambiguous English descriptions for auditability and dashboard views without LLM invocation.

4. **Pure Causal Engine (`SpecStrategy`)**:
   - Implements `@keel/core` `Strategy` port.
   - Computes technical indicators dynamically over confirmed bar lookbacks.
   - Pure, zero-side-effect evaluation producing deterministic `StrategySignal` proposals.

5. **Parity Golden Verification**:
   - Implements golden AST specs for `DONCHIAN_TREND_V1_SPEC`, `VOL_MEAN_REVERSION_V1_SPEC`, and `VOL_MOMENTUM_V1_SPEC`.
   - Verified 1:1 signal and proposal parity against hardcoded built-in strategies (`packages/strategy`).
   - Verified 1:1 replay parity in `ReplayEngine.run` producing identical `totalTrades`, `netPnlUsdt`, and `avgR`.

## Changes

- **`packages/spec`**:
  - Created package with `package.json`, `tsconfig.json`, and full TypeScript implementation in `src/index.ts`.
  - Added unit test suite `test/spec-engine.test.ts` (7 tests).
- **`packages/replay`**:
  - Added devDependency on `@keel/spec`.
  - Added replay parity test suite `test/spec-strategy.test.ts` (3 tests).
- **`docs/adr/0020-strategy-spec-v1-ast-and-canonical-hash.md`**:
  - Documented AST grammar, hashing scheme, causal interpreter, and safety constraints.
- **`docs/audit/assumptions.md`**:
  - Documented assumption `A-T5`.
- **`docs/claims.json`**:
  - Added `CLAIM-ADR-0020-SPEC-CANONICAL-HASH` and `CLAIM-ADR-0020-SPEC-GOLDEN-PARITY`.

## Verification

- `pnpm test`: 23 test files, 159 tests passed.
- `pnpm typecheck`: Clean across all packages.
- `pnpm lint`: Clean with 0 warnings.
- `pnpm check-claims`: All 45 claims verified.
- `pnpm build`: Clean build across monorepo.
