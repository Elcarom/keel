# 0010. Unified Risk Routing, State Persistence, and Verifiable Exchange Reconciliation

**Status**: accepted

## Context

An independent review of `@keel/broker`, `@keel/api`, and `@keel/risk` identified critical safety defects:

1. `POST /api/v1/broker/order` routed orders directly to `okxBroker.submitOrder` without passing through `RiskGuardian`, creating exchange positions with `initialRiskUsdt: "0.00"` and strategyId `"exchange-execution"`.
2. `paper-broker.ts` instantiated `StrategyRiskState` and `PortfolioRiskState` resetting `dayStartEquityUsdt`, `weekStartEquityUsdt`, `highWaterMarkEquityUsdt`, `tradesTodayCount`, and `feesTodayUsdt` to current equity on every tick, disabling daily/weekly loss stops and fee budget halts.
3. `server.ts` carried forward `paperDrawdownPct` from existing records without computing mark-to-market drawdown, preventing automated demotion from triggering.
4. `OkxBroker.reconcilePositions` did not query OKX exchange REST endpoints, equating exchange position count to local count.
5. `OkxBroker.flattenAllPositions` modified an in-memory Map without issuing closing orders on OKX.
6. `OkxBroker.sendDmsHeartbeat` caught all exceptions silently and always reported `ok: true`.

## Decision

1. **Mandatory Single-Path Risk Routing**:
   Every order submission path across Paper, Demo, and Live execution modes MUST pass through `RiskGuardian.evaluateProposal` prior to dispatch. Sizing is governed strictly by stop-distance `1R` risk and portfolio exposure caps. Un-evaluated order routing is prohibited.
2. **Persistent Ledger Risk State**:
   `StrategyRiskState` and `PortfolioRiskState` derive day-start equity, week-start equity, high-water mark, trades today, and fees today from immutable double-entry ledger journals. Day and week resets occur strictly at UTC midnight (00:00:00 UTC).
3. **Continuous Mark-to-Market Drawdown Tracking**:
   `paperDrawdownPct` is dynamically calculated as the percentage deficit from the persistent high-water mark to current net equity. When this exceeds the configured threshold, automated demotion and position flattening trigger immediately.
4. **Verifiable Exchange Reconciliation**:
   `reconcilePositions` queries OKX REST endpoint `/api/v5/account/positions` and pending algo orders `/api/v5/trade/orders-algo-pending`. Any discrepancy between local records and exchange state triggers a `CRITICAL` alert and initiates emergency position reconciliation.
5. **Deterministic Double-Action Kill Switch Flatten**:
   `flattenAllPositions` sends `POST /api/v5/trade/cancel-all-after` to cancel resting orders and submits market `reduceOnly=true` orders for all open net positions, asserting that net positions reach zero.
6. **Honest Error Handling & State Persistence**:
   OKX HTTP errors and body-level error codes (`code !== "0"` or `sCode !== "0"`) throw explicit errors. DMS heartbeat failures propagate immediately as `CRITICAL` alerts. Broker state (orders, positions, algo orders) is persisted to SQLite across restarts.
