# ADR-0022: Separate Paper and Exchange Trading Books

## Status

Accepted

## Context and Decision

Audit 3 found the exchange broker persisting real positions and journals into the paper account and ledger, so the paper engine simulated exits on real positions, a paper flatten "closed" them locally, and live risk sizing read equity mixed with simulated PnL. We now keep two **Trading Books** in the same SQLite database: the paper book keeps its original tables (`ledger_entries`, `ledger_equity_snapshots`, `paper_positions`, `paper_orders`) and the exchange book gets parallel `exchange_*` tables, selected through `bookTables(book)` behind the unchanged `LedgerRepository` and `PaperAccountRepository` ports. Only `circuit_breaker_state` is shared, so a single circuit-breaker trip or Kill Switch stops both books. (GLOSSARY.md calls the exchange book the **Venue Book**.) The venue (demo vs real-money OKX account) is derived from the Execution Mode on every request, and a mode change that would switch venue is refused while the exchange book holds open positions, because demo and real-money positions live on different exchange accounts.

## Considered Options

- **Tag rows with a `book` column**: rejected; every existing query would need a filter, and one missed `WHERE` re-creates the original commingling.
- **A separate database file per book**: rejected; it breaks the single WAL file that backup/restore (ADR-0004) treats as the unit of consistency.

## Consequences

- The exchange ledger is seeded with the configured capital, not the venue balance. Before sizing any exchange entry, Keel reads the OKX USDT balance and refuses the entry (fail-closed) if it cannot, or if Venue Book equity exceeds that balance by more than `risk.portfolio.venueEquityDriftTolerancePct`. The recovery is a **Venue Capital Rebase**: a stepped-up capital adjustment, allowed only while the Venue Book is flat, that starts a new equity baseline. Resetting the high-water mark was chosen over keeping it, because a baseline that includes capital the venue never held would report a permanent false drawdown.
- Existing databases keep their paper data untouched; the exchange tables start empty.
