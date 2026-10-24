# Runbook: Incident Response

Plain, deterministic steps when a `CRITICAL` or `WARNING` alert fires on Discord or in Mission Control.

---

## 1. Immediate Triage: Flatten & Halt (`Kill Switch`)

If you suspect abnormal execution, stale market data, or a reconciliation mismatch while in `Demo`, `Live-Ramp`, or `Live`:

1. Open **Keel → Mission Control** on your phone or browser and press **KILL SWITCH (Flatten & Halt)**.
2. If the dashboard is unreachable, log into the **OKX mobile app / web UI** directly and click **Close All** on the Positions tab and **Cancel All** on Open Orders.
3. Stop the Unraid container (`docker stop keel`) if the process is misbehaving; OKX's 60-second **Dead-Man's Switch** (`cancel-all-after`) will automatically cancel any remaining resting entry orders while leaving attached mark-price **Protective Stops** intact.

---

## 2. Specific Incident Playbooks

### A. `CRITICAL: Reconciliation Mismatch`

- **Cause**: Exchange position, contract size, or attached Protective Stop on OKX differed from Keel's local SQLite ledger during periodic reconciliation.
- **Automatic System Action**: Keel adopts the OKX exchange state as the source of truth, ensures a mark-price Protective Stop covers 100% of any open position (or flattens if stop attachment fails), and pauses new entries on that instrument.
- **Operator Action**: Inspect the **Positions & Orders** and **Decision Journal** pages to verify whether an external manual trade, partial fill during a disconnect, or liquidation occurred. Acknowledge the reconciliation record before re-enabling the strategy.

### B. `CRITICAL: Market-Data Staleness Flatten`

- **Cause**: Ticker or candle WebSocket stream exceeded the maximum staleness age threshold and REST fallback also failed.
- **Automatic System Action**: Keel halts new entries and executes the configured staleness fail-safe policy.
- **Operator Action**: Check `/api/v1/system/status`, the **Data** page, and OKX System Status (`status.okx.com`). Once WebSocket feeds recover and the automatic gap-healer backfills missed Confirmed Bars, verify zero gaps remain before resuming.

### C. `WARNING: AI Budget Exhausted / Gateway Timeout`

- **Cause**: Monthly (`$15`) or daily (`$0.75`) Gemini budget reached `100%`, or Gemini returned errors/timeouts.
- **Automatic System Action**: The **LLM Gateway** automatically degrades to the deterministic **Baseline Chooser** (`ADR-0007`). Risk limits, stops, and execution are unaffected.
- **Operator Action**: None required for safety. Review **AI Control** if you wish to inspect prompt logs or adjust the monthly budget cap.
