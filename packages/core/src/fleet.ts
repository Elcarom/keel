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
  "trend_pullback",
  "squeeze_breakout",
  "volume_breakout",
  "inside_bar_breakout",
  "keltner_ride",
  "regime_momentum",
  "rsi_reversal",
  "failed_breakout",
  "capitulation_fade",
  "pair_reversion",
  "pair_momentum"
] as const;
export const BotArchetypeSchema = z.enum(BOT_ARCHETYPES);
export type BotArchetype = z.infer<typeof BotArchetypeSchema>;

/** A blueprint is one of the reviewed archetypes, or rules Claude invented (see Invention). */
export const BlueprintArchetypeSchema = z.enum([...BOT_ARCHETYPES, "invented"]);
export type BlueprintArchetype = z.infer<typeof BlueprintArchetypeSchema>;

/** Indicator kinds the Strategy Spec language can compute; the single source for every layer. */
export const INDICATOR_KINDS = [
  "donchian",
  "atr",
  "sma",
  "stddev",
  "zscore",
  "momentum",
  "ema",
  "rsi",
  "volume_sma",
  "adx",
  "bollinger",
  "percentile",
  "correlation",
  "spread"
] as const;
export type IndicatorKind = (typeof INDICATOR_KINDS)[number];

export const FLEET_INSTRUMENTS = [
  "BTC-USDT-SWAP",
  "ETH-USDT-SWAP",
  "SOL-USDT-SWAP",
  "XRP-USDT-SWAP",
  "DOGE-USDT-SWAP",
  "BNB-USDT-SWAP",
  "ADA-USDT-SWAP",
  "AVAX-USDT-SWAP",
  "LINK-USDT-SWAP",
  "LTC-USDT-SWAP"
] as const;
export const FleetInstrumentSchema = z.enum(FLEET_INSTRUMENTS);
export type FleetInstrument = z.infer<typeof FleetInstrumentSchema>;

/** The most coins one boat may trade: its own market plus up to four more in its basket. */
export const MAX_BOAT_MARKETS = 5;

/** Pair archetypes trade two coins against each other: long one leg, short the other (ADR-0032). */
export const PAIR_ARCHETYPES: ReadonlySet<string> = new Set(["pair_reversion", "pair_momentum"]);

/**
 * Rules Claude wrote itself, in the Strategy Spec condition language. Stored as data and
 * validated by @keel/spec before anything compiles; `rules` is Keel's plain-English rendering.
 */
export const InventionSchema = z.object({
  indicators: z
    .array(
      z.object({
        id: z.string().min(1).max(24),
        kind: z.enum(INDICATOR_KINDS),
        period: z.number().int().min(2).max(200),
        /** Read from another market's bars, aligned hour by hour (ADR-0028). */
        market: FleetInstrumentSchema.optional(),
        /** Computed on 4-hour or daily bars built from complete hourly bars (ADR-0031). */
        timeframe: z.enum(["4H", "1D"]).optional()
      })
    )
    .min(1)
    .max(6),
  longEntry: z.unknown(),
  shortEntry: z.unknown(),
  /** Optional exit rules: close an open long (short) when they turn true (ADR-0029). */
  longExit: z.unknown().optional(),
  shortExit: z.unknown().optional(),
  rules: z.array(z.string())
});
export type Invention = z.infer<typeof InventionSchema>;

/**
 * The market each instrument is cross-checked on during a sea trial: an edge that only exists on
 * one coin is more likely luck than structure.
 */
export const SIBLING_INSTRUMENTS: Readonly<Record<FleetInstrument, FleetInstrument>> = {
  "BTC-USDT-SWAP": "ETH-USDT-SWAP",
  "ETH-USDT-SWAP": "BTC-USDT-SWAP",
  "SOL-USDT-SWAP": "AVAX-USDT-SWAP",
  "XRP-USDT-SWAP": "ADA-USDT-SWAP",
  "DOGE-USDT-SWAP": "SOL-USDT-SWAP",
  "BNB-USDT-SWAP": "ETH-USDT-SWAP",
  "ADA-USDT-SWAP": "XRP-USDT-SWAP",
  "AVAX-USDT-SWAP": "SOL-USDT-SWAP",
  "LINK-USDT-SWAP": "AVAX-USDT-SWAP",
  "LTC-USDT-SWAP": "BTC-USDT-SWAP"
};

export const BOT_DIRECTIONS = ["both", "long_only", "short_only"] as const;
export const BotDirectionSchema = z.enum(BOT_DIRECTIONS);
export type BotDirection = z.infer<typeof BotDirectionSchema>;

export const ARCHETYPE_LABELS: Readonly<Record<BlueprintArchetype, string>> = {
  invented: "Invented rules",
  breakout: "Channel breakout",
  mean_reversion: "Mean reversion",
  momentum: "Momentum",
  ma_crossover: "Moving-average crossover",
  trend_pullback: "Trend pullback",
  squeeze_breakout: "Volatility squeeze",
  volume_breakout: "Volume-confirmed breakout",
  inside_bar_breakout: "Inside-bar breakout",
  keltner_ride: "Keltner channel ride",
  regime_momentum: "Regime-filtered momentum",
  rsi_reversal: "RSI reversal",
  failed_breakout: "Failed-breakout fade",
  capitulation_fade: "Capitulation fade",
  pair_reversion: "Pair reversion",
  pair_momentum: "Pair momentum"
};

export const ARCHETYPE_FAMILIES = ["trend", "breakout", "reversion", "pairs"] as const;
export type ArchetypeFamily = (typeof ARCHETYPE_FAMILIES)[number];

export const ARCHETYPE_FAMILY: Readonly<Record<BotArchetype, ArchetypeFamily>> = {
  momentum: "trend",
  ma_crossover: "trend",
  trend_pullback: "trend",
  keltner_ride: "trend",
  regime_momentum: "trend",
  breakout: "breakout",
  squeeze_breakout: "breakout",
  volume_breakout: "breakout",
  inside_bar_breakout: "breakout",
  mean_reversion: "reversion",
  rsi_reversal: "reversion",
  failed_breakout: "reversion",
  capitulation_fade: "reversion",
  pair_reversion: "pairs",
  pair_momentum: "pairs"
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
  rationale: z.string().max(2000),
  /** More coins the same rules also trade, one position per coin (ADR-0028). */
  basket: z
    .array(FleetInstrumentSchema)
    .max(MAX_BOAT_MARKETS - 1)
    .default([]),
  /** Ratchet the stop this many ATRs behind each close; null keeps the stop fixed (ADR-0029). */
  trailingAtrMultiple: z.number().nullable().default(null),
  /** Close a position after this many hourly bars; null holds until stop or target. */
  maxBarsHeld: z.number().nullable().default(null),
  /**
   * The second coin of a pair: the boat holds this coin against its own market, one long and one
   * short, entering and leaving together (ADR-0032). Null for every other boat.
   */
  pairWith: FleetInstrumentSchema.nullable().default(null)
});
export type BotBlueprintDraft = z.infer<typeof BotBlueprintDraftSchema>;
/** A draft as a model may write it: newer fields may be missing and take their defaults. */
export type BotBlueprintDraftInput = z.input<typeof BotBlueprintDraftSchema>;

export const BotBlueprintSchema = BotBlueprintDraftSchema.extend({
  archetype: BlueprintArchetypeSchema,
  /** Present exactly when archetype is "invented". */
  invention: InventionSchema.nullable().default(null),
  name: z.string().min(1).max(40),
  tagline: z.string().min(1).max(160),
  lookbackPeriod: z.number().int().min(5).max(200),
  fastPeriod: z.number().int().min(3).max(100),
  entryThreshold: z.number().min(0.2).max(4),
  stopAtrMultiple: z.number().min(0.5).max(6),
  rewardMultiple: z.number().min(0.8).max(6),
  rationale: z.string().max(600),
  trailingAtrMultiple: z.number().min(0.5).max(6).nullable().default(null),
  maxBarsHeld: z.number().int().min(2).max(240).nullable().default(null)
});
export type BotBlueprint = z.infer<typeof BotBlueprintSchema>;

/** Every coin a boat trades: its own market first, then its pair leg or its basket. */
export function blueprintMarkets(b: {
  readonly instrumentId: FleetInstrument;
  readonly basket?: readonly FleetInstrument[] | undefined;
  readonly pairWith?: FleetInstrument | null | undefined;
}): FleetInstrument[] {
  if (b.pairWith && b.pairWith !== b.instrumentId) return [b.instrumentId, b.pairWith];
  return [...new Set([b.instrumentId, ...(b.basket ?? [])])].slice(0, MAX_BOAT_MARKETS);
}

/** A pair boat's two legs, its own market first; null for a boat that is not a pair. */
export function pairLegs(b: {
  readonly instrumentId: FleetInstrument;
  readonly pairWith?: FleetInstrument | null | undefined;
}): readonly [FleetInstrument, FleetInstrument] | null {
  return b.pairWith && b.pairWith !== b.instrumentId ? [b.instrumentId, b.pairWith] : null;
}

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
    "rationale",
    "basket",
    "trailingAtrMultiple",
    "maxBarsHeld",
    "pairWith"
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
      description:
        "Short window in 1H bars, 3-100, kept below lookbackPeriod (crossover, pullback, squeeze and regime momentum)"
    },
    entryThreshold: {
      type: "number",
      description:
        "0.2-4: the archetype's trigger strength (z-score band, ATR multiple, volume or calm ratio, RSI distance from 50 in tens)"
    },
    stopAtrMultiple: { type: "number", description: "Protective stop distance in ATRs, 0.5-6" },
    rewardMultiple: { type: "number", description: "Take-profit as a multiple of risk, 0.8-6" },
    rationale: { type: "string", description: "Why this could work, in two or three sentences" },
    basket: {
      type: "array",
      items: { type: "string", enum: [...FLEET_INSTRUMENTS] },
      description:
        "Up to 4 more coins the same rules also trade, one position per coin; [] for a single-coin boat"
    },
    trailingAtrMultiple: {
      type: ["number", "null"],
      description:
        "0.5-6: ratchet the stop this many ATRs behind each close so winners can run; null keeps the stop fixed"
    },
    maxBarsHeld: {
      type: ["integer", "null"],
      description: "2-240: close any position after this many hourly bars; null for no time limit"
    },
    pairWith: {
      type: ["string", "null"],
      enum: [...FLEET_INSTRUMENTS, null],
      description:
        "Pair archetypes only: the second coin, held against instrumentId (one long, one short); null otherwise"
    }
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
export function normalizeBlueprint(draft: BotBlueprintDraftInput): BotBlueprint {
  const lookbackPeriod = clampInt(draft.lookbackPeriod, 5, 200);
  // A fast average must stay faster than the slow one, or the crossover never fires
  const fastPeriod = clampInt(draft.fastPeriod, 3, Math.max(3, Math.min(100, lookbackPeriod - 2)));
  // A pair needs a second, different coin and nothing else: no basket, no per-leg trailing stop
  const isPair = PAIR_ARCHETYPES.has(draft.archetype);
  const pairWith = isPair
    ? draft.pairWith && draft.pairWith !== draft.instrumentId
      ? draft.pairWith
      : SIBLING_INSTRUMENTS[draft.instrumentId]
    : null;
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
    rationale: draft.rationale.trim().slice(0, 600),
    basket: isPair ? [] : blueprintMarkets({ ...draft, pairWith: null }).slice(1),
    trailingAtrMultiple:
      isPair || draft.trailingAtrMultiple === null || draft.trailingAtrMultiple === undefined
        ? null
        : clampNum(draft.trailingAtrMultiple, 0.5, 6),
    // A pair always has a time limit: a spread that never comes back is a broken pair
    maxBarsHeld:
      draft.maxBarsHeld === null || draft.maxBarsHeld === undefined
        ? isPair
          ? Math.min(240, lookbackPeriod * 3)
          : null
        : clampInt(draft.maxBarsHeld, 2, 240),
    pairWith,
    invention: null
  });
}

export const RiskAppetiteSchema = z.enum(["cautious", "balanced", "bold"]);
export type RiskAppetite = z.infer<typeof RiskAppetiteSchema>;

/**
 * Blueprint mode fills one of the reviewed archetypes; Inventor mode lets Claude write new rules
 * in the Strategy Spec language.
 */
export const DesignModeSchema = z.enum(["blueprint", "inventor"]);
export type DesignMode = z.infer<typeof DesignModeSchema>;

/** The operator's guided request to the Shipyard. */
export const DesignBriefSchema = z.object({
  mode: DesignModeSchema.default("blueprint"),
  instruments: z.array(FleetInstrumentSchema).min(1).max(FLEET_INSTRUMENTS.length),
  /** Empty means "surprise me": any archetype. */
  styles: z.array(BotArchetypeSchema).max(BOT_ARCHETYPES.length),
  riskAppetite: RiskAppetiteSchema,
  direction: z.enum(["any", "long_only", "short_only"]),
  count: z.number().int().min(2).max(6),
  notes: z.string().max(1000)
});
export type DesignBrief = z.infer<typeof DesignBriefSchema>;

/** The most inventions one imported file may hold: each takes a sea trial of about 15 seconds. */
export const MAX_IMPORTED_INVENTIONS = 20;

/** The brief a batch was drawn up under; an imported file may hold more ideas than a brief asks. */
export const BatchBriefSchema = DesignBriefSchema.extend({
  count: z.number().int().min(1).max(MAX_IMPORTED_INVENTIONS)
});
export type BatchBrief = z.infer<typeof BatchBriefSchema>;

/** What the operator wants a Claude chat to invent, for the copy-and-paste Inventor prompt. */
export const InventorPromptRequestSchema = z.object({
  instruments: z.array(FleetInstrumentSchema).min(1).max(FLEET_INSTRUMENTS.length),
  direction: z.enum(["any", "long_only", "short_only"]),
  count: z.number().int().min(1).max(MAX_IMPORTED_INVENTIONS),
  notes: z.string().max(1000)
});
export type InventorPromptRequest = z.infer<typeof InventorPromptRequestSchema>;

/** An imported invention Keel refused, with the reason in words Claude can act on. */
export const InventionRejectionSchema = z.object({
  name: z.string(),
  error: z.string()
});
export type InventionRejection = z.infer<typeof InventionRejectionSchema>;

export const VerdictSchema = z.enum(["seaworthy", "promising", "choppy", "sinks"]);
export type Verdict = z.infer<typeof VerdictSchema>;

/** The checks every proposition's sea trial runs; critical ones gate the "seaworthy" verdict. */
export const SEA_TRIAL_CHECKS = [
  "enough_trades",
  "survives_costs",
  "out_of_sample",
  "steady_quarters",
  "robust_parameters",
  "travels_well",
  "beats_random",
  "beats_holding",
  "luck_adjusted",
  "survives_resampling",
  "shallow_drawdown"
] as const;
export const SeaTrialCheckKeySchema = z.enum(SEA_TRIAL_CHECKS);
export type SeaTrialCheckKey = z.infer<typeof SeaTrialCheckKeySchema>;

export const SeaTrialCheckSchema = z.object({
  key: SeaTrialCheckKeySchema,
  label: z.string(),
  passed: z.boolean(),
  critical: z.boolean(),
  detail: z.string()
});
export type SeaTrialCheck = z.infer<typeof SeaTrialCheckSchema>;

/** One calendar quarter of the backtest: the boat's return beside the market's. */
export const SeaTrialSegmentSchema = z.object({
  fromTs: z.number().int(),
  toTs: z.number().int(),
  returnPct: z.number(),
  marketReturnPct: z.number(),
  trades: z.number().int().nonnegative()
});
export type SeaTrialSegment = z.infer<typeof SeaTrialSegmentSchema>;

/** The same idea re-run with one parameter nudged, or on the sibling market. */
export const SeaTrialVariantSchema = z.object({
  label: z.string(),
  returnPct: z.number(),
  sharpeRatio: z.number(),
  trades: z.number().int().nonnegative()
});
export type SeaTrialVariant = z.infer<typeof SeaTrialVariantSchema>;

export const SeaTrialSchema = z.object({
  checks: z.array(SeaTrialCheckSchema),
  segments: z.array(SeaTrialSegmentSchema),
  neighbours: z.array(SeaTrialVariantSchema),
  sibling: SeaTrialVariantSchema.extend({ instrumentId: z.string() }).nullable(),
  monteCarlo: z.object({
    paths: z.number().int().positive(),
    lossProbabilityPct: z.number(),
    p5ReturnPct: z.number(),
    medianReturnPct: z.number(),
    p95DrawdownPct: z.number()
  }),
  /** One-sided t-test that the average trade's net R is above zero. */
  tStat: z.number(),
  pValue: z.number(),
  /** Average net R per trade with every cost doubled. */
  stressAvgR: z.number(),
  /** Average net R on purged walk-forward out-of-sample folds. */
  outOfSampleAvgR: z.number(),
  /** Where the boat's Sharpe sits among random-entry paths, 0-100. */
  randomEntryPercentile: z.number(),
  /** Propositions assessed so far: the trial count behind the luck adjustment. */
  trials: z.number().int().positive(),
  /** "settled" when real funding history was charged; "assumed" when a flat rate stood in. */
  funding: z.enum(["settled", "assumed"]),
  /** Equity change (%) at each week of the backtest window: a fixed grid, so trials compare. */
  weeklyEquityPct: z.array(z.number()).default([]),
  /** How long the average trade lasted, in hours. */
  avgHoldHours: z.number().nonnegative().default(0)
});
export type SeaTrial = z.infer<typeof SeaTrialSchema>;

/** A boat or proposition whose backtest moved almost in step with this one (ADR-0030). */
export const LookalikeSchema = z.object({
  name: z.string(),
  kind: z.enum(["boat", "proposition"]),
  /** Correlation of weekly equity changes, -1..1. */
  correlation: z.number()
});
export type Lookalike = z.infer<typeof LookalikeSchema>;

/** Above this weekly correlation, two ideas are treated as the same bet. */
export const LOOKALIKE_CORRELATION = 0.8;

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
  equityCurvePct: z.array(z.number()),
  /** Length of the backtest window; assessments from before sea trials covered a year. */
  days: z.number().int().positive().default(365),
  /** Null for propositions assessed before sea trials existed. */
  seaTrial: SeaTrialSchema.nullable().default(null),
  lookalike: LookalikeSchema.nullable().default(null)
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

/** Who wrote a batch: Claude over the API, Keel's samples, or a file the operator imported. */
export const DesignSourceSchema = z.enum(["claude", "sample", "imported"]);
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
  brief: BatchBriefSchema,
  source: DesignSourceSchema,
  status: z.enum(["assessing", "done"]),
  note: z.string().nullable(),
  /** What the sea trial is doing right now, while the batch is assessing. */
  progress: z.string().nullable(),
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
  instrumentId: z.string(),
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

export const EquityPointSchema = z.object({ ts: z.number().int(), equityUsdt: z.string() });
export type EquityPoint = z.infer<typeof EquityPointSchema>;

export const BotOpenPositionSchema = z.object({
  instrumentId: z.string(),
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
  /** The first open position; a basket boat may hold one per coin, all in openPositions. */
  openPosition: BotOpenPositionSchema.nullable(),
  openPositions: z.array(BotOpenPositionSchema),
  lastBarAtMs: z.number().int().nullable(),
  equityCurve: z.array(z.number()),
  recentTrades: z.array(BotTradeSchema),
  /** Daily equity since launch, the last point being now (display only). */
  equityHistory: z.array(EquityPointSchema),
  /** "drifting" when the drift watch would dock it; "new" until it has 10 trades. */
  health: z.enum(["new", "on_course", "drifting"]),
  /** For each coin it trades: closed trades and their net P&L. */
  coins: z.array(
    z.object({ instrumentId: z.string(), trades: z.number().int(), pnlUsdt: z.string() })
  )
});
export type Bot = z.infer<typeof BotSchema>;

export const FLEET_DUTIES = [
  "digest",
  "driftWatch",
  "autopilot",
  "nightShift",
  "rebalance"
] as const;
export type FleetDuty = (typeof FLEET_DUTIES)[number];

/** One unattended Fleet duty, as the Fleet page shows it. */
export const FleetDutyStatusSchema = z.object({
  duty: z.enum(FLEET_DUTIES),
  label: z.string(),
  enabled: z.boolean(),
  lastRunMs: z.number().int().nullable(),
  /** What it last did, or why it is waiting. */
  note: z.string().nullable()
});
export type FleetDutyStatus = z.infer<typeof FleetDutyStatusSchema>;

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
  /** The active boats' equity added up, day by day (display only). */
  equityHistory: z.array(EquityPointSchema).default([]),
  schedulerRunning: z.boolean(),
  killSwitchActive: z.boolean(),
  killSwitchReason: z.string().nullable(),
  designer: z.object({
    source: DesignSourceSchema,
    model: z.string()
  }),
  liveTradingAvailable: z.literal(false),
  /** What each unattended duty is doing (ADR-0030). */
  duties: z.array(FleetDutyStatusSchema).default([])
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
  readonly brief: BatchBrief;
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
  /** Every proposition ever drafted: the trial count behind the luck adjustment. */
  countPropositions(): number;

  /** When an unattended Fleet duty last ran (ADR-0030), or null if never. */
  getDutyLastRun(duty: string): number | null;
  setDutyLastRun(duty: string, ms: number): void;

  /** Where an instrument's backtest window (from `windowFromTs`) came from, once filled. */
  getBacktestDataSource(instrumentId: string, windowFromTs: number): "okx" | "synthetic" | null;
  setBacktestDataSource(
    instrumentId: string,
    windowFromTs: number,
    source: "okx" | "synthetic"
  ): void;
}
