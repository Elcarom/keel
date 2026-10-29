import { useState } from "react";
import { type Bot, type Proposition, type Wallet } from "@keel/core";
import { Banner, api, errorOf, ghostBtn, input, primaryBtn, usd } from "./ui.js";

export function LaunchForm({
  proposition,
  wallets,
  onLaunched,
  onCancel
}: {
  proposition: Proposition;
  wallets: readonly Wallet[];
  onLaunched: (bot: Bot) => Promise<void>;
  onCancel: () => void;
}) {
  const firstFunded = wallets.find((w) => Number(w.availableUsdt) >= 100) ?? wallets[0];
  const [name, setName] = useState(proposition.blueprint.name);
  const [walletId, setWalletId] = useState(firstFunded?.walletId ?? "");
  const wallet = wallets.find((w) => w.walletId === walletId);
  const suggested = wallet
    ? Math.max(100, Math.min(2000, Math.floor(Number(wallet.availableUsdt) / 4)))
    : 1000;
  const [allocation, setAllocation] = useState(String(suggested));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const res = await api.fleet.launchBot({
      params: { propositionId: proposition.propositionId },
      body: { name, walletId, allocationUsdt: allocation.trim(), mode: "paper" }
    });
    setSubmitting(false);
    if (res.status === 200) {
      await onLaunched(res.body.bot);
    } else {
      setError(errorOf(res.body));
    }
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="mt-4 space-y-3 rounded-xl border border-teal-400/30 bg-teal-400/5 p-4"
      data-testid="launch-form"
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-xs text-slate-400">
          Name
          <input
            data-testid="launch-name"
            className={`${input} mt-1`}
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label className="text-xs text-slate-400">
          Wallet
          <select
            data-testid="launch-wallet"
            className={`${input} mt-1`}
            value={walletId}
            onChange={(e) => setWalletId(e.target.value)}
          >
            {wallets.map((w) => (
              <option key={w.walletId} value={w.walletId}>
                {w.name} — {usd.format(Number(w.availableUsdt))} free
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-400">
          Stake (USDT)
          <input
            data-testid="launch-allocation"
            className={`${input} mt-1 font-mono-tabular`}
            inputMode="decimal"
            value={allocation}
            onChange={(e) => setAllocation(e.target.value)}
            required
          />
        </label>
      </div>
      <fieldset className="flex flex-wrap items-center gap-3 text-sm">
        <legend className="sr-only">Trading mode</legend>
        <label className="inline-flex items-center gap-2 text-slate-100">
          <input type="radio" name="mode" checked readOnly className="accent-teal-400" /> Paper
          trading
        </label>
        <label
          className="inline-flex items-center gap-2 text-slate-500"
          title="Live trading is not part of this prototype"
        >
          <input type="radio" name="mode" disabled /> Live trading{" "}
          <span className="text-xs">(not in this prototype)</span>
        </label>
      </fieldset>
      {error && <Banner kind="danger">{error}</Banner>}
      <div className="flex justify-end gap-2">
        <button type="button" className={ghostBtn} onClick={onCancel}>
          Not yet
        </button>
        <button
          type="submit"
          data-testid="launch-submit-btn"
          className={primaryBtn}
          disabled={submitting || !walletId}
        >
          {submitting ? "Launching…" : "Launch 🚢"}
        </button>
      </div>
    </form>
  );
}
