import { useRef, useState } from "react";
import {
  ARCHETYPE_FAMILIES,
  ARCHETYPE_FAMILY,
  ARCHETYPE_LABELS,
  BOT_ARCHETYPES,
  FLEET_INSTRUMENTS,
  type ArchetypeFamily,
  type BotArchetype,
  type DesignMode,
  type DesignBrief,
  type FleetInstrument,
  type FleetOverview,
  type InventionRejection,
  type InventorPromptRequest
} from "@keel/core";
import {
  ArchetypeIcon,
  Banner,
  Chip,
  api,
  card,
  coin,
  errorOf,
  ghostBtn,
  input,
  primaryBtn
} from "./ui.js";

// ---------------------------------------------------------------------------
// Shipyard
// ---------------------------------------------------------------------------

export const ARCHETYPE_HINTS: Record<BotArchetype, string> = {
  breakout: "Charges through when price escapes its range",
  mean_reversion: "Fades stretched moves back to the mean",
  momentum: "Rides strong impulses while they last",
  ma_crossover: "Changes tack when averages cross",
  trend_pullback: "Follows the trend, boards on the dips",
  squeeze_breakout: "Waits out the calm, sails off when it breaks",
  volume_breakout: "Only trusts breakouts with a crowd behind them",
  inside_bar_breakout: "A quiet bar, then a push with the current",
  keltner_ride: "Rides once price clears its volatility band",
  regime_momentum: "Momentum, but only with the big current",
  rsi_reversal: "Catches the turn out of an overstretched sea",
  failed_breakout: "Bets on breakouts that bounce off the wall",
  capitulation_fade: "Buys what a panic bar left behind",
  pair_reversion: "Two coins lashed together: leans on the one that drifted too far",
  pair_momentum: "Holds the faster of two coins against the slower"
};

export const FAMILY_LABELS: Record<ArchetypeFamily, string> = {
  trend: "Trend followers",
  breakout: "Breakouts",
  reversion: "Reversion",
  pairs: "Pairs: one coin against another"
};

export const MAJORS: readonly FleetInstrument[] = ["BTC-USDT-SWAP", "ETH-USDT-SWAP"];

/** A read-only block of text with a copy button; selecting it works where the clipboard API is off. */
export function CopyBox({
  text,
  testId,
  rows = 8
}: {
  text: string;
  testId: string;
  rows?: number;
}) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Plain http on a LAN has no clipboard API: fall back to a selection copy
      ref.current?.select();
      document.execCommand("copy");
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="space-y-2">
      <textarea
        ref={ref}
        readOnly
        rows={rows}
        value={text}
        data-testid={testId}
        onFocus={(e) => e.currentTarget.select()}
        className={`${input} font-mono-tabular text-xs`}
      />
      <button type="button" className={ghostBtn} onClick={() => void copy()}>
        {copied ? "Copied ✓" : "Copy"}
      </button>
    </div>
  );
}

/**
 * Inventor mode without the API: Keel writes the prompt, the operator runs it in their own Claude
 * chat, and the JSON that comes back is checked and sea-trialled like any other invention.
 */
export function ImportSteps({
  request,
  onImported
}: {
  request: InventorPromptRequest;
  onImported: () => Promise<void>;
}) {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    accepted: number;
    rejected: readonly InventionRejection[];
    repairPrompt: string | null;
  } | null>(null);

  const getPrompt = async () => {
    setError(null);
    const res = await api.fleet.inventorPrompt({ body: request });
    if (res.status === 200) setPrompt(res.body.prompt);
    else setError(errorOf(res.body));
  };

  const readFile = async (file: File | undefined) => {
    if (file) setText(await file.text());
  };

  const importText = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    const res = await api.fleet.importInventions({ body: { text } });
    setBusy(false);
    if (res.status !== 200) {
      setError(errorOf(res.body));
      return;
    }
    setResult({
      accepted: res.body.batch?.propositions.length ?? 0,
      rejected: res.body.rejected,
      repairPrompt: res.body.repairPrompt
    });
    if (res.body.batch) {
      setText("");
      await onImported();
    }
  };

  const step = "mb-1 text-sm font-semibold text-slate-100";
  return (
    <div className="space-y-5" data-testid="import-steps">
      <div className="rounded-xl border border-[#2B3947] p-4">
        <p className={step}>1 · Ask your own Claude</p>
        <p className="mb-3 text-xs text-slate-400">
          Keel writes a prompt holding the whole rule language and your brief above. Paste it into a
          new chat at claude.ai. That uses your subscription, so there are no API fees. Opus with
          extended thinking gives the most inventive answers.
        </p>
        {prompt === null ? (
          <button
            type="button"
            className={ghostBtn}
            data-testid="get-inventor-prompt-btn"
            onClick={() => void getPrompt()}
          >
            Write the prompt for {request.count} {request.count === 1 ? "idea" : "ideas"}
          </button>
        ) : (
          <div className="space-y-2">
            <CopyBox text={prompt} testId="inventor-prompt" />
            <button
              type="button"
              className="text-xs font-semibold text-teal-300 hover:text-teal-200"
              onClick={() => void getPrompt()}
            >
              Rewrite it for the brief as it is now
            </button>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-[#2B3947] p-4">
        <p className={step}>2 · Bring the answer back</p>
        <p className="mb-3 text-xs text-slate-400">
          Choose the .json file Claude made, or paste its whole reply. Keel finds the JSON, checks
          every rule, attaches the stop and puts each invention that passes through a sea trial.
        </p>
        <input
          type="file"
          accept=".json,.txt,application/json,text/plain"
          data-testid="import-file-input"
          onChange={(e) => void readFile(e.target.files?.[0])}
          className="mb-2 block text-xs text-slate-300 file:mr-3 file:rounded-lg file:border file:border-[#2B3947] file:bg-transparent file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-slate-200"
        />
        <textarea
          rows={6}
          value={text}
          data-testid="import-text"
          onChange={(e) => setText(e.target.value)}
          placeholder={'…or paste Claude\'s reply here: {"propositions": [ … ]}'}
          className={`${input} font-mono-tabular text-xs`}
        />
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            className={primaryBtn}
            data-testid="import-submit-btn"
            disabled={busy || text.trim().length === 0}
            onClick={() => void importText()}
          >
            {busy ? "Checking the rules…" : "Sea-trial these inventions"}
          </button>
        </div>
      </div>

      {error && <Banner kind="danger">{error}</Banner>}
      {result && result.accepted > 0 && (
        <Banner kind="ok" testId="import-success-banner">
          {result.accepted} invention{result.accepted === 1 ? " is" : "s are"} on the slipway for a
          sea trial.
        </Banner>
      )}
      {result && result.rejected.length > 0 && (
        <div className="space-y-2" data-testid="import-rejections">
          <Banner kind="warn">
            <p className="font-semibold">
              Keel rejected {result.rejected.length}{" "}
              {result.rejected.length === 1 ? "invention" : "inventions"}:
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
              {result.rejected.map((r, i) => (
                <li key={`${r.name}-${i}`}>
                  <strong>{r.name}</strong>: {r.error}
                </li>
              ))}
            </ul>
          </Banner>
          {result.repairPrompt && (
            <>
              <p className="text-xs text-slate-400">
                Paste this into the same Claude chat to have the rejected ones fixed, then import
                its answer:
              </p>
              <CopyBox text={result.repairPrompt} testId="repair-prompt" rows={4} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function BriefForm({
  onDesigned,
  designer
}: {
  onDesigned: () => Promise<void>;
  designer: FleetOverview["designer"];
}) {
  // With Claude on hand, Inventor is the default; without a key, Inventor via your own chat
  const claude = designer.source === "claude";
  const [brief, setBrief] = useState<DesignBrief>({
    mode: claude ? "inventor" : "blueprint",
    instruments: ["BTC-USDT-SWAP", "ETH-USDT-SWAP"],
    styles: [],
    riskAppetite: "balanced",
    direction: "any",
    count: 4,
    notes: ""
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Import is Inventor mode run in the operator's own Claude chat, so it is not a DesignMode
  const [importing, setImporting] = useState(!claude);
  const [importCount, setImportCount] = useState(6);
  const inventing = importing || brief.mode === "inventor";

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
            {inventing
              ? "Claude invents brand-new entry rules. Keel checks every rule, attaches the stop and puts each invention through a sea trial: two years of hourly data, doubled costs, walk-forward, nudged windows and thresholds, and a sibling market. Then it ranks them."
              : "Claude drafts the propositions. Keel then puts every one through a sea trial: two years of hourly data, doubled costs, walk-forward, nudged settings and a sibling market. Then it ranks them."}
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
          {importing
            ? "Designer: your own Claude chat"
            : designer.source === "claude"
              ? `Designer: Claude (${designer.model})`
              : "Designer: sample mode (no Anthropic key)"}
        </span>
      </div>

      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Design mode">
        {(
          [
            [
              "blueprint",
              "Blueprints",
              "Claude picks and tunes one of 13 reviewed strategy shapes."
            ],
            [
              "inventor",
              "✦ Inventor",
              "Claude writes brand-new rules from indicators, price, volume and the clock. Thinks harder; costs a little more per brief."
            ],
            [
              "import",
              "⇅ Inventor via your chat",
              "Inventor mode with no API fees: copy Keel's prompt into claude.ai, then bring back the JSON file it writes."
            ]
          ] as const
        ).map(([mode, label, hint]) => {
          const selected = mode === "import" ? importing : !importing && brief.mode === mode;
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={selected}
              data-testid={`mode-${mode}`}
              onClick={() => {
                setImporting(mode === "import");
                if (mode !== "import") setBrief((b) => ({ ...b, mode: mode as DesignMode }));
              }}
              className={`rounded-xl border p-3 text-left transition ${
                selected
                  ? mode !== "blueprint"
                    ? "border-violet-400 bg-violet-400/10"
                    : "border-teal-400 bg-teal-400/10"
                  : "border-[#2B3947] hover:border-slate-400"
              }`}
            >
              <span className="block text-sm font-semibold text-slate-100">{label}</span>
              <span className="block text-xs text-slate-400">{hint}</span>
            </button>
          );
        })}
      </div>

      <fieldset>
        <legend className="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">
          Waters
        </legend>
        <div className="flex flex-wrap items-center gap-2">
          {FLEET_INSTRUMENTS.map((id) => (
            <Chip
              key={id}
              selected={brief.instruments.includes(id)}
              onClick={() => toggleInstrument(id)}
              testId={`instrument-${id}`}
            >
              {coin(id)}
            </Chip>
          ))}
          <span className="mx-1 hidden h-5 w-px bg-[#2B3947] sm:block" aria-hidden />
          <button
            type="button"
            className="text-xs font-semibold text-teal-300 hover:text-teal-200"
            onClick={() => setBrief((b) => ({ ...b, instruments: [...MAJORS] }))}
          >
            Majors
          </button>
          <button
            type="button"
            data-testid="instruments-all"
            className="text-xs font-semibold text-teal-300 hover:text-teal-200"
            onClick={() => setBrief((b) => ({ ...b, instruments: [...FLEET_INSTRUMENTS] }))}
          >
            All {FLEET_INSTRUMENTS.length}
          </button>
        </div>
      </fieldset>

      {!inventing && (
        <details
          className="group rounded-xl border border-[#2B3947] p-3"
          data-testid="brief-styles"
        >
          <summary
            className="cursor-pointer text-xs font-semibold tracking-wide text-slate-400 uppercase"
            data-testid="brief-styles-toggle"
          >
            Styles{" "}
            <span className="tracking-normal normal-case text-slate-500">
              — optional; leave closed to let Claude surprise you
              {brief.styles.length > 0 ? ` (${brief.styles.length} picked)` : ""}
            </span>
          </summary>
          <fieldset className="mt-3">
            <legend className="sr-only">Styles</legend>
            <div className="space-y-3">
              {ARCHETYPE_FAMILIES.map((family) => (
                <div key={family}>
                  <p className="mb-1.5 text-[11px] font-semibold text-slate-500">
                    {FAMILY_LABELS[family]}
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {BOT_ARCHETYPES.filter((a) => ARCHETYPE_FAMILY[a] === family).map((s) => {
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
                            <span className="block text-xs text-slate-400">
                              {ARCHETYPE_HINTS[s]}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </fieldset>
        </details>
      )}

      <div className="grid gap-5 md:grid-cols-3">
        {importing ? (
          <p className="text-xs text-slate-400">
            Claude sets each invention&apos;s stop and target to suit its idea; Keel attaches the
            stop.
          </p>
        ) : (
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
        )}
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
            {importing
              ? [3, 6, 10, 15, 20].map((n) => (
                  <Chip
                    key={n}
                    selected={importCount === n}
                    onClick={() => setImportCount(n)}
                    testId={`import-count-${n}`}
                  >
                    {n}
                  </Chip>
                ))
              : [2, 3, 4, 5, 6].map((n) => (
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
          {inventing ? "What edge are you hunting?" : "Anything else for Claude?"}
        </label>
        <textarea
          id="brief-notes"
          data-testid="brief-notes"
          rows={3}
          maxLength={1000}
          value={brief.notes}
          onChange={(e) => setBrief((b) => ({ ...b, notes: e.target.value }))}
          placeholder={
            inventing
              ? "e.g. fade the moves thin weekend books leave behind, or catch breakouts when Europe wakes up"
              : "e.g. something calm that holds trades for a day or two, or a quick boat that only trades ETH breakouts"
          }
          className={input}
        />
      </div>

      {importing ? (
        <ImportSteps
          request={{
            instruments: brief.instruments,
            direction: brief.direction,
            count: importCount,
            notes: brief.notes
          }}
          onImported={onDesigned}
        />
      ) : (
        <>
          {error && <Banner kind="danger">{error}</Banner>}

          <div className="flex justify-end">
            <button
              type="submit"
              data-testid="design-submit-btn"
              className={primaryBtn}
              disabled={submitting}
            >
              {submitting
                ? brief.mode === "inventor"
                  ? "Claude is at the drawing table…"
                  : "Claude is sketching hulls…"
                : brief.mode === "inventor"
                  ? "Commission inventions"
                  : "Draft propositions"}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
