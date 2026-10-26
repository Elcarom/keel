# ADR-0019: Shadow Stage Resolution, Deduplicated Picks, & Runtime Promotion Re-Check (T7 / M-H)

## Status

Accepted

## Context

Audit findings on strategy lifecycle governance and promotion gating revealed:

1. **Shadow-Stage Stat Leakage & Ledger Coupling (M-H)**:
   - Shadow-stage trade counts and performance were previously derived from the paper ledger or raw audit log events.
   - Paper execution records and paper positions should never contaminate shadow forward-testing statistics.
   - `daysInStage` was previously vulnerable to being measured from the first ledger entry rather than the actual stage promotion timestamp (`promotedAtMs`).
2. **Unresolved Shadow Proposals**:
   - Shadow recommendations emitted by AI shadow advisors were recorded without tracking signal bar identities, deduplicating repetitive calls on identical bars, or tracking actual hypothetical trade outcomes against subsequent market bars.
   - Promotion required `shadowMinTrades` (30) but lacked an objective mechanism to evaluate resolved trade expectancy.
3. **Stale Promotion Eligibility Trust**:
   - The promotion endpoint (`POST /api/v1/promotion/promote`) previously trusted stored `eligibleNextStage` from earlier `evaluate` calls.
   - If market conditions changed, drawdown occurred, or an operator attempted to promote without active gate verification, the system risked promoting unqualified strategies.

## Decision

1. **Dedicated Shadow Decision Repository (`shadow_decisions`)**:
   - Introduced a persistent SQLite table `shadow_decisions` dedicated to shadow recommendations.
   - Enforces unique constraint `UNIQUE(strategy_id, instrument_id, signal_bar_close_ts)` to guarantee deduplication per (strategy, instrument, bar).
   - Stores proposed side, proposed entry price, proposed protective stop, and proposed take-profit.
2. **Realistic Next-Bar Resolution into Hypothetical R**:
   - Pending shadow decisions are resolved against subsequent confirmed bars using the identical execution model derived in ADR-0009 and ADR-0014:
     - Entry fills at next-bar open with configured adverse slippage (`computeNextBarOpenEntry`).
     - Stop and take-profit exits are evaluated intrabar (`evaluateIntrabarExit`) with gap-aware fills and adverse stop slippage.
   - Each resolved decision records its exact outcome in unit risk ($R = \text{pnl} / \text{initialRisk}$).
   - `getShadowStats` returns `resolvedCount`, `pendingCount`, `expectancyR`, and `winRate`.
3. **Shadow Stage Promotion Gate Requirements**:
   - Transition from `Shadow` to `Paper` strictly requires:
     - Quantitative replay gate passed.
     - `shadowDurationDays >= shadowMinDays` (measured from `promotedAtMs`).
     - `resolvedCount >= shadowMinTrades` (only resolved outcomes count toward trade requirements; unresolved pending decisions do not count).
     - Resolved expectancy $R \ge 0$ (non-negative forward expectancy).
4. **Runtime Promotion Re-Check**:
   - `POST /api/v1/promotion/promote` re-evaluates all gate criteria against live database state at promote time:
     - Re-evaluates current paper drawdown and open positions.
     - Resolves any pending shadow decisions across confirmed bars.
     - Evaluates whether `currentEvaluation.eligibleNextStage === body.targetStage`.
   - Never trusts stored `eligibleNextStage` values from previous snapshots.

## Consequences

- Shadow forward-testing is completely isolated from paper and exchange ledgers.
- AI and baseline decisions are rigorously evaluated and marked to market into empirical R distributions.
- Strategies cannot be promoted without passing runtime re-check with current data.
