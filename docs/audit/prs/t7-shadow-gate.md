# PR: Shadow Gate, Runtime Promotion Re-Check, & Complete Defect Remediation (Ticket T7 / M-H)

## Summary

Remediates findings **M-H** and completes Ticket **T7** of the platform defect audit:

- Implements dedicated `shadow_decisions` persistence and repository (`ShadowRepository`) in `@keel/data` with deduplication per `(strategy, instrument, bar)`.
- Resolves pending shadow decisions into empirical unit risk ($R$) against subsequent confirmed bars using next-bar open entry with slippage and gap-aware intrabar exits (ADR-0009 / ADR-0014 / ADR-0019).
- Hardens `PromotionLadderEvaluator.evaluate`:
  - `shadowDurationDays` measured from `promotedAtMs`.
  - Only resolved shadow outcomes count toward `shadowMinTrades`.
  - Enforces non-negative resolved expectancy ($R \ge 0$) before permitting promotion to `Paper`.
- Hardens `POST /api/v1/promotion/promote`:
  - Re-evaluates all promotion gate criteria at promote time against live ledger, paper positions, and resolved shadow decisions.
  - Strictly rejects promotion if live evaluation fails, eliminating stale `eligibleNextStage` trust.
- Wires automatic shadow decision resolution into `UnattendedScheduler.stepOnce` and `POST /api/v1/ai/shadow-evaluate`.

## Tests Added & Passing

- `packages/core/test/risk-and-promotion.test.ts`:
  - Tests that negative resolved shadow expectancy ($R < 0$) rejects promotion to `Paper` even when days and trade counts pass.
  - Tests that non-negative resolved expectancy ($R \ge 0$) with sufficient days and trades permits promotion to `Paper`.
- `packages/data/test/shadow-repository.test.ts`:
  - Tests deduplication on identical `(strategy, instrument, signalBarCloseTs)`.
  - Tests end-to-end resolution of pending decisions against subsequent confirmed bars, calculating exact hypothetical $R$ and average expectancy.
- `packages/api/test/promotion.test.ts`:
  - Tests that `POST /api/v1/promotion/promote` re-evaluates eligibility at runtime and rejects with 400 when live criteria are not satisfied, even if `eligibleNextStage` was pre-stored in SQLite.

## Verification

- `pnpm test`: 21 test files, 142 tests passing.
- `pnpm typecheck`: Clean across all packages.
- `pnpm lint`: Clean (0 errors, 0 warnings).
- `pnpm format:check`: Clean.
