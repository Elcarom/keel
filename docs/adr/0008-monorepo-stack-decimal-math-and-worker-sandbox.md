# 0008. Monorepo Stack, Fixed-Point Decimal Accounting, and Isolated Worker Sandbox

**Status**: accepted

We standardize the **`Keel`** (`@keel/*`) monorepo on the following engineering stack and determinism rules:

1. **Runtime & Tooling**: Node 22 LTS, TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, zero `any` in domain packages), `pnpm` workspaces, Vitest + `fast-check` for unit and property-based testing, Playwright for end-to-end dashboard flows, and ESLint + Prettier.
2. **Exact Decimal Arithmetic for Money & Quantities**: Raw IEEE-754 floating-point numbers (`number`) are forbidden for balance, equity, fee, funding, margin, or contract-quantity accounting. All financial values in `core`, `ledger`, `risk`, and `broker` use an explicit fixed-point/decimal value object (`Decimal` / bigint-scaled `ScaledDecimal` with explicit rounding modes matching exchange tick/lot rules). Floating-point math is permitted only inside statistical indicators (`strategy`, `replay` reporting) after converting from confirmed bar prices.
3. **Sandboxed Strategy Lab Execution**: AI-proposed candidate strategies in the Strategy Lab are represented either as declarative parameterizations of registered strategy templates or executed inside an isolated Node `worker_threads` worker (`resourceLimits` for heap/CPU, hard execution timeout, and zero network/filesystem/process capabilities) so an untrusted candidate cannot perform I/O or starve the trading engine.
