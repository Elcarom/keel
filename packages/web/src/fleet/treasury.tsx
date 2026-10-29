import { useState } from "react";
import { type FleetOverview } from "@keel/core";
import { Banner, Stat, api, card, errorOf, ghostBtn, input, money, primaryBtn } from "./ui.js";

// ---------------------------------------------------------------------------
// Treasury
// ---------------------------------------------------------------------------

export function TreasuryView({
  overview,
  reload
}: {
  overview: FleetOverview;
  reload: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [balance, setBalance] = useState("5000");
  const [deposits, setDeposits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const res = await api.fleet.createWallet({
      body: { name, startingBalanceUsdt: balance.trim() }
    });
    if (res.status === 200) {
      setName("");
      await reload();
    } else {
      setError(errorOf(res.body, "Check the name and amount"));
    }
  };

  const deposit = async (walletId: string) => {
    setError(null);
    const amount = (deposits[walletId] ?? "").trim();
    const res = await api.fleet.depositToWallet({
      params: { walletId },
      body: { amountUsdt: amount }
    });
    if (res.status === 200) {
      setDeposits((d) => ({ ...d, [walletId]: "" }));
      await reload();
    } else {
      setError(errorOf(res.body, "Enter a positive amount"));
    }
  };

  return (
    <div className="space-y-6">
      <Banner kind="info">
        These are paper wallets: play money for paper-trading boats. Real-money wallets arrive with
        live trading, which isn&apos;t part of this prototype.
      </Banner>
      {error && <Banner kind="danger">{error}</Banner>}
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {overview.wallets.map((w) => (
          <article key={w.walletId} className={card} data-testid="wallet-card">
            <div className="flex items-start justify-between">
              <h3 className="text-base font-bold text-slate-50">{w.name}</h3>
              <span className="rounded-full border border-sky-400/30 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-sky-200 uppercase">
                Paper
              </span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <Stat label="Free to allocate" value={money(w.availableUsdt)} />
              <Stat
                label="With boats"
                value={money(w.allocatedUsdt)}
                hint={`${w.botCount} boat${w.botCount === 1 ? "" : "s"}`}
              />
            </div>
            <div className="mt-4 flex gap-2">
              <input
                aria-label={`Add funds to ${w.name}`}
                className={`${input} font-mono-tabular`}
                inputMode="decimal"
                placeholder="Amount"
                value={deposits[w.walletId] ?? ""}
                onChange={(e) => setDeposits((d) => ({ ...d, [w.walletId]: e.target.value }))}
              />
              <button type="button" className={ghostBtn} onClick={() => void deposit(w.walletId)}>
                Add funds
              </button>
            </div>
          </article>
        ))}
        <form onSubmit={(e) => void create(e)} className={`${card} space-y-3 border-dashed`}>
          <h3 className="text-base font-bold text-slate-50">Open a new wallet</h3>
          <input
            className={input}
            placeholder="Name, e.g. Experiments"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <input
            className={`${input} font-mono-tabular`}
            inputMode="decimal"
            value={balance}
            onChange={(e) => setBalance(e.target.value)}
            required
          />
          <button type="submit" className={primaryBtn}>
            Open wallet
          </button>
        </form>
      </div>
    </div>
  );
}
