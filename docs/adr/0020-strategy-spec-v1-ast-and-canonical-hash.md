# ADR-0020: Strategy Spec V1 AST, Canonical Hash, and Pure Causal Interpreter

## Status

Accepted

## Context

Keel previously hardcoded strategies as bespoke TypeScript classes (`DonchianTrendStrategy`, `VolNormalizedMeanReversionStrategy`, `VolNormalizedMomentumStrategy`). While safe, this architecture limits systematic research, automated backtesting, and verifiable rule governance:

1. Hardcoded classes cannot be serialized to the database as declarative, version-controlled records.
2. Parameter changes or strategy variants cannot be mechanically compared, diffed, or verified without recompiling code.
3. Automated research and future strategy authoring require a sandboxed, declarative specification language with zero arbitrary code execution (`eval`, `Function`, or dynamic imports) and zero AI on the money path.
4. Strategy identity requires a deterministic canonical representation (`specHash`) that is invariant to JSON key ordering, formatting whitespace, or property permutation.

## Decision

1. **Package `@keel/spec`**:
   - Establish a dedicated workspace package `@keel/spec` exporting the `StrategySpecV1` schema, canonical hash calculator, deterministic English explainer, and pure causal interpreter `SpecStrategy`.

2. **Declarative Zod Schema `StrategySpecV1`**:
   - `name`: string identifier.
   - `version`: literal 1.
   - `description`: string summary.
   - `timeframe`: `"15m" | "1H" | "4H" | "1D"`.
   - `lookbacks`: map of timeframe to required bar counts.
   - `indicators`: whitelist of deterministic technical indicators (`donchian`, `atr`, `sma`, `stddev`, `zscore`, `momentum`).
   - `rules`: bounded AST expressions for conditions:
     - Numeric expressions: `constant`, `bar_field`, `indicator`, `binary_op` (`+`, `-`, `*`, `/`).
     - Boolean conditions: `comparison` (`>`, `>=`, `<`, `<=`, `==`, `!=`), `logical_op` (`and`, `or`, `not`), `crosses_above`, `crosses_below`.
     - `longEntry` and `shortEntry` conditions.
   - `risk`:
     - `stopModel`: `atr_multiple`, `channel_bound`, or `fixed_points`.
     - `takeProfit`: `rewardMultiple` (maker limit exit).
   - `synthetic`: optional boolean flag. If `true`, the strategy is synthetic/fixture and strictly blocked by the runtime from ever being promoted to Demo or Live.

3. **Canonical Serialization & Parameter Hash (`specHash`)**:
   - Defined as recursive lexicographical key sorting followed by deterministic JSON stringification.
   - `specHash = sha256Hex(canonicalJson)` (64-character lowercase hex).
   - Any two spec objects with identical semantic content produce identical `specHash`, regardless of property insertion order.

4. **Pure Causal Interpreter `SpecStrategy implements Strategy`**:
   - Implements `@keel/strategy`'s `Strategy` port.
   - Purely causal: evaluates rules strictly on confirmed bars up to `snapshot.asOfMs`. Never peeks at forming bars or future bars.
   - Evaluates indicator pipelines deterministically.
   - Generates proposals with standard protective stops and take profits matching existing hardcoded convention.
   - Golden parity: built-in strategies (`donchian-trend-v1`, `vol-mean-reversion-v1`, `vol-momentum-v1`) must have bit-for-bit proposal equivalence with their declarative spec equivalents.

5. **Deterministic Plain-English Description (`describeSpec`)**:
   - Pure function transforming any `StrategySpecV1` into structured human-readable text detailing indicators, entry conditions, protective stop distances, and take-profit targets.

## Consequences

- Strategies become declarative, inspectable, and storable data structures.
- Unsanctioned code execution is impossible because rules are interpreted by a bounded AST evaluator.
- Research trials and experiment registries can index strategies by immutable `specHash`.
- Zero AI on money path remains strictly enforced: specs are evaluated deterministically.
