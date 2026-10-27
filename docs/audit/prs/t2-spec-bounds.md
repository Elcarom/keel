# PR: Ticket T2 — Spec Schema Resource Bounds & Safe Pre-Parse (A3)

## Summary of Changes

Addresses audit defect **A3**:

1. **Iterative Pre-Parse Structural Budget Validator (`validateSpecAstBudget`)**:
   - Traverses input JSON using an explicit stack rather than recursive calls, guaranteeing zero call stack exhaustion / `RangeError` even on 3,000-deep nesting.
   - Enforces max JSON depth of 8 across the payload.
   - Enforces max AST expression depth of 6 within `rules.longEntry` and `rules.shortEntry`.
   - Enforces max total AST node budget of 32 across rules.
   - Piped directly into `StrategySpecV1Schema` via `z.unknown().superRefine(...).pipe(...)` so invalid or malicious specs are rejected before recursive parsing.
2. **Strict Resource Bounds in `StrategySpecV1Schema`**:
   - Indicator `period`: bounded to `[2, 500]` integers (preventing 100,000,000 lookback allocations).
   - Indicator and bar field `shift`: bounded to `[0, 500]` integers.
   - `lookbacks`: timeframe key literal `"1H"`, value bounded to `[1, 500]`.
   - `indicators`: maximum 8 indicators per spec.
   - Stop `multiplier`: bounded to `[0.1, 10]`; `fixed_points`: bounded to `(0, 1_000_000]`.
   - `rewardMultiple`: bounded to `[0.5, 10]`.
   - Added `cooldownBars`: bounded to `[0, 200]`, defaulting to 0.
   - Added `timeStopBars`: optional, bounded to `[1, 500]`.
   - `name`: bounded to $\le 64$ characters, matching `/^[A-Za-z0-9._-]+$/`.
   - `description`: bounded to $\le 2000$ characters.
   - `timeframe`: strictly literal `"1H"`.
3. **Floating-Point Equality Operator Removal**:
   - Removed `==` and `!=` from comparison operators in `ConditionSchema` and `evaluateCondition`, preventing fragile float comparisons.
4. **Canonical Hash Invariance**:
   - Excluded `metadata` from canonical hash computation in `computeSpecHash(spec)`, ensuring spec parameter hashes are purely deterministic and invariant to arbitrary metadata payloads.

## Verification

- Added failing regression tests in `packages/spec/test/spec-bounds.test.ts` (14/14 tests passing).
- Verified `packages/spec/test/spec-engine.test.ts` (9/9 tests passing).
- Verified full workspace test suite: 179/179 tests across 26 test files passing.
- Typecheck (`pnpm typecheck`): 0 errors across 9 packages.
- Strict lint (`pnpm lint`): 0 errors, 0 warnings.
- Documentation claims (`node scripts/check-claims.js`): 49/49 claims verified.
