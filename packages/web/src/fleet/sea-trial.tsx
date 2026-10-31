import { type Assessment, type SeaTrial } from "@keel/core";
import { coin, signedPct, tone } from "./ui.js";

// ---------------------------------------------------------------------------
// Sea trial: the checks behind a proposition's rank
// ---------------------------------------------------------------------------

/** What each Blind Trial outcome means; only the outcome is ever kept (ADR-0035). */
const BLIND_TRIAL_WORDS: Readonly<Record<string, string>> = {
  passed: "Passed: it held up with doubled costs on a year it never saw",
  failed: "Failed on a year it never saw",
  skipped: "Not run: a design earns it by clearing every critical check",
  budget_spent: "Not run: the Blind Trial budget is spent",
  none: "Not run: assessed before Blind Trials"
};

export function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
}

export function CheckMark({ passed }: { passed: boolean }) {
  return passed ? (
    <span aria-label="passed" className="font-bold text-emerald-300">
      ✓
    </span>
  ) : (
    <span aria-label="failed" className="font-bold text-rose-300">
      ✕
    </span>
  );
}

/** One line under the stats: how many checks passed, with the critical ones named. */
export function SeaTrialSummary({
  trial,
  open,
  onToggle
}: {
  trial: SeaTrial;
  open: boolean;
  onToggle: () => void;
}) {
  const passed = trial.checks.filter((c) => c.passed).length;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-[#2B3947] px-3 py-2">
      <span className="text-xs font-semibold text-slate-200" data-testid="sea-trial-summary">
        Sea trial: {passed} of {trial.checks.length} checks
      </span>
      {trial.checks
        .filter((c) => c.critical)
        .map((c) => (
          <span key={c.key} className="inline-flex items-center gap-1 text-[11px] text-slate-300">
            <CheckMark passed={c.passed} /> {c.label}
          </span>
        ))}
      <button
        type="button"
        data-testid="sea-trial-toggle"
        className="ml-auto text-xs font-semibold text-teal-300 hover:text-teal-200"
        onClick={onToggle}
        aria-expanded={open}
      >
        {open ? "Hide the sea trial" : "Full sea trial"}
      </button>
    </div>
  );
}

/**
 * One row of season bars around zero, on its own scale: the boat's few percent stay readable
 * next to a market that tripled. Two strips, not two axes on one chart.
 */
export function SeasonStrip({
  label,
  values,
  tips,
  filled
}: {
  label: string;
  values: readonly number[];
  tips: readonly string[];
  filled: boolean;
}) {
  const max = Math.max(0.5, ...values.map((v) => Math.abs(v)));
  const half = 22;
  return (
    <div>
      <p className="mb-1 text-[11px] text-slate-400">{label}</p>
      <div className="grid grid-cols-8 gap-1" role="list" aria-label={label}>
        {values.map((v, i) => (
          <div
            key={i}
            role="listitem"
            title={tips[i]}
            aria-label={tips[i]}
            className="group rounded-md transition hover:bg-slate-700/30"
          >
            <div className="relative" style={{ height: `${half * 2}px` }}>
              <div className="absolute inset-x-0 top-1/2 border-t border-slate-600" />
              <div
                className={`absolute inset-x-[22%] ${
                  filled
                    ? v >= 0
                      ? "rounded-t-[3px] bg-teal-300"
                      : "rounded-b-[3px] bg-rose-300"
                    : `border border-slate-400 ${v >= 0 ? "rounded-t-[3px]" : "rounded-b-[3px]"}`
                }`}
                style={{
                  height: `${Math.max(1, (Math.abs(v) / max) * half)}px`,
                  ...(v >= 0 ? { bottom: "50%" } : { top: "50%" })
                }}
              />
            </div>
            <p className="font-mono-tabular text-center text-[9px] text-slate-400">
              {v > 0 ? "+" : ""}
              {Math.abs(v) >= 100 ? Math.round(v) : v.toFixed(1)}%
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SeasonBars({ trial }: { trial: SeaTrial }) {
  const tips = trial.segments.map(
    (s, i) =>
      `Q${i + 1}, ${shortDate(s.fromTs)}–${shortDate(s.toTs)}: boat ${signedPct(s.returnPct)}, market ${signedPct(s.marketReturnPct)}, ${s.trades} trades`
  );
  return (
    <div className="space-y-2">
      <SeasonStrip
        label="The boat, by season"
        values={trial.segments.map((s) => s.returnPct)}
        tips={tips}
        filled
      />
      <SeasonStrip
        label="The market, same seasons"
        values={trial.segments.map((s) => s.marketReturnPct)}
        tips={tips}
        filled={false}
      />
      <div className="grid grid-cols-8 gap-1">
        {trial.segments.map((s, i) => (
          <p key={s.fromTs} className="text-center text-[10px] text-slate-500">
            Q{i + 1}
          </p>
        ))}
      </div>
    </div>
  );
}

export function SeaTrialPanel({ assessment, trial }: { assessment: Assessment; trial: SeaTrial }) {
  const variants = [
    ...trial.neighbours,
    ...(trial.sibling
      ? [{ ...trial.sibling, label: `On ${coin(trial.sibling.instrumentId)}` }]
      : [])
  ];
  return (
    <div className="mt-3 space-y-5 rounded-xl bg-[#0F1419] p-4" data-testid="sea-trial-panel">
      <ul className="grid gap-x-6 gap-y-2.5 md:grid-cols-2">
        {trial.checks.map((c) => (
          <li key={c.key} className="flex gap-2 text-xs" data-testid={`check-${c.key}`}>
            <CheckMark passed={c.passed} />
            <span>
              <span className="font-semibold text-slate-100">{c.label}</span>
              {c.critical && (
                <span className="ml-1.5 rounded bg-slate-700/70 px-1 py-px text-[10px] text-slate-300">
                  must pass
                </span>
              )}
              <span className="block text-slate-400">{c.detail}</span>
            </span>
          </li>
        ))}
      </ul>

      <div className="grid gap-5 lg:grid-cols-2">
        <SeasonBars trial={trial} />
        <div>
          <p className="mb-2 text-[11px] text-slate-400">Same idea, nudged</p>
          <table className="font-mono-tabular w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] text-slate-500">
                <th className="py-1 font-normal">Variant</th>
                <th className="py-1 text-right font-normal">Return</th>
                <th className="py-1 text-right font-normal">Sharpe</th>
                <th className="py-1 text-right font-normal">Trades</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-[#2B3947] text-slate-100">
                <td className="py-1">As designed</td>
                <td className={`py-1 text-right ${tone(assessment.returnPct)}`}>
                  {signedPct(assessment.returnPct)}
                </td>
                <td className="py-1 text-right">{assessment.sharpeRatio.toFixed(2)}</td>
                <td className="py-1 text-right">{assessment.totalTrades}</td>
              </tr>
              {variants.map((v) => (
                <tr key={v.label} className="border-t border-[#2B3947] text-slate-300">
                  <td className="py-1">{v.label}</td>
                  <td className={`py-1 text-right ${tone(v.returnPct)}`}>
                    {signedPct(v.returnPct)}
                  </td>
                  <td className="py-1 text-right">{v.sharpeRatio.toFixed(2)}</td>
                  <td className="py-1 text-right">{v.trades}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <dl className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-[11px] text-slate-500">Reshuffled histories</dt>
          <dd className="text-slate-200">
            {trial.monteCarlo.lossProbabilityPct}% of {trial.monteCarlo.paths.toLocaleString()} lose
            money; 1-in-20 bad case {signedPct(trial.monteCarlo.p5ReturnPct)}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] text-slate-500">Is the edge real?</dt>
          <dd className="text-slate-200">
            t = {trial.tStat.toFixed(2)}, p ={" "}
            {trial.pValue < 0.001 ? "<0.001" : trial.pValue.toFixed(3)} · {trial.trials} backtests
            counted
          </dd>
        </div>
        <div>
          <dt className="text-[11px] text-slate-500">Costs and funding</dt>
          <dd className="text-slate-200">
            {trial.stressAvgR >= 0 ? "+" : ""}
            {trial.stressAvgR.toFixed(2)}R per trade at 2× costs ·{" "}
            {trial.funding === "assumed"
              ? "funding assumed at 0.01%/8h wherever OKX keeps no history"
              : "settled funding charged"}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] text-slate-500">Strict research gate</dt>
          <dd className="text-slate-200">
            {assessment.gatePassed ? "Passed" : "Not yet"} · random entries beaten{" "}
            {Math.round(trial.randomEntryPercentile)}%
          </dd>
        </div>
        <div>
          <dt className="text-[11px] text-slate-500">
            Blind Trial (2025, never shown to the Shipwright)
          </dt>
          <dd className="text-slate-200" data-testid="blind-trial">
            {BLIND_TRIAL_WORDS[assessment.blindTrial?.outcome ?? "none"]}
          </dd>
        </div>
      </dl>
    </div>
  );
}
