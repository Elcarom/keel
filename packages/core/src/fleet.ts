import { z } from "zod";

// ============================================================================
// The Fleet: bots, the wallets that fund them, and the propositions they are launched from.
// A Bot is a running instance of one compiled Strategy Spec trading its own isolated paper
// Trading Book, funded by an allocation drawn from a Wallet.
// ============================================================================

export const BOT_ARCHETYPES = [
  "breakout",
  "mean_reversion",
  "momentum",
  "ma_crossover",
  "trend_pullback"
] as const;
export const BotArchetypeSchema = z.enum(BOT_ARCHETYPES);
export type BotArchetype = z.infer<typeof BotArchetypeSchema>;

export const FLEET_INSTRUMENTS = ["BTC-USDT-SWAP", "ETH-USDT-SWAP"] as const;
export const FleetInstrumentSchema = z.enum(FLEET_INSTRUMENTS);
export type FleetInstrument = z.infer<typeof FleetInstrumentSchema>;

export const BOT_DIRECTIONS = ["both", "long_only", "short_only"] as const;
export const BotDirectionSchema = z.enum(BOT_DIRECTIONS);
export type BotDirection = z.infer<typeof BotDirectionSchema>;

export const ARCHETYPE_LABELS: Readonly<Record<BotArchetype, string>> = {
  breakout: "Channel breakout",
  mean_reversion: "Mean reversion",
  momentum: "Momentum",
  ma_crossover: "Moving-average crossover",
  trend_pullback: "Trend pullback"
};

/** What a model returns: numbers are unbounded here and clamped when normalized. */
export const BotBlueprintDraftSchema = z.object({
  name: z.string().min(1).max(80),
  tagline: z.string().min(1).max(300),
  archetype: BotArchetypeSchema,
  instrumentId: FleetInstrumentSchema,
  direction: BotDirectionSchema,
  lookbackPeriod: z.number(),
  fastPeriod: z.number(),
  entryThreshold: z.number(),
  stopAtrMultiple: z.number(),
  rewardMultiple: z.number(),
  rationale: z.string().max(2000)
});
export type BotBlueprintDraft = z.infer<typeof BotBlueprintDraftSchema>;

export const BotBlueprintSchema = BotBlueprintDraftSchema.extend({
  name: z.string().min(1).max(40),
  tagline: z.string().min(1).max(160),
  lookbackPeriod: z.number().int().min(5).max(200),
  fastPeriod: z.number().int().min(3).max(100),
  entryThreshold: z.number().min(0.2).max(4),
  stopAtrMultiple: z.number().min(0.5).max(6),
  rewardMultiple: z.number().min(0.8).max(6),
  rationale: z.string().max(600)
});
export type BotBlueprint = z.infer<typeof BotBlueprintSchema>;

/** JSON Schema of one draft, for providers that constrain decoding (no numeric bounds allowed). */
export const BOT_BLUEPRINT_DRAFT_JSON_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  additionalProperties: false,
  required: [
    "name",
    "tagline",
    "archetype",
    "instrumentId",
    "direction",
    "lookbackPeriod",
    "fastPeriod",
    "entryThreshold",
    "stopAtrMultiple",
    "rewardMultiple",
    "rationale"
  ],
  properties: {
    name: { type: "string", description: "Nautical bot name, 1-3 words, e.g. 'Trade Wind'" },
    tagline: { type: "string", description: "One playful sentence on how the bot sails" },
    archetype: { type: "string", enum: [...BOT_ARCHETYPES] },
    instrumentId: { type: "string", enum: [...FLEET_INSTRUMENTS] },
    direction: { type: "string", enum: [...BOT_DIRECTIONS] },
    lookbackPeriod: {
      type: "integer",
      description: "Main window in 1H bars, 5-200 (channel, z-score, momentum or slow average)"
    },
    fastPeriod: {
      type: "integer",
      description: "Fast average window in 1H bars, 3-100 (crossover and pullback only)"
    },
    entryThreshold: {
      type: "number",
      description:
        "0.2-4: z-score band for mean reversion/pullback, ATR-scaled impulse for momentum"
    },
    stopAtrMultiple: { type: "number", description: "Protective stop distance in ATRs, 0.5-6" },
    rewardMultiple: { type: "number", description: "Take-profit as a multiple of risk, 0.8-6" },
    rationale: { type: "string", description: "Why this could work, in two or three sentences" }
  }
};

function clampInt(value: number, min: number, max: number): number {
  const v = Number.isFinite(value) ? Math.round(value) : min;
  return Math.min(max, Math.max(min, v));
}

function clampNum(value: number, min: number, max: number): number {
  const v = Number.isFinite(value) ? value : min;
  return Math.round(Math.min(max, Math.max(min, v)) * 100) / 100;
}

/** Clamps every parameter into its reviewed range and trims text; never fails on numbers. */
export function normalizeBlueprint(draft: BotBlueprintDraft): BotBlueprint {
  const lookbackPeriod = clampInt(draft.lookbackPeriod, 5, 200);
  // A fast average must stay faster than the slow one, or the crossover never fires
  const fastPeriod = clampInt(draft.fastPeriod, 3, Math.max(3, Math.min(100, lookbackPeriod - 2)));
  return BotBlueprintSchema.parse({
    name: draft.name.trim().slice(0, 40),
    tagline: draft.tagline.trim().slice(0, 160),
    archetype: draft.archetype,
    instrumentId: draft.instrumentId,
    direction: draft.direction,
    lookbackPeriod,
    fastPeriod,
    entryThreshold: clampNum(draft.entryThreshold, 0.2, 4),
    stopAtrMultiple: clampNum(draft.stopAtrMultiple, 0.5, 6),
    rewardMultiple: clampNum(draft.rewardMultiple, 0.8, 6),
    rationale: draft.rationale.trim().slice(0, 600)
  });
}

export const RiskAppetiteSchema = z.enum(["cautious", "balanced", "bold"]);
export type RiskAppetite = z.infer<typeof RiskAppetiteSchema>;

/** The operator's guided request to the Shipyard. */
export const DesignBriefSchema = z.object({
  instruments: z.array(FleetInstrumentSchema).min(1).max(FLEET_INSTRUMENTS.length),
  /** Empty means "surprise me": any archetype. */
  styles: z.array(BotArchetypeSchema).max(BOT_ARCHETYPES.length),
  riskAppetite: RiskAppetiteSchema,
  direction: z.enum(["any", "long_only", "short_only"]),
  count: z.number().int().min(2).max(6),
  notes: z.string().max(1000)
});
export type DesignBrief = z.infer<typeof DesignBriefSchema>;

export const VerdictSchema = z.enum(["seaworthy", "promising", "choppy", "sinks"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const AssessmentSchema = z.object({
  score: z.number().min(0).max(100),
  verdict: VerdictSchema,
  headline: z.string(),
  gatePassed: z.boolean(),
  dataSource: z.enum(["okx", "synthetic"]),
  fromTs: z.number().int(),
  toTs: z.number().int(),
  totalTrades: z.number().int().nonnegative(),
  winRate: z.number(),
  returnPct: z.number(),
  maxDrawdownPct: z.number(),
  sharpeRatio: z.number(),
  deflatedSharpeRatio: z.number(),
  avgR: z.number(),
  buyAndHoldReturnPct: z.number(),
  /** Equity as % return from the start, downsampled for sparklines. */
  equityCurvePct: z.array(z.number())
});
export type Assessment = z.infer<typeof AssessmentSchema>;

export const PropositionStatusSchema = z.enum([
  "assessing",
  "ranked",
  "failed",
  "launched",
  "discarded"
]);
export type PropositionStatus = z.infer<typeof PropositionStatusSchema>;

export const DesignSourceSchema = z.enum(["claude", "sample"]);
export type DesignSource = z.infer<typeof DesignSourceSchema>;

export const PropositionSchema = z.object({
  propositionId: z.string(),
  batchId: z.string(),
  createdAtMs: z.number().int(),
  source: DesignSourceSchema,
  blueprint: BotBlueprintSchema,
  status: PropositionStatusSchema,
  assessment: AssessmentSchema.nullable(),
  rank: z.number().int().positive().nullable(),
  error: z.string().nullable(),
  botId: z.string().nullable()
});
export type Proposition = z.infer<typeof PropositionSchema>;

export const DesignBatchSchema = z.object({
  batchId: z.string(),
  createdAtMs: z.number().int(),
  brief: DesignBriefSchema,
  source: DesignSourceSchema,
  status: z.enum(["assessing", "done"]),
  note: z.string().nullable(),
  propositions: z.array(PropositionSchema)
});
export type DesignBatch = z.infer<typeof DesignBatchSchema>;

export const WalletSchema = z.object({
  walletId: z.string(),
  name: z.string(),
  kind: z.literal("paper"),
  createdAtMs: z.number().int(),
  /** Unallocated cash. */
  availableUsdt: z.string(),
  /** Allocations currently held by active bots. */
  allocatedUsdt: z.string(),
  botCount: z.number().int().nonnegative()
});
export type Wallet = z.infer<typeof WalletSchema>;

export const BotStatusSchema = z.enum(["running", "paused", "retired"]);
export type BotStatus = z.infer<typeof BotStatusSchema>;

/** Prototype scope: Live trading is not built, so a bot can only trade the paper book. */
export const BotModeSchema = z.literal("paper");

export const BotTradeSchema = z.object({
  side: z.enum(["long", "short"]),
  entryPrice: z.string(),
  exitPrice: z.string().nullable(),
  contracts: z.string(),
  pnlUsdt: z.string(),
  openedAtMs: z.number().int(),
  closedAtMs: z.number().int().nullable(),
  exitReason: z.string().nullable()
});
export type BotTrade = z.infer<typeof BotTradeSchema>;

export const BotOpenPositionSchema = z.object({
  side: z.enum(["long", "short"]),
  entryPrice: z.string(),
  contracts: z.string(),
  protectiveStopPrice: z.string(),
  takeProfitPrice: z.string().nullable(),
  unrealizedPnlUsdt: z.string(),
  openedAtMs: z.number().int()
});

export const BotSchema = z.object({
  botId: z.string(),
  name: z.string(),
  tagline: z.string(),
  blueprint: BotBlueprintSchema,
  mode: BotModeSchema,
  status: BotStatusSchema,
  /** Why the bot last changed status, e.g. a loss limit that sent it back to harbour. */
  statusReason: z.string().nullable(),
  walletId: z.string(),
  walletName: z.string(),
  allocationUsdt: z.string(),
  createdAtMs: z.number().int(),
  retiredAtMs: z.number().int().nullable(),
  backtest: AssessmentSchema.nullable(),
  equityUsdt: z.string(),
  pnlUsdt: z.string(),
  returnPct: z.number(),
  maxDrawdownPct: z.number(),
  tradesCount: z.number().int().nonnegative(),
  winRate: z.number(),
  openPosition: BotOpenPositionSchema.nullable(),
  lastBarAtMs: z.number().int().nullable(),
  equityCurve: z.array(z.number()),
  recentTrades: z.array(BotTradeSchema)
});
export type Bot = z.infer<typeof BotSchema>;

export const FleetOverviewSchema = z.object({
  bots: z.array(BotSchema),
  wallets: z.array(WalletSchema),
  totals: z.object({
    equityUsdt: z.string(),
    pnlUsdt: z.string(),
    returnPct: z.number(),
    activeBots: z.number().int(),
    openPositions: z.number().int()
  }),
  schedulerRunning: z.boolean(),
  killSwitchActive: z.boolean(),
  killSwitchReason: z.string().nullable(),
  designer: z.object({
    source: DesignSourceSchema,
    model: z.string()
  }),
  liveTradingAvailable: z.literal(false)
});
export type FleetOverview = z.infer<typeof FleetOverviewSchema>;

// ---------------------------------------------------------------------------
// Persistence port
// ---------------------------------------------------------------------------

export interface WalletRecord {
  readonly walletId: string;
  readonly name: string;
  readonly kind: "paper";
  readonly createdAtMs: number;
}

/** Signed movement of wallet cash: deposits and bot returns are positive, allocations negative. */
export interface WalletEntryRecord {
  readonly walletId: string;
  readonly ts: number;
  readonly amountUsdt: string;
  readonly reason: "deposit" | "allocation" | "return";
  readonly botId: string | null;
}

export interface BotRecord {
  readonly botId: string;
  readonly name: string;
  readonly tagline: string;
  readonly blueprint: BotBlueprint;
  readonly walletId: string;
  readonly allocationUsdt: string;
  readonly status: BotStatus;
  readonly statusReason: string | null;
  readonly createdAtMs: number;
  readonly retiredAtMs: number | null;
  readonly propositionId: string | null;
  readonly backtest: Assessment | null;
}

export interface DesignBatchRecord {
  readonly batchId: string;
  readonly createdAtMs: number;
  readonly brief: DesignBrief;
  readonly source: DesignSource;
  readonly note: string | null;
}

export type PropositionRecord = Proposition;

export interface FleetRepository {
  createWallet(wallet: WalletRecord): WalletRecord;
  getWallet(walletId: string): WalletRecord | null;
  listWallets(): readonly WalletRecord[];
  appendWalletEntry(entry: WalletEntryRecord): void;
  /** Sum of a wallet's entries, as a decimal string. */
  getWalletBalanceUsdt(walletId: string): string;

  saveBot(bot: BotRecord): BotRecord;
  getBot(botId: string): BotRecord | null;
  listBots(): readonly BotRecord[];
  deleteBot(botId: string): void;

  saveBatch(batch: DesignBatchRecord): DesignBatchRecord;
  listBatches(limit: number): readonly DesignBatchRecord[];
  saveProposition(proposition: PropositionRecord): PropositionRecord;
  getProposition(propositionId: string): PropositionRecord | null;
  listPropositions(batchId: string): readonly PropositionRecord[];

  /** Where an instrument's backtest window came from, once it has been filled. */
  getBacktestDataSource(instrumentId: string): "okx" | "synthetic" | null;
  setBacktestDataSource(instrumentId: string, source: "okx" | "synthetic"): void;
}
