import { useCallback, useEffect, useState } from "react";
import {
  keelApiContract,
  type AuditEventRecord,
  type AuthSessionResponse,
  type ConfigDiffResult,
  type ConfigFieldMetadata,
  type ConfigRiskClass,
  type ConfigSnapshotRecord,
  type KeelConfig,
  type SecretKeyName,
  type SecretMetadataRecord,
  type SystemStatusResponse
} from "@keel/core";
import { initClient } from "@ts-rest/core";

const apiClient = initClient(keelApiContract, {
  baseUrl: "",
  baseHeaders: {}
});

const RISK_BADGE_STYLES: Record<ConfigRiskClass, string> = {
  safe: "border-emerald-500/40 bg-emerald-500/15 text-emerald-400",
  confirm: "border-amber-500/40 bg-amber-500/15 text-amber-400",
  "restart-required": "border-sky-500/40 bg-sky-500/15 text-sky-400",
  "locked-in-live": "border-rose-500/40 bg-rose-500/15 text-rose-400"
};

function extractApiError(body: unknown, fallback = "Request failed"): string {
  if (
    body !== null &&
    typeof body === "object" &&
    "error" in body &&
    typeof (body as { error: unknown }).error === "string"
  ) {
    return (body as { error: string }).error;
  }
  return fallback;
}

export function App() {
  const [status, setStatus] = useState<SystemStatusResponse | null>(null);
  const [authSession, setAuthSession] = useState<AuthSessionResponse | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [streamConnected, setStreamConnected] = useState(false);

  // Bootstrap / Login form states
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [username, setUsername] = useState("captain");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);

  // Authenticated governance states
  const [activeSnapshot, setActiveSnapshot] = useState<ConfigSnapshotRecord | null>(null);
  const [draftConfig, setDraftConfig] = useState<KeelConfig | null>(null);
  const [registry, setRegistry] = useState<readonly ConfigFieldMetadata[]>([]);
  const [history, setHistory] = useState<readonly ConfigSnapshotRecord[]>([]);
  const [secrets, setSecrets] = useState<readonly SecretMetadataRecord[]>([]);
  const [auditEvents, setAuditEvents] = useState<readonly AuditEventRecord[]>([]);
  const [diffPreview, setDiffPreview] = useState<ConfigDiffResult | null>(null);
  const [changeReason, setChangeReason] = useState("Operator tuning");
  const [stepUpPassword, setStepUpPassword] = useState("");
  const [govMessage, setGovMessage] = useState<string | null>(null);
  const [govError, setGovError] = useState<string | null>(null);

  // Secret Vault form state
  const [selectedSecretKey, setSelectedSecretKey] = useState<SecretKeyName>("geminiApiKey");
  const [secretPlaintext, setSecretPlaintext] = useState("");

  const refreshSystemAndSession = useCallback(async () => {
    const [statusRes, sessRes] = await Promise.all([
      apiClient.system.getStatus(),
      apiClient.auth.getSession()
    ]);
    if (statusRes.status === 200) {
      setStatus(statusRes.body);
    }
    if (sessRes.status === 200) {
      setAuthSession(sessRes.body);
      return sessRes.body;
    }
    return null;
  }, []);

  const refreshGovernanceData = useCallback(async () => {
    const [cfgRes, histRes, secRes, audRes] = await Promise.all([
      apiClient.config.getActive(),
      apiClient.config.getHistory(),
      apiClient.secrets.listMetadata(),
      apiClient.audit.listRecent()
    ]);
    if (cfgRes.status === 200) {
      setActiveSnapshot(cfgRes.body.active);
      setDraftConfig(cfgRes.body.active.config);
      setRegistry(cfgRes.body.registry);
    }
    if (histRes.status === 200) {
      setHistory(histRes.body.history);
    }
    if (secRes.status === 200) {
      setSecrets(secRes.body.secrets);
    }
    if (audRes.status === 200) {
      setAuditEvents(audRes.body.events);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void refreshSystemAndSession()
      .then((sess) => {
        if (active && sess?.authenticated) {
          void refreshGovernanceData();
        }
      })
      .catch(() => {
        // Handled by offline indicator in UI
      });

    const source = new EventSource("/api/v1/stream/heartbeat");
    source.addEventListener("heartbeat", () => {
      if (active) {
        setStreamConnected(true);
      }
    });
    source.onerror = () => {
      if (active) {
        setStreamConnected(false);
      }
    };

    return () => {
      active = false;
      source.close();
    };
  }, [refreshSystemAndSession, refreshGovernanceData]);

  const handleBootstrap = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    const res = await apiClient.auth.bootstrap({
      body: { bootstrapToken, username, password }
    });
    if (res.status === 200) {
      setStepUpPassword(password);
      await refreshSystemAndSession();
      await refreshGovernanceData();
    } else {
      setAuthError(extractApiError(res.body));
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    const res = await apiClient.auth.login({
      body: { username, password }
    });
    if (res.status === 200) {
      setStepUpPassword(password);
      await refreshSystemAndSession();
      await refreshGovernanceData();
    } else {
      setAuthError(extractApiError(res.body));
    }
  };

  const handleLogout = async () => {
    await apiClient.auth.logout({ body: {} });
    setActiveSnapshot(null);
    setDraftConfig(null);
    await refreshSystemAndSession();
  };

  const handlePreviewDiff = async () => {
    if (!draftConfig) return;
    setGovError(null);
    const res = await apiClient.config.previewDiff({
      body: { config: draftConfig }
    });
    if (res.status === 200) {
      setDiffPreview(res.body);
    }
  };

  const handleSaveConfig = async () => {
    if (!draftConfig) return;
    setGovError(null);
    setGovMessage(null);
    const res = await apiClient.config.updateConfig({
      body: {
        config: draftConfig,
        reason: changeReason,
        stepUpPassword: stepUpPassword || undefined
      }
    });
    if (res.status === 200) {
      setDiffPreview(res.body.diff);
      setGovMessage(`Saved Config Version v${res.body.snapshot.version}`);
      await refreshSystemAndSession();
      await refreshGovernanceData();
    } else {
      setGovError(extractApiError(res.body));
    }
  };

  const handleRollback = async (targetVersion: number) => {
    setGovError(null);
    setGovMessage(null);
    const res = await apiClient.config.rollbackConfig({
      body: {
        targetVersion,
        reason: `Rollback to v${targetVersion}`,
        stepUpPassword: stepUpPassword || undefined
      }
    });
    if (res.status === 200) {
      setGovMessage(`Rolled back to v${targetVersion} (now v${res.body.snapshot.version})`);
      await refreshSystemAndSession();
      await refreshGovernanceData();
    } else {
      setGovError(extractApiError(res.body));
    }
  };

  const handleSaveSecret = async (e: React.FormEvent) => {
    e.preventDefault();
    setGovError(null);
    setGovMessage(null);
    const res = await apiClient.secrets.upsertSecret({
      body: {
        keyName: selectedSecretKey,
        plaintextValue: secretPlaintext,
        stepUpPassword: stepUpPassword || undefined
      }
    });
    if (res.status === 200) {
      setSecretPlaintext("");
      setGovMessage(
        `Encrypted & stored ${res.body.secret.keyName} (${res.body.secret.maskedPreview})`
      );
      await refreshGovernanceData();
    } else {
      setGovError(extractApiError(res.body));
    }
  };

  const handleCreateBackup = async () => {
    setGovError(null);
    setGovMessage(null);
    const res = await apiClient.system.createBackup({ body: {} });
    if (res.status === 200) {
      setGovMessage(
        `SQLite Backup created: ${res.body.backup.fileName} (integrityOk=${String(res.body.backup.integrityOk)})`
      );
      await refreshGovernanceData();
    } else {
      setGovError(extractApiError(res.body));
    }
  };

  const isDark = theme === "dark";
  const executionMode = status?.executionMode ?? "Paper";
  const isHealthy = streamConnected && status?.status === "ok";
  const cardClass = isDark
    ? "rounded-xl border border-[#222C36] bg-[#161D24] p-5"
    : "rounded-xl border border-stone-300 bg-[#F3EFE6] p-5";
  const inputClass = isDark
    ? "w-full rounded-md border border-slate-700 bg-[#0F1419] px-3 py-1.5 text-sm text-slate-100"
    : "w-full rounded-md border border-stone-400 bg-white px-3 py-1.5 text-sm text-slate-900";

  const getFieldRiskClass = (path: string): ConfigRiskClass =>
    registry.find((r) => r.path === path)?.riskClass ?? "confirm";

  return (
    <div
      className={
        isDark
          ? "min-h-screen bg-[#0F1419] text-slate-100 transition-colors"
          : "min-h-screen bg-[#FBF9F5] text-[#182026] transition-colors"
      }
    >
      <header
        className={
          isDark
            ? "border-b border-[#222C36] bg-[#161D24] px-6 py-4"
            : "border-b border-stone-300 bg-[#F3EFE6] px-6 py-4"
        }
      >
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {/* Keel Logo Mark: Hull Cross-Section & Error-Bar Balance Spine */}
            <svg
              aria-label="Keel logo"
              className="h-8 w-8 text-[#0D9488]"
              viewBox="0 0 32 32"
              fill="none"
            >
              <path
                d="M5 11C5 18.5 10.5 23 16 25C21.5 23 27 18.5 27 11H5Z"
                stroke="currentColor"
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
              <line
                x1="12"
                y1="6"
                x2="20"
                y2="6"
                stroke="#F59E0B"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            <div>
              <h1 className="text-lg font-bold tracking-tight">Keel</h1>
              <p className="text-xs opacity-75">
                Systematic Crypto-Derivatives Research &amp; Execution
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span
              data-testid="execution-mode-badge"
              className="inline-flex items-center gap-1.5 rounded-full border border-teal-500/40 bg-teal-500/15 px-3 py-1 text-xs font-semibold tracking-wider text-teal-400 uppercase"
            >
              <span className="h-2 w-2 rounded-full bg-teal-400" />
              {executionMode}
            </span>

            <span
              data-testid="heartbeat-indicator"
              className="font-mono-tabular inline-flex items-center gap-1.5 rounded-md border border-slate-700/60 px-2.5 py-1 text-xs"
            >
              <span
                className={
                  isHealthy
                    ? "h-2 w-2 rounded-full bg-emerald-400"
                    : "h-2 w-2 rounded-full bg-amber-400"
                }
              />
              {isHealthy ? "HEARTBEAT OK" : "CONNECTING"}
            </span>

            <button
              type="button"
              onClick={() => setTheme(isDark ? "light" : "dark")}
              className="rounded-md border border-slate-600/50 px-3 py-1 text-xs font-medium hover:border-teal-500"
            >
              {isDark ? "Chart Paper (Light)" : "Night Watch (Dark)"}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div className="grid gap-6 md:grid-cols-3">
          <section className={cardClass}>
            <h2 className="text-xs font-semibold tracking-wider uppercase opacity-70">
              Paper Portfolio Equity
            </h2>
            <p
              data-testid="paper-equity-display"
              className="font-mono-tabular mt-2 text-2xl font-semibold text-emerald-400"
            >
              10,000.00 USDT
            </p>
            <p className="mt-1 text-xs opacity-70">
              Unit Risk (1R): <span className="font-mono-tabular">0.75% (75.00 USDT)</span>
            </p>
          </section>

          <section className={cardClass}>
            <h2 className="text-xs font-semibold tracking-wider uppercase opacity-70">
              Deterministic Config Hash
            </h2>
            <p
              data-testid="config-hash-display"
              className="font-mono-tabular mt-2 text-lg font-medium"
            >
              {status ? status.configHash.slice(0, 16) : "----------------"}
            </p>
            <p className="mt-1 text-xs opacity-70">
              Version:{" "}
              <span data-testid="config-version-display" className="font-mono-tabular">
                v{status?.configVersion ?? 1}
              </span>{" "}
              · Hold Stop Policy
            </p>
          </section>

          <section className={cardClass}>
            <h2 className="text-xs font-semibold tracking-wider uppercase opacity-70">
              Ingress &amp; Clock Telemetry
            </h2>
            <p
              data-testid="server-clock-display"
              className="font-mono-tabular mt-2 text-sm font-medium"
            >
              {status ? status.serverTimeIso : "Synchronizing clock..."}
            </p>
            <p className="mt-1 text-xs opacity-70">
              Cloudflare Tunnel:{" "}
              <span className="font-mono-tabular">
                {status?.cloudflareTunnelActive ? "Detected" : "Direct / Local"}
              </span>
            </p>
          </section>
        </div>

        {/* Unauthenticated Bootstrap / Login Gate */}
        {authSession && !authSession.authenticated && (
          <section
            data-testid={authSession.bootstrapped ? "login-panel" : "bootstrap-panel"}
            className={cardClass}
          >
            <h2 className="text-base font-bold">
              {authSession.bootstrapped
                ? "Operator Session Sign-In (ADR-0003)"
                : "First-Boot Operator Bootstrap (ADR-0003)"}
            </h2>
            <p className="mt-1 text-xs opacity-75">
              {authSession.bootstrapped
                ? "Sign in with your Argon2id/Scrypt operator credentials to access configuration governance and the AES-256-GCM secret vault."
                : "Enter the one-time bootstrap token printed to container stdout to initialize the operator account."}
            </p>

            {authError && (
              <div
                data-testid="auth-error-banner"
                className="mt-3 rounded-md border border-rose-500/50 bg-rose-500/10 px-3 py-2 text-xs text-rose-400"
              >
                {authError}
              </div>
            )}

            <form
              onSubmit={(e) =>
                void (authSession.bootstrapped ? handleLogin(e) : handleBootstrap(e))
              }
              className="mt-4 grid gap-4 md:grid-cols-4"
            >
              {!authSession.bootstrapped && (
                <div>
                  <label className="mb-1 block text-xs font-medium">One-Time Bootstrap Token</label>
                  <input
                    data-testid="bootstrap-token-input"
                    type="password"
                    value={bootstrapToken}
                    onChange={(e) => setBootstrapToken(e.target.value)}
                    placeholder="Paste container log token"
                    className={inputClass}
                    required
                  />
                </div>
              )}
              <div>
                <label className="mb-1 block text-xs font-medium">Operator Username</label>
                <input
                  data-testid="bootstrap-username-input"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className={inputClass}
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium">Password (min 10 chars)</label>
                <input
                  data-testid="bootstrap-password-input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputClass}
                  required
                />
              </div>
              <div className="flex items-end">
                <button
                  data-testid="bootstrap-submit-btn"
                  type="submit"
                  className="w-full rounded-md bg-[#0D9488] px-4 py-2 text-xs font-semibold text-white hover:bg-teal-600"
                >
                  {authSession.bootstrapped ? "Sign In" : "Initialize Operator Account"}
                </button>
              </div>
            </form>
          </section>
        )}

        {/* Authenticated Governance Cockpit */}
        {authSession?.authenticated && draftConfig && activeSnapshot && (
          <div data-testid="governance-cockpit" className="space-y-6">
            <section className={cardClass}>
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-700/50 pb-4">
                <div>
                  <h2 className="text-base font-bold">
                    Configuration Governance &amp; Risk-Class Controls
                  </h2>
                  <p className="text-xs opacity-75">
                    Signed in as{" "}
                    <span
                      data-testid="authenticated-user-badge"
                      className="font-mono-tabular font-semibold text-teal-400"
                    >
                      {authSession.username}
                    </span>{" "}
                    · Active Snapshot{" "}
                    <span className="font-mono-tabular">v{activeSnapshot.version}</span>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    data-testid="create-backup-btn"
                    type="button"
                    onClick={() => void handleCreateBackup()}
                    className="rounded-md border border-teal-500/40 bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-300 hover:bg-teal-500/25"
                  >
                    Create Atomic SQLite Backup
                  </button>
                  <button
                    data-testid="logout-btn"
                    type="button"
                    onClick={() => void handleLogout()}
                    className="rounded-md border border-slate-600 px-3 py-1.5 text-xs font-medium hover:border-rose-500"
                  >
                    Sign Out
                  </button>
                </div>
              </div>

              {govMessage && (
                <div
                  data-testid="gov-success-banner"
                  className="mt-4 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300"
                >
                  {govMessage}
                </div>
              )}
              {govError && (
                <div
                  data-testid="gov-error-banner"
                  className="mt-4 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"
                >
                  {govError}
                </div>
              )}

              <div className="mt-4 grid gap-4 md:grid-cols-3">
                <div className="rounded-lg border border-slate-700/60 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold">Daily Gemini Cap (USD)</span>
                    <span
                      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${RISK_BADGE_STYLES[getFieldRiskClass("ai.dailyBudgetUsd")]}`}
                    >
                      {getFieldRiskClass("ai.dailyBudgetUsd")}
                    </span>
                  </div>
                  <input
                    data-testid="input-daily-budget"
                    type="number"
                    step="0.05"
                    value={draftConfig.ai.dailyBudgetUsd}
                    onChange={(e) =>
                      setDraftConfig({
                        ...draftConfig,
                        ai: {
                          ...draftConfig.ai,
                          dailyBudgetUsd: Number(e.target.value)
                        }
                      })
                    }
                    className={`${inputClass} font-mono-tabular mt-2`}
                  />
                </div>

                <div className="rounded-lg border border-slate-700/60 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold">Enable AI Strategy Lab</span>
                    <span
                      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${RISK_BADGE_STYLES[getFieldRiskClass("ai.strategyLabEnabled")]}`}
                    >
                      {getFieldRiskClass("ai.strategyLabEnabled")}
                    </span>
                  </div>
                  <label className="mt-3 flex items-center gap-2 text-xs">
                    <input
                      data-testid="toggle-strategy-lab"
                      type="checkbox"
                      checked={draftConfig.ai.strategyLabEnabled}
                      onChange={(e) =>
                        setDraftConfig({
                          ...draftConfig,
                          ai: {
                            ...draftConfig.ai,
                            strategyLabEnabled: e.target.checked
                          }
                        })
                      }
                    />
                    <span>Allow sandboxed worker_threads candidate generation</span>
                  </label>
                </div>

                <div className="rounded-lg border border-slate-700/60 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold">Unit Risk per Trade (1R %)</span>
                    <span
                      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${RISK_BADGE_STYLES[getFieldRiskClass("risk.strategy.riskPerTradePct")]}`}
                    >
                      {getFieldRiskClass("risk.strategy.riskPerTradePct")}
                    </span>
                  </div>
                  <p className="font-mono-tabular mt-2 text-sm">
                    {draftConfig.risk.strategy.riskPerTradePct}%
                  </p>
                </div>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-3">
                <div>
                  <label className="mb-1 block text-xs font-medium">Reason for Change</label>
                  <input
                    data-testid="config-reason-input"
                    type="text"
                    value={changeReason}
                    onChange={(e) => setChangeReason(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium">
                    Step-Up Password (required for confirm/locked)
                  </label>
                  <input
                    data-testid="step-up-password-input"
                    type="password"
                    value={stepUpPassword}
                    onChange={(e) => setStepUpPassword(e.target.value)}
                    placeholder="Confirm operator password"
                    className={inputClass}
                  />
                </div>
                <div className="flex items-end gap-2">
                  <button
                    data-testid="preview-diff-btn"
                    type="button"
                    onClick={() => void handlePreviewDiff()}
                    className="rounded-md border border-slate-600 px-3 py-2 text-xs font-semibold hover:border-teal-500"
                  >
                    Preview Diff
                  </button>
                  <button
                    data-testid="save-config-btn"
                    type="button"
                    onClick={() => void handleSaveConfig()}
                    className="rounded-md bg-[#0D9488] px-4 py-2 text-xs font-semibold text-white hover:bg-teal-600"
                  >
                    Save Config Version
                  </button>
                </div>
              </div>

              {diffPreview && (
                <div
                  data-testid="diff-preview-box"
                  className="mt-4 rounded-lg border border-slate-700/60 bg-slate-900/40 p-3 text-xs"
                >
                  <div className="flex items-center gap-4 font-mono">
                    <span>Changes: {diffPreview.changes.length}</span>
                    <span>Highest Risk: {diffPreview.highestRiskClass}</span>
                    <span>Step-Up Required: {String(diffPreview.requiresStepUp)}</span>
                  </div>
                </div>
              )}
            </section>

            <div className="grid gap-6 md:grid-cols-2">
              {/* Version History & Rollback */}
              <section className={cardClass}>
                <h3 className="text-sm font-bold">Versioned Config Snapshots &amp; Rollback</h3>
                <ul className="mt-3 space-y-2 text-xs">
                  {history.map((snap) => (
                    <li
                      key={snap.version}
                      className="flex items-center justify-between rounded border border-slate-700/50 px-3 py-2"
                    >
                      <div>
                        <span className="font-mono-tabular font-bold text-teal-400">
                          v{snap.version}
                        </span>{" "}
                        · <span className="font-mono-tabular">{snap.configHash.slice(0, 12)}</span>{" "}
                        · <span className="opacity-75">{snap.reason}</span>
                      </div>
                      {snap.version !== activeSnapshot.version && (
                        <button
                          data-testid={`rollback-version-${snap.version}-btn`}
                          type="button"
                          onClick={() => void handleRollback(snap.version)}
                          className="rounded border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 text-[11px] font-semibold text-amber-300 hover:bg-amber-500/25"
                        >
                          Rollback to v{snap.version}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>

              {/* AES-256-GCM Secret Vault */}
              <section className={cardClass}>
                <h3 className="text-sm font-bold">AES-256-GCM Secret Vault</h3>
                <form onSubmit={(e) => void handleSaveSecret(e)} className="mt-3 flex gap-2">
                  <select
                    data-testid="vault-key-select"
                    value={selectedSecretKey}
                    onChange={(e) => setSelectedSecretKey(e.target.value as SecretKeyName)}
                    className={inputClass}
                  >
                    <option value="geminiApiKey">geminiApiKey</option>
                    <option value="discordWebhookUrl">discordWebhookUrl</option>
                    <option value="okxApiKey">okxApiKey</option>
                    <option value="okxSecretKey">okxSecretKey</option>
                    <option value="okxPassphrase">okxPassphrase</option>
                  </select>
                  <input
                    data-testid="vault-value-input"
                    type="password"
                    value={secretPlaintext}
                    onChange={(e) => setSecretPlaintext(e.target.value)}
                    placeholder="Plaintext secret value"
                    className={inputClass}
                    required
                  />
                  <button
                    data-testid="vault-save-btn"
                    type="submit"
                    className="rounded-md bg-[#0D9488] px-3 py-1.5 text-xs font-semibold text-white"
                  >
                    Encrypt
                  </button>
                </form>

                <ul className="mt-3 space-y-1.5 text-xs">
                  {secrets.map((sec) => (
                    <li
                      key={sec.keyName}
                      className="flex items-center justify-between rounded border border-slate-700/50 px-3 py-1.5 font-mono"
                    >
                      <span>{sec.keyName}</span>
                      <span>
                        {sec.isConfigured ? (
                          <span className="text-emerald-400">{sec.maskedPreview}</span>
                        ) : (
                          <span className="opacity-50">unconfigured</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>

            {/* Complete CONFIG_FIELD_REGISTRY Specification Table */}
            <section className={cardClass}>
              <h3 className="text-sm font-bold">
                Config Schema Registry Reference ({registry.length} Registered Fields)
              </h3>
              <div className="mt-3 max-h-64 overflow-y-auto">
                <table data-testid="config-registry-table" className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-700/60 opacity-70">
                      <th className="py-1.5">Path</th>
                      <th className="py-1.5">Label &amp; Help</th>
                      <th className="py-1.5">Bounds / Unit</th>
                      <th className="py-1.5">Default</th>
                      <th className="py-1.5">Risk Class</th>
                    </tr>
                  </thead>
                  <tbody>
                    {registry.map((field) => (
                      <tr key={field.path} className="border-b border-slate-800/60">
                        <td className="font-mono-tabular py-1.5 pr-2">{field.path}</td>
                        <td className="py-1.5 pr-2">
                          <div className="font-semibold">{field.label}</div>
                          <div className="text-[11px] opacity-70">{field.helpText}</div>
                        </td>
                        <td className="font-mono-tabular py-1.5 pr-2">
                          {field.min !== undefined || field.max !== undefined
                            ? `${field.min ?? "-"}..${field.max ?? "-"}`
                            : "-"}{" "}
                          {field.unit ?? ""}
                        </td>
                        <td className="font-mono-tabular py-1.5 pr-2">
                          {JSON.stringify(field.defaultValue)}
                        </td>
                        <td className="py-1.5">
                          <span
                            className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${RISK_BADGE_STYLES[field.riskClass]}`}
                          >
                            {field.riskClass}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Immutable Audit Trail */}
            <section className={cardClass}>
              <h3 className="text-sm font-bold">Immutable Audit Trail (SQLite WAL)</h3>
              <div className="mt-3 overflow-x-auto">
                <table data-testid="audit-log-table" className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-700/60 opacity-70">
                      <th className="py-1.5">ID</th>
                      <th className="py-1.5">Action</th>
                      <th className="py-1.5">Actor</th>
                      <th className="py-1.5">Client IP</th>
                      <th className="py-1.5">Risk Class</th>
                      <th className="py-1.5">Config Hash</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono-tabular">
                    {auditEvents.map((ev) => (
                      <tr key={ev.id} className="border-b border-slate-800/60">
                        <td className="py-1.5">#{ev.id}</td>
                        <td className="py-1.5 text-teal-400">{ev.action}</td>
                        <td className="py-1.5">{ev.actor}</td>
                        <td className="py-1.5">{ev.clientIp}</td>
                        <td className="py-1.5">{ev.riskClass}</td>
                        <td className="py-1.5">{ev.configHash.slice(0, 12)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
