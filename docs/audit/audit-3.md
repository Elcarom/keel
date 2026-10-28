# Audit 3: Money-Path Remediation and Re-Audit

**Repository**: `Elcarom/psychic-octo-funicular` (Keel)
**Baseline commit**: `4e266b3`
**Final commit**: `a936fa9` (merged to `main`, pushed to `origin/main`)
**Scope**: every critical (C1–C4) and high (H5–H9) finding from the third full audit against `AGENTS.md`. Medium findings are listed under [Still open](#4-still-open).
**Human gate**: the owner's instruction to fix these findings counted as the G2 sign-off for changing order-placing code. No real-money capability was added to the UI (G3).

---

## 1. Remediation matrix

| ID  | Severity | Finding                                                                                                                                                      | Fix                                                                                                                                                                                                  |  Commit   |
| :-- | :------: | :----------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------: |
| C4  | CRITICAL | Root `build`/`typecheck` used an unquoted `./packages/*` filter that bash glob-expanded, so CI built and typechecked nothing                                 | Quoted the filter, moved build before typecheck, and added `.gitattributes` to force LF                                                                                                              | `d3954d3` |
| C1  | CRITICAL | `flattenAllPositions` cancelled every Protective Stop and disarmed the DMS before closing anything, so a failed close left the position open and unprotected | A stop is cancelled only after its own position's close is confirmed, and only when no other open position on that instrument still needs it. The DMS stays armed until everything is confirmed flat | `40dbf7d` |
| H6  |   HIGH   | A reduce-only order with a stop recorded a phantom opposite-side position                                                                                    | Reduce-only is a confirmed full close; partial sizes are refused                                                                                                                                     | `cabc0a2` |
| H7  |   HIGH   | Without credentials, `submitOrder` returned FILLED at the requested price. Flatten booked exits at the last bar close                                        | The broker refuses to trade without credentials. Order records hold the confirmed fill                                                                                                               | `cabc0a2` |
| C2  | CRITICAL | Paper and exchange trades shared one account, ledger and position book. Live risk sizing read the mixed equity                                               | Separate Paper Book and Venue Book (ADR-0022). Only the circuit breaker is shared                                                                                                                    | `3d5822a` |
| C3  | CRITICAL | `POST /api/v1/broker/orders` needed only a session, which bypassed G2/G3 and the Promotion Ladder                                                            | Exchange orders need an exchange Execution Mode, a fresh step-up, and a Promotion Ladder stage that allows the venue. Manual orders are Demo-only                                                    | `81b9c2b` |
| H5  |   HIGH   | The demo/live venue was frozen at startup. Live-Ramp signed as demo and skipped heartbeat and reconciliation                                                 | The venue is derived per request from the current Execution Mode. Live-Ramp is real-money and gets the DMS and reconciliation. Mode changes that would strand open exchange positions are refused    | `b25896c` |
| H8  |   HIGH   | The DMS heartbeat ran only on the 60s scheduler step against a 60s countdown                                                                                 | A 15s heartbeat on its own timer, which runs even when the scheduler is disabled                                                                                                                     | `40cc349` |
| H9  |   HIGH   | The Kill Switch only toggled the paper circuit breaker: no flatten, no lock, and re-arming took one click                                                    | Manual and drawdown trips lock entries, flatten both books, and verify flat against the venue. Reset requires step-up                                                                                | `6f0f013` |

Every fix has a test that failed first and an entry in `docs/claims.json`.

## 2. Review follow-ups (`587cd8e`)

A two-axis review (standards and spec) of `4e266b3..HEAD` found five gaps in the first pass. All are fixed:

- Closing one position could cancel another position's stop on the same instrument.
- Automatic drawdown trips didn't flatten anything.
- The "flat" check read only the local cache, not the venue.
- Switching Demo → Paper could strand open exchange positions.
- The heartbeat ran only when the scheduler was enabled.

## 3. Re-audit results

- **Checks**: format, lint, build, typecheck, 206 unit/property tests and 63 claims pass from a clean tree under bash.
- **Hard rules**:
  - no `any` and no lint suppressions
  - package layering unchanged; AI imports stay in `@keel/ai` and `@keel/api`
  - the forming-bar gate is intact
  - only one code path places orders, and it is the gated route
- **Reference copy check**: 7 of about 11,000 lines match `reference/beebots`, all boilerplate, as in earlier audits.
- **End-to-end**: at `a936fa9`, 4 of 9 Playwright specs passed. M1, M2, M4, M6 and M8 failed identically on the baseline `4e266b3`, so they predated this work. A follow-up fixed all three causes, and all 9 specs now pass:
  - **M1, M8**: the e2e server had no `KEEL_MASTER_KEY`, so the vault refused every save (ADR-0013). `playwright.config.ts` now sets a test-only key.
  - **M4, M6**: AI calls required a Gemini key. The CLI now reads `KEEL_AI_SIMULATE_RESPONSES` into `ai.simulateResponses`, and the e2e server sets it.
  - **M2**: the synthetic seed ended at the current time, which is inside the sealed 2026 holdout, so the replay was correctly refused. The seed is now anchored no later than the start of the in-sample cutoff (2025-01-01), as ADR-0011 requires for test evaluations.
- **Domain docs**: `GLOSSARY.md` gained Trading Book, Kill Switch and Kill Switch Flatten entries that match the code. ADR-0022 records the book split.

## 4. Medium findings

Fixed in a follow-up, each with a failing-first test and a claim where it changes behaviour:

| Finding                                                                | Fix                                                                                                                                                                                      |
| :--------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fill size parsed with `Number(accFillSz)` and returned as `z.number()` | Fill sizes stay `ScaledDecimal` end to end; `ExchangeOrderResult.sizeLots` is a decimal string. Order input stays an integer lot count, which is exact                                   |
| Flattening untracked (foreign) positions assumed their side            | In long/short mode OKX reports `pos` unsigned, so the side now comes from `posSide`. Every tracked position on the instrument is subtracted, not just the first, so none is closed twice |
| All requests in one flatten shared a signing timestamp                 | Every OKX request is signed at the time it is sent, so a slow flatten no longer outlives OKX's 30-second timestamp window                                                                |
| `check-claims` matched test names as text only                         | `pnpm test` writes Vitest's JSON report, and a claim passes only when its test ran and passed. Skipped, failing or deleted tests now fail the check                                      |
| The G2 runbook expected attached-stop fields the code omits            | `go-live-checklist.md` now describes the real attached stop, the 15s heartbeat, the Demo-only venue, and the Kill Switch lock                                                            |
| Duplicated step-up check and `"manual-execution"` literal              | One `stepUpDenied` helper serves all six human-gated routes and always rate-limits on the request IP. The literal is now `MANUAL_EXECUTION_STRATEGY_ID` in `@keel/core`                  |

## 5. Still open

| Item                                                                             | Risk                                                                                                                                                |
| :------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exchange-book equity is seeded from configured capital, not the real OKX balance | Live-Ramp position sizing can be wrong. Needs an owner decision on how to reconcile, because the ledger's high-water mark and drawdown are affected |
