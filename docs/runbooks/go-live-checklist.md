# Runbook: Go-Live Checklist (Human Gates G2 & G3)

Keel operates in **Paper** mode by default. Moving any strategy or AI advisor to real capital requires passing all quantitative gates on the **Promotion Ladder** ([ADR-0007](../adr/0007-promotion-ladder-gates-and-contamination-free-ai-eval.md)) and completing this checklist.

---

## Gate G2: Before Connecting an OKX Demo or Live API Key

- [ ] **IP Allow-List & Trade-Only Permissions**: In OKX Account Settings → API, create an API key bound to your home/Unraid egress IP address with **Trade** and **Read** permissions only (**Withdraw** permission MUST be disabled).
- [ ] **Account Mode Verification**: Confirm the OKX account/sub-account is set to **One-Way (Net) Position Mode** and **Isolated Margin** for `USDT-SWAP` contracts ([ADR-0001](../adr/0001-linear-perpetuals-domain-scope.md)).
- [ ] **Encryption at Rest & Vault Master Key**: Verify `KEEL_MASTER_KEY` is configured in your container environment (generate with: `openssl rand -base64 48`; minimum 32 characters, ≥ 12 distinct characters, non-placeholder entropy) and securely stored in your password manager. Keel strictly refuses vault operations if unset, < 32 characters, < 12 distinct characters, containing placeholder strings ('your-random', 'change-me'), or equal to the default string. Also ensure `/mnt/user/appdata/keel/data` permissions are strictly restricted (`0700`/`0600`).
- [ ] **Attached Protective Stop & DMS Verification in Demo**: Switch the Execution Mode to `Demo` (`OkxBroker` signs against the OKX demo account in `Demo` only; `Live-Ramp` and `Live` use the real-money account). Place an order from the Exchange Broker panel. This needs a fresh step-up and a strategy promoted to the `Demo` stage. Then confirm on the OKX Demo Web UI that:
  1. Every entry order creates an attached stop-loss algo order that triggers on **mark price** (`slTriggerPxType = mark`) and executes at market (`slOrdPx = -1`). Keel deliberately sends no `closeFraction` or `reduceOnly` inside `attachAlgoOrds`, because OKX V5 does not document them there; an attached stop closes its own position.
  2. Keel beats the dead-man's switch (`cancel-all-after`, 60-second countdown) every 15 seconds. Stopping the Keel container for >60 seconds cancels resting orders while the attached stop-loss stays active ([ADR-0006](../adr/0006-okx-attached-protective-stops-and-dead-mans-switch.md)).

---

## Gate G3: Before Unlocking `Live-Ramp` or `Live` Execution Mode

- [ ] **Promotion Ladder Evidence**:
  - Strategy has passed `Replay-Validated` (`≥ 150` trades, `DSR ≥ 0.90`, positive expectancy at `2.0x` cost stress, positive walk-forward out-of-sample expectancy, and benchmark outperformance against Buy & Hold and Random Entry baselines).
  - Strategy has completed `≥ 14 days / ≥ 30 trades` in `Forward Shadow` and `≥ 30 days / ≥ 50 trades` in `Paper Capital` with continuous mark-to-market drawdown strictly within limits and zero reconciliation errors.
  - Any enabled AI advisor has `≥ 50` uncontaminated forward disagreements beating the **Baseline Chooser** (`p < 0.10`).
- [ ] **Discord Alert Verification**: Click **Send Test Alert** in UI → Integrations and verify immediate delivery of a `CRITICAL` notification on your phone.
- [ ] **Kill Switch Drill**: Trigger the **Kill Switch** in `Demo` mode from your phone over the Cloudflare Tunnel and confirm all resting orders cancel and open positions flatten within 3 seconds. Confirm that new entries stay locked afterwards, and that re-arming requires a step-up.
- [ ] **Backup & Restore Drill**: Trigger a manual backup to `/backups` and verify [`restore-from-backup.md`](./restore-from-backup.md) has been tested.
- [ ] **Live-Ramp Sizing Tier**: Start at the `0.25x` `Live-Ramp` multiplier (`14 days / 20 trades`) before stepping to `0.50x` and `1.0x`.
