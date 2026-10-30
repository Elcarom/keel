import { useState } from "react";
import { ARCHETYPE_LABELS, blueprintMarkets, type Bot, type FleetOverview } from "@keel/core";
import {
  ArchetypeIcon,
  Banner,
  Chip,
  DIRECTION_LABELS,
  InventionRules,
  Sparkline,
  Stat,
  StatusChip,
  ago,
  api,
  card,
  coin,
  dangerBtn,
  errorOf,
  exitsLabel,
  ghostBtn,
  marketsLabel,
  money,
  price,
  primaryBtn,
  signedMoney,
  signedPct,
  tone,
  usd
} from "./ui.js";
import { HealthBadge, StandingBadge } from "./boat-page.js";
import { DutiesPanel } from "./logbook.js";

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

export function BotCard({
  bot,
  onAction,
  onOpen,
  busy
}: {
  bot: Bot;
  onAction: (bot: Bot, action: "pause" | "resume" | "retire" | "delete") => void;
  onOpen: (bot: Bot) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pnl = Number(bot.pnlUsdt);
  const positions = bot.openPositions;
  const many = blueprintMarkets(bot.blueprint).length > 1;
  return (
    <article
      data-testid="bot-card"
      className={`${card} flex flex-col gap-4 ${bot.status === "retired" ? "opacity-70" : ""}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-teal-400/10 p-2 text-teal-200">
            <ArchetypeIcon archetype={bot.blueprint.archetype} />
          </div>
          <div>
            <h3 data-testid="bot-name" className="text-lg leading-tight font-bold text-slate-50">
              <button
                type="button"
                data-testid="open-boat-btn"
                className="text-left hover:text-teal-200"
                onClick={() => onOpen(bot)}
              >
                {bot.name}
              </button>
            </h3>
            <p className="text-xs text-slate-400">
              {ARCHETYPE_LABELS[bot.blueprint.archetype]} ·{" "}
              <span data-testid="bot-markets">{marketsLabel(bot.blueprint)}</span> ·{" "}
              {DIRECTION_LABELS[bot.blueprint.direction]}
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <StatusChip status={bot.status} />
          {bot.status !== "retired" && <HealthBadge health={bot.health} />}
          <StandingBadge standing={bot.standing} />
          <span className="rounded-full border border-sky-400/30 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-sky-200 uppercase">
            Paper
          </span>
        </div>
      </header>

      <p className="text-sm text-slate-300 italic">“{bot.tagline}”</p>

      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[11px] tracking-wide text-slate-400 uppercase">Equity</div>
          <div className="font-mono-tabular text-2xl font-bold text-slate-50">
            {money(bot.equityUsdt)}
          </div>
        </div>
        <div className="text-right">
          <div
            className={`font-mono-tabular text-lg font-bold ${tone(pnl)}`}
            data-testid="bot-return"
          >
            {signedPct(bot.returnPct)}
          </div>
          <div className={`font-mono-tabular text-xs ${tone(pnl)}`}>
            {signedMoney(bot.pnlUsdt)} USDT
          </div>
        </div>
      </div>

      <Sparkline
        values={bot.equityCurve}
        format={(v) => money(v)}
        label={`${bot.name} equity after each trade`}
      />

      <div className="grid grid-cols-4 gap-3">
        <Stat label="Trades" value={String(bot.tradesCount)} />
        <Stat
          label="Win rate"
          value={bot.tradesCount > 0 ? `${Math.round(bot.winRate * 100)}%` : "—"}
        />
        <Stat label="Worst dip" value={`${bot.maxDrawdownPct.toFixed(1)}%`} />
        <Stat label="Stake" value={usd.format(Number(bot.allocationUsdt))} hint={bot.walletName} />
      </div>

      <div className="rounded-xl bg-[#0F1419] px-3 py-2 text-xs">
        {positions.length > 0 ? (
          <ul className="space-y-1" data-testid="bot-open-positions">
            {positions.map((pos) => (
              <li key={pos.instrumentId} className="text-slate-200">
                {many && (
                  <span className="font-semibold text-slate-100">{coin(pos.instrumentId)} </span>
                )}
                <span
                  className={
                    pos.side === "long"
                      ? "font-semibold text-emerald-300"
                      : "font-semibold text-rose-300"
                  }
                >
                  {pos.side === "long" ? "Long" : "Short"}
                </span>{" "}
                {pos.contracts} @ {price(pos.entryPrice)} · stop {price(pos.protectiveStopPrice)}
                {pos.takeProfitPrice ? ` · target ${price(pos.takeProfitPrice)}` : ""} ·{" "}
                <span className={tone(Number(pos.unrealizedPnlUsdt))}>
                  {signedMoney(pos.unrealizedPnlUsdt)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-slate-400">
            {bot.status === "running" ? "No position — watching the horizon" : "No position"} · last
            bar {ago(bot.lastBarAtMs)}
          </span>
        )}
      </div>

      {bot.statusReason && <p className="text-xs text-amber-200/80">{bot.statusReason}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {bot.status === "running" && (
          <button
            type="button"
            data-testid="bot-pause-btn"
            className={ghostBtn}
            disabled={busy}
            onClick={() => onAction(bot, "pause")}
          >
            Return to harbour
          </button>
        )}
        {bot.status === "paused" && (
          <button
            type="button"
            data-testid="bot-resume-btn"
            className={ghostBtn}
            disabled={busy}
            onClick={() => onAction(bot, "resume")}
          >
            Set sail
          </button>
        )}
        {bot.status !== "retired" && (
          <button
            type="button"
            data-testid="bot-retire-btn"
            className={ghostBtn}
            disabled={busy}
            onClick={() => onAction(bot, "retire")}
          >
            Retire
          </button>
        )}
        <button
          type="button"
          data-testid="bot-delete-btn"
          className={dangerBtn}
          disabled={busy}
          onClick={() => onAction(bot, "delete")}
        >
          Scuttle
        </button>
        <button
          type="button"
          className="ml-auto text-xs font-semibold text-teal-300 hover:text-teal-200"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Close logbook" : "Logbook"}
        </button>
      </div>

      {open && <BotLogbook bot={bot} />}
    </article>
  );
}

export function BotLogbook({ bot }: { bot: Bot }) {
  const b = bot.blueprint;
  return (
    <div className="space-y-4 border-t border-[#243140] pt-4 text-xs">
      <div>
        <h4 className="mb-2 font-semibold text-slate-200">Recent trades</h4>
        {bot.recentTrades.length === 0 ? (
          <p className="text-slate-400">No trades yet.</p>
        ) : (
          <table className="w-full text-left">
            <thead className="text-slate-400">
              <tr>
                <th className="py-1 font-medium">Coin</th>
                <th className="py-1 font-medium">Side</th>
                <th className="py-1 font-medium">Entry</th>
                <th className="py-1 font-medium">Exit</th>
                <th className="py-1 text-right font-medium">P&amp;L</th>
              </tr>
            </thead>
            <tbody className="font-mono-tabular">
              {bot.recentTrades.map((t) => (
                <tr
                  key={`${t.instrumentId}-${t.openedAtMs}-${t.side}`}
                  className="border-t border-[#1E2833]"
                >
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
        )}
      </div>
      <div>
        <h4 className="mb-2 font-semibold text-slate-200">How it sails</h4>
        <p className="text-slate-300">{b.rationale}</p>
        {b.invention ? (
          <div className="mt-2">
            <InventionRules rules={b.invention.rules} />
          </div>
        ) : (
          <p className="mt-2 font-mono-tabular text-slate-400">
            window {b.lookbackPeriod}h
            {b.archetype === "ma_crossover" || b.archetype === "trend_pullback"
              ? ` · fast ${b.fastPeriod}h`
              : ""}
            {b.archetype === "mean_reversion" ||
            b.archetype === "momentum" ||
            b.archetype === "trend_pullback"
              ? ` · trigger ${b.entryThreshold}`
              : ""}{" "}
            · stop {b.stopAtrMultiple}× ATR · target {b.rewardMultiple}R{exitsLabel(b)}
          </p>
        )}
      </div>
      {bot.backtest && (
        <div>
          <h4 className="mb-1 font-semibold text-slate-200">Sea trial (backtest)</h4>
          <p className="text-slate-300">
            {bot.backtest.headline} · score {bot.backtest.score}/100{" "}
            {bot.backtest.dataSource === "synthetic" ? "· synthetic data" : "· OKX history"}
          </p>
        </div>
      )}
    </div>
  );
}

const VIEW_KEY = "keel.fleet.view";

function readView(): "cards" | "table" {
  try {
    return window.localStorage.getItem(VIEW_KEY) === "table" ? "table" : "cards";
  } catch {
    return "cards";
  }
}

/** Every boat on one line each, for a fleet too big for cards. */
function FleetTable({ bots, onOpen }: { bots: readonly Bot[]; onOpen: (bot: Bot) => void }) {
  return (
    <div className={`${card} overflow-x-auto`} data-testid="fleet-table">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="text-xs text-slate-400">
          <tr>
            <th className="py-1.5 font-medium">Boat</th>
            <th className="py-1.5 font-medium">Coins</th>
            <th className="py-1.5 font-medium">Status</th>
            <th className="py-1.5 text-right font-medium">Return</th>
            <th className="py-1.5 text-right font-medium">P&amp;L (USDT)</th>
            <th className="py-1.5 text-right font-medium">Trades</th>
            <th className="py-1.5 text-right font-medium">Won</th>
            <th className="py-1.5 text-right font-medium">Worst dip</th>
          </tr>
        </thead>
        <tbody className="font-mono-tabular">
          {bots.map((b) => (
            <tr key={b.botId} className="border-t border-[#1E2833]">
              <td className="py-1.5">
                <button
                  type="button"
                  className="font-sans font-semibold text-teal-300 hover:text-teal-200"
                  onClick={() => onOpen(b)}
                >
                  {b.name}
                </button>
              </td>
              <td className="py-1.5 font-sans text-slate-300">{marketsLabel(b.blueprint)}</td>
              <td className="py-1.5 font-sans">
                <span className="flex gap-1.5">
                  <StatusChip status={b.status} />
                  {b.status !== "retired" && <HealthBadge health={b.health} />}
                </span>
              </td>
              <td className={`py-1.5 text-right ${tone(b.returnPct)}`}>{signedPct(b.returnPct)}</td>
              <td className={`py-1.5 text-right ${tone(Number(b.pnlUsdt))}`}>
                {signedMoney(b.pnlUsdt)}
              </td>
              <td className="py-1.5 text-right">{b.tradesCount}</td>
              <td className="py-1.5 text-right">
                {b.tradesCount > 0 ? `${Math.round(b.winRate * 100)}%` : "—"}
              </td>
              <td className="py-1.5 text-right">{b.maxDrawdownPct.toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FleetView({
  overview,
  reload,
  goShipyard,
  onOpenBoat
}: {
  overview: FleetOverview;
  reload: () => Promise<void>;
  goShipyard: () => void;
  onOpenBoat: (botId: string) => void;
}) {
  const [showRetired, setShowRetired] = useState(false);
  const [view, setView] = useState<"cards" | "table">(readView);
  const chooseView = (v: "cards" | "table") => {
    setView(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      // A remembered view is a convenience only
    }
  };
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "danger"; text: string } | null>(null);

  const active = overview.bots.filter((b) => b.status !== "retired");
  const retired = overview.bots.filter((b) => b.status === "retired");
  const shown = showRetired ? retired : active;
  const pnl = Number(overview.totals.pnlUsdt);

  const act = async (bot: Bot, action: "pause" | "resume" | "retire" | "delete") => {
    if (
      action === "delete" &&
      !window.confirm(
        `Scuttle ${bot.name}? Its position is closed, its stake goes back to the wallet and its logbook is deleted.`
      )
    )
      return;
    if (
      action === "retire" &&
      !window.confirm(
        `Retire ${bot.name}? Its position is closed and its equity goes back to ${bot.walletName}.`
      )
    )
      return;
    setBusyId(bot.botId);
    setMessage(null);
    const params = { botId: bot.botId };
    const res =
      action === "pause"
        ? await api.fleet.pauseBot({ params, body: {} })
        : action === "resume"
          ? await api.fleet.resumeBot({ params, body: {} })
          : action === "retire"
            ? await api.fleet.retireBot({ params, body: {} })
            : await api.fleet.deleteBot({ params, body: {} });
    setBusyId(null);
    if (res.status === 200) {
      const verb = {
        pause: "is back in harbour",
        resume: "has set sail",
        retire: "has retired",
        delete: "has been scuttled"
      }[action];
      setMessage({ kind: "ok", text: `${bot.name} ${verb}.` });
    } else {
      setMessage({ kind: "danger", text: errorOf(res.body) });
    }
    await reload();
  };

  return (
    <div className="space-y-6">
      {overview.killSwitchActive && (
        <Banner kind="danger" testId="kill-switch-banner">
          <strong>Kill Switch is on.</strong> Every position was closed and no boat can open a new
          one until it is reset in the Engine Room. {overview.killSwitchReason}
        </Banner>
      )}
      {!overview.schedulerRunning && active.some((b) => b.status === "running") && (
        <Banner kind="warn" testId="scheduler-off-banner">
          <strong>The tide isn&apos;t running.</strong> Boats only trade when the scheduler fetches
          new hourly bars. Set <code className="font-mono-tabular">KEEL_ENABLE_SCHEDULER=true</code>{" "}
          on the container and restart it.
        </Banner>
      )}
      {message && <Banner kind={message.kind}>{message.text}</Banner>}

      <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <div className={card}>
          <Stat label="Fleet equity" value={money(overview.totals.equityUsdt)} />
        </div>
        <div className={card}>
          <Stat
            label="Profit & loss"
            value={`${signedMoney(overview.totals.pnlUsdt)} USDT`}
            valueClass={tone(pnl)}
            hint={signedPct(overview.totals.returnPct)}
          />
        </div>
        <div className={card}>
          <Stat
            label="Boats at sea"
            value={String(overview.totals.activeBots)}
            hint={`${active.length} in the fleet`}
          />
        </div>
        <div className={card}>
          <Stat
            label="Open positions"
            value={String(overview.totals.openPositions)}
            hint="All paper trading"
          />
        </div>
      </section>

      {overview.equityHistory.length >= 2 && (
        <section className={card} data-testid="fleet-equity-chart">
          <Sparkline
            values={overview.equityHistory.map((p) => Number(p.equityUsdt))}
            format={(v) => money(v)}
            label="Fleet equity, day by day"
            height={72}
          />
          <p className="mt-1 text-xs text-slate-400">Fleet equity, day by day</p>
        </section>
      )}

      <DutiesPanel duties={overview.duties} compact />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <Chip selected={!showRetired} onClick={() => setShowRetired(false)}>
            Active ({active.length})
          </Chip>
          <Chip selected={showRetired} onClick={() => setShowRetired(true)}>
            Retired ({retired.length})
          </Chip>
          <span className="mx-1 hidden w-px bg-[#2B3947] sm:block" aria-hidden />
          <Chip selected={view === "cards"} onClick={() => chooseView("cards")} testId="view-cards">
            Cards
          </Chip>
          <Chip selected={view === "table"} onClick={() => chooseView("table")} testId="view-table">
            Table
          </Chip>
        </div>
        <button type="button" className={primaryBtn} onClick={goShipyard}>
          + Design new boats
        </button>
      </div>

      {shown.length === 0 ? (
        <div className={`${card} py-12 text-center`} data-testid="fleet-empty">
          <p className="text-lg font-semibold text-slate-100">
            {showRetired ? "No boats have retired yet." : "The harbour is quiet."}
          </p>
          {!showRetired && (
            <p className="mt-1 text-sm text-slate-400">
              Head to the Shipyard, tell Claude what you&apos;re after, and launch the best of what
              comes back.
            </p>
          )}
        </div>
      ) : view === "table" ? (
        <FleetTable bots={shown} onOpen={(b) => onOpenBoat(b.botId)} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
          {shown.map((bot) => (
            <BotCard
              key={bot.botId}
              bot={bot}
              busy={busyId === bot.botId}
              onAction={(b, a) => void act(b, a)}
              onOpen={(b) => onOpenBoat(b.botId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
