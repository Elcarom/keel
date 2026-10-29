import { useCallback, useEffect, useState } from "react";
import {
  ARCHETYPE_LABELS,
  type Bot,
  type DesignBatch,
  type FleetOverview,
  type Proposition,
  type Wallet
} from "@keel/core";
import { BriefForm } from "./brief.js";
import { LaunchForm } from "./launch.js";
import { SeaTrialPanel, SeaTrialSummary } from "./sea-trial.js";
import {
  ArchetypeIcon,
  Banner,
  Chip,
  DIRECTION_LABELS,
  InventedBadge,
  InventionRules,
  Sparkline,
  Stat,
  VerdictBadge,
  api,
  card,
  exitsLabel,
  ghostBtn,
  marketsLabel,
  pair,
  primaryBtn,
  signedPct,
  tone
} from "./ui.js";

/** Side by side: the numbers that decide between two or three propositions. */
function CompareTable({
  propositions,
  onClear
}: {
  propositions: readonly Proposition[];
  onClear: () => void;
}) {
  const rows: readonly [string, (p: Proposition) => string][] = [
    ["Verdict", (p) => p.assessment?.verdict ?? "—"],
    ["Score", (p) => String(p.assessment?.score ?? "—")],
    ["Coins", (p) => marketsLabel(p.blueprint)],
    ["Return (2 years)", (p) => (p.assessment ? signedPct(p.assessment.returnPct) : "—")],
    ["Sharpe", (p) => String(p.assessment?.sharpeRatio ?? "—")],
    ["Worst dip", (p) => (p.assessment ? `${p.assessment.maxDrawdownPct}%` : "—")],
    ["Trades", (p) => String(p.assessment?.totalTrades ?? "—")],
    ["Win rate", (p) => (p.assessment ? `${Math.round(p.assessment.winRate * 100)}%` : "—")],
    [
      "Checks passed",
      (p) => {
        const checks = p.assessment?.seaTrial?.checks ?? [];
        return checks.length > 0
          ? `${checks.filter((c) => c.passed).length} of ${checks.length}`
          : "—";
      }
    ],
    [
      "Typical trade",
      (p) => (p.assessment?.seaTrial ? `${p.assessment.seaTrial.avgHoldHours}h` : "—")
    ],
    ["Sails like", (p) => p.assessment?.lookalike?.name ?? "nothing on the slipway"]
  ];
  return (
    <section className={`${card} overflow-x-auto`} data-testid="compare-table">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-base font-bold text-slate-100">Side by side</h2>
        <button type="button" className={ghostBtn} onClick={onClear}>
          Clear
        </button>
      </div>
      <table className="w-full min-w-[480px] text-left text-sm">
        <thead>
          <tr>
            <th className="py-1" />
            {propositions.map((p) => (
              <th key={p.propositionId} className="py-1 font-semibold text-slate-100">
                {p.blueprint.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono-tabular">
          {rows.map(([label, value]) => (
            <tr key={label} className="border-t border-[#1E2833]">
              <th className="py-1 pr-3 font-sans text-xs font-medium text-slate-400">{label}</th>
              {propositions.map((p) => (
                <td key={p.propositionId} className="py-1 text-slate-200">
                  {value(p)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function PropositionCard({
  proposition,
  wallets,
  reload,
  onLaunched,
  comparing,
  onCompare
}: {
  proposition: Proposition;
  wallets: readonly Wallet[];
  reload: () => Promise<void>;
  onLaunched: (bot: Bot) => Promise<void>;
  comparing: boolean;
  onCompare: () => void;
}) {
  const [launching, setLaunching] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  const [showTrial, setShowTrial] = useState(false);
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
              {b.invention && <InventedBadge source={proposition.source} />}
              {proposition.assessment && (
                <label className="flex cursor-pointer items-center gap-1 text-[11px] font-semibold text-slate-400">
                  <input
                    type="checkbox"
                    checked={comparing}
                    onChange={onCompare}
                    data-testid="compare-toggle"
                    className="accent-teal-400"
                  />
                  Compare
                </label>
              )}
              {proposition.assessment?.lookalike && (
                <span
                  data-testid="lookalike-badge"
                  title="Its two-year backtest moved almost in step with this one, week by week: launching both doubles the same bet."
                  className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[11px] font-semibold text-amber-200"
                >
                  ≈ Sails like {proposition.assessment.lookalike.name} (
                  {Math.round(proposition.assessment.lookalike.correlation * 100)}% in step)
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400">
              {ARCHETYPE_LABELS[b.archetype]} ·{" "}
              <span data-testid="proposition-markets">{marketsLabel(b)}</span> ·{" "}
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

      {b.invention && (
        <div className="mt-3" data-testid="invention-rules">
          <InventionRules rules={b.invention.rules} />
        </div>
      )}

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
              {a.seaTrial ? (
                <Stat
                  label="Out of sample"
                  value={`${a.seaTrial.outOfSampleAvgR >= 0 ? "+" : ""}${a.seaTrial.outOfSampleAvgR.toFixed(2)}R`}
                  valueClass={tone(a.seaTrial.outOfSampleAvgR)}
                  hint="per trade"
                />
              ) : (
                <Stat
                  label="Research gate"
                  value={a.gatePassed ? "Passed" : "Not yet"}
                  valueClass={a.gatePassed ? "text-emerald-300" : "text-slate-300"}
                />
              )}
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

      {a?.seaTrial && (
        <SeaTrialSummary
          trial={a.seaTrial}
          open={showTrial}
          onToggle={() => setShowTrial((s) => !s)}
        />
      )}
      {a?.seaTrial && showTrial && <SeaTrialPanel assessment={a} trial={a.seaTrial} />}

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
          {!b.invention && (
            <p className="font-mono-tabular text-slate-400">
              window {b.lookbackPeriod}h · fast {b.fastPeriod}h · trigger {b.entryThreshold} · stop{" "}
              {b.stopAtrMultiple}× ATR · target {b.rewardMultiple}R{exitsLabel(b)}
            </p>
          )}
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

export function ShipyardView({
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
  const [compare, setCompare] = useState<readonly string[]>([]);
  const toggleCompare = (id: string) =>
    setCompare((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id].slice(-3)));

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
      {compare.length >= 2 && (
        <CompareTable
          propositions={batches
            .flatMap((b) => b.propositions)
            .filter((p) => compare.includes(p.propositionId))}
          onClear={() => setCompare([])}
        />
      )}
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
                {batch.source === "claude"
                  ? "by Claude"
                  : batch.source === "imported"
                    ? "imported from your Claude chat"
                    : "samples"}
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
          {batch.progress && (
            <p
              className="flex items-center gap-2 text-xs text-sky-200"
              data-testid="sea-trial-progress"
            >
              <span className="h-2 w-2 animate-pulse rounded-full bg-sky-300" />
              {batch.progress}
            </p>
          )}
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
                comparing={compare.includes(p.propositionId)}
                onCompare={() => toggleCompare(p.propositionId)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
