import { useRef, useState } from "react";
import {
  FLEET_INSTRUMENTS,
  type DesignBrief,
  type FleetInstrument,
  type FleetOverview,
  type InventionRejection,
  type InventorPromptRequest
} from "@keel/core";
import { Banner, Chip, api, card, coin, errorOf, ghostBtn, input, primaryBtn } from "./ui.js";

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
 * The Inventor via a chat: Keel writes the prompt, the operator runs it in a chat with any model,
 * and the JSON that comes back is checked and sea-trialled like any other invention.
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
        <p className={step}>1 · Ask the model of your choice</p>
        <p className="mb-3 text-xs text-slate-400">
          Keel writes a prompt holding the whole rule language and your brief above. Paste it into a
          new chat with any model you like. The strongest reasoning models give the most inventive
          answers.
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
          Choose the .json file the model made, or paste its whole reply. Keel finds the JSON,
          checks every rule, attaches the stop and puts each invention that passes through a sea
          trial.
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
          placeholder={'…or paste the reply here: {"propositions": [ … ]}'}
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
                Paste this into the same chat to have the rejected ones fixed, then import its
                answer:
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
  // With Claude linked the Inventor is the default; without it, the Inventor via a chat
  const claude = designer.source === "claude";
  const [brief, setBrief] = useState<DesignBrief>({
    instruments: [...MAJORS],
    direction: "any",
    count: 4,
    notes: ""
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viaChat, setViaChat] = useState(!claude);
  const [chatCount, setChatCount] = useState(6);

  const toggleInstrument = (id: FleetInstrument) =>
    setBrief((b) => {
      const has = b.instruments.includes(id);
      const next = has ? b.instruments.filter((i) => i !== id) : [...b.instruments, id];
      return next.length === 0 ? b : { ...b, instruments: next };
    });

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

  const legend = "mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase";
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
            A model invents brand-new entry rules. Keel checks every rule, attaches the stop and
            puts each invention through a sea trial, then ranks them.
          </p>
        </div>
        <span
          data-testid="designer-source"
          className={`rounded-full border px-3 py-1 text-xs font-semibold ${
            viaChat || claude
              ? "border-teal-400/40 text-teal-200"
              : "border-amber-400/40 text-amber-200"
          }`}
        >
          {viaChat
            ? "Inventor: a chat of your choosing"
            : claude
              ? `Inventor: Claude (${designer.model})`
              : "Inventor: samples (Claude not linked)"}
        </span>
      </div>

      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Inventor">
        {(
          [
            [
              false,
              "inventor",
              "✦ Inventor",
              "Claude, on your subscription, writes new rules from indicators, price, volume and the clock."
            ],
            [
              true,
              "chat",
              "⇅ Inventor via a chat",
              "Use any model you like: copy Keel's prompt into its chat, then bring back the JSON it writes."
            ]
          ] as const
        ).map(([chat, id, label, hint]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={viaChat === chat}
            data-testid={`mode-${id}`}
            onClick={() => setViaChat(chat)}
            className={`rounded-xl border p-3 text-left transition ${
              viaChat === chat
                ? "border-violet-400 bg-violet-400/10"
                : "border-[#2B3947] hover:border-slate-400"
            }`}
          >
            <span className="block text-sm font-semibold text-slate-100">{label}</span>
            <span className="block text-xs text-slate-400">{hint}</span>
          </button>
        ))}
      </div>

      <fieldset>
        <legend className={legend}>Waters</legend>
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

      <div className="grid gap-5 sm:grid-cols-2">
        <fieldset>
          <legend className={legend}>Direction</legend>
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
          <legend className={legend}>How many ideas</legend>
          <div className="flex flex-wrap gap-2">
            {viaChat
              ? [3, 6, 10, 15, 20].map((n) => (
                  <Chip
                    key={n}
                    selected={chatCount === n}
                    onClick={() => setChatCount(n)}
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
        <label htmlFor="brief-notes" className={`${legend} block`}>
          What edge are you hunting?
        </label>
        <textarea
          id="brief-notes"
          data-testid="brief-notes"
          rows={3}
          maxLength={1000}
          value={brief.notes}
          onChange={(e) => setBrief((b) => ({ ...b, notes: e.target.value }))}
          placeholder="e.g. fade the moves thin weekend books leave behind, or catch breakouts when Europe wakes up"
          className={input}
        />
      </div>

      {viaChat ? (
        <ImportSteps
          request={{
            instruments: brief.instruments,
            direction: brief.direction,
            count: chatCount,
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
              {submitting ? "Claude is at the drawing table…" : "Commission inventions"}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
