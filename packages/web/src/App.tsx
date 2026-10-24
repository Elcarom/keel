import { useCallback, useEffect, useState } from "react";
import {
  keelApiContract,
  type AuditEventRecord,
  type AuthSessionResponse,
  type CircuitBreakerRecord,
  type ConfigDiffResult,
  type ConfigFieldMetadata,
  type ConfigRiskClass,
  type ConfigSnapshotRecord,
  type ContextFeatureRecord,
  type DmsStatus,
  type EventGateEvaluation,
  type ExchangeOrderResult,
  type ExperimentRecord,
  type KeelConfig,
  type LedgerTrialBalance,
  type MarketSummaryResponse,
  type MarkoutForensicReport,
  type NarrativeClusterRecord,
  type PaperOrderRecord,
  type PaperPositionRecord,
  type ReconciliationResult,
  type SecretKeyName,
  type SecretMetadataRecord,
  type StrategyPromotionRecord,
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

  // M2 Market Data & Replay Research Lab state
  const [marketSummary, setMarketSummary] = useState<MarketSummaryResponse | null>(null);
  const [experiments, setExperiments] = useState<readonly ExperimentRecord[]>([]);
  const [selectedStrategyId, setSelectedStrategyId] = useState("donchian-trend-v1");
  const [selectedInstrumentId, setSelectedInstrumentId] = useState("BTC-USDT-SWAP");
  const [replayRunning, setReplayRunning] = useState(false);

  // M3 Risk Guardian, Paper Execution, Double-Entry Ledger, & Promotion state
  const [paperCircuitBreaker, setPaperCircuitBreaker] = useState<CircuitBreakerRecord | null>(null);
  const [trialBalance, setTrialBalance] = useState<LedgerTrialBalance | null>(null);
  const [openPositions, setOpenPositions] = useState<readonly PaperPositionRecord[]>([]);
  const [_recentOrders, setRecentOrders] = useState<readonly PaperOrderRecord[]>([]);
  const [promotions, setPromotions] = useState<readonly StrategyPromotionRecord[]>([]);
  const [paperTickRunning, setPaperTickRunning] = useState(false);
  const [flattenRunning, setFlattenRunning] = useState(false);
  // M4 AI Decision Support & Budget state
  const [aiStatus, setAiStatus] = useState<{
    enabled: boolean;
    provider: string;
    fastModel: string;
    reasoningModel: string;
    remainingDailyBudgetUsd: number;
    remainingMonthlyBudgetUsd: number;
    dailyBudgetUsd: number;
    monthlyBudgetUsd: number;
  } | null>(null);
  const [contextInputText, setContextInputText] = useState(
    "FOMC holds federal funds rate steady; chair remarks that monetary policy remains sufficiently restrictive."
  );
  const [extractedFeatures, setExtractedFeatures] = useState<readonly ContextFeatureRecord[]>([]);
  const [shadowResult, setShadowResult] = useState<{
    baselineChosenProposalId: string | null;
    shadowChosenProposalId: string | null;
    shadowConfidence: number;
    shadowRationale: string;
    agreement: boolean;
    trainingContaminated: boolean;
  } | null>(null);
  const [extractingContext, setExtractingContext] = useState(false);
  const [evaluatingShadow, setEvaluatingShadow] = useState(false);

  // M6 Advanced AI Decision Support state
  const [eventGateEvaluation, setEventGateEvaluation] = useState<EventGateEvaluation | null>(null);
  const [evaluatingEventGate, setEvaluatingEventGate] = useState(false);
  const [eventShockInput, setEventShockInput] = useState(
    "Emergency Fed rate decision: surprise 50 bps inter-meeting hike announced"
  );
  const [narrativeClusters, setNarrativeClusters] = useState<readonly NarrativeClusterRecord[]>([]);
  const [clusteringNarratives, setClusteringNarratives] = useState(false);
  const [markoutReport, setMarkoutReport] = useState<MarkoutForensicReport | null>(null);
  const [analyzingMarkout, setAnalyzingMarkout] = useState(false);

  // M5 Exchange Broker & Attached Stops state
  const [brokerStatus, setBrokerStatus] = useState<{
    connected: boolean;
    venue: string;
    dms: DmsStatus;
    openPositionsCount: number;
    openOrdersCount: number;
  } | null>(null);
  const [submittedExchangeOrders, setSubmittedExchangeOrders] = useState<
    readonly ExchangeOrderResult[]
  >([]);
  const [reconciliation, setReconciliation] = useState<ReconciliationResult | null>(null);
  const [orderSide, setOrderSide] = useState<"long" | "short">("long");
  const [orderSizeLots, setOrderSizeLots] = useState(1);
  const [orderEntryPrice, setOrderEntryPrice] = useState("50000.00");
  const [orderStopPrice, setOrderStopPrice] = useState("48500.00");
  const [orderTakeProfitPrice, _setOrderTakeProfitPrice] = useState("53000.00");
  const [submittingOrder, setSubmittingOrder] = useState(false);
  const [sendingDms, setSendingDms] = useState(false);
  const [reconciling, setReconciling] = useState(false);

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
    const [cfgRes, histRes, secRes, audRes, mktRes, expRes, paperRes, aiRes, brkRes] =
      await Promise.all([
        apiClient.config.getActive(),
        apiClient.config.getHistory(),
        apiClient.secrets.listMetadata(),
        apiClient.audit.listRecent(),
        apiClient.market.getSummary(),
        apiClient.replay.listExperiments(),
        apiClient.paper.getStatus(),
        apiClient.ai.getStatus(),
        apiClient.broker.getStatus()
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
    if (mktRes.status === 200) {
      setMarketSummary(mktRes.body);
    }
    if (expRes.status === 200) {
      setExperiments(expRes.body.experiments);
    }
    if (paperRes.status === 200) {
      setPaperCircuitBreaker(paperRes.body.circuitBreaker);
      setTrialBalance(paperRes.body.trialBalance);
      setOpenPositions(paperRes.body.openPositions);
      setRecentOrders(paperRes.body.recentOrders);
      setPromotions(paperRes.body.promotions);
    }
    if (aiRes.status === 200) {
      setAiStatus(aiRes.body);
    }
    if (brkRes.status === 200) {
      setBrokerStatus(brkRes.body);
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

  const handleSeedMarket = async () => {
    setGovError(null);
    setGovMessage(null);
    const res = await apiClient.market.seedSynthetic({
      body: {
        instrumentId: selectedInstrumentId,
        barCount1H: 240
      }
    });
    if (res.status === 200) {
      setGovMessage(
        `Seeded confirmed market bars (${res.body.snapshot.barCount} bars, snapshot=${res.body.snapshot.snapshotId.slice(0, 12)})`
      );
      await refreshGovernanceData();
    } else {
      setGovError(extractApiError(res.body));
    }
  };

  const handleRunReplay = async () => {
    setGovError(null);
    setGovMessage(null);
    setReplayRunning(true);
    try {
      const res = await apiClient.replay.runBacktest({
        body: {
          strategyId: selectedStrategyId,
          instrumentId: selectedInstrumentId,
          timeframe: "1H"
        }
      });
      if (res.status === 200) {
        const exp = res.body.experiment;
        setGovMessage(
          `Replay complete: ${exp.strategyId} on ${exp.instrumentId} (${exp.totalTrades} trades, AvgR=${exp.avgR.toFixed(2)}, 2x-StressR=${exp.stressNetExpectancyR.toFixed(2)}, DSR=${exp.deflatedSharpeRatio.toFixed(2)})`
        );
        await refreshGovernanceData();
      } else {
        setGovError(extractApiError(res.body));
      }
    } finally {
      setReplayRunning(false);
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

            {/* M2 Market Data & Replay Research Lab */}
            <section data-testid="replay-lab-panel" className={cardClass}>
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-700/50 pb-4">
                <div>
                  <h3 className="text-sm font-bold">
                    Confirmed Market Store &amp; Event-Driven Replay Research Lab (M2)
                  </h3>
                  <p className="text-xs opacity-75">
                    Strictly causal confirmed-bar views (`confirm === &quot;1&quot;`), 8h settled
                    funding, 2x cost-stress expectancy, Purged Walk-Forward, and Deflated Sharpe
                    Ratio.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    data-testid="instrument-select"
                    value={selectedInstrumentId}
                    onChange={(e) => setSelectedInstrumentId(e.target.value)}
                    className={
                      isDark
                        ? "rounded-md border border-slate-700 bg-[#0F1419] px-2.5 py-1.5 text-xs text-slate-100"
                        : "rounded-md border border-stone-400 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                    }
                  >
                    <option value="BTC-USDT-SWAP">BTC-USDT-SWAP</option>
                    <option value="ETH-USDT-SWAP">ETH-USDT-SWAP</option>
                  </select>
                  <button
                    data-testid="seed-market-btn"
                    type="button"
                    onClick={() => void handleSeedMarket()}
                    className="rounded-md border border-teal-500/40 bg-teal-500/15 px-3 py-1.5 text-xs font-semibold text-teal-300 hover:bg-teal-500/25"
                  >
                    Seed Confirmed Bars (240h)
                  </button>
                  <select
                    data-testid="strategy-select"
                    value={selectedStrategyId}
                    onChange={(e) => setSelectedStrategyId(e.target.value)}
                    className={
                      isDark
                        ? "rounded-md border border-slate-700 bg-[#0F1419] px-2.5 py-1.5 text-xs text-slate-100"
                        : "rounded-md border border-stone-400 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                    }
                  >
                    {(marketSummary?.strategies ?? []).map((strat) => (
                      <option key={strat.id} value={strat.id}>
                        {strat.name} ({strat.id})
                      </option>
                    ))}
                    {(!marketSummary || marketSummary.strategies.length === 0) && (
                      <>
                        <option value="donchian-trend-v1">Donchian Trend Breakout v1</option>
                        <option value="vol-mean-reversion-v1">
                          Vol-Normalized Mean Reversion v1
                        </option>
                        <option value="vol-momentum-v1">Vol-Normalized Momentum Impulse v1</option>
                      </>
                    )}
                  </select>
                  <button
                    data-testid="run-replay-btn"
                    type="button"
                    disabled={replayRunning}
                    onClick={() => void handleRunReplay()}
                    className="rounded-md bg-[#0D9488] px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-600 disabled:opacity-50"
                  >
                    {replayRunning ? "Running..." : "Run Event-Driven Replay"}
                  </button>
                </div>
              </div>

              {marketSummary && marketSummary.instruments.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-3 text-xs">
                  {marketSummary.instruments.map((inst) => (
                    <div
                      key={inst.instrumentId}
                      data-testid={`coverage-${inst.instrumentId}`}
                      className="font-mono-tabular rounded border border-slate-700/60 px-3 py-1.5"
                    >
                      <span className="font-bold text-teal-400">{inst.instrumentId}</span> · 15m:{" "}
                      {inst.barCounts["15m"]} · 1H: {inst.barCounts["1H"]} · 4H:{" "}
                      {inst.barCounts["4H"]} · 1D: {inst.barCounts["1D"]} · Funding:{" "}
                      {inst.fundingCount}
                    </div>
                  ))}
                </div>
              )}

              {marketSummary && marketSummary.strategies.length > 0 && (
                <div
                  data-testid="strategy-readiness-list"
                  className="mt-3 grid gap-2 md:grid-cols-3"
                >
                  {marketSummary.strategies.map((strat) => {
                    const statusForInst = strat.lookbackStatusByInstrument[selectedInstrumentId];
                    const isReady = statusForInst?.satisfied === true;
                    const reqText = Object.entries(strat.lookbackRequirements)
                      .map(([tf, cnt]) => `${tf}>=${cnt}`)
                      .join(", ");
                    return (
                      <div
                        key={strat.id}
                        data-testid={`strategy-readiness-${strat.id}`}
                        className="flex items-center justify-between rounded border border-slate-700/50 px-3 py-1.5 text-xs"
                      >
                        <div>
                          <div className="font-semibold">{strat.name}</div>
                          <div className="font-mono-tabular text-[11px] opacity-70">
                            Lookback: {reqText}
                          </div>
                        </div>
                        <span
                          className={
                            isReady
                              ? "rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-emerald-400"
                              : "rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-amber-400"
                          }
                        >
                          {isReady ? "SATISFIED" : "DEFICIT"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="mt-4 overflow-x-auto">
                <table data-testid="experiments-table" className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-700/60 opacity-70">
                      <th className="py-1.5">Strategy</th>
                      <th className="py-1.5">Instrument</th>
                      <th className="py-1.5">Snapshot ID</th>
                      <th className="py-1.5">Trades</th>
                      <th className="py-1.5">Avg R</th>
                      <th className="py-1.5">2x Stress R</th>
                      <th className="py-1.5">OOS Walk-Fwd R</th>
                      <th className="py-1.5">DSR</th>
                      <th className="py-1.5">Net PnL (USDT)</th>
                      <th className="py-1.5">ADR-0007 Gate</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono-tabular">
                    {experiments.map((exp) => (
                      <tr key={exp.experimentId} className="border-b border-slate-800/60">
                        <td className="py-1.5 text-teal-400">{exp.strategyId}</td>
                        <td className="py-1.5">{exp.instrumentId}</td>
                        <td className="py-1.5">{exp.dataSnapshotId.slice(0, 12)}</td>
                        <td className="py-1.5">{exp.totalTrades}</td>
                        <td className="py-1.5">{exp.avgR.toFixed(3)}R</td>
                        <td className="py-1.5">{exp.stressNetExpectancyR.toFixed(3)}R</td>
                        <td className="py-1.5">{exp.walkForwardOutOfSampleAvgR.toFixed(3)}R</td>
                        <td className="py-1.5">{exp.deflatedSharpeRatio.toFixed(3)}</td>
                        <td className="py-1.5">{exp.netPnlUsdt}</td>
                        <td className="py-1.5">
                          <span
                            data-testid={`gate-badge-${exp.experimentId}`}
                            className={
                              exp.replayGatePassed
                                ? "rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-400"
                                : "rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-400"
                            }
                          >
                            {exp.replayGatePassed ? "PASS" : "HOLD"}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {experiments.length === 0 && (
                      <tr>
                        <td colSpan={10} className="py-3 text-center opacity-60">
                          No experiments recorded yet. Seed confirmed bars and run a replay.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            {/* M3 Paper Execution Cockpit & Double-Entry Ledger */}
            <section data-testid="paper-cockpit-panel" className={cardClass}>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700/60 pb-3">
                <div>
                  <h3 className="text-sm font-bold">
                    Paper Execution, Risk Guardian &amp; Double-Entry Ledger
                  </h3>
                  <p className="text-xs opacity-70">
                    ADR-0002 Two-Tier Risk Controls &bull; ADR-0006 Attached Protective Stop &bull;
                    ADR-0008 Exact Double-Entry
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    data-testid="circuit-breaker-badge"
                    className={`rounded border px-2 py-0.5 text-xs font-semibold ${
                      paperCircuitBreaker?.status === "NORMAL"
                        ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400"
                        : "border-rose-500/40 bg-rose-500/15 text-rose-400"
                    }`}
                  >
                    CB: {paperCircuitBreaker?.status ?? "NORMAL"}
                  </span>
                  <span
                    data-testid="trial-balance-badge"
                    className={`rounded border px-2 py-0.5 text-xs font-semibold ${
                      trialBalance?.isBalanced
                        ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400"
                        : "border-rose-500/40 bg-rose-500/15 text-rose-400"
                    }`}
                  >
                    LEDGER: {trialBalance?.isBalanced ? "BALANCED" : "IMBALANCED"}
                  </span>
                </div>
              </div>

              {/* Ledger Trial Balance Overview */}
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded border border-slate-700/40 bg-slate-800/30 p-2">
                  <div className="text-[11px] opacity-70">Cash Balance</div>
                  <div
                    data-testid="cash-balance-val"
                    className="font-mono text-sm font-bold text-emerald-400"
                  >
                    {trialBalance?.cashBalanceUsdt ?? "10000.00000000"} USDT
                  </div>
                </div>
                <div className="rounded border border-slate-700/40 bg-slate-800/30 p-2">
                  <div className="text-[11px] opacity-70">Realized PnL</div>
                  <div
                    data-testid="realized-pnl-val"
                    className="font-mono text-sm font-bold text-teal-400"
                  >
                    {trialBalance?.realizedPnlUsdt ?? "0.00000000"} USDT
                  </div>
                </div>
                <div className="rounded border border-slate-700/40 bg-slate-800/30 p-2">
                  <div className="text-[11px] opacity-70">Fees Paid</div>
                  <div
                    data-testid="fees-expense-val"
                    className="font-mono text-sm font-bold text-amber-400"
                  >
                    {trialBalance?.feesExpenseUsdt ?? "0.00000000"} USDT
                  </div>
                </div>
                <div className="rounded border border-slate-700/40 bg-slate-800/30 p-2">
                  <div className="text-[11px] opacity-70">Net Equity</div>
                  <div
                    data-testid="net-equity-val"
                    className="font-mono text-sm font-bold text-sky-400"
                  >
                    {trialBalance?.netEquityUsdt ?? "10000.00000000"} USDT
                  </div>
                </div>
              </div>

              {/* Paper Controls: Step Tick & Emergency Flatten */}
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  data-testid="execute-paper-tick-btn"
                  disabled={paperTickRunning}
                  onClick={async () => {
                    setPaperTickRunning(true);
                    setGovMessage(null);
                    setGovError(null);
                    try {
                      const res = await apiClient.paper.executeTick({
                        body: {
                          instrumentId: selectedInstrumentId,
                          strategyId: selectedStrategyId
                        }
                      });
                      if (res.status === 200) {
                        setGovMessage(
                          `Paper tick executed: ${res.body.positionsOpenedCount} opened, ${res.body.positionsClosedCount} closed`
                        );
                        await refreshGovernanceData();
                      } else {
                        setGovError(extractApiError(res.body, "Paper tick failed"));
                      }
                    } catch (err) {
                      setGovError(String(err));
                    } finally {
                      setPaperTickRunning(false);
                    }
                  }}
                  className="rounded bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-500 disabled:opacity-50"
                >
                  {paperTickRunning ? "Stepping..." : "Step Paper Tick"}
                </button>

                <button
                  type="button"
                  data-testid="flatten-positions-btn"
                  disabled={flattenRunning}
                  onClick={async () => {
                    setFlattenRunning(true);
                    setGovMessage(null);
                    setGovError(null);
                    try {
                      const res = await apiClient.paper.flatten({
                        body: { reason: "Operator cockpit flatten" }
                      });
                      if (res.status === 200) {
                        setGovMessage(`Flattened ${res.body.flattenedCount} paper positions`);
                        await refreshGovernanceData();
                      } else {
                        setGovError(extractApiError(res.body, "Flatten failed"));
                      }
                    } catch (err) {
                      setGovError(String(err));
                    } finally {
                      setFlattenRunning(false);
                    }
                  }}
                  className="rounded bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
                >
                  {flattenRunning ? "Flattening..." : "Emergency Flatten All"}
                </button>

                <button
                  type="button"
                  data-testid="trip-kill-switch-btn"
                  onClick={async () => {
                    setGovMessage(null);
                    setGovError(null);
                    const newStatus =
                      paperCircuitBreaker?.status === "MANUAL_KILL_SWITCH"
                        ? "NORMAL"
                        : "MANUAL_KILL_SWITCH";
                    const res = await apiClient.paper.setCircuitBreaker({
                      body: {
                        status: newStatus,
                        reason:
                          newStatus === "NORMAL"
                            ? "Operator re-armed system"
                            : "Manual operator emergency halt"
                      }
                    });
                    if (res.status === 200) {
                      setGovMessage(`Circuit breaker updated to ${res.body.circuitBreaker.status}`);
                      await refreshGovernanceData();
                    } else {
                      setGovError(extractApiError(res.body, "Failed to toggle kill switch"));
                    }
                  }}
                  className="rounded border border-rose-500/60 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-400 hover:bg-rose-500/20"
                >
                  {paperCircuitBreaker?.status === "MANUAL_KILL_SWITCH"
                    ? "Re-Arm Circuit Breaker"
                    : "Trip Manual Kill-Switch"}
                </button>

                <button
                  type="button"
                  data-testid="evaluate-promotion-btn"
                  onClick={async () => {
                    setGovMessage(null);
                    setGovError(null);
                    const res = await apiClient.promotion.evaluate({
                      body: { strategyId: selectedStrategyId }
                    });
                    if (res.status === 200) {
                      setGovMessage(
                        `Strategy ${res.body.promotion.strategyId} evaluated: Current Stage = ${res.body.promotion.currentStage}, Next = ${res.body.promotion.eligibleNextStage ?? "None"}`
                      );
                      await refreshGovernanceData();
                    } else {
                      setGovError(extractApiError(res.body, "Failed to evaluate promotion"));
                    }
                  }}
                  className="rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500"
                >
                  Evaluate ADR-0007 Promotion
                </button>
              </div>

              {/* Open Positions Table */}
              <div className="mt-4">
                <h4 className="text-xs font-semibold uppercase tracking-wider opacity-80">
                  Open Paper Positions ({openPositions.length}) — Attached Protective Stops
                </h4>
                <div className="mt-2 overflow-x-auto">
                  <table data-testid="open-positions-table" className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-700/60 opacity-70">
                        <th className="py-1.5">Position ID</th>
                        <th className="py-1.5">Strategy</th>
                        <th className="py-1.5">Instrument</th>
                        <th className="py-1.5">Side</th>
                        <th className="py-1.5">Contracts</th>
                        <th className="py-1.5">Entry Price</th>
                        <th className="py-1.5 text-rose-400">Protective Stop</th>
                        <th className="py-1.5">Take Profit</th>
                        <th className="py-1.5">Initial Risk (1R)</th>
                        <th className="py-1.5">Status</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono-tabular">
                      {openPositions.map((pos) => (
                        <tr key={pos.positionId} className="border-b border-slate-800/60">
                          <td className="py-1.5">{pos.positionId}</td>
                          <td className="py-1.5 text-teal-400">{pos.strategyId}</td>
                          <td className="py-1.5">{pos.instrumentId}</td>
                          <td className="py-1.5 uppercase font-semibold">
                            <span
                              className={pos.side === "long" ? "text-emerald-400" : "text-rose-400"}
                            >
                              {pos.side}
                            </span>
                          </td>
                          <td className="py-1.5">{pos.contracts}</td>
                          <td className="py-1.5">{pos.entryPrice}</td>
                          <td className="py-1.5 font-bold text-rose-400">
                            {pos.protectiveStopPrice}
                          </td>
                          <td className="py-1.5">{pos.takeProfitPrice ?? "-"}</td>
                          <td className="py-1.5">{pos.initialRiskUsdt} USDT</td>
                          <td className="py-1.5">
                            <span className="rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400">
                              {pos.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                      {openPositions.length === 0 && (
                        <tr>
                          <td colSpan={10} className="py-3 text-center opacity-60">
                            No open paper positions. Step paper ticks with active strategy signals.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Strategy Promotion Ladder Status */}
              <div className="mt-4">
                <h4 className="text-xs font-semibold uppercase tracking-wider opacity-80">
                  Quantitative Promotion Ladder (ADR-0007)
                </h4>
                <div className="mt-2 overflow-x-auto">
                  <table data-testid="promotion-ladder-table" className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-700/60 opacity-70">
                        <th className="py-1.5">Strategy</th>
                        <th className="py-1.5">Current Stage</th>
                        <th className="py-1.5">Replay Gate</th>
                        <th className="py-1.5">Paper Trades</th>
                        <th className="py-1.5">Paper Drawdown</th>
                        <th className="py-1.5">Eligible Next Stage</th>
                        <th className="py-1.5">Demotion Reason</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono-tabular">
                      {promotions.map((promo) => (
                        <tr key={promo.strategyId} className="border-b border-slate-800/60">
                          <td className="py-1.5 text-teal-400">{promo.strategyId}</td>
                          <td className="py-1.5 font-bold text-sky-400">{promo.currentStage}</td>
                          <td className="py-1.5">
                            <span
                              className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
                                promo.replayGatePassed
                                  ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400"
                                  : "border-amber-500/40 bg-amber-500/15 text-amber-400"
                              }`}
                            >
                              {promo.replayGatePassed ? "PASS" : "HOLD"}
                            </span>
                          </td>
                          <td className="py-1.5">{promo.paperTradesCount}</td>
                          <td className="py-1.5">{promo.paperDrawdownPct.toFixed(2)}%</td>
                          <td className="py-1.5 text-emerald-400">
                            {promo.eligibleNextStage ?? "None"}
                          </td>
                          <td className="py-1.5 text-rose-400">{promo.demotionReason ?? "None"}</td>
                        </tr>
                      ))}
                      {promotions.length === 0 && (
                        <tr>
                          <td colSpan={7} className="py-3 text-center opacity-60">
                            No strategy promotion evaluations recorded yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            {/* M4 AI Decision Support, Context Analyst & Shadow Advisor Cockpit */}
            <section data-testid="ai-decision-support-panel" className={cardClass}>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700/60 pb-3">
                <div>
                  <h3 className="text-sm font-bold">
                    AI Decision Support, Context Analyst &amp; Shadow Advisor
                  </h3>
                  <p className="text-xs opacity-70">
                    ADR-0007 Budgeted Gemini LLM Gateway &bull; Context Feature Extraction &bull;
                    A/B Shadow Evaluation
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    data-testid="ai-provider-badge"
                    className="rounded border border-indigo-500/40 bg-indigo-500/15 px-2 py-0.5 text-xs font-semibold text-indigo-400"
                  >
                    AI: {aiStatus?.provider?.toUpperCase() ?? "GEMINI"} (
                    {aiStatus?.fastModel ?? "flash"})
                  </span>
                  <span
                    data-testid="ai-daily-budget-badge"
                    className="rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-400"
                  >
                    BUDGET: ${aiStatus?.remainingDailyBudgetUsd?.toFixed(4) ?? "0.7500"} / $
                    {aiStatus?.dailyBudgetUsd?.toFixed(2) ?? "0.75"}
                  </span>
                </div>
              </div>

              {/* LLM Pacing & Model Selection Progress Panel (AC2) */}
              <div className="mt-4 grid gap-4 rounded border border-slate-700/50 bg-slate-900/30 p-3 md:grid-cols-2">
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-medium text-slate-300">Daily Gemini Budget</span>
                    <span className="font-mono text-emerald-400">
                      $
                      {(
                        (aiStatus?.dailyBudgetUsd ?? 0.75) -
                        (aiStatus?.remainingDailyBudgetUsd ?? 0.75)
                      ).toFixed(4)}{" "}
                      / ${(aiStatus?.dailyBudgetUsd ?? 0.75).toFixed(2)}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded bg-slate-800">
                    <div
                      data-testid="ai-daily-spend-progress"
                      className="h-full bg-emerald-400 transition-all duration-300"
                      style={{
                        width: `${Math.min(
                          100,
                          (((aiStatus?.dailyBudgetUsd ?? 0.75) -
                            (aiStatus?.remainingDailyBudgetUsd ?? 0.75)) /
                            (aiStatus?.dailyBudgetUsd ?? 0.75)) *
                            100
                        )}%`
                      }}
                    />
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-medium text-slate-300">Monthly Gemini Budget</span>
                    <span className="font-mono text-sky-400">
                      $
                      {(
                        (aiStatus?.monthlyBudgetUsd ?? 15.0) -
                        (aiStatus?.remainingMonthlyBudgetUsd ?? 15.0)
                      ).toFixed(4)}{" "}
                      / ${(aiStatus?.monthlyBudgetUsd ?? 15.0).toFixed(2)}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded bg-slate-800">
                    <div
                      data-testid="ai-monthly-spend-progress"
                      className="h-full bg-sky-400 transition-all duration-300"
                      style={{
                        width: `${Math.min(
                          100,
                          (((aiStatus?.monthlyBudgetUsd ?? 15.0) -
                            (aiStatus?.remainingMonthlyBudgetUsd ?? 15.0)) /
                            (aiStatus?.monthlyBudgetUsd ?? 15.0)) *
                            100
                        )}%`
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* AI Context Analyst: Unstructured Text Ingestion */}
              <div className="mt-4">
                <h4 className="text-xs font-semibold uppercase tracking-wider opacity-80">
                  Context Analyst: Market Announcement &amp; Macro Ingestion
                </h4>
                <div className="mt-2 space-y-2">
                  <textarea
                    data-testid="context-input-textarea"
                    value={contextInputText}
                    onChange={(e) => setContextInputText(e.target.value)}
                    rows={2}
                    className="w-full rounded border border-slate-700 bg-slate-900/50 p-2 font-mono text-xs"
                    placeholder="Enter market announcement or macro news item..."
                  />
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      data-testid="extract-context-btn"
                      disabled={extractingContext}
                      onClick={async () => {
                        setExtractingContext(true);
                        setGovMessage(null);
                        setGovError(null);
                        try {
                          const res = await apiClient.ai.extractContext({
                            body: {
                              text: contextInputText,
                              source: "Operator Manual Desk",
                              instrumentId: selectedInstrumentId
                            }
                          });
                          if (res.status === 200) {
                            setExtractedFeatures((prev) => [res.body.feature, ...prev]);
                            setGovMessage(
                              `Context extracted: ${res.body.feature.headline} (${res.body.feature.directionalBias})`
                            );
                            await refreshGovernanceData();
                          } else {
                            setGovError(extractApiError(res.body, "Failed to extract context"));
                          }
                        } catch (err) {
                          setGovError(String(err));
                        } finally {
                          setExtractingContext(false);
                        }
                      }}
                      className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                    >
                      {extractingContext ? "Extracting..." : "Extract Context Feature"}
                    </button>
                  </div>
                </div>

                {/* Extracted Context Features Table */}
                <div className="mt-3 overflow-x-auto">
                  <table data-testid="context-features-table" className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-700/60 opacity-70">
                        <th className="py-1.5">Feature ID</th>
                        <th className="py-1.5">Headline</th>
                        <th className="py-1.5">Bias</th>
                        <th className="py-1.5">Confidence</th>
                        <th className="py-1.5">Novelty</th>
                        <th className="py-1.5">Contamination</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono-tabular">
                      {extractedFeatures.map((feat) => (
                        <tr key={feat.featureId} className="border-b border-slate-800/60">
                          <td className="py-1.5">{feat.featureId.slice(0, 12)}</td>
                          <td className="py-1.5 text-teal-400 font-semibold">{feat.headline}</td>
                          <td className="py-1.5 uppercase font-bold">
                            <span
                              className={
                                feat.directionalBias === "bullish"
                                  ? "text-emerald-400"
                                  : feat.directionalBias === "bearish"
                                    ? "text-rose-400"
                                    : "text-amber-400"
                              }
                            >
                              {feat.directionalBias}
                            </span>
                          </td>
                          <td className="py-1.5">{(feat.confidenceScore * 100).toFixed(0)}%</td>
                          <td className="py-1.5">{(feat.noveltyScore * 100).toFixed(0)}%</td>
                          <td className="py-1.5">
                            <span
                              className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
                                feat.trainingContaminated
                                  ? "border-rose-500/40 bg-rose-500/15 text-rose-400"
                                  : "border-emerald-500/40 bg-emerald-500/15 text-emerald-400"
                              }`}
                            >
                              {feat.trainingContaminated ? "CONTAMINATED" : "CLEAN"}
                            </span>
                          </td>
                        </tr>
                      ))}
                      {extractedFeatures.length === 0 && (
                        <tr>
                          <td colSpan={6} className="py-2.5 text-center opacity-60">
                            No context features extracted yet. Submit announcement text above.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Shadow Advisor: A/B Scored Evaluation Alongside Baseline */}
              <div className="mt-4 border-t border-slate-700/60 pt-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold uppercase tracking-wider opacity-80">
                    Shadow Advisor: A/B Baseline Control Evaluation
                  </h4>
                  <button
                    type="button"
                    data-testid="evaluate-shadow-btn"
                    disabled={evaluatingShadow}
                    onClick={async () => {
                      setEvaluatingShadow(true);
                      setGovMessage(null);
                      setGovError(null);
                      try {
                        const res = await apiClient.ai.shadowEvaluate({
                          body: {
                            strategyId: selectedStrategyId,
                            instrumentId: selectedInstrumentId
                          }
                        });
                        if (res.status === 200) {
                          setShadowResult(res.body);
                          setGovMessage(
                            `Shadow evaluated: Baseline=${res.body.baselineChosenProposalId ?? "None"}, Shadow=${res.body.shadowChosenProposalId ?? "None"} (Agreement=${res.body.agreement})`
                          );
                          await refreshGovernanceData();
                        } else {
                          setGovError(extractApiError(res.body, "Shadow evaluation failed"));
                        }
                      } catch (err) {
                        setGovError(String(err));
                      } finally {
                        setEvaluatingShadow(false);
                      }
                    }}
                    className="rounded bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-50"
                  >
                    {evaluatingShadow ? "Evaluating..." : "Run Shadow Evaluation"}
                  </button>
                </div>

                {shadowResult && (
                  <div
                    data-testid="shadow-result-card"
                    className="mt-3 rounded border border-slate-700/40 bg-slate-800/30 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-3 text-xs">
                      <div>
                        Baseline Pick:{" "}
                        <span className="font-mono font-bold text-teal-400">
                          {shadowResult.baselineChosenProposalId ?? "None"}
                        </span>
                      </div>
                      <div>
                        Shadow Advisor Pick:{" "}
                        <span className="font-mono font-bold text-indigo-400">
                          {shadowResult.shadowChosenProposalId ?? "None"}
                        </span>
                      </div>
                      <div>
                        Agreement:{" "}
                        <span
                          className={`font-bold ${
                            shadowResult.agreement ? "text-emerald-400" : "text-amber-400"
                          }`}
                        >
                          {shadowResult.agreement ? "MATCH" : "DISAGREEMENT"}
                        </span>
                      </div>
                      <div>
                        Confidence:{" "}
                        <span className="font-mono">
                          {(shadowResult.shadowConfidence * 100).toFixed(0)}%
                        </span>
                      </div>
                    </div>
                    <div className="mt-2 text-xs italic opacity-80">
                      &quot;{shadowResult.shadowRationale}&quot;
                    </div>
                  </div>
                )}

                {/* M6 EventGateAdvisor Sub-Section */}
                <div
                  data-testid="event-gate-panel"
                  className="mt-5 border-t border-slate-700/60 pt-4"
                >
                  <h4 className="text-xs font-semibold uppercase tracking-wider opacity-80">
                    Event Gate Advisor: Macro &amp; Geopolitical Shock Gating (M6)
                  </h4>
                  <div className="mt-2 flex flex-col gap-2">
                    <textarea
                      data-testid="event-gate-input"
                      rows={2}
                      value={eventShockInput}
                      onChange={(e) => setEventShockInput(e.target.value)}
                      className={inputClass}
                      placeholder="Enter emergency macro shock or geopolitical announcement..."
                    />
                    <div className="flex justify-end">
                      <button
                        type="button"
                        data-testid="evaluate-event-gate-btn"
                        disabled={evaluatingEventGate}
                        onClick={async () => {
                          setEvaluatingEventGate(true);
                          setGovMessage(null);
                          setGovError(null);
                          try {
                            const res = await apiClient.ai.evaluateEventGate({
                              body: { eventText: eventShockInput }
                            });
                            if (res.status === 200) {
                              setEventGateEvaluation(res.body.evaluation);
                              setGovMessage(
                                `Event Gate Evaluated: ${res.body.evaluation.recommendation} (${res.body.evaluation.volatilityRisk} risk)`
                              );
                              await refreshGovernanceData();
                            } else {
                              setGovError(
                                extractApiError(res.body, "Event gate evaluation failed")
                              );
                            }
                          } catch (err) {
                            setGovError(String(err));
                          } finally {
                            setEvaluatingEventGate(false);
                          }
                        }}
                        className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                      >
                        {evaluatingEventGate ? "Evaluating Gate..." : "Evaluate Event Gate"}
                      </button>
                    </div>
                  </div>

                  {eventGateEvaluation && (
                    <div
                      data-testid="event-gate-result-card"
                      className="mt-3 rounded border border-slate-700/80 bg-slate-800/40 p-3 text-xs"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700/60 pb-2">
                        <span className="font-semibold text-teal-300">
                          {eventGateEvaluation.eventHeadline}
                        </span>
                        <span
                          data-testid="event-gate-recommendation-badge"
                          className={`rounded border px-2 py-0.5 text-xs font-bold uppercase ${
                            eventGateEvaluation.recommendation === "STAND_DOWN"
                              ? "border-rose-500/60 bg-rose-500/20 text-rose-300"
                              : eventGateEvaluation.recommendation === "REDUCE_SIZE"
                                ? "border-amber-500/60 bg-amber-500/20 text-amber-300"
                                : "border-emerald-500/60 bg-emerald-500/20 text-emerald-300"
                          }`}
                        >
                          {eventGateEvaluation.recommendation}
                        </span>
                      </div>
                      <div className="mt-2 grid gap-2 sm:grid-cols-3">
                        <div>
                          Volatility Risk:{" "}
                          <span className="font-bold uppercase text-amber-400">
                            {eventGateEvaluation.volatilityRisk}
                          </span>
                        </div>
                        <div>
                          Risk Score:{" "}
                          <span className="font-mono">
                            {(eventGateEvaluation.riskScore * 100).toFixed(0)}%
                          </span>
                        </div>
                        <div>
                          Cooldown:{" "}
                          <span className="font-mono">
                            {eventGateEvaluation.cooldownMinutes} min
                          </span>
                        </div>
                      </div>
                      <div className="mt-2 text-xs italic opacity-85">
                        &quot;{eventGateEvaluation.rationale}&quot;
                      </div>
                    </div>
                  )}
                </div>

                {/* M6 Narrative Cluster Tagger Sub-Section */}
                <div className="mt-5 border-t border-slate-700/60 pt-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-semibold uppercase tracking-wider opacity-80">
                      Narrative Cluster Tagger (M6)
                    </h4>
                    <button
                      type="button"
                      data-testid="cluster-narratives-btn"
                      disabled={clusteringNarratives}
                      onClick={async () => {
                        setClusteringNarratives(true);
                        setGovMessage(null);
                        setGovError(null);
                        try {
                          const announcements =
                            extractedFeatures.length > 0
                              ? extractedFeatures.map((f) => f.headline)
                              : [
                                  "Federal Reserve signals slower balance sheet runoff",
                                  "Crypto ETF institutional inflows accelerate in Q3"
                                ];
                          const res = await apiClient.ai.clusterNarratives({
                            body: { announcements }
                          });
                          if (res.status === 200) {
                            setNarrativeClusters(res.body.clusters);
                            setGovMessage(`Tagged ${res.body.clusters.length} narrative clusters`);
                            await refreshGovernanceData();
                          } else {
                            setGovError(extractApiError(res.body, "Failed to cluster narratives"));
                          }
                        } catch (err) {
                          setGovError(String(err));
                        } finally {
                          setClusteringNarratives(false);
                        }
                      }}
                      className="rounded border border-indigo-500/50 bg-indigo-500/15 px-3 py-1 text-xs font-semibold text-indigo-300 hover:bg-indigo-500/25 disabled:opacity-50"
                    >
                      {clusteringNarratives ? "Clustering..." : "Tag Narrative Clusters"}
                    </button>
                  </div>

                  <div className="mt-2 overflow-x-auto">
                    <table
                      data-testid="narrative-clusters-table"
                      className="w-full text-left text-xs font-mono"
                    >
                      <thead>
                        <tr className="border-b border-slate-700/60 opacity-70">
                          <th className="py-1">Cluster ID</th>
                          <th className="py-1">Narrative Name</th>
                          <th className="py-1">Theme</th>
                          <th className="py-1">Bias</th>
                          <th className="py-1">Novelty</th>
                        </tr>
                      </thead>
                      <tbody>
                        {narrativeClusters.map((c) => (
                          <tr key={c.clusterId} className="border-b border-slate-800/60">
                            <td className="py-1.5">{c.clusterId.slice(0, 10)}</td>
                            <td className="py-1.5 font-bold text-teal-300">{c.name}</td>
                            <td className="py-1.5">{c.theme}</td>
                            <td className="py-1.5 uppercase font-bold text-amber-400">
                              {c.sentimentBias}
                            </td>
                            <td className="py-1.5">{(c.noveltyScore * 100).toFixed(0)}%</td>
                          </tr>
                        ))}
                        {narrativeClusters.length === 0 && (
                          <tr>
                            <td colSpan={5} className="py-2 text-center opacity-60">
                              No narrative clusters tagged yet. Click &quot;Tag Narrative
                              Clusters&quot; above.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* M6 Markout Forensics Analyst Sub-Section */}
                <div className="mt-5 border-t border-slate-700/60 pt-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-semibold uppercase tracking-wider opacity-80">
                      Markout Forensics Analyst: Execution Quality &amp; Adverse Selection (M6)
                    </h4>
                    <button
                      type="button"
                      data-testid="analyze-markout-btn"
                      disabled={analyzingMarkout}
                      onClick={async () => {
                        setAnalyzingMarkout(true);
                        setGovMessage(null);
                        setGovError(null);
                        try {
                          const res = await apiClient.ai.analyzeMarkoutForensics({
                            body: {
                              orderId: submittedExchangeOrders[0]?.orderId ?? "ord_e2e_demo_001",
                              instrumentId: "BTC-USDT-SWAP",
                              side: "long",
                              fillPrice: "50000.00",
                              markoutPrices: {
                                price5m: "50030.00",
                                price15m: "50075.00",
                                price1h: "50120.00"
                              }
                            }
                          });
                          if (res.status === 200) {
                            setMarkoutReport(res.body.report);
                            setGovMessage(
                              `Markout Forensics: ${res.body.report.executionQualityRating} quality`
                            );
                            await refreshGovernanceData();
                          } else {
                            setGovError(extractApiError(res.body, "Failed to analyze markouts"));
                          }
                        } catch (err) {
                          setGovError(String(err));
                        } finally {
                          setAnalyzingMarkout(false);
                        }
                      }}
                      className="rounded border border-teal-500/50 bg-teal-500/15 px-3 py-1 text-xs font-semibold text-teal-300 hover:bg-teal-500/25 disabled:opacity-50"
                    >
                      {analyzingMarkout ? "Analyzing..." : "Analyze Execution Markouts"}
                    </button>
                  </div>

                  {markoutReport && (
                    <div
                      data-testid="markout-forensics-card"
                      className="mt-3 rounded border border-slate-700/80 bg-slate-800/40 p-3 text-xs"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700/60 pb-2">
                        <span className="font-mono text-teal-300">
                          Order: {markoutReport.orderId} ({markoutReport.instrumentId}{" "}
                          {markoutReport.side.toUpperCase()})
                        </span>
                        <span
                          data-testid="markout-quality-badge"
                          className="rounded border border-emerald-500/50 bg-emerald-500/15 px-2 py-0.5 text-xs font-bold text-emerald-400"
                        >
                          {markoutReport.executionQualityRating}
                        </span>
                      </div>
                      <div className="mt-2 grid gap-2 sm:grid-cols-4 font-mono-tabular">
                        <div>
                          5m Drift:{" "}
                          <span className="font-bold text-emerald-400">
                            +{markoutReport.markout5mBps} bps
                          </span>
                        </div>
                        <div>
                          15m Drift:{" "}
                          <span className="font-bold text-emerald-400">
                            +{markoutReport.markout15mBps} bps
                          </span>
                        </div>
                        <div>
                          1h Drift:{" "}
                          <span className="font-bold text-emerald-400">
                            +{markoutReport.markout1hBps} bps
                          </span>
                        </div>
                        <div>
                          Aggressiveness:{" "}
                          <span className="font-bold text-indigo-400">
                            {markoutReport.recommendedAggressiveness}
                          </span>
                        </div>
                      </div>
                      <div className="mt-2 text-xs italic opacity-85">
                        &quot;{markoutReport.forensicSummary}&quot;
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* M5 Exchange Broker & Attached Protective Stops Cockpit (ADR-0006) */}
            <section data-testid="exchange-broker-panel" className={cardClass}>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700/60 pb-3">
                <div>
                  <h3 className="text-sm font-bold">
                    Exchange Broker Execution &amp; Attached Protective Stops
                  </h3>
                  <p className="text-xs opacity-70">
                    ADR-0006 OKX V5 Linear Perpetuals &bull; Atomic attachAlgoOrds &bull; 60s
                    Dead-Man&apos;s Switch (cancel-all-after)
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    data-testid="broker-venue-badge"
                    className="rounded border border-teal-500/40 bg-teal-500/15 px-2 py-0.5 text-xs font-semibold text-teal-400"
                  >
                    VENUE: {brokerStatus?.venue ?? "OKX-EEA"} (
                    {executionMode === "Live" ? "LIVE" : "DEMO"})
                  </span>
                  <span
                    data-testid="broker-dms-badge"
                    className={`rounded border px-2 py-0.5 text-xs font-semibold ${
                      brokerStatus?.dms?.healthy
                        ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400"
                        : "border-amber-500/40 bg-amber-500/15 text-amber-400"
                    }`}
                  >
                    DMS: {brokerStatus?.dms?.healthy ? "ACTIVE (60s)" : "IDLE"}
                  </span>
                  <span
                    data-testid="reconciliation-status-badge"
                    className={`rounded border px-2 py-0.5 text-xs font-semibold ${
                      reconciliation?.matched
                        ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-400"
                        : "border-slate-500/40 bg-slate-500/15 text-slate-300"
                    }`}
                  >
                    RECON:{" "}
                    {reconciliation?.matched
                      ? "MATCHED"
                      : reconciliation
                        ? "DRIFT DETECTED"
                        : "NOT RUN"}
                  </span>
                </div>
              </div>

              {/* DMS & Reconciliation Actions */}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-700/60 pb-4">
                <div className="text-xs opacity-80">
                  Dead-Man&apos;s Switch automatically cancels all resting unexecuted limit orders
                  after 60s if the container crashes, while protective stops remain exchange-active.
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="send-dms-btn"
                    disabled={sendingDms}
                    onClick={async () => {
                      setSendingDms(true);
                      setGovMessage(null);
                      setGovError(null);
                      try {
                        const res = await apiClient.broker.dmsHeartbeat({ body: {} });
                        if (res.status === 200) {
                          setGovMessage(
                            `DMS Heartbeat refreshed: 60s window active (healthy=${res.body.dms.healthy})`
                          );
                          await refreshGovernanceData();
                        } else {
                          setGovError(extractApiError(res.body, "DMS heartbeat failed"));
                        }
                      } catch (err) {
                        setGovError(String(err));
                      } finally {
                        setSendingDms(false);
                      }
                    }}
                    className="rounded bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-500 disabled:opacity-50"
                  >
                    {sendingDms ? "Sending DMS..." : "Send DMS Heartbeat"}
                  </button>

                  <button
                    type="button"
                    data-testid="reconcile-positions-btn"
                    disabled={reconciling}
                    onClick={async () => {
                      setReconciling(true);
                      setGovMessage(null);
                      setGovError(null);
                      try {
                        const res = await apiClient.broker.reconcile({ body: {} });
                        if (res.status === 200) {
                          setReconciliation(res.body.reconciliation);
                          setGovMessage(
                            `Reconciliation complete: matched=${res.body.reconciliation.matched} (${res.body.reconciliation.localPositionsCount} positions)`
                          );
                          await refreshGovernanceData();
                        } else {
                          setGovError(extractApiError(res.body, "Reconciliation failed"));
                        }
                      } catch (err) {
                        setGovError(String(err));
                      } finally {
                        setReconciling(false);
                      }
                    }}
                    className="rounded border border-slate-600 px-3 py-1.5 text-xs font-semibold hover:border-teal-500 disabled:opacity-50"
                  >
                    {reconciling ? "Reconciling..." : "Reconcile Positions"}
                  </button>

                  <button
                    type="button"
                    data-testid="emergency-flatten-btn"
                    onClick={async () => {
                      setGovMessage(null);
                      setGovError(null);
                      try {
                        const res = await apiClient.broker.flatten({
                          body: { reason: "Operator manual emergency flatten" }
                        });
                        if (res.status === 200) {
                          setGovMessage(
                            `Emergency flatten executed: ${res.body.flattenedCount} positions closed.`
                          );
                          await refreshGovernanceData();
                        } else {
                          setGovError(extractApiError(res.body, "Emergency flatten failed"));
                        }
                      } catch (err) {
                        setGovError(String(err));
                      }
                    }}
                    className="rounded border border-rose-600/70 bg-rose-600/10 px-3 py-1.5 text-xs font-semibold text-rose-400 hover:bg-rose-600 hover:text-white"
                  >
                    Emergency Flatten All
                  </button>
                </div>
              </div>

              {/* Order Submission Form with Mandatory Attached Protective Stop */}
              <div className="mt-4">
                <h4 className="text-xs font-semibold uppercase tracking-wider opacity-80">
                  Order Dispatch with Mandatory Attached Protective Stop (ADR-0006)
                </h4>
                <div className="mt-2 grid gap-3 md:grid-cols-5 text-xs">
                  <div>
                    <label className="mb-1 block opacity-70">Instrument</label>
                    <input
                      data-testid="order-instrument-input"
                      type="text"
                      value={selectedInstrumentId}
                      onChange={(e) => setSelectedInstrumentId(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block opacity-70">Side</label>
                    <select
                      data-testid="order-side-select"
                      value={orderSide}
                      onChange={(e) => setOrderSide(e.target.value as "long" | "short")}
                      className={inputClass}
                    >
                      <option value="long">LONG (Buy)</option>
                      <option value="short">SHORT (Sell)</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block opacity-70">Size (Lots)</label>
                    <input
                      data-testid="order-size-input"
                      type="number"
                      value={orderSizeLots}
                      onChange={(e) => setOrderSizeLots(Number(e.target.value))}
                      className={inputClass}
                      min={1}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block opacity-70">Entry Price (USDT)</label>
                    <input
                      data-testid="order-entry-price-input"
                      type="text"
                      value={orderEntryPrice}
                      onChange={(e) => setOrderEntryPrice(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block font-semibold text-rose-400">
                      Protective Stop Price (REQUIRED)
                    </label>
                    <input
                      data-testid="order-stop-price-input"
                      type="text"
                      value={orderStopPrice}
                      onChange={(e) => setOrderStopPrice(e.target.value)}
                      className={`${inputClass} border-rose-500/50`}
                      required
                    />
                  </div>
                </div>

                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    data-testid="submit-exchange-order-btn"
                    disabled={submittingOrder}
                    onClick={async () => {
                      setSubmittingOrder(true);
                      setGovMessage(null);
                      setGovError(null);
                      try {
                        const res = await apiClient.broker.submitOrder({
                          body: {
                            instrumentId: selectedInstrumentId,
                            side: orderSide,
                            sizeLots: orderSizeLots,
                            entryPrice: orderEntryPrice,
                            protectiveStopPrice: orderStopPrice,
                            takeProfitPrice: orderTakeProfitPrice,
                            reduceOnly: false
                          }
                        });
                        if (res.status === 200) {
                          setSubmittedExchangeOrders((prev) => [res.body.order, ...prev]);
                          setGovMessage(
                            `Exchange order ${res.body.order.orderId} filled with atomic attached stop ${res.body.order.algoOrderId} @ ${res.body.order.protectiveStopPrice}`
                          );
                          await refreshGovernanceData();
                        } else {
                          setGovError(extractApiError(res.body, "Order submission failed"));
                        }
                      } catch (err) {
                        setGovError(String(err));
                      } finally {
                        setSubmittingOrder(false);
                      }
                    }}
                    className="rounded bg-emerald-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {submittingOrder
                      ? "Submitting Protected Order..."
                      : "Submit Protected Exchange Order"}
                  </button>
                </div>
              </div>

              {/* Submitted Orders with Attached Algo Stops Table */}
              <div className="mt-4">
                <h4 className="text-xs font-semibold uppercase tracking-wider opacity-80 mb-2">
                  Exchange Orders &amp; Attached Protective Stops
                </h4>
                <div className="overflow-x-auto">
                  <table
                    data-testid="exchange-orders-table"
                    className="w-full text-left text-xs font-mono"
                  >
                    <thead>
                      <tr className="border-b border-slate-700/60 opacity-70">
                        <th className="py-1.5">Order ID</th>
                        <th className="py-1.5">Client Ord ID</th>
                        <th className="py-1.5">Algo Stop ID</th>
                        <th className="py-1.5">Instrument</th>
                        <th className="py-1.5">Side</th>
                        <th className="py-1.5">Lots</th>
                        <th className="py-1.5">Fill Price</th>
                        <th className="py-1.5">Protective Stop</th>
                        <th className="py-1.5">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {submittedExchangeOrders.map((ord) => (
                        <tr key={ord.orderId} className="border-b border-slate-800/60">
                          <td className="py-1.5">{ord.orderId.slice(0, 14)}</td>
                          <td className="py-1.5">{ord.clOrdId.slice(0, 14)}</td>
                          <td className="py-1.5 text-amber-400 font-semibold">
                            {ord.algoOrderId.slice(0, 14)}
                          </td>
                          <td className="py-1.5">{ord.instrumentId}</td>
                          <td
                            className={`py-1.5 font-bold uppercase ${
                              ord.side === "long" ? "text-emerald-400" : "text-rose-400"
                            }`}
                          >
                            {ord.side}
                          </td>
                          <td className="py-1.5">{ord.sizeLots}</td>
                          <td className="py-1.5">{ord.fillPrice}</td>
                          <td className="py-1.5 text-rose-400 font-bold">
                            {ord.protectiveStopPrice}
                          </td>
                          <td className="py-1.5">
                            <span className="rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-400 font-semibold">
                              {ord.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                      {submittedExchangeOrders.length === 0 && (
                        <tr>
                          <td colSpan={9} className="py-2.5 text-center opacity-60">
                            No exchange orders placed yet. Submit protected order above.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

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
