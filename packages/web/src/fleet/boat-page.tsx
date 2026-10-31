import { useRef, useState } from "react";
import { ARCHETYPE_LABELS, type Bot } from "@keel/core";
import { BotLogbook } from "./fleet-view.js";
import { SeaTrialPanel } from "./sea-trial.js";
import {
  ArchetypeIcon,
  DIRECTION_LABELS,
  Stat,
  StatusChip,
  card,
  coin,
  ghostBtn,
  marketsLabel,
  money,
  signedMoney,
  signedPct,
  tone,
  usd
} from "./ui.js";

const DAY_MS = 86_400_000;

export const HEALTH_LABELS: Record<
  Bot["health"],
  { label: string; className: string; hint: string }
> = {
  new: {
    label: "New",
    className: "border-slate-500/40 text-slate-300",
    hint: "Fewer than 10 trades: too early to judge against its sea trial"
  },
  on_course: {
    label: "On course",
    className: "border-emerald-400/40 text-emerald-200",
    hint: "Sailing within what its sea trial expected"
  },
  drifting: {
    label: "Drifting",
    className: "border-amber-400/50 text-amber-200",
    hint: "Doing clearly worse than its sea trial expected; the drift watch docks it if it is on"
  }
};

export function HealthBadge({ health }: { health: Bot["health"] }) {
  const h = HEALTH_LABELS[health];
  return (
    <span
      data-testid="boat-health"
      title={h.hint}
      className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${h.className}`}
    >
      {h.label}
    </span>
  );
}

/** How the boat ranks against propositions (ADR-0033). */
export function StandingBadge({ standing }: { standing: Bot["standing"] }) {
  if (!standing) return null;
  return (
    <span
      data-testid="boat-standing"
      title={
        standing.proven
          ? "Its sea-trial score, shifting towards its live paper results over its first 90 days. A proposition must beat it clearly to take its place."
          : "Still proving itself: its sea-trial score for now. It cannot be replaced yet."
      }
      className="rounded-full border border-slate-500/40 px-2 py-0.5 text-[11px] font-semibold text-slate-200"
    >
      Standing {standing.score}
      {standing.proven ? "" : " · proving"}
    </span>
  );
}

/**
 * Live equity since launch against what the sea trial expected: the band runs from the trial's
 * 5th-percentile resampled return to its median, scaled to the days the boat has sailed.
 */
function ExpectationChart({ bot }: { bot: Bot }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const points = bot.equityHistory.map((p) => ({ ts: p.ts, equity: Number(p.equityUsdt) }));
  const stake = Number(bot.allocationUsdt);
  const mc = bot.backtest?.seaTrial?.monteCarlo;
  const trialDays = bot.backtest?.days ?? 730;
  if (points.length < 2 || !mc || stake <= 0) {
    return (
      <p className="text-xs text-slate-400" data-testid="expectation-chart-empty">
        The chart fills in after the boat&apos;s first full day at sea.
      </p>
    );
  }
  const start = bot.createdAtMs;
  const expected = (ts: number, pct: number) =>
    stake * (1 + ((pct / 100) * Math.max(0, ts - start)) / (trialDays * DAY_MS));
  const low = points.map((p) => expected(p.ts, mc.p5ReturnPct));
  const mid = points.map((p) => expected(p.ts, mc.medianReturnPct));
  const all = [...points.map((p) => p.equity), ...low, ...mid];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const W = 600;
  const H = 180;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => (max === min ? H / 2 : H - 8 - ((v - min) / (max - min)) * (H - 16));
  const line = (vs: readonly number[]) => vs.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const band = `${line(mid)} ${[...low]
    .map((v, i) => `${x(i)},${y(v)}`)
    .reverse()
    .join(" ")}`;
  const h = hover === null ? null : points[hover];

  return (
    <figure className="space-y-2" data-testid="expectation-chart">
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
        <span>Equity since launch against its sea trial</span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-teal-300" aria-hidden /> Live equity
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-4 rounded-sm bg-sky-400/20" aria-hidden /> Expected
          range (trial&apos;s 5th percentile to median)
        </span>
      </figcaption>
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        className="h-44 w-full"
        role="img"
        aria-label={`${bot.name} equity ${money(points[points.length - 1]?.equity ?? 0)} against the range its sea trial expected`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = ref.current?.getBoundingClientRect();
          if (!box) return;
          const i = Math.round(((e.clientX - box.left) / box.width) * (points.length - 1));
          setHover(Math.max(0, Math.min(points.length - 1, i)));
        }}
      >
        <polygon points={band} className="fill-sky-400/15" />
        <polyline
          points={line(points.map((p) => p.equity))}
          fill="none"
          className="stroke-teal-300"
          strokeWidth={2}
        />
        {hover !== null && h && (
          <>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={0}
              y2={H}
              className="stroke-slate-500"
              strokeWidth={1}
            />
            <circle
              cx={x(hover)}
              cy={y(h.equity)}
              r={4}
              className="fill-teal-300 stroke-[#141B23]"
              strokeWidth={2}
            />
          </>
        )}
      </svg>
      {h && hover !== null && (
        <p className="font-mono-tabular text-xs text-slate-300">
          {new Date(h.ts).toLocaleDateString()} · equity {money(h.equity)} · expected{" "}
          {money(low[hover] ?? 0)}–{money(mid[hover] ?? 0)}
        </p>
      )}
    </figure>
  );
}

export function BoatPage({
  bot,
  onBack,
  onAction,
  busy
}: {
  bot: Bot;
  onBack: () => void;
  onAction: (bot: Bot, action: "pause" | "resume" | "retire" | "delete") => void;
  busy: boolean;
}) {
  const pnl = Number(bot.pnlUsdt);
  const trial = bot.backtest?.seaTrial ?? null;
  return (
    <div className="space-y-5" data-testid="boat-page">
      <button
        type="button"
        className="text-sm font-semibold text-teal-300 hover:text-teal-200"
        onClick={onBack}
      >
        ← Back to the fleet
      </button>
      <header className={`${card} flex flex-wrap items-start justify-between gap-4`}>
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-teal-400/10 p-2 text-teal-200">
            <ArchetypeIcon archetype={bot.rig.archetype} />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-slate-50">{bot.name}</h2>
            <p className="text-sm text-slate-400">
              {ARCHETYPE_LABELS[bot.rig.archetype]} · {marketsLabel(bot.rig)} ·{" "}
              {DIRECTION_LABELS[bot.rig.direction]}
            </p>
            <p className="mt-1 text-sm text-slate-300 italic">“{bot.tagline}”</p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2">
            <StandingBadge standing={bot.standing} />
            <HealthBadge health={bot.health} />
            <StatusChip status={bot.status} />
          </div>
          <div className="flex gap-2">
            {bot.status === "running" && (
              <button
                type="button"
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
                className={ghostBtn}
                disabled={busy}
                onClick={() => onAction(bot, "resume")}
              >
                Set sail
              </button>
            )}
          </div>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <div className={card}>
          <Stat
            label="Equity"
            value={money(bot.equityUsdt)}
            hint={`stake ${usd.format(Number(bot.allocationUsdt))}`}
          />
        </div>
        <div className={card}>
          <Stat
            label="Return"
            value={signedPct(bot.returnPct)}
            valueClass={tone(pnl)}
            hint={`${signedMoney(bot.pnlUsdt)} USDT`}
          />
        </div>
        <div className={card}>
          <Stat
            label="Trades"
            value={String(bot.tradesCount)}
            hint={`${Math.round(bot.winRate * 100)}% won`}
          />
        </div>
        <div className={card}>
          <Stat
            label="Worst dip"
            value={`${bot.maxDrawdownPct.toFixed(1)}%`}
            hint={trial ? `trial's 95th pct ${trial.monteCarlo.p95DrawdownPct}%` : undefined}
          />
        </div>
        <div className={card}>
          <Stat
            label="Open now"
            value={String(bot.openPositions.length)}
            hint={
              bot.openPositions.map((p) => `${coin(p.instrumentId)} ${p.side}`).join(", ") || "flat"
            }
          />
        </div>
      </section>

      <section className={card}>
        <ExpectationChart bot={bot} />
      </section>

      {bot.coins.length > 1 && (
        <section className={card} data-testid="boat-coins">
          <h3 className="mb-2 text-sm font-semibold text-slate-100">Coin by coin</h3>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-400">
              <tr>
                <th className="py-1 font-medium">Coin</th>
                <th className="py-1 text-right font-medium">Closed trades</th>
                <th className="py-1 text-right font-medium">Net P&amp;L (USDT)</th>
              </tr>
            </thead>
            <tbody className="font-mono-tabular">
              {bot.coins.map((c) => (
                <tr key={c.instrumentId} className="border-t border-[#1E2833]">
                  <td className="py-1">{coin(c.instrumentId)}</td>
                  <td className="py-1 text-right">{c.trades}</td>
                  <td className={`py-1 text-right ${tone(Number(c.pnlUsdt))}`}>
                    {signedMoney(c.pnlUsdt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className={card}>
        <BotLogbook bot={bot} />
      </section>

      {bot.backtest && trial && (
        <section className={card}>
          <h3 className="mb-3 text-sm font-semibold text-slate-100">The sea trial it passed</h3>
          <SeaTrialPanel assessment={bot.backtest} trial={trial} />
        </section>
      )}
    </div>
  );
}
