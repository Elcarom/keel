# Runbook: Go-Live Checklist (Human Gates G2 & G3)

Keel operates in **Paper** mode by default. Moving any strategy or AI advisor to real capital requires passing all quantitative gates on the **Promotion Ladder** ([ADR-0007](../adr/0007-promotion-ladder-gates-and-contamination-free-ai-eval.md)) and completing this checklist.

---

## Gate G2: Before Connecting an OKX Demo or Live API Key

- [ ] **IP Allow-List & Trade-Only Permissions**: In OKX Account Settings → API, create an API key bound to your home/Unraid egress IP address with **Trade** and **Read** permissions only (**Withdraw** permission MUST be disabled).
- [ ] **Account Mode Verification**: Confirm the OKX account/sub-account is set to **One-Way (Net) Position Mode** and **Isolated Margin** for `USDT-SWAP` contracts ([ADR-0001](../adr/0001-linear-perpetuals-domain-scope.md)).
- [ ] **Encryption at Rest**: Verify `/mnt/user/appdata/keel/data/secret.key` exists with `0600` permissions and a copy is stored in your password manager off-server.
- [ ] **Attached Protective Stop & DMS Verification in Demo**: Run the contract and fault-injection suite in `Demo` mode (`OkxDemoBroker`) and confirm on the OKX Demo Web UI that:
  1. Every entry order creates an attached mark-price stop-loss algo order (`closeFraction = 1`, `reduceOnly = true`).
  2. Stopping the Keel container for >60 seconds triggers `cancel-all-after` on resting limit orders while keeping the attached stop-loss order active ([ADR-0006](../adr/0006-okx-attached-protective-stops-and-dead-mans-switch.md)).

---

## Gate G3: Before Unlocking `Live-Ramp` or `Live` Execution Mode

- [ ] **Promotion Ladder Evidence**:
  - Strategy has passed `Replay-Validated` (`≥ 150` trades, `DSR ≥ 0.90`, `PBO ≤ 0.20`, positive expectancy at `2.0x` cost stress).
  - Strategy has completed `≥ 14 days` in `Forward Shadow` and `≥ 30 days / ≥ 50 trades` in `Paper Capital` with realized Sharpe inside the 90% bootstrap CI and zero reconciliation errors.
  - Any enabled AI advisor has `≥ 50` uncontaminated forward disagreements beating the **Baseline Chooser** (`p < 0.10`).
- [ ] **Discord Alert Verification**: Click **Send Test Alert** in UI → Integrations and verify immediate delivery of a `CRITICAL` notification on your phone.
- [ ] **Kill Switch Drill**: Trigger the **Kill Switch** in `Demo` mode from your phone over the Cloudflare Tunnel and confirm all resting orders cancel and open positions flatten within 3 seconds.
- [ ] **Backup & Restore Drill**: Trigger a manual backup to `/backups` and verify [`restore-from-backup.md`](./restore-from-backup.md) has been tested.
- [ ] **Live-Ramp Sizing Tier**: Start at the `0.25x` `Live-Ramp` multiplier (`14 days / 20 trades`) before stepping to `0.50x` and `1.0x`.
