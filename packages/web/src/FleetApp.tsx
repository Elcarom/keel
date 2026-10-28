import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ARCHETYPE_LABELS,
  BOT_ARCHETYPES,
  FLEET_INSTRUMENTS,
  keelApiContract,
  type Bot,
  type BotArchetype,
  type DesignBatch,
  type DesignBrief,
  type FleetInstrument,
  type FleetOverview,
  type Proposition,
  type Verdict,
  type Wallet
} from "@keel/core";
import { initClient } from "@ts-rest/core";

const api = initClient(keelApiContract, { baseUrl: "", baseHeaders: {} });

type Tab = "fleet" | "shipyard" | "treasury";

function errorOf(body: unknown, fallback = "Something went wrong"): string {
  if (body !== null && typeof body === "object" && "error" in body) {
    const e = (body as { error: unknown }).error;
    if (typeof e === "string") return e;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Formatting (display only: amounts arrive as exact decimal strings)
// ---------------------------------------------------------------------------

const usd = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function money(value: string | number): string {
  return `${usd.format(Number(value))} USDT`;
}

function signedMoney(value: string | number): string {
  const n = Number(value);
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${usd.format(Math.abs(n))}`;
}

function signedPct(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}%`;
}

function tone(n: number): string {
  return n > 0 ? "text-emerald-300" : n < 0 ? "text-rose-300" : "text-slate-300";
}

function ago(ms: number | null): string {
  if (ms === null) return "never";
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function pair(instrumentId: string): string {
  return instrumentId.replace("-USDT-SWAP", " perp");
}

const DIRECTION_LABELS = { both: "Long & short", long_only: "Long only", short_only: "Short only" };

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function ArchetypeIcon({
  archetype,
  className = "h-5 w-5"
}: {
  archetype: BotArchetype;
  className?: string;
}) {
  const common = {
    className,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true
  };
  switch (archetype) {
    case "breakout":
      return (
        <svg {...common}>
          <path d="M3 15h7v-5h4v5h7" />
          <path d="M12 3v5M9.5 5.5 12 3l2.5 2.5" />
        </svg>
      );
    case "mean_reversion":
      return (
        <svg {...common}>
          <path d="M2 12c2.5-6 5-6 7.5 0s5 6 7.5 0 3-3 5-3" />
          <path d="M2 12h20" strokeDasharray="2 3" />
        </svg>
      );
    case "momentum":
      return (
        <svg {...common}>
          <path d="M12 3v15M12 3l7 11h-7M12 5 6 14h6" />
          <path d="M4 19c2.5 1.5 13.5 1.5 16 0" />
        </svg>
      );
    case "ma_crossover":
      return (
        <svg {...common}>
          <path d="M3 17c5 0 7-10 18-10" />
          <path d="M3 7c6 0 9 10 18 10" />
        </svg>
      );
    case "trend_pullback":
      return (
        <svg {...common}>
          <circle cx="12" cy="5" r="2" />
          <path d="M12 7v13M8 11h8M5 15c0 3 3 5 7 5s7-2 7-5" />
        </svg>
      );
  }
}

function KeelMark() {
  return (
    <svg aria-label="Keel" className="h-8 w-8" viewBox="0 0 32 32" fill="none">
      <path
        d="M5 11C5 18.5 10.5 23 16 25C21.5 23 27 18.5 27 11H5Z"
        stroke="#2DD4BF"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <line
        x1="16"
        y1="5"
        x2="16"
        y2="28"
        stroke="#F59E0B"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

const VERDICTS: Record<Verdict, { label: string; className: string; glyph: string }> = {
  seaworthy: {
    label: "Seaworthy",
    glyph: "✓",
    className: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
  },
  promising: {
    label: "Promising",
    glyph: "↗",
    className: "border-sky-400/40 bg-sky-400/10 text-sky-200"
  },
  choppy: {
    label: "Choppy waters",
    glyph: "~",
    className: "border-amber-400/40 bg-amber-400/10 text-amber-200"
  },
  sinks: {
    label: "Takes on water",
    glyph: "↓",
    className: "border-rose-400/40 bg-rose-400/10 text-rose-200"
  }
};

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const v = VERDICTS[verdict];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${v.className}`}
    >
      <span aria-hidden>{v.glyph}</span>
      {v.label}
    </span>
  );
}

const STATUS_CHIPS: Record<Bot["status"], { label: string; dot: string; text: string }> = {
  running: { label: "At sea", dot: "bg-teal-300 animate-pulse", text: "text-teal-200" },
  paused: { label: "In harbour", dot: "bg-amber-300", text: "text-amber-200" },
  retired: { label: "Retired", dot: "bg-slate-500", text: "text-slate-400" }
};

function StatusChip({ status }: { status: Bot["status"] }) {
  const s = STATUS_CHIPS[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${s.text}`}>
      <span className={`h-2 w-2 rounded-full ${s.dot}`} aria-hidden />
      {s.label}
    </span>
  );
}

/** Single-series line with a hover readout; the card's title names the series. */
function Sparkline({
  values,
  format,
  label,
  height = 44
}: {
  values: readonly number[];
  format: (v: number) => string;
  label: string;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const width = 240;
  if (values.length < 2) {
    return (
      <div className="flex items-center text-[11px] text-slate-500" style={{ height }}>
        Not enough voyage yet to draw a course
      </div>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 4;
  const x = (i: number) => (i / (values.length - 1)) * width;
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const first = values[0] ?? 0;
  const last = values[values.length - 1] ?? 0;
  const stroke = last >= first ? "#5EEAD4" : "#FDA4AF";
  const hv = hover !== null ? values[hover] : undefined;

  return (
    <div className="relative">
      <svg
        ref={ref}
        role="img"
        aria-label={`${label}: from ${format(first)} to ${format(last)}`}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="block w-full cursor-crosshair"
        style={{ height }}
        onMouseMove={(e) => {
          const rect = ref.current?.getBoundingClientRect();
          if (!rect) return;
          const ratio = (e.clientX - rect.left) / rect.width;
          setHover(
            Math.max(0, Math.min(values.length - 1, Math.round(ratio * (values.length - 1))))
          );
        }}
        onMouseLeave={() => setHover(null)}
      >
        <line
          x1="0"
          x2={width}
          y1={y(first)}
          y2={y(first)}
          stroke="#334155"
          strokeWidth="1"
          strokeDasharray="3 4"
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          points={points}
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {hover !== null && hv !== undefined && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1="0"
            y2={height}
            stroke="#94A3B8"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {hover !== null && hv !== undefined && (
        <div
          className="pointer-events-none absolute -top-7 rounded-md border border-slate-600 bg-slate-900 px-2 py-0.5 text-[11px] font-mono-tabular text-slate-100 shadow"
          style={{
            left: `clamp(0px, calc(${(hover / (values.length - 1)) * 100}% - 40px), calc(100% - 90px))`
          }}
        >
          {format(hv)}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  valueClass = "text-slate-100",
  hint
}: {
  label: string;
  value: string;
  valueClass?: string | undefined;
  hint?: string | undefined;
}) {
  return (
    <div>
      <div className="text-[11px] tracking-wide text-slate-400 uppercase">{label}</div>
      <div className={`font-mono-tabular text-sm font-semibold ${valueClass}`}>{value}</div>
      {hint && <div className="text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}

function Banner({
  kind,
  children,
  testId
}: {
  kind: "warn" | "danger" | "info" | "ok";
  children: React.ReactNode;
  testId?: string;
}) {
  const styles = {
    warn: "border-amber-400/40 bg-amber-400/10 text-amber-100",
    danger: "border-rose-400/50 bg-rose-500/10 text-rose-100",
    info: "border-sky-400/30 bg-sky-400/10 text-sky-100",
    ok: "border-emerald-400/40 bg-emerald-400/10 text-emerald-100"
  };
  return (
    <div data-testid={testId} className={`rounded-xl border px-4 py-3 text-sm ${styles[kind]}`}>
      {children}
    </div>
  );
}

const card = "rounded-2xl border border-[#243140] bg-[#141B23] p-5 shadow-sm";
const input =
  "w-full rounded-lg border border-[#2B3947] bg-[#0F1419] px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-teal-400 focus:outline-none";
const primaryBtn =
  "rounded-lg bg-teal-500 px-4 py-2 text-sm font-semibold text-[#06201D] hover:bg-teal-400 disabled:cursor-not-allowed disabled:opacity-50";
const ghostBtn =
  "rounded-lg border border-[#2B3947] px-3 py-1.5 text-xs font-semibold text-slate-200 hover:border-slate-400 disabled:opacity-50";
const dangerBtn =
  "rounded-lg border border-rose-500/40 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/15";

function Chip({
  selected,
  onClick,
  children,
  testId
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={selected}
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition ${
        selected
          ? "border-teal-400 bg-teal-400/15 text-teal-100"
          : "border-[#2B3947] text-slate-300 hover:border-slate-400"
      }`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

function BotCard({
  bot,
  onAction,
  busy
}: {
  bot: Bot;
  onAction: (bot: Bot, action: "pause" | "resume" | "retire" | "delete") => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pnl = Number(bot.pnlUsdt);
  const pos = bot.openPosition;
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
              {bot.name}
            </h3>
            <p className="text-xs text-slate-400">
              {ARCHETYPE_LABELS[bot.blueprint.archetype]} · {pair(bot.blueprint.instrumentId)} ·{" "}
              {DIRECTION_LABELS[bot.blueprint.direction]}
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <StatusChip status={bot.status} />
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
        {pos ? (
          <span className="text-slate-200">
            <span
              className={
                pos.side === "long"
                  ? "font-semibold text-emerald-300"
                  : "font-semibold text-rose-300"
              }
            >
              {pos.side === "long" ? "Long" : "Short"}
            </span>{" "}
            {pos.contracts} @ {usd.format(Number(pos.entryPrice))} · stop{" "}
            {usd.format(Number(pos.protectiveStopPrice))}
            {pos.takeProfitPrice
              ? ` · target ${usd.format(Number(pos.takeProfitPrice))}`
              : ""} ·{" "}
            <span className={tone(Number(pos.unrealizedPnlUsdt))}>
              {signedMoney(pos.unrealizedPnlUsdt)}
            </span>
          </span>
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

function BotLogbook({ bot }: { bot: Bot }) {
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
                <th className="py-1 font-medium">Side</th>
                <th className="py-1 font-medium">Entry</th>
                <th className="py-1 font-medium">Exit</th>
                <th className="py-1 text-right font-medium">P&amp;L</th>
              </tr>
            </thead>
            <tbody className="font-mono-tabular">
              {bot.recentTrades.map((t) => (
                <tr key={`${t.openedAtMs}-${t.side}`} className="border-t border-[#1E2833]">
                  <td className="py-1">{t.side}</td>
                  <td className="py-1">{usd.format(Number(t.entryPrice))}</td>
                  <td className="py-1">{t.exitPrice ? usd.format(Number(t.exitPrice)) : "open"}</td>
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
          · stop {b.stopAtrMultiple}× ATR · target {b.rewardMultiple}R
        </p>
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

function FleetView({
  overview,
  reload,
  goShipyard
}: {
  overview: FleetOverview;
  reload: () => Promise<void>;
  goShipyard: () => void;
}) {
  const [showRetired, setShowRetired] = useState(false);
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

      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-2">
          <Chip selected={!showRetired} onClick={() => setShowRetired(false)}>
            Active ({active.length})
          </Chip>
          <Chip selected={showRetired} onClick={() => setShowRetired(true)}>
            Retired ({retired.length})
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
      ) : (
        <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
          {shown.map((bot) => (
            <BotCard
              key={bot.botId}
              bot={bot}
              busy={busyId === bot.botId}
              onAction={(b, a) => void act(b, a)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shipyard
// ---------------------------------------------------------------------------

const ARCHETYPE_HINTS: Record<BotArchetype, string> = {
  breakout: "Charges through when price escapes its range",
  mean_reversion: "Fades stretched moves back to the mean",
  momentum: "Rides strong impulses while they last",
  ma_crossover: "Changes tack when averages cross",
  trend_pullback: "Follows the trend, boards on the dips"
};

function BriefForm({
  onDesigned,
  designer
}: {
  onDesigned: () => Promise<void>;
  designer: FleetOverview["designer"];
}) {
  const [brief, setBrief] = useState<DesignBrief>({
    instruments: ["BTC-USDT-SWAP", "ETH-USDT-SWAP"],
    styles: [],
    riskAppetite: "balanced",
    direction: "any",
    count: 4,
    notes: ""
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleInstrument = (id: FleetInstrument) =>
    setBrief((b) => {
      const has = b.instruments.includes(id);
      const next = has ? b.instruments.filter((i) => i !== id) : [...b.instruments, id];
      return next.length === 0 ? b : { ...b, instruments: next };
    });
  const toggleStyle = (s: BotArchetype) =>
    setBrief((b) => ({
      ...b,
      styles: b.styles.includes(s) ? b.styles.filter((x) => x !== s) : [...b.styles, s]
    }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const res = await api.fleet.designBots({ body: brief });
    setSubmitting(false);
    if (res.status === 200) {
      await onDesigned();
    } else {
      setError(errorOf(res.body));
    }
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className={`${card} space-y-5`}
      data-testid="design-brief-form"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-50">Draw up a brief</h2>
          <p className="text-sm text-slate-400">
            Claude drafts the propositions; Keel backtests every one on a year of hourly data and
            ranks them.
          </p>
        </div>
        <span
          data-testid="designer-source"
          className={`rounded-full border px-3 py-1 text-xs font-semibold ${
            designer.source === "claude"
              ? "border-teal-400/40 text-teal-200"
              : "border-amber-400/40 text-amber-200"
          }`}
        >
          {designer.source === "claude"
            ? `Designer: Claude (${designer.model})`
            : "Designer: sample mode (no Anthropic key)"}
        </span>
      </div>

      <fieldset>
        <legend className="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
          Waters
        </legend>
        <div className="flex flex-wrap gap-2">
          {FLEET_INSTRUMENTS.map((id) => (
            <Chip
              key={id}
              selected={brief.instruments.includes(id)}
              onClick={() => toggleInstrument(id)}
            >
              {pair(id)}
            </Chip>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
          Styles{" "}
          <span className="tracking-normal normal-case text-slate-500">
            — pick none to let Claude surprise you
          </span>
        </legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {BOT_ARCHETYPES.map((s) => {
            const selected = brief.styles.includes(s);
            return (
              <button
                key={s}
                type="button"
                aria-pressed={selected}
                data-testid={`style-${s}`}
                onClick={() => toggleStyle(s)}
                className={`flex items-start gap-3 rounded-xl border p-3 text-left transition ${
                  selected
                    ? "border-teal-400 bg-teal-400/10"
                    : "border-[#2B3947] hover:border-slate-400"
                }`}
              >
                <span className={selected ? "text-teal-200" : "text-slate-400"}>
                  <ArchetypeIcon archetype={s} />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-slate-100">
                    {ARCHETYPE_LABELS[s]}
                  </span>
                  <span className="block text-xs text-slate-400">{ARCHETYPE_HINTS[s]}</span>
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="grid gap-5 md:grid-cols-3">
        <fieldset>
          <legend className="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
            Appetite for risk
          </legend>
          <div className="flex flex-wrap gap-2">
            {(["cautious", "balanced", "bold"] as const).map((r) => (
              <Chip
                key={r}
                selected={brief.riskAppetite === r}
                onClick={() => setBrief((b) => ({ ...b, riskAppetite: r }))}
              >
                {r[0]?.toUpperCase()}
                {r.slice(1)}
              </Chip>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
            Direction
          </legend>
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["any", "Either way"],
                ["long_only", "Long only"],
                ["short_only", "Short only"]
              ] as const
            ).map(([d, label]) => (
              <Chip
                key={d}
                selected={brief.direction === d}
                onClick={() => setBrief((b) => ({ ...b, direction: d }))}
              >
                {label}
              </Chip>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
            How many ideas
          </legend>
          <div className="flex flex-wrap gap-2">
            {[2, 3, 4, 5, 6].map((n) => (
              <Chip
                key={n}
                selected={brief.count === n}
                onClick={() => setBrief((b) => ({ ...b, count: n }))}
              >
                {n}
              </Chip>
            ))}
          </div>
        </fieldset>
      </div>

      <div>
        <label
          htmlFor="brief-notes"
          className="mb-2 block text-xs font-semibold tracking-wide text-slate-400 uppercase"
        >
          Anything else for Claude?
        </label>
        <textarea
          id="brief-notes"
          data-testid="brief-notes"
          rows={3}
          maxLength={1000}
          value={brief.notes}
          onChange={(e) => setBrief((b) => ({ ...b, notes: e.target.value }))}
          placeholder="e.g. something calm that holds trades for a day or two, or a quick boat that only trades ETH breakouts"
          className={input}
        />
      </div>

      {error && <Banner kind="danger">{error}</Banner>}

      <div className="flex justify-end">
        <button
          type="submit"
          data-testid="design-submit-btn"
          className={primaryBtn}
          disabled={submitting}
        >
          {submitting ? "Claude is sketching hulls…" : "Draft propositions"}
        </button>
      </div>
    </form>
  );
}

function LaunchForm({
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

function PropositionCard({
  proposition,
  wallets,
  reload,
  onLaunched
}: {
  proposition: Proposition;
  wallets: readonly Wallet[];
  reload: () => Promise<void>;
  onLaunched: (bot: Bot) => Promise<void>;
}) {
  const [launching, setLaunching] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  const b = proposition.blueprint;
  const a = proposition.assessment;
  const rankLabel =
    proposition.rank === 1
      ? "Flagship pick"
      : proposition.rank !== null
        ? `#${proposition.rank}`
        : null;

  const discard = async () => {
    await api.fleet.discardProposition({
      params: { propositionId: proposition.propositionId },
      body: {}
    });
    await reload();
  };

  return (
    <article
      data-testid="proposition-card"
      className={`${card} ${proposition.rank === 1 ? "border-amber-400/40" : ""} ${proposition.status === "discarded" ? "opacity-50" : ""}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-slate-700/40 p-2 text-slate-200">
            <ArchetypeIcon archetype={b.archetype} />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 data-testid="proposition-name" className="text-base font-bold text-slate-50">
                {b.name}
              </h3>
              {rankLabel && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${proposition.rank === 1 ? "bg-amber-400/20 text-amber-200" : "bg-slate-700/60 text-slate-300"}`}
                >
                  {rankLabel}
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400">
              {ARCHETYPE_LABELS[b.archetype]} · {pair(b.instrumentId)} ·{" "}
              {DIRECTION_LABELS[b.direction]}
            </p>
            <p className="mt-1 text-sm text-slate-300 italic">“{b.tagline}”</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          {proposition.status === "assessing" && (
            <span
              className="inline-flex items-center gap-2 text-xs text-sky-200"
              data-testid="proposition-assessing"
            >
              <span className="h-2 w-2 animate-pulse rounded-full bg-sky-300" /> On the slipway:
              backtesting…
            </span>
          )}
          {a && <VerdictBadge verdict={a.verdict} />}
          {a && (
            <span
              className="font-mono-tabular text-xs text-slate-300"
              data-testid="proposition-score"
            >
              score {a.score}/100
            </span>
          )}
        </div>
      </div>

      {proposition.status === "failed" && (
        <p className="mt-3 text-sm text-rose-200">The sea trial failed: {proposition.error}</p>
      )}

      {a && (
        <div className="mt-4 grid gap-4 md:grid-cols-[1fr_1.2fr]">
          <div>
            <p className="text-sm font-medium text-slate-200">{a.headline}</p>
            <div className="mt-3 grid grid-cols-3 gap-3">
              <Stat
                label="Return"
                value={signedPct(a.returnPct)}
                valueClass={tone(a.returnPct)}
                hint={`hold: ${signedPct(a.buyAndHoldReturnPct)}`}
              />
              <Stat label="Worst dip" value={`${a.maxDrawdownPct.toFixed(1)}%`} />
              <Stat
                label="Trades"
                value={String(a.totalTrades)}
                hint={a.totalTrades > 0 ? `${Math.round(a.winRate * 100)}% wins` : undefined}
              />
              <Stat label="Sharpe" value={a.sharpeRatio.toFixed(2)} />
              <Stat
                label="Luck-adjusted"
                value={`${Math.round(a.deflatedSharpeRatio * 100)}%`}
                hint="deflated Sharpe"
              />
              <Stat
                label="Research gate"
                value={a.gatePassed ? "Passed" : "Not yet"}
                valueClass={a.gatePassed ? "text-emerald-300" : "text-slate-300"}
              />
            </div>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between text-[11px] text-slate-400">
              <span>Backtest equity, % from start</span>
              <span>{a.dataSource === "synthetic" ? "⚠ synthetic data" : "OKX history"}</span>
            </div>
            <Sparkline
              values={a.equityCurvePct}
              format={(v) => signedPct(v)}
              label={`${b.name} backtest equity`}
              height={72}
            />
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {proposition.status === "ranked" && !launching && (
          <button
            type="button"
            data-testid="launch-btn"
            className={primaryBtn}
            onClick={() => setLaunching(true)}
          >
            Launch as a boat
          </button>
        )}
        {(proposition.status === "ranked" || proposition.status === "failed") && !launching && (
          <button type="button" className={ghostBtn} onClick={() => void discard()}>
            Set aside
          </button>
        )}
        {proposition.status === "launched" && (
          <span className="text-sm text-teal-200">⚓ Launched into the fleet</span>
        )}
        {proposition.status === "discarded" && (
          <span className="text-sm text-slate-400">Set aside</span>
        )}
        <button
          type="button"
          className="ml-auto text-xs font-semibold text-teal-300 hover:text-teal-200"
          onClick={() => setShowWhy((s) => !s)}
        >
          {showWhy ? "Hide the thinking" : "Why this idea?"}
        </button>
      </div>

      {showWhy && (
        <div className="mt-3 space-y-1 rounded-xl bg-[#0F1419] p-3 text-xs text-slate-300">
          <p>{b.rationale}</p>
          <p className="font-mono-tabular text-slate-400">
            window {b.lookbackPeriod}h · fast {b.fastPeriod}h · trigger {b.entryThreshold} · stop{" "}
            {b.stopAtrMultiple}× ATR · target {b.rewardMultiple}R
          </p>
        </div>
      )}

      {launching && proposition.status === "ranked" && (
        <LaunchForm
          proposition={proposition}
          wallets={wallets}
          onCancel={() => setLaunching(false)}
          onLaunched={async (bot) => {
            setLaunching(false);
            await onLaunched(bot);
          }}
        />
      )}
    </article>
  );
}

function ShipyardView({
  overview,
  reloadFleet,
  goFleet
}: {
  overview: FleetOverview;
  reloadFleet: () => Promise<void>;
  goFleet: () => void;
}) {
  const [batches, setBatches] = useState<readonly DesignBatch[]>([]);
  const [launched, setLaunched] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api.fleet.listDesigns();
    if (res.status === 200) setBatches(res.body.batches);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const assessing = batches.some((b) => b.status === "assessing");
  useEffect(() => {
    if (!assessing) return;
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [assessing, load]);

  // Launched and set-aside propositions are filed away so the slipway only shows open choices
  const [showFiled, setShowFiled] = useState(false);
  const isFiled = (p: Proposition) => p.status === "launched" || p.status === "discarded";
  const all = batches.flatMap((b) => b.propositions);
  const filedCount = all.filter(isFiled).length;
  const openCount = all.length - filedCount;
  const shownBatches = batches
    .map((b) => ({
      ...b,
      propositions: b.propositions.filter((p) => isFiled(p) === showFiled)
    }))
    .filter((b) => b.propositions.length > 0);

  return (
    <div className="space-y-6">
      <BriefForm designer={overview.designer} onDesigned={load} />
      {all.length > 0 && (
        <div className="flex gap-2">
          <Chip selected={!showFiled} onClick={() => setShowFiled(false)}>
            On the slipway ({openCount})
          </Chip>
          <Chip
            selected={showFiled}
            onClick={() => setShowFiled(true)}
            testId="show-filed-propositions"
          >
            Launched or set aside ({filedCount})
          </Chip>
        </div>
      )}
      {all.length > 0 && shownBatches.length === 0 && (
        <p className="text-sm text-slate-400" data-testid="shipyard-empty">
          {showFiled
            ? "Nothing launched or set aside yet."
            : "Every proposition has been launched or set aside. Draw up a new brief for more."}
        </p>
      )}
      {launched && (
        <Banner kind="ok" testId="launch-success-banner">
          <strong>{launched}</strong> has been launched and is now paper trading.{" "}
          <button type="button" className="font-semibold underline" onClick={goFleet}>
            See it in the fleet →
          </button>
        </Banner>
      )}
      {shownBatches.map((batch) => (
        <section key={batch.batchId} className="space-y-3" data-testid="design-batch">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-bold text-slate-100">
              {batch.status === "assessing" ? "Fresh off the drawing board" : "Ranked propositions"}{" "}
              <span className="text-sm font-normal text-slate-400">
                · {new Date(batch.createdAtMs).toLocaleString()} ·{" "}
                {batch.source === "claude" ? "by Claude" : "samples"}
              </span>
            </h2>
            <span className="text-xs text-slate-400">
              {batch.brief.instruments.map(pair).join(", ")} · {batch.brief.riskAppetite}
              {batch.brief.styles.length > 0
                ? ` · ${batch.brief.styles.map((s) => ARCHETYPE_LABELS[s]).join(", ")}`
                : ""}
            </span>
          </div>
          {batch.note && <Banner kind="info">{batch.note}</Banner>}
          <div className="grid gap-4">
            {batch.propositions.map((p) => (
              <PropositionCard
                key={p.propositionId}
                proposition={p}
                wallets={overview.wallets}
                reload={load}
                onLaunched={async (bot) => {
                  setLaunched(bot.name);
                  await Promise.all([load(), reloadFleet()]);
                }}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Treasury
// ---------------------------------------------------------------------------

function TreasuryView({
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

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function FleetApp({
  username,
  onOpenEngineRoom,
  onSignedOut
}: {
  username: string | null;
  onOpenEngineRoom: () => void;
  onSignedOut: () => void;
}) {
  const [tab, setTab] = useState<Tab>("fleet");
  const [overview, setOverview] = useState<FleetOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await api.fleet.getOverview();
    if (res.status === 200) {
      setOverview(res.body);
      setLoadError(null);
    } else if (res.status === 401) {
      onSignedOut();
    } else {
      setLoadError("Could not reach the fleet");
    }
  }, [onSignedOut]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 15_000);
    return () => clearInterval(t);
  }, [reload]);

  const signOut = async () => {
    await api.auth.logout({ body: {} });
    onSignedOut();
  };

  const tabs = useMemo(
    () =>
      [
        [
          "fleet",
          "Fleet",
          overview ? overview.bots.filter((b) => b.status !== "retired").length : null
        ],
        ["shipyard", "Shipyard", null],
        ["treasury", "Treasury", overview ? overview.wallets.length : null]
      ] as const,
    [overview]
  );

  return (
    <div className="min-h-screen bg-[#0B1016] text-slate-100" data-testid="fleet-app">
      <header className="border-b border-[#1E2833] bg-[#0F151C]/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2">
            <KeelMark />
            <div>
              <div className="text-lg leading-none font-bold tracking-tight">Keel</div>
              <div className="text-[11px] text-slate-400">steady hands for restless markets</div>
            </div>
          </div>
          <nav
            className="order-3 flex w-full gap-1 sm:order-none sm:ml-6 sm:w-auto"
            aria-label="Sections"
          >
            {tabs.map(([id, label, count]) => (
              <button
                key={id}
                type="button"
                data-testid={`tab-${id}`}
                aria-current={tab === id ? "page" : undefined}
                onClick={() => setTab(id)}
                className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                  tab === id
                    ? "bg-teal-400/15 text-teal-100"
                    : "text-slate-400 hover:text-slate-100"
                }`}
              >
                {label}
                {count !== null && <span className="ml-1.5 text-xs text-slate-500">{count}</span>}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-xs">
            <span className="hidden text-slate-400 sm:inline">Captain {username}</span>
            <button
              type="button"
              data-testid="open-engine-room"
              className={ghostBtn}
              onClick={onOpenEngineRoom}
            >
              Engine room
            </button>
            <button type="button" className={ghostBtn} onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {loadError && <Banner kind="danger">{loadError}</Banner>}
        {!overview ? (
          <p className="text-sm text-slate-400">Taking a headcount of the fleet…</p>
        ) : tab === "fleet" ? (
          <FleetView overview={overview} reload={reload} goShipyard={() => setTab("shipyard")} />
        ) : tab === "shipyard" ? (
          <ShipyardView overview={overview} reloadFleet={reload} goFleet={() => setTab("fleet")} />
        ) : (
          <TreasuryView overview={overview} reload={reload} />
        )}
      </main>
    </div>
  );
}
