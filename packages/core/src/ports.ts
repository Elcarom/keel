import { z } from "zod";
import type { ScaledDecimal } from "./decimal.js";
import {
  ConfigRiskClassSchema,
  KeelConfigSchema,
  type ConfigRiskClass,
  type KeelConfig
} from "./config.js";

export const SecretKeyNameSchema = z.enum([
  "okxApiKey",
  "okxSecretKey",
  "okxPassphrase",
  "geminiApiKey",
  "discordWebhookUrl"
]);
export type SecretKeyName = z.infer<typeof SecretKeyNameSchema>;

export const ALL_SECRET_KEY_NAMES: readonly SecretKeyName[] = SecretKeyNameSchema.options;

export const ConfigSnapshotRecordSchema = z.object({
  version: z.number().int().positive(),
  configHash: z.string().regex(/^[a-f0-9]{64}$/),
  config: KeelConfigSchema,
  actor: z.string(),
  reason: z.string(),
  highestRiskClass: ConfigRiskClassSchema,
  createdAtMs: z.number().int()
});
export type ConfigSnapshotRecord = z.infer<typeof ConfigSnapshotRecordSchema>;

export interface SaveConfigSnapshotInput {
  readonly config: KeelConfig;
  readonly actor: string;
  readonly reason: string;
  readonly highestRiskClass: ConfigRiskClass;
  readonly createdAtMs: number;
}

export interface RollbackConfigInput {
  readonly targetVersion: number;
  readonly actor: string;
  readonly reason: string;
  readonly createdAtMs: number;
}

export interface ConfigRepository {
  getActiveConfig(): ConfigSnapshotRecord;
  saveConfigSnapshot(input: SaveConfigSnapshotInput): ConfigSnapshotRecord;
  getHistory(limit?: number): readonly ConfigSnapshotRecord[];
  getVersion(version: number): ConfigSnapshotRecord | null;
  rollbackToVersion(input: RollbackConfigInput): ConfigSnapshotRecord;
}

export const AuditEventRecordSchema = z.object({
  id: z.number().int().positive(),
  ts: z.number().int(),
  actor: z.string(),
  clientIp: z.string(),
  action: z.string(),
  riskClass: ConfigRiskClassSchema,
  configHash: z.string(),
  details: z.record(z.string(), z.unknown())
});
export type AuditEventRecord = z.infer<typeof AuditEventRecordSchema>;

export type NewAuditEventInput = Omit<AuditEventRecord, "id">;

export interface AuditRepository {
  append(event: NewAuditEventInput): AuditEventRecord;
  listRecent(limit?: number): readonly AuditEventRecord[];
  countShadowEvaluations(strategyId: string): number;
}

export interface EncryptedSecretRecord {
  readonly keyName: SecretKeyName;
  readonly ciphertextBase64: string;
  readonly ivBase64: string;
  readonly authTagBase64: string;
  readonly maskedPreview: string;
  readonly updatedAtMs: number;
  readonly updatedBy: string;
}

export const SecretMetadataRecordSchema = z.object({
  keyName: SecretKeyNameSchema,
  isConfigured: z.boolean(),
  maskedPreview: z.string(),
  updatedAtMs: z.number().int().nullable(),
  updatedBy: z.string().nullable()
});
export type SecretMetadataRecord = z.infer<typeof SecretMetadataRecordSchema>;

export interface SecretVaultRepository {
  upsertSecret(record: EncryptedSecretRecord): void;
  getSecret(keyName: SecretKeyName): EncryptedSecretRecord | null;
  listSecrets(): readonly EncryptedSecretRecord[];
}

export interface AdminUserRecord {
  readonly username: string;
  readonly passwordHashHex: string;
  readonly passwordSaltHex: string;
  readonly totpSecretBase32: string | null;
  readonly totpEnabled: boolean;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface AdminSessionRecord {
  readonly sessionIdHash: string;
  readonly username: string;
  readonly clientIp: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly lastStepUpAtMs: number | null;
}

export interface AuthRateLimitRecord {
  readonly key: string;
  readonly attempts: number;
  readonly firstAttemptMs: number;
  readonly lockedUntilMs: number;
}

export interface AuthRepository {
  getAdminUser(): AdminUserRecord | null;
  upsertAdminUser(user: AdminUserRecord): void;
  createSession(session: AdminSessionRecord): void;
  getSession(sessionIdHash: string): AdminSessionRecord | null;
  updateSessionStepUp(sessionIdHash: string, stepUpAtMs: number): void;
  deleteSession(sessionIdHash: string): void;
  pruneExpiredSessions(nowMs: number): number;
  getRateLimit(key: string): AuthRateLimitRecord | null;
  recordRateLimitAttempt(key: string, nowMs: number, windowMs: number): AuthRateLimitRecord;
  resetRateLimit(key: string): void;
}

export const NotificationSeveritySchema = z.enum(["CRITICAL", "WARNING", "INFO"]);
export type NotificationSeverity = z.infer<typeof NotificationSeveritySchema>;

export interface NotificationMessage {
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body: string;
  readonly dedupKey?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}
export type NotificationPayload = NotificationMessage;

export const NotificationDeliveryResultSchema = z.object({
  delivered: z.boolean(),
  suppressedReason: z
    .enum(["disabled", "severity_filtered", "cooldown_active", "missing_webhook"])
    .optional(),
  error: z.string().optional()
});
export type NotificationDeliveryResult = z.infer<typeof NotificationDeliveryResultSchema>;

export interface NotificationChannel {
  send(message: NotificationMessage): Promise<NotificationDeliveryResult>;
}

export const BackupRecordSchema = z.object({
  fileName: z.string(),
  filePath: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  createdAtMs: z.number().int(),
  integrityOk: z.boolean()
});
export type BackupRecord = z.infer<typeof BackupRecordSchema>;

// ============================================================================
// Milestone M2: Market Data, Confirmed Bars, Proposals, & Experiment Registry
// ============================================================================

export const BarTimeframeSchema = z.enum(["15m", "1H", "4H", "1D"]);
export type BarTimeframe = z.infer<typeof BarTimeframeSchema>;

export const ALL_BAR_TIMEFRAMES: readonly BarTimeframe[] = BarTimeframeSchema.options;

export const TIMEFRAME_DURATION_MS: Record<BarTimeframe, number> = {
  "15m": 15 * 60 * 1000,
  "1H": 60 * 60 * 1000,
  "4H": 4 * 60 * 60 * 1000,
  "1D": 24 * 60 * 60 * 1000
};

export const ConfirmedBarSchema = z.object({
  instrumentId: z.string().min(1),
  timeframe: BarTimeframeSchema,
  openTs: z.number().int().nonnegative(),
  closeTs: z.number().int().positive(),
  open: z.string(),
  high: z.string(),
  low: z.string(),
  close: z.string(),
  volumeContracts: z.string(),
  volumeQuote: z.string(),
  confirm: z.literal("1")
});
export type ConfirmedBar = z.infer<typeof ConfirmedBarSchema>;

export interface RawOkxCandlePayload {
  readonly openTs: number | string;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volumeContracts: string;
  readonly volumeQuote: string;
  readonly confirm: string;
}

export const SettledFundingRateSchema = z.object({
  instrumentId: z.string().min(1),
  fundingTs: z.number().int().nonnegative(),
  fundingRate: z.string(),
  realizedRate: z.string()
});
export type SettledFundingRate = z.infer<typeof SettledFundingRateSchema>;

export type LookbackRequirement = Partial<Record<BarTimeframe, number>>;

export const MarketGapRangeSchema = z.object({
  instrumentId: z.string(),
  timeframe: BarTimeframeSchema,
  missingFromOpenTs: z.number().int().nonnegative(),
  missingToOpenTs: z.number().int().nonnegative(),
  missingBarCount: z.number().int().positive()
});
export type MarketGapRange = z.infer<typeof MarketGapRangeSchema>;

export const LookbackDeficitSchema = z.object({
  timeframe: BarTimeframeSchema,
  requiredBars: z.number().int().positive(),
  availableBars: z.number().int().nonnegative(),
  hasGaps: z.boolean()
});
export type LookbackDeficit = z.infer<typeof LookbackDeficitSchema>;

export const LookbackValidationResultSchema = z.object({
  instrumentId: z.string(),
  asOfMs: z.number().int().nonnegative(),
  satisfied: z.boolean(),
  deficits: z.array(LookbackDeficitSchema)
});
export type LookbackValidationResult = z.infer<typeof LookbackValidationResultSchema>;

export const DataSnapshotMetadataSchema = z.object({
  snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
  instrumentIds: z.array(z.string()),
  fromTs: z.number().int().nonnegative(),
  toTs: z.number().int().nonnegative(),
  barCount: z.number().int().nonnegative(),
  fundingCount: z.number().int().nonnegative()
});
export type DataSnapshotMetadata = z.infer<typeof DataSnapshotMetadataSchema>;

export interface FeatureSnapshot {
  readonly instrumentId: string;
  readonly asOfMs: number;
  readonly barsByTimeframe: Readonly<Partial<Record<BarTimeframe, readonly ConfirmedBar[]>>>;
  readonly recentFundingRates: readonly SettledFundingRate[];
}

export const ProposalSchema = z.object({
  proposalId: z.string().min(1),
  strategyId: z.string().min(1),
  strategyVersion: z.string().min(1),
  instrumentId: z.string().min(1),
  side: z.enum(["long", "short"]),
  entryPrice: z.string(),
  protectiveStopPrice: z.string(),
  takeProfitPrice: z.string().nullable(),
  convictionScore: z.number().min(0).max(1),
  rationale: z.string(),
  tags: z.array(z.string())
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const ProposalMenuSchema = z.object({
  asOfMs: z.number().int().nonnegative(),
  strategyId: z.string().min(1),
  strategyVersion: z.string().min(1),
  instrumentId: z.string().min(1),
  proposals: z.array(ProposalSchema),
  standDownReason: z.string().optional()
});
export type ProposalMenu = z.infer<typeof ProposalMenuSchema>;

export interface MarketDataRepository {
  ingestOkxCandles(input: {
    instrumentId: string;
    timeframe: BarTimeframe;
    candles: readonly RawOkxCandlePayload[];
  }): { insertedCount: number; skippedUnconfirmedCount: number };

  ingestSettledFunding(rates: readonly SettledFundingRate[]): number;

  getConfirmedBarsAsOf(input: {
    instrumentId: string;
    timeframe: BarTimeframe;
    asOfMs: number;
    limit?: number | undefined;
  }): readonly ConfirmedBar[];

  getConfirmedBarsInRange(input: {
    instrumentId: string;
    timeframe: BarTimeframe;
    fromOpenTs: number;
    toCloseTs: number;
  }): readonly ConfirmedBar[];

  getSettledFundingAsOf(input: {
    instrumentId: string;
    asOfMs: number;
    limit?: number | undefined;
  }): readonly SettledFundingRate[];

  getSettledFundingInRange(input: {
    instrumentId: string;
    fromTs: number;
    toTs: number;
  }): readonly SettledFundingRate[];

  detectGaps(input: {
    instrumentId: string;
    timeframe: BarTimeframe;
    fromOpenTs: number;
    toOpenTs: number;
  }): readonly MarketGapRange[];

  detectFundingGaps(input: {
    readonly instrumentId: string;
    readonly fromFundingTs: number;
    readonly toFundingTs: number;
  }): readonly { readonly missingFromTs: number; readonly missingToTs: number }[];

  assertLookbackSatisfied(input: {
    instrumentId: string;
    asOfMs: number;
    requirements: LookbackRequirement;
  }): LookbackValidationResult;

  buildFeatureSnapshot(input: {
    instrumentId: string;
    asOfMs: number;
    requirements: LookbackRequirement;
  }): FeatureSnapshot;

  computeDataSnapshot(input: {
    instrumentIds: readonly string[];
    fromTs: number;
    toTs: number;
  }): DataSnapshotMetadata;

  listInstrumentsWithCoverage(): readonly {
    instrumentId: string;
    barCounts: Record<BarTimeframe, number>;
    fundingCount: number;
    earliestOpenTs: number | null;
    latestCloseTs: number | null;
  }[];
}

export const IN_SAMPLE_START_TS = 1_672_531_200_000; // 2023-01-01 00:00:00 UTC
export const IN_SAMPLE_END_TS = 1_735_689_600_000; // 2025-01-01 00:00:00 UTC
export const SEALED_HOLDOUT_START_TS = 1_735_689_600_000; // 2025-01-01 00:00:00 UTC
export const SEALED_HOLDOUT_END_TS = 1_767_225_600_000; // 2026-01-01 00:00:00 UTC

export const SEALED_2026_HOLDOUT_START_TS = 1_767_225_600_000; // 2026-01-01 00:00:00 UTC
export const SEALED_2026_HOLDOUT_END_TS = 1_782_863_999_000; // 2026-06-30 23:59:59 UTC

export const BenchmarkBaselineSchema = z.object({
  returnPct: z.number(),
  sharpeRatio: z.number(),
  maxDrawdownPct: z.number().nonnegative()
});
export type BenchmarkBaseline = z.infer<typeof BenchmarkBaselineSchema>;

export const ExperimentRecordSchema = z.object({
  sequence: z.number().int().positive().optional(),
  experimentId: z.string().min(1),
  strategyId: z.string().min(1),
  strategyVersion: z.string().min(1),
  instrumentId: z.string().min(1),
  timeframe: BarTimeframeSchema,
  dataSnapshotId: z.string().regex(/^[a-f0-9]{64}$/),
  configHash: z.string().regex(/^[a-f0-9]{64}$/),
  fromTs: z.number().int().nonnegative(),
  toTs: z.number().int().nonnegative(),
  totalTrades: z.number().int().nonnegative(),
  winRate: z.number().min(0).max(1),
  avgR: z.number(),
  netPnlUsdt: z.string(),
  totalFeesUsdt: z.string(),
  totalFundingUsdt: z.string(),
  maxDrawdownPct: z.number().nonnegative(),
  sharpeRatio: z.number(),
  deflatedSharpeRatio: z.number().min(0).max(1),
  stressNetExpectancyR: z.number(),
  walkForwardOutOfSampleAvgR: z.number(),
  replayGatePassed: z.boolean(),
  createdAtMs: z.number().int().nonnegative(),
  numTrials: z.number().int().positive().default(1),
  buyAndHoldReturnPct: z.number().default(0),
  buyAndHoldSharpeRatio: z.number().default(0),
  randomEntryReturnPct: z.number().default(0),
  randomEntrySharpeRatio: z.number().default(0)
});
export type ExperimentRecord = z.infer<typeof ExperimentRecordSchema>;

export interface ResearchTrialInput {
  readonly strategyId: string;
  readonly parameterHash: string;
  readonly instrumentId: string;
  readonly timeframe: string;
  readonly recordedAtMs?: number | undefined;
}

export interface HoldoutTokenInput {
  readonly token: string;
  readonly partition: string;
  readonly createdAtMs?: number | undefined;
}

export interface ConsumeHoldoutTokenInput {
  readonly token?: string | undefined;
  readonly partition: string;
  readonly nowMs: number;
}

export interface ExperimentRepository {
  saveExperiment(record: ExperimentRecord): ExperimentRecord;
  listExperiments(limit?: number): readonly ExperimentRecord[];
  getExperiment(experimentId: string): ExperimentRecord | null;
  recordTrial(trial: ResearchTrialInput): number;
  getTrialCount(): number;
  createHoldoutToken(input: HoldoutTokenInput): void;
  consumeHoldoutToken(input: ConsumeHoldoutTokenInput): boolean;
  hasUnusedHoldoutToken(partition: string): boolean;
}

export const CircuitBreakerStatusSchema = z.enum([
  "NORMAL",
  "DAILY_LOSS_HALT",
  "WEEKLY_LOSS_HALT",
  "DRAWDOWN_KILL_SWITCH",
  "MANUAL_KILL_SWITCH"
]);
export type CircuitBreakerStatus = z.infer<typeof CircuitBreakerStatusSchema>;

export const CircuitBreakerRecordSchema = z.object({
  status: CircuitBreakerStatusSchema,
  reason: z.string(),
  triggeredAtMs: z.number().int().nonnegative(),
  cooldownUntilMs: z.number().int().nonnegative().nullable(),
  updatedBy: z.string().min(1)
});
export type CircuitBreakerRecord = z.infer<typeof CircuitBreakerRecordSchema>;

export const LedgerAccountSchema = z.enum([
  "cash:usdt",
  "equity_capital:usdt",
  "realized_pnl:usdt",
  "fees_expense:usdt",
  "funding_pnl:usdt"
]);
export type LedgerAccount = z.infer<typeof LedgerAccountSchema>;

export const LedgerEntryRecordSchema = z.object({
  entryId: z.string().min(1),
  txGroupId: z.string().min(1),
  ts: z.number().int().nonnegative(),
  strategyId: z.string().nullable(),
  instrumentId: z.string().nullable(),
  debitAccount: LedgerAccountSchema,
  creditAccount: LedgerAccountSchema,
  amountUsdt: z.string(),
  description: z.string().min(1)
});
export type LedgerEntryRecord = z.infer<typeof LedgerEntryRecordSchema>;

export const LedgerTrialBalanceSchema = z.object({
  totalDebitsUsdt: z.string(),
  totalCreditsUsdt: z.string(),
  isBalanced: z.boolean(),
  cashBalanceUsdt: z.string(),
  realizedPnlUsdt: z.string(),
  feesExpenseUsdt: z.string(),
  fundingPnlUsdt: z.string(),
  netEquityUsdt: z.string(),
  entryCount: z.number().int().nonnegative()
});
export type LedgerTrialBalance = z.infer<typeof LedgerTrialBalanceSchema>;

export interface NewLedgerJournalInput {
  readonly txGroupId: string;
  readonly ts: number;
  readonly strategyId: string | null;
  readonly instrumentId: string | null;
  readonly debitAccount: LedgerAccount;
  readonly creditAccount: LedgerAccount;
  readonly amountUsdt: string;
  readonly description: string;
}

export interface LedgerRiskMetrics {
  readonly currentEquityUsdt: ScaledDecimal;
  readonly dayStartEquityUsdt: ScaledDecimal;
  readonly weekStartEquityUsdt: ScaledDecimal;
  readonly highWaterMarkEquityUsdt: ScaledDecimal;
  readonly feesTodayUsdt: ScaledDecimal;
  readonly drawdownPct: ScaledDecimal;
}

export interface LedgerRepository {
  recordJournal(input: NewLedgerJournalInput): LedgerEntryRecord;
  listEntries(limit?: number): readonly LedgerEntryRecord[];
  getTrialBalance(): LedgerTrialBalance;
  getRiskMetrics(params: {
    readonly asOfMs: number;
    readonly strategyId?: string | null | undefined;
    readonly openUnrealizedPnlUsdt?: ScaledDecimal | undefined;
  }): LedgerRiskMetrics;
}

export const PaperPositionRecordSchema = z.object({
  positionId: z.string().min(1),
  strategyId: z.string().min(1),
  instrumentId: z.string().min(1),
  side: z.enum(["long", "short"]),
  contracts: z.string(),
  entryPrice: z.string(),
  protectiveStopPrice: z.string(),
  takeProfitPrice: z.string().nullable(),
  initialRiskUsdt: z.string(),
  unrealizedPnlUsdt: z.string(),
  realizedPnlUsdt: z.string(),
  feesPaidUsdt: z.string(),
  fundingPaidUsdt: z.string(),
  openedAtMs: z.number().int().nonnegative(),
  lastFundingSettledTs: z.number().int().nonnegative(),
  status: z.enum(["OPEN", "CLOSED"]),
  closedAtMs: z.number().int().nonnegative().nullable(),
  exitPrice: z.string().nullable(),
  exitReason: z.string().nullable()
});
export type PaperPositionRecord = z.infer<typeof PaperPositionRecordSchema>;

export const PaperOrderRecordSchema = z.object({
  orderId: z.string().min(1),
  positionId: z.string().min(1),
  proposalId: z.string().min(1),
  strategyId: z.string().min(1),
  instrumentId: z.string().min(1),
  side: z.enum(["long", "short"]),
  orderRole: z.enum(["ENTRY", "PROTECTIVE_STOP", "TAKE_PROFIT", "FLATTEN"]),
  contracts: z.string(),
  fillPrice: z.string(),
  protectiveStopPrice: z.string(),
  feeUsdt: z.string(),
  status: z.enum(["FILLED", "REJECTED"]),
  createdAtMs: z.number().int().nonnegative()
});
export type PaperOrderRecord = z.infer<typeof PaperOrderRecordSchema>;

export interface PaperAccountRepository {
  savePosition(position: PaperPositionRecord): PaperPositionRecord;
  getPosition(positionId: string): PaperPositionRecord | null;
  listOpenPositions(): readonly PaperPositionRecord[];
  listAllPositions(limit?: number): readonly PaperPositionRecord[];
  saveOrder(order: PaperOrderRecord): PaperOrderRecord;
  listOrders(limit?: number): readonly PaperOrderRecord[];
  countFilledOrdersToday(params: {
    readonly sinceMs: number;
    readonly strategyId?: string | null | undefined;
  }): number;
  getCircuitBreaker(): CircuitBreakerRecord;
  setCircuitBreaker(record: CircuitBreakerRecord): CircuitBreakerRecord;
  getLastProcessedBarCloseTs(params: {
    readonly instrumentId: string;
    readonly strategyId: string;
  }): number | null;
  recordProcessedBar(params: {
    readonly instrumentId: string;
    readonly strategyId: string;
    readonly closeTs: number;
  }): void;
  getPendingProposal(params: {
    readonly strategyId: string;
    readonly instrumentId: string;
  }): Proposal | null;
  savePendingProposal(params: {
    readonly strategyId: string;
    readonly instrumentId: string;
    readonly proposal: Proposal | null;
  }): void;
}

export const PromotionStageSchema = z.enum([
  "Research",
  "Replay",
  "Shadow",
  "Paper",
  "Demo",
  "Live-Ramp",
  "Live"
]);
export type PromotionStage = z.infer<typeof PromotionStageSchema>;

export const StrategyPromotionRecordSchema = z.object({
  strategyId: z.string().min(1),
  currentStage: PromotionStageSchema,
  latestExperimentId: z.string().nullable(),
  replayGatePassed: z.boolean(),
  paperTradesCount: z.number().int().nonnegative(),
  paperDrawdownPct: z.number().nonnegative(),
  rampAllocationPct: z.number().nonnegative().default(100),
  eligibleNextStage: PromotionStageSchema.nullable(),
  demotionReason: z.string().nullable(),
  promotedAtMs: z.number().int().nonnegative().optional(),
  updatedAtMs: z.number().int().nonnegative()
});
export type StrategyPromotionRecord = z.infer<typeof StrategyPromotionRecordSchema>;

export interface PromotionRepository {
  upsertPromotion(record: StrategyPromotionRecord): StrategyPromotionRecord;
  getPromotion(strategyId: string): StrategyPromotionRecord | null;
  listPromotions(): readonly StrategyPromotionRecord[];
}

export interface PaperTickResult {
  readonly asOfMs: number;
  readonly barEvaluated: ConfirmedBar | null;
  readonly positionsClosed: readonly PaperPositionRecord[];
  readonly positionsOpened: readonly PaperPositionRecord[];
  readonly vetoedProposals: readonly { proposal: Proposal; reason: string }[];
  readonly trialBalance: LedgerTrialBalance;
}

export interface Broker {
  getCircuitBreaker(): CircuitBreakerRecord;
  setCircuitBreaker(record: CircuitBreakerRecord): CircuitBreakerRecord;
  getOpenPositions(): readonly PaperPositionRecord[];
  getAllPositions(limit?: number): readonly PaperPositionRecord[];
  getOrders(limit?: number): readonly PaperOrderRecord[];
  flattenAllPositions(
    reason: string
  ): readonly PaperPositionRecord[] | Promise<readonly PaperPositionRecord[]>;
  executeConfirmedBarTick(params: {
    readonly bar: ConfirmedBar;
    readonly strategy?: unknown;
    readonly spec?: unknown;
    readonly featureBars?:
      Readonly<Partial<Record<BarTimeframe, readonly ConfirmedBar[]>>> | undefined;
    readonly settledFundingRates?: readonly SettledFundingRate[] | undefined;
  }): PaperTickResult;
}

export const ExchangeOrderInputSchema = z.object({
  instrumentId: z.string().min(1),
  side: z.enum(["long", "short"]),
  sizeLots: z.number().int().positive(),
  entryPrice: z.string().min(1),
  protectiveStopPrice: z.string().optional(), // MANDATORY attached stop checked at domain boundary with 403 (ADR-0006)
  takeProfitPrice: z.string().optional(),
  clOrdId: z.string().optional(),
  strategyId: z.string().optional(),
  initialRiskUsdt: z.string().optional(),
  reduceOnly: z.boolean().default(false)
});
export type ExchangeOrderInput = z.infer<typeof ExchangeOrderInputSchema>;

export const ExchangeOrderResultSchema = z.object({
  orderId: z.string(),
  clOrdId: z.string(),
  algoOrderId: z.string(),
  instrumentId: z.string(),
  side: z.enum(["long", "short"]),
  fillPrice: z.string(),
  sizeLots: z.number(),
  protectiveStopPrice: z.string(),
  status: z.enum(["SUBMITTED", "FILLED", "REJECTED"]),
  submittedAtMs: z.number().int()
});
export type ExchangeOrderResult = z.infer<typeof ExchangeOrderResultSchema>;

export const DmsStatusSchema = z.object({
  enabled: z.boolean(),
  timeoutSeconds: z.number().int(),
  lastHeartbeatAtMs: z.number().int().nullable(),
  nextHeartbeatDueMs: z.number().int().nullable(),
  healthy: z.boolean()
});
export type DmsStatus = z.infer<typeof DmsStatusSchema>;

export const ReconciliationResultSchema = z.object({
  asOfMs: z.number().int(),
  matched: z.boolean(),
  localPositionsCount: z.number().int(),
  exchangePositionsCount: z.number().int(),
  driftDetails: z.array(z.string())
});
export type ReconciliationResult = z.infer<typeof ReconciliationResultSchema>;

export interface ExchangeBroker extends Broker {
  submitOrder(input: ExchangeOrderInput): Promise<ExchangeOrderResult>;
  sendDmsHeartbeat(): Promise<{
    ok: boolean;
    countdownSeconds: number;
    status?: "ok" | "not_configured" | "failed";
  }>;
  reconcilePositions(): Promise<ReconciliationResult>;
  getDmsStatus(): DmsStatus;
  amendAlgoOrder(params: {
    readonly algoOrderId: string;
    readonly instrumentId: string;
    readonly newStopPrice: string;
  }): Promise<{ ok: boolean; algoOrderId: string; newStopPrice: string }>;
}

export const ContextDirectionalBiasSchema = z.enum(["bullish", "bearish", "neutral"]);
export type ContextDirectionalBias = z.infer<typeof ContextDirectionalBiasSchema>;

export const ContextFeatureRecordSchema = z.object({
  featureId: z.string().min(1),
  source: z.string().min(1),
  headline: z.string().min(1),
  directionalBias: ContextDirectionalBiasSchema,
  noveltyScore: z.number().min(0).max(1),
  confidenceScore: z.number().min(0).max(1),
  asOfMs: z.number().int().nonnegative(),
  affectedInstruments: z.array(z.string()),
  tags: z.array(z.string()),
  trainingContaminated: z.boolean().default(false)
});
export type ContextFeatureRecord = z.infer<typeof ContextFeatureRecordSchema>;

export interface LlmCallBudgetReservation {
  readonly reservationId: string;
  readonly featureName: string;
  readonly estimatedTokens: number;
  readonly estimatedCostUsd: number;
  readonly approved: boolean;
  readonly rejectionReason?: string | undefined;
}

export interface LlmCompletionRequest {
  readonly featureName:
    | "contextAnalyst"
    | "shadowAdvisor"
    | "strategyLab"
    | "postTradeAndCopilot"
    | "eventGateAdvisor"
    | "narrativeClusterTagger"
    | "markoutForensics";
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly asOfMs: number;
  readonly modelCutoffDate?: string | undefined;
}

export interface LlmCompletionResponse<T = unknown> {
  readonly parsed: T;
  readonly rawText: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly actualCostUsd: number;
  readonly trainingContaminated: boolean;
}

export interface LlmGateway {
  completeStructured<T>(
    request: LlmCompletionRequest,
    schema: z.ZodType<T>
  ): Promise<LlmCompletionResponse<T>>;
  getRemainingDailyBudgetUsd(): number;
  getRemainingMonthlyBudgetUsd(): number;
}

// ============================================================================
// Milestone M6: Advanced AI Decision Support, Event Gate, & Markout Forensics
// ============================================================================

export const EventGateRecommendationSchema = z.enum([
  "PASS",
  "REDUCE_SIZE",
  "WIDEN_STOP",
  "STAND_DOWN"
]);
export type EventGateRecommendation = z.infer<typeof EventGateRecommendationSchema>;

export const EventGateEvaluationSchema = z.object({
  asOfMs: z.number().int().nonnegative(),
  eventHeadline: z.string().min(1),
  volatilityRisk: z.enum(["low", "moderate", "high", "extreme"]),
  riskScore: z.number().min(0).max(1),
  recommendation: EventGateRecommendationSchema,
  rationale: z.string().min(1),
  affectedInstruments: z.array(z.string()),
  cooldownMinutes: z.number().int().nonnegative(),
  trainingContaminated: z.boolean().default(false)
});
export type EventGateEvaluation = z.infer<typeof EventGateEvaluationSchema>;

export const NarrativeClusterRecordSchema = z.object({
  clusterId: z.string().min(1),
  name: z.string().min(1),
  theme: z.string().min(1),
  sentimentBias: ContextDirectionalBiasSchema,
  noveltyScore: z.number().min(0).max(1),
  affectedInstruments: z.array(z.string()),
  announcementsCount: z.number().int().nonnegative(),
  asOfMs: z.number().int().nonnegative(),
  trainingContaminated: z.boolean().default(false)
});
export type NarrativeClusterRecord = z.infer<typeof NarrativeClusterRecordSchema>;

export const MarkoutForensicReportSchema = z.object({
  orderId: z.string().min(1),
  instrumentId: z.string().min(1),
  side: z.enum(["long", "short"]),
  fillPrice: z.string(),
  markout5mBps: z.number(),
  markout15mBps: z.number(),
  markout1hBps: z.number(),
  adverseSelectionScore: z.number().min(0).max(1),
  executionQualityRating: z.enum(["EXCELLENT", "ACCEPTABLE", "ADVERSE_SELECTION", "TOXIC"]),
  recommendedAggressiveness: z.enum(["MORE_PASSIVE", "OPTIMAL", "MORE_AGGRESSIVE"]),
  forensicSummary: z.string(),
  asOfMs: z.number().int().nonnegative(),
  trainingContaminated: z.boolean().default(false)
});
export type MarkoutForensicReport = z.infer<typeof MarkoutForensicReportSchema>;
