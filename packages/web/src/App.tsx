import { useCallback, useEffect, useState } from "react";
import {
  type AuditEventRecord,
  type AuthSessionResponse,
  type CircuitBreakerRecord,
  type ConfigFieldMetadata,
  type ConfigSnapshotRecord,
  type FleetOverview,
  type InstrumentCoverageSummary,
  type KeelConfig,
  type SecretKeyName,
  type SecretMetadataRecord
} from "@keel/core";
import { DutySettings } from "./fleet/duty-settings.js";
import {
  Banner,
  KeelMark,
  ago,
  api,
  card,
  coin,
  dangerBtn,
  errorOf,
  ghostBtn,
  input,
  primaryBtn
} from "./fleet/ui.js";

export interface EngineRoomProps {
  /** Called once a sign-in or bootstrap leaves the browser with a working session. */
  readonly onSignedIn?: (() => void) | undefined;
  /** Shows a way back to the Fleet when the Engine Room is opened from it. */
  readonly onExitEngineRoom?: (() => void) | undefined;
}

/** The secrets the captain links from here; the vault's other keys belong to retired screens. */
const LINKS: readonly {
  readonly key: SecretKeyName;
  readonly label: string;
  readonly hint: string;
  readonly placeholder: string;
}[] = [
  {
    key: "claudeCodeToken",
    label: "Claude subscription",
    hint: "Run `claude setup-token` on any computer with Claude Code and paste the token. The night shift then researches on your plan.",
    placeholder: "sk-ant-oat01-…"
  },
  {
    key: "discordWebhookUrl",
    label: "Discord alerts",
    hint: "A channel webhook for the daily digest, launches, replacements and warnings.",
    placeholder: "https://discord.com/api/webhooks/…"
  }
];

/** Plain words for the audit actions the captain is likely to see. */
const ACTIONS: Readonly<Record<string, string>> = {
  "auth.bootstrap": "Created the captain account",
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "config.update": "Changed settings",
  "config.rollback": "Restored earlier settings",
  "secrets.upsert": "Stored a secret",
  "system.backup": "Backed up the database"
};

const KILLED = new Set(["MANUAL_KILL_SWITCH", "DRAWDOWN_KILL_SWITCH"]);

function SectionTitle({ title, hint }: { title: string; hint?: string | undefined }) {
  return (
    <div className="mb-3">
      <h2 className="text-base font-bold text-slate-100">{title}</h2>
      {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

/**
 * The Engine Room: what the captain sets once and then leaves alone. Claude's link, the Fleet's
 * unattended duties, the Kill Switch, backups, market data and the audit trail.
 */
export function App({ onSignedIn, onExitEngineRoom }: EngineRoomProps = {}) {
  const [session, setSession] = useState<AuthSessionResponse | null>(null);

  // Sign-in
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [username, setUsername] = useState("captain");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);

  // Engine Room data
  const [active, setActive] = useState<ConfigSnapshotRecord | null>(null);
  const [draft, setDraft] = useState<KeelConfig | null>(null);
  const [registry, setRegistry] = useState<readonly ConfigFieldMetadata[]>([]);
  const [history, setHistory] = useState<readonly ConfigSnapshotRecord[]>([]);
  const [secrets, setSecrets] = useState<readonly SecretMetadataRecord[]>([]);
  const [audit, setAudit] = useState<readonly AuditEventRecord[]>([]);
  const [coverage, setCoverage] = useState<readonly InstrumentCoverageSummary[]>([]);
  const [breaker, setBreaker] = useState<CircuitBreakerRecord | null>(null);
  const [overview, setOverview] = useState<FleetOverview | null>(null);

  // One confirmation for every protected action on the page
  const [stepUpPassword, setStepUpPassword] = useState("");
  const [stepUpTotpCode, setStepUpTotpCode] = useState("");
  const [secretValues, setSecretValues] = useState<Partial<Record<SecretKeyName, string>>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const stepUp = () => ({
    stepUpPassword: stepUpPassword || undefined,
    stepUpTotpCode: stepUpTotpCode || undefined
  });

  const refreshSession = useCallback(async () => {
    const res = await api.auth.getSession();
    if (res.status === 200) {
      setSession(res.body);
      return res.body;
    }
    return null;
  }, []);

  const refresh = useCallback(async () => {
    const [cfg, hist, sec, aud, mkt, paper, fleet] = await Promise.all([
      api.config.getActive(),
      api.config.getHistory(),
      api.secrets.listMetadata(),
      api.audit.listRecent(),
      api.market.getSummary(),
      api.paper.getStatus(),
      api.fleet.getOverview()
    ]);
    if (cfg.status === 200) {
      setActive(cfg.body.active);
      setDraft(cfg.body.active.config);
      setRegistry(cfg.body.registry);
    }
    if (hist.status === 200) setHistory(hist.body.history);
    if (sec.status === 200) setSecrets(sec.body.secrets);
    if (aud.status === 200) setAudit(aud.body.events);
    if (mkt.status === 200) setCoverage(mkt.body.instruments);
    if (paper.status === 200) setBreaker(paper.body.circuitBreaker);
    if (fleet.status === 200) setOverview(fleet.body);
  }, []);

  useEffect(() => {
    void refreshSession().then((s) => {
      if (s?.authenticated) void refresh();
    });
  }, [refreshSession, refresh]);

  /** Runs one action and shows its outcome in the banner at the top. */
  const act = async (work: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      setMessage(await work());
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // ------------------------------------------------------------------------
  // Sign-in
  // ------------------------------------------------------------------------

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    const res = session?.bootstrapped
      ? await api.auth.login({ body: { username, password } })
      : await api.auth.bootstrap({ body: { bootstrapToken, username, password } });
    if (res.status !== 200) {
      setAuthError(errorOf(res.body));
      return;
    }
    setStepUpPassword(password);
    const now = await refreshSession();
    if (now?.authenticated) {
      await refresh();
      onSignedIn?.();
      return;
    }
    // The server accepted the credentials but the browser refused the session cookie
    setAuthError(
      window.location.protocol === "http:"
        ? "Signed in, but your browser refused the session cookie over plain HTTP. Set KEEL_ALLOW_INSECURE_HTTP=true on the container, or open Keel over HTTPS."
        : "Signed in, but your browser did not keep the session cookie. Check that cookies are allowed for this site."
    );
  };

  const signOut = async () => {
    await api.auth.logout({ body: {} });
    setActive(null);
    setDraft(null);
    await refreshSession();
  };

  // ------------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------------

  const saveSettings = () =>
    act(async () => {
      if (!draft) throw new Error("Settings are still loading");
      const res = await api.config.updateConfig({
        body: { config: draft, reason: "Changed in the Engine Room", ...stepUp() }
      });
      if (res.status !== 200) throw new Error(errorOf(res.body));
      return `Saved: settings are now version ${res.body.snapshot.version}`;
    });

  const restore = (version: number) =>
    act(async () => {
      const res = await api.config.rollbackConfig({
        body: { targetVersion: version, reason: `Restored v${version}`, ...stepUp() }
      });
      if (res.status !== 200) throw new Error(errorOf(res.body));
      return `Restored v${version} (saved as v${res.body.snapshot.version})`;
    });

  const saveSecret = (key: SecretKeyName) =>
    act(async () => {
      const value = secretValues[key]?.trim();
      if (!value) throw new Error("Paste a value first");
      const res = await api.secrets.upsertSecret({
        body: { keyName: key, plaintextValue: value, ...stepUp() }
      });
      if (res.status !== 200) throw new Error(errorOf(res.body));
      setSecretValues((v) => ({ ...v, [key]: "" }));
      return `Stored ${res.body.secret.keyName} (${res.body.secret.maskedPreview})`;
    });

  const killed = breaker !== null && KILLED.has(breaker.status);
  const toggleKillSwitch = () =>
    act(async () => {
      const res = await api.paper.setCircuitBreaker({
        body: killed
          ? { status: "NORMAL", reason: "Reset by the captain", ...stepUp() }
          : { status: "MANUAL_KILL_SWITCH", reason: "Pulled by the captain", ...stepUp() }
      });
      if (res.status !== 200) throw new Error(errorOf(res.body));
      const ks = res.body.killSwitch;
      return killed
        ? "Kill Switch reset: boats may open positions again"
        : `Kill Switch on: closed ${ks?.paperFlattenedCount ?? 0} positions${ks && !ks.paperFlat ? " (some are still open)" : ""}`;
    });

  const backup = () =>
    act(async () => {
      const res = await api.system.createBackup({ body: {} });
      if (res.status !== 200) throw new Error(errorOf(res.body));
      return `Backed up to ${res.body.backup.fileName}${res.body.backup.integrityOk ? "" : " (integrity check failed)"}`;
    });

  // ------------------------------------------------------------------------
  // Page
  // ------------------------------------------------------------------------

  const dirty =
    draft !== null && active !== null && JSON.stringify(draft) !== JSON.stringify(active.config);
  const claudeLinked = overview?.designer.source === "claude";
  const duties = overview?.duties ?? [];

  return (
    <div className="min-h-screen bg-[#0B1016] text-slate-100" data-testid="engine-room">
      <header className="border-b border-[#1E2833] bg-[#0F151C]/90">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 sm:px-6">
          <KeelMark />
          <div>
            <h1 className="text-lg leading-none font-bold tracking-tight">Keel</h1>
            <div className="text-[11px] text-slate-400">Engine Room</div>
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs">
            {session?.authenticated && (
              <>
                <span className="hidden text-slate-400 sm:inline">
                  Captain{" "}
                  <span data-testid="authenticated-user-badge" className="text-slate-200">
                    {session.username}
                  </span>
                </span>
                <button type="button" className={ghostBtn} onClick={() => void signOut()}>
                  Sign out
                </button>
              </>
            )}
            {onExitEngineRoom && (
              <button
                type="button"
                data-testid="back-to-fleet"
                className={ghostBtn}
                onClick={onExitEngineRoom}
              >
                ← Back to the Fleet
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-6">
        {session && !session.authenticated && (
          <section
            data-testid={session.bootstrapped ? "login-panel" : "bootstrap-panel"}
            className={card}
          >
            <SectionTitle
              title={session.bootstrapped ? "Sign in" : "Set up your captain account"}
              hint={
                session.bootstrapped
                  ? undefined
                  : "Paste the one-time token from the container log (docker logs keel), then choose a name and password."
              }
            />
            {authError && (
              <div className="mb-3" data-testid="auth-error-banner">
                <Banner kind="danger">{authError}</Banner>
              </div>
            )}
            <form onSubmit={(e) => void signIn(e)} className="grid gap-3 sm:grid-cols-4">
              {!session.bootstrapped && (
                <input
                  data-testid="bootstrap-token-input"
                  type="password"
                  aria-label="One-time token"
                  placeholder="One-time token"
                  value={bootstrapToken}
                  onChange={(e) => setBootstrapToken(e.target.value)}
                  className={input}
                  required
                />
              )}
              <input
                data-testid="bootstrap-username-input"
                aria-label="Name"
                placeholder="Name"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className={input}
                required
              />
              <input
                data-testid="bootstrap-password-input"
                type="password"
                aria-label="Password"
                placeholder="Password (10+ characters)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={input}
                required
              />
              <button data-testid="bootstrap-submit-btn" type="submit" className={primaryBtn}>
                {session.bootstrapped ? "Sign in" : "Create account"}
              </button>
            </form>
          </section>
        )}

        {session?.authenticated && draft && active && (
          <div data-testid="governance-cockpit" className="space-y-5">
            {message && (
              <Banner kind="ok" testId="gov-success-banner">
                {message}
              </Banner>
            )}
            {error && (
              <Banner kind="danger" testId="gov-error-banner">
                {error}
              </Banner>
            )}

            <section className={card}>
              <SectionTitle
                title="Confirm it's you"
                hint="Saving settings, storing a secret and the Kill Switch ask for your password, plus your authenticator code if you set one up."
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  data-testid="step-up-password-input"
                  type="password"
                  aria-label="Password"
                  placeholder="Password"
                  value={stepUpPassword}
                  onChange={(e) => setStepUpPassword(e.target.value)}
                  className={input}
                />
                <input
                  data-testid="step-up-totp-input"
                  inputMode="numeric"
                  aria-label="Authenticator code"
                  placeholder="Authenticator code (if set up)"
                  value={stepUpTotpCode}
                  onChange={(e) => setStepUpTotpCode(e.target.value)}
                  className={input}
                />
              </div>
            </section>

            <section className={card}>
              <SectionTitle title="Claude and alerts" />
              <p className="mb-3 text-sm" data-testid="claude-status">
                {claudeLinked ? (
                  <span className="text-emerald-300">
                    ● Claude is linked and drafts your boats.
                  </span>
                ) : (
                  <span className="text-amber-300">
                    ● Claude is not linked: the Shipyard offers samples and the night shift waits.
                  </span>
                )}
              </p>
              <div className="space-y-3">
                {LINKS.map((link) => {
                  const meta = secrets.find((s) => s.keyName === link.key);
                  return (
                    <div key={link.key} className="rounded-xl border border-[#243140] p-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-sm font-semibold">{link.label}</span>
                        <span
                          data-testid={`secret-status-${link.key}`}
                          className={`text-xs ${meta?.isConfigured ? "text-emerald-300" : "text-slate-500"}`}
                        >
                          {meta?.isConfigured
                            ? `Stored ${meta.maskedPreview}${meta.updatedAtMs ? ` · ${ago(meta.updatedAtMs)}` : ""}`
                            : "Not set"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-400">{link.hint}</p>
                      <div className="mt-2 flex gap-2">
                        <input
                          data-testid={`secret-input-${link.key}`}
                          type="password"
                          aria-label={link.label}
                          placeholder={link.placeholder}
                          value={secretValues[link.key] ?? ""}
                          onChange={(e) =>
                            setSecretValues((v) => ({ ...v, [link.key]: e.target.value }))
                          }
                          className={input}
                        />
                        <button
                          type="button"
                          data-testid={`secret-save-${link.key}`}
                          disabled={busy}
                          className={primaryBtn}
                          onClick={() => void saveSecret(link.key)}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className={card}>
              <SectionTitle
                title="Autonomy"
                hint="Turn on the Night Shift and the Autopilot, and open a paper wallet named Autopilot in the Treasury, for a fleet Claude researches and fixed rules manage."
              />
              <DutySettings
                config={draft.fleet}
                registry={registry}
                duties={duties}
                inputClass={input}
                onChange={(fleet) => setDraft({ ...draft, fleet })}
              />
              <label className="mt-3 block max-w-sm text-xs">
                <span className="font-semibold text-slate-200">Claude model</span>
                <input
                  data-testid="claude-model-input"
                  className={`${input} mt-1`}
                  value={draft.ai.botDesignerModel}
                  onChange={(e) =>
                    setDraft({ ...draft, ai: { ...draft.ai, botDesignerModel: e.target.value } })
                  }
                />
              </label>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  data-testid="save-config-btn"
                  disabled={busy || !dirty}
                  className={primaryBtn}
                  onClick={() => void saveSettings()}
                >
                  Save settings
                </button>
                {dirty && (
                  <button
                    type="button"
                    className={ghostBtn}
                    onClick={() => setDraft(active.config)}
                  >
                    Discard changes
                  </button>
                )}
                <span className="text-xs text-slate-500">
                  Version{" "}
                  <span data-testid="config-version-display" className="text-slate-300">
                    v{active.version}
                  </span>
                </span>
              </div>
              {history.length > 1 && (
                <details className="mt-4 text-xs">
                  <summary className="cursor-pointer text-slate-400">Earlier versions</summary>
                  <ul className="mt-2 space-y-1">
                    {history.slice(0, 8).map((snap) => (
                      <li key={snap.version} className="flex items-center gap-3">
                        <span className="w-10 text-slate-300">v{snap.version}</span>
                        <span className="flex-1 text-slate-400">
                          {snap.reason} · {ago(snap.createdAtMs)}
                        </span>
                        {snap.version !== active.version && (
                          <button
                            type="button"
                            data-testid={`rollback-version-${snap.version}-btn`}
                            className={ghostBtn}
                            disabled={busy}
                            onClick={() => void restore(snap.version)}
                          >
                            Restore
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>

            <section className={card}>
              <SectionTitle title="Safety" />
              <div className="flex flex-wrap items-center gap-3">
                <span
                  data-testid="kill-switch-status"
                  className={`text-sm ${killed ? "text-rose-300" : "text-emerald-300"}`}
                >
                  {killed
                    ? `● Kill Switch on: ${breaker?.reason ?? ""}`
                    : "● Kill Switch off: boats trade normally"}
                </span>
                <button
                  type="button"
                  data-testid="kill-switch-btn"
                  disabled={busy}
                  className={killed ? ghostBtn : dangerBtn}
                  onClick={() => void toggleKillSwitch()}
                >
                  {killed ? "Reset the Kill Switch" : "Pull the Kill Switch"}
                </button>
              </div>
              <p className="mt-2 text-xs text-slate-400">
                Pulling it closes every paper position at once, and no boat opens a new one until
                you reset it.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-[#243140] pt-4">
                <button
                  type="button"
                  data-testid="backup-btn"
                  disabled={busy}
                  className={ghostBtn}
                  onClick={() => void backup()}
                >
                  Back up the database now
                </button>
                <span className="text-xs text-slate-400">
                  A consistent copy of everything goes to the backups folder.
                </span>
              </div>
            </section>

            <section className={card}>
              <SectionTitle
                title="Market data"
                hint="Confirmed hourly bars and settled funding Keel holds for each coin."
              />
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs" data-testid="coverage-table">
                  <thead className="text-slate-400">
                    <tr>
                      <th className="py-1.5 font-medium">Coin</th>
                      <th className="py-1.5 font-medium">Hourly bars</th>
                      <th className="py-1.5 font-medium">Funding settlements</th>
                      <th className="py-1.5 font-medium">Latest bar</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono-tabular">
                    {coverage.map((c) => (
                      <tr
                        key={c.instrumentId}
                        data-testid={`coverage-${c.instrumentId}`}
                        className="border-t border-[#1E2833]"
                      >
                        <td className="py-1.5 text-slate-200">{coin(c.instrumentId)}</td>
                        <td className="py-1.5">{(c.barCounts["1H"] ?? 0).toLocaleString()}</td>
                        <td className="py-1.5">{c.fundingCount.toLocaleString()}</td>
                        <td className="py-1.5 text-slate-400">{ago(c.latestCloseTs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className={card}>
              <SectionTitle
                title="Recent activity"
                hint="Every change to settings, secrets and safety is recorded."
              />
              <table data-testid="audit-log-table" className="w-full text-left text-xs">
                <tbody>
                  {audit.slice(0, 15).map((ev) => (
                    <tr key={ev.id} className="border-t border-[#1E2833]">
                      <td className="w-28 py-1.5 text-slate-400">{ago(ev.ts)}</td>
                      <td className="py-1.5 text-slate-200">
                        {ACTIONS[ev.action] ?? ev.action}{" "}
                        <span className="text-slate-500">({ev.action})</span>
                      </td>
                      <td className="py-1.5 text-right text-slate-500">{ev.actor}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
