import { type FleetDutyStatus, type FleetOverview } from "@keel/core";
import { ago, card, coin, price, signedMoney, tone } from "./ui.js";

const DUTY_HINTS: Record<FleetDutyStatus["duty"], string> = {
  digest: "A Discord summary of every boat, once a day",
  driftWatch: "Docks a boat doing clearly worse than its sea trial expected",
  autopilot: "Launches seaworthy, original propositions from the Autopilot wallet",
  nightShift: "Draws up a Shipyard brief on a schedule",
  rebalance: "Evens out stakes between a wallet's flat boats every Monday"
};

/** What each unattended duty is doing. Settings live in the Engine Room. */
export function DutiesPanel({
  duties,
  compact = false
}: {
  duties: readonly FleetDutyStatus[];
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="duties-strip">
        <span className="text-slate-400">Autonomy:</span>
        {duties.map((d) => (
          <span
            key={d.duty}
            title={d.note ?? DUTY_HINTS[d.duty]}
            className={`rounded-full border px-2 py-0.5 font-semibold ${
              d.enabled ? "border-teal-400/40 text-teal-200" : "border-[#2B3947] text-slate-500"
            }`}
          >
            {d.enabled ? "●" : "○"} {d.label}
          </span>
        ))}
      </div>
    );
  }
  return (
    <section className={card} data-testid="duties-panel">
      <h2 className="text-base font-bold text-slate-100">Unattended duties</h2>
      <p className="mb-3 text-xs text-slate-400">
        Fixed rules that run after every scheduler step, on paper only. Switch them on or off under
        Engine Room → Autonomy.
      </p>
      <ul className="divide-y divide-[#1E2833]">
        {duties.map((d) => (
          <li
            key={d.duty}
            className="flex flex-wrap items-baseline justify-between gap-2 py-2"
            data-testid={`duty-${d.duty}`}
          >
            <div>
              <span
                className={`text-sm font-semibold ${d.enabled ? "text-slate-100" : "text-slate-500"}`}
              >
                {d.label}
              </span>{" "}
              <span className="text-xs text-slate-400">— {DUTY_HINTS[d.duty]}</span>
              {d.note && <p className="text-xs text-slate-300">{d.note}</p>}
            </div>
            <span className="text-xs text-slate-400">
              {d.enabled ? "On" : "Off"} · last ran {ago(d.lastRunMs)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The ship's log: what the duties did and every boat's recent trades in one place. */
export function LogbookView({
  overview,
  onOpenBoat
}: {
  overview: FleetOverview;
  onOpenBoat: (botId: string) => void;
}) {
  const trades = overview.bots
    .flatMap((b) => b.recentTrades.map((t) => ({ ...t, botId: b.botId, boat: b.name })))
    .sort((a, b) => (b.closedAtMs ?? b.openedAtMs) - (a.closedAtMs ?? a.openedAtMs))
    .slice(0, 60);
  return (
    <div className="space-y-6" data-testid="logbook-view">
      <DutiesPanel duties={overview.duties} />
      <section className={card}>
        <h2 className="mb-3 text-base font-bold text-slate-100">Recent trades across the fleet</h2>
        {trades.length === 0 ? (
          <p className="text-sm text-slate-400">No trades yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="text-xs text-slate-400">
                <tr>
                  <th className="py-1 font-medium">When</th>
                  <th className="py-1 font-medium">Boat</th>
                  <th className="py-1 font-medium">Coin</th>
                  <th className="py-1 font-medium">Side</th>
                  <th className="py-1 font-medium">Entry</th>
                  <th className="py-1 font-medium">Exit</th>
                  <th className="py-1 text-right font-medium">P&amp;L</th>
                </tr>
              </thead>
              <tbody className="font-mono-tabular">
                {trades.map((t) => (
                  <tr
                    key={`${t.botId}-${t.instrumentId}-${t.openedAtMs}`}
                    className="border-t border-[#1E2833]"
                  >
                    <td className="py-1 text-slate-400">{ago(t.closedAtMs ?? t.openedAtMs)}</td>
                    <td className="py-1">
                      <button
                        type="button"
                        className="font-sans font-semibold text-teal-300 hover:text-teal-200"
                        onClick={() => onOpenBoat(t.botId)}
                      >
                        {t.boat}
                      </button>
                    </td>
                    <td className="py-1">{coin(t.instrumentId)}</td>
                    <td className="py-1">{t.side}</td>
                    <td className="py-1">{price(t.entryPrice)}</td>
                    <td className="py-1">{t.exitPrice ? price(t.exitPrice) : "open"}</td>
                    <td className={`py-1 text-right ${tone(Number(t.pnlUsdt))}`}>
                      {signedMoney(t.pnlUsdt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
