# Audit 4: Real-Money Path, Promotion Ladder and Hardening

**Repository**: `Elcarom/psychic-octo-funicular` (Keel)
**Audited commit**: `fe4c04a`
**Scope**: a full audit against `AGENTS.md` and `docs/design/bot-platform.md` after audit 3, followed by remediation of every finding the owner approved. The owner's go-ahead covered the G2/G3 sign-off for the sizing and gate changes.

---

## 1. Baseline at `fe4c04a`

- **Checks**: format, lint, build, strict typecheck, 220 tests, 73 claims and 9 Playwright specs passed from a clean build.
- **Hard rules**:
  - no `any` and no suppressions
  - accounting stays in `ScaledDecimal`; `Number()` is used only for statistics
  - `@keel/ai` is imported only by `@keel/api`
  - the forming-bar gate is intact
  - every exchange entry carries a stop
- **Reference copy check**: 7 of 11,174 lines (0.06%) match `reference/beebots`, all boilerplate.

## 2. Findings and remediation

| ID  | Severity | Finding                                                                                                                                   | Fix                                                                                                                                                                                                                             |
| :-- | :------: | :---------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H1  |   HIGH   | Venue Book drawdown and daily loss were only checked when an order was attempted, so open real-money losses never tripped the Kill Switch | The Venue Book's loss limits are checked after every 15s DMS heartbeat (`RiskGuardian.evaluatePortfolioBreakers`). A breach trips the Kill Switch, which flattens both books                                                    |
| H2  |   HIGH   | Live-Ramp sizing was never applied, and `rampAllocationPct` was not even persisted                                                        | Live-Ramp entries are capped at `rampAllocationPct` of the 1R size. The value is now stored; existing rows migrate to the most conservative 10% tier                                                                            |
| H3  |   HIGH   | Demo → Live-Ramp (and Live-Ramp → Live) promotion counted paper trades                                                                    | Demo, Live-Ramp and Live are judged on Venue Book trades closed since stage entry, and on Venue Book drawdown                                                                                                                   |
| H4  |   HIGH   | G3 ("step-up MFA") accepted a password alone; the design doc labelled Live-Ramp as G2                                                     | Switching into, rolling back into, promoting to, ordering in or rebasing in Live-Ramp/Live requires an enrolled TOTP authenticator. The dashboard sends the TOTP code with every step-up. The design doc labels Live-Ramp as G3 |
| H5  |   HIGH   | `@fastify/static@8.3.0` had path-traversal and auth-bypass advisories; zod 3 has a memory-exhaustion advisory                             | `@fastify/static` upgraded to `^10.1.8`. zod is **accepted**: no patched 3.x exists, ts-rest 3.52 requires zod 3, and Fastify's default 1 MiB body limit caps the oversized input                                               |
| M1  |  MEDIUM  | `SEALED_2026_HOLDOUT_END_TS` was unused, so the holdout sealed all data from 2026 onward                                                  | `overlapsSealed2026Holdout` bounds the partition at the replay engine, walk-forward folds, the replay API and the scheduler                                                                                                     |
| M2  |  MEDIUM  | Strategies never place exchange orders automatically; exchange orders exist only through the manual route                                 | **Open: owner decision.** The H2/H3 fixes apply to manual orders today and will apply to automatic ones if they are added                                                                                                       |
| M3  |  MEDIUM  | `?? Date.now()` fallbacks bypassed the `Clock` port                                                                                       | The data repositories take the store's `Clock`, and the ingress time is required. `SystemClock` is the only `Date.now()` left                                                                                                   |
| M4  |  MEDIUM  | OKX keys could come from plaintext `OKX_API_*` environment variables                                                                      | Removed. OKX keys come only from the vault, whose writes need step-up and are audited                                                                                                                                           |
| L1  |   LOW    | `tsconfig.tsbuildinfo` beside `dist/` made a rebuild after deleting `dist/` emit nothing                                                  | `core` and `api` keep build info in `dist/`, as `ai` and `broker` already did                                                                                                                                                   |
| L2  |   LOW    | No browser security headers                                                                                                               | CSP (`default-src 'self'`, `frame-ancestors 'none'`), `nosniff`, `X-Frame-Options: DENY` and `no-referrer` on every response. The dashboard e2e suite passes under the CSP                                                      |
| L3  |   LOW    | Dev-only advisories through `vitest@2.1.9` (tinypool, vite, esbuild)                                                                      | Vitest upgraded to `^4.1.12`. The suite runs unchanged                                                                                                                                                                          |
| L4  |   LOW    | Environment variables were undocumented                                                                                                   | README has an environment variable table                                                                                                                                                                                        |
| L5  |   LOW    | Venue Capital Rebase was API-only                                                                                                         | The Exchange Broker panel has a rebase button, covered by the M5 e2e spec                                                                                                                                                       |

Every behaviour change has a failing-first test and a claim in `docs/claims.json`.

## 3. Results after remediation

- format, lint, build, typecheck: pass from a clean build
- 228 unit and property tests, 81 claims (each claim's test must run and pass), 9 Playwright specs
- `pnpm audit`: 1 high (zod, accepted above). There were 22 advisories before remediation

## 4. Open decisions

- **M2, automatic exchange trading:** should promoted strategies place Demo, Live-Ramp and Live orders through the scheduler? Today only the operator can place exchange orders.
- **G2 MFA on Demo:** the design doc says G2 is "step-up MFA" for any exchange account, including Demo. Demo orders currently accept a password step-up. Requiring TOTP there would change every Demo flow.
- **Ramp tiers:** the global `risk.liveRampMultipliers` setting is still unused. Live-Ramp sizing follows the per-strategy `rampAllocationPct` (10/25/50%) set from evidence at promotion. Remove the global setting or reconcile the two.
