import { z } from "zod";

export const ExecutionModeSchema = z.enum(["Replay", "Paper", "Demo", "Live-Ramp", "Live"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

/** Modes that route orders to a Venue (Demo account or real money). */
export function isExchangeExecutionMode(mode: ExecutionMode): boolean {
  return mode === "Demo" || mode === "Live-Ramp" || mode === "Live";
}

/** Modes that put real capital at risk on the Venue's live account. */
export function isRealMoneyExecutionMode(mode: ExecutionMode): boolean {
  return mode === "Live-Ramp" || mode === "Live";
}

export const ConfigRiskClassSchema = z.enum([
  "safe",
  "confirm",
  "restart-required",
  "locked-in-live"
]);
export type ConfigRiskClass = z.infer<typeof ConfigRiskClassSchema>;

const RISK_CLASS_SEVERITY: Record<ConfigRiskClass, number> = {
  safe: 0,
  confirm: 1,
  "restart-required": 2,
  "locked-in-live": 3
};

export const SystemConfigSchema = z.object({
  executionMode: ExecutionModeSchema.default("Paper"),
  port: z.number().int().min(1024).max(65535).default(8080),
  trustCloudflareHeaders: z.boolean().default(true),
  cloudflareTeamDomain: z.string().default(""),
  cloudflareAudienceTag: z.string().default(""),
  sseHeartbeatMs: z.number().int().min(5000).max(60000).default(15000),
  shutdownPolicy: z.enum(["hold", "flatten"]).default("hold")
});
export type SystemConfig = z.infer<typeof SystemConfigSchema>;

export const StrategyRiskConfigSchema = z.object({
  riskPerTradePct: z.number().min(0.1).max(1.5).default(0.75),
  maxGrossLeverage: z.number().min(0.5).max(3.0).default(2.0),
  dailyLossStopPct: z.number().min(0.5).max(10.0).default(3.0),
  weeklyLossStopPct: z.number().min(1.0).max(20.0).default(6.0),
  maxDrawdownPct: z.number().min(3.0).max(30.0).default(15.0),
  maxTradesPerDay: z.number().int().min(1).max(50).default(6),
  dailyFeeBudgetPct: z.number().min(0.05).max(2.0).default(0.4)
});

export const PortfolioRiskConfigSchema = z.object({
  maxGrossLeverage: z.number().min(0.5).max(3.0).default(2.0),
  maxNetDirectionalExposure: z.number().min(0.25).max(2.5).default(1.25),
  maxSingleInstrumentExposure: z.number().min(0.25).max(2.0).default(1.0),
  dailyLossStopPct: z.number().min(1.0).max(12.0).default(4.0),
  maxDrawdownKillSwitchPct: z.number().min(3.0).max(25.0).default(12.0),
  venueEquityDriftTolerancePct: z.number().min(0.1).max(10.0).default(1.0)
});

export const RiskConfigSchema = z.object({
  paperPortfolioEquityUsdt: z.number().min(100).max(10_000_000).default(10000),
  liveRampMultipliers: z.tuple([z.number(), z.number(), z.number()]).default([0.25, 0.5, 1.0]),
  strategy: StrategyRiskConfigSchema.default({}),
  portfolio: PortfolioRiskConfigSchema.default({})
});
export type RiskConfig = z.infer<typeof RiskConfigSchema>;

export const PromotionLadderConfigSchema = z.object({
  replayMinTrades: z.number().int().min(100).max(5000).default(150),
  replayMinWalkForwardFolds: z.number().int().min(3).max(20).default(5),
  replayMinSharpe: z.number().min(0.8).max(5.0).default(1.0),
  replayMinDeflatedSharpeConfidence: z.number().min(0.8).max(0.999).default(0.9),
  replayCostStressMultiplier: z.number().min(1.25).max(5.0).default(2.0),
  shadowMinDays: z.number().int().min(7).max(180).default(14),
  shadowMinTrades: z.number().int().min(10).max(500).default(30),
  aiMinDisagreementSample: z.number().int().min(20).max(500).default(50),
  aiMaxBootstrapPValue: z.number().min(0.01).max(0.25).default(0.1),
  paperMinDays: z.number().int().min(14).max(365).default(30),
  paperMinTrades: z.number().int().min(20).max(1000).default(50),
  liveDemotionDrawdownPct: z.number().min(3.0).max(25.0).default(12.0),
  liveRampDemotionDrawdownPct: z.number().min(1.0).max(10.0).default(3.0),
  demoPromotionMinTrades: z.number().int().min(5).max(100).default(20),
  demoPromotionMaxDrawdownPct: z.number().min(1.0).max(15.0).default(8.0),
  liveRampPromotionMinTrades: z.number().int().min(10).max(200).default(50),
  aiDemotionEdgeDecayR: z.number().min(-1.0).max(-0.01).default(-0.15),
  slippageDriftMultiplierCap: z.number().min(1.5).max(5.0).default(2.5)
});
export type PromotionLadderConfig = z.infer<typeof PromotionLadderConfigSchema>;

export const AiFeatureSubBudgetsConfigSchema = z.object({
  contextAnalystPct: z.number().min(0).max(100).default(40),
  shadowAdvisorPct: z.number().min(0).max(100).default(30),
  strategyLabPct: z.number().min(0).max(100).default(20),
  postTradeAndCopilotPct: z.number().min(0).max(100).default(10)
});

export const AiGatewayConfigSchema = z.object({
  provider: z.literal("gemini").default("gemini"),
  fastModel: z.string().min(1).default("gemini-2.5-flash"),
  reasoningModel: z.string().min(1).default("gemini-2.5-pro"),
  botDesignerModel: z.string().min(1).default("claude-opus-5-5"),
  trainingCutoffDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .default("2025-03-01"),
  monthlyBudgetUsd: z.number().min(0).max(500).default(15.0),
  dailyBudgetUsd: z.number().min(0).max(50).default(0.75),
  simulateResponses: z.boolean().default(false),
  subBudgets: AiFeatureSubBudgetsConfigSchema.default({}),
  shadowAdvisorEnabled: z.boolean().default(true),
  contextAnalystEnabled: z.boolean().default(true),
  strategyLabEnabled: z.boolean().default(false),
  postTradeAnalystEnabled: z.boolean().default(false),
  eventGateAdvisorEnabled: z.boolean().default(true)
});
export type AiGatewayConfig = z.infer<typeof AiGatewayConfigSchema>;

export const NotificationsConfigSchema = z.object({
  discordEnabled: z.boolean().default(false),
  routeCritical: z.boolean().default(true),
  routeWarning: z.boolean().default(true),
  routeInfoDigest: z.boolean().default(true),
  warningCooldownMinutes: z.number().int().min(1).max(240).default(15)
});

/**
 * The Fleet's unattended duties (ADR-0030): a daily digest, the drift watch, the Autopilot,
 * the night shift and stake rebalancing. Every one is paper-only and deterministic.
 */
export const FleetConfigSchema = z.object({
  digestEnabled: z.boolean().default(true),
  digestHourUtc: z.number().int().min(0).max(23).default(7),
  driftWatchEnabled: z.boolean().default(true),
  autopilotEnabled: z.boolean().default(false),
  autopilotWalletName: z.string().min(1).max(40).default("Autopilot"),
  autopilotMinScore: z.number().int().min(45).max(100).default(65),
  autopilotStakePct: z.number().min(1).max(100).default(10),
  nightShiftEnabled: z.boolean().default(false),
  nightShiftCadence: z.enum(["daily", "weekly"]).default("weekly"),
  nightShiftHourUtc: z.number().int().min(0).max(23).default(2),
  nightShiftCount: z.number().int().min(2).max(6).default(4),
  nightShiftMode: z.enum(["blueprint", "inventor"]).default("inventor"),
  rebalanceEnabled: z.boolean().default(false)
});
export type FleetConfig = z.infer<typeof FleetConfigSchema>;

export const KeelConfigSchema = z.object({
  system: SystemConfigSchema.default({}),
  risk: RiskConfigSchema.default({}),
  promotionLadder: PromotionLadderConfigSchema.default({}),
  ai: AiGatewayConfigSchema.default({}),
  notifications: NotificationsConfigSchema.default({}),
  fleet: FleetConfigSchema.default({})
});

export type KeelConfig = z.infer<typeof KeelConfigSchema>;

export interface ConfigFieldMetadata {
  readonly key: string;
  readonly path: string;
  readonly label: string;
  readonly helpText: string;
  readonly unit?: string | undefined;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly defaultValue?: unknown;
  readonly riskClass: ConfigRiskClass;
}

interface RawFieldSpec {
  readonly path: string;
  readonly label: string;
  readonly helpText: string;
  readonly unit?: string | undefined;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly defaultValue?: unknown;
  readonly riskClass: ConfigRiskClass;
}

const RAW_FIELD_SPECS: readonly RawFieldSpec[] = [
  {
    path: "system.executionMode",
    label: "Execution Mode",
    helpText: "Active operating environment (Replay, Paper, Demo, Live-Ramp, or Live).",
    defaultValue: "Paper",
    riskClass: "confirm"
  },
  {
    path: "system.port",
    label: "HTTP Port",
    helpText: "Single container port serving the Fastify API and React dashboard.",
    min: 1024,
    max: 65535,
    defaultValue: 8080,
    riskClass: "restart-required"
  },
  {
    path: "system.trustCloudflareHeaders",
    label: "Trust Cloudflare Tunnel Headers",
    helpText: "Honor CF-Connecting-IP and X-Forwarded-Proto from local cloudflared ingress.",
    defaultValue: true,
    riskClass: "restart-required"
  },
  {
    path: "system.cloudflareTeamDomain",
    label: "Cloudflare Zero Trust Team Domain",
    helpText: "Optional Cloudflare Access team domain used to validate Cf-Access-Jwt-Assertion.",
    defaultValue: "",
    riskClass: "confirm"
  },
  {
    path: "system.cloudflareAudienceTag",
    label: "Cloudflare Access Audience (AUD) Tag",
    helpText: "Optional Cloudflare Access application Audience Tag for JWT verification.",
    defaultValue: "",
    riskClass: "confirm"
  },
  {
    path: "system.sseHeartbeatMs",
    label: "Live Stream Heartbeat Interval",
    helpText: "Keep-alive frame interval for SSE streams behind Cloudflare's 100s timeout.",
    unit: "ms",
    min: 5000,
    max: 60000,
    defaultValue: 15000,
    riskClass: "safe"
  },
  {
    path: "system.shutdownPolicy",
    label: "Container Shutdown Policy",
    helpText: "Whether to hold open positions with exchange stops or flatten on SIGTERM.",
    defaultValue: "hold",
    riskClass: "confirm"
  },
  {
    path: "risk.paperPortfolioEquityUsdt",
    label: "Paper Portfolio Starting Equity",
    helpText: "Simulated portfolio capital allocated across strategies in Paper mode.",
    unit: "USDT",
    min: 100,
    max: 10_000_000,
    defaultValue: 10000,
    riskClass: "confirm"
  },
  {
    path: "risk.liveRampMultipliers",
    label: "Live-Ramp Size Multipliers",
    helpText:
      "Fractions of the 1R size a Live-Ramp strategy may trade: below 20 Venue Book trades in stage, from 20, and from 40.",
    unit: "x",
    defaultValue: [0.25, 0.5, 1.0],
    riskClass: "locked-in-live"
  },
  {
    path: "risk.strategy.riskPerTradePct",
    label: "Strategy Unit Risk per Trade (1R)",
    helpText: "Maximum percentage of strategy equity lost if an initial Protective Stop is hit.",
    unit: "%",
    min: 0.1,
    max: 1.5,
    defaultValue: 0.75,
    riskClass: "confirm"
  },
  {
    path: "risk.strategy.maxGrossLeverage",
    label: "Strategy Max Gross Leverage",
    helpText: "Maximum isolated notional exposure per strategy relative to strategy equity.",
    unit: "x",
    min: 0.5,
    max: 3.0,
    defaultValue: 2.0,
    riskClass: "locked-in-live"
  },
  {
    path: "risk.strategy.dailyLossStopPct",
    label: "Strategy Daily Loss Stop",
    helpText:
      "Daily drawdown from 00:00 UTC equity that flattens and halts the strategy for the day.",
    unit: "%",
    min: 0.5,
    max: 10.0,
    defaultValue: 3.0,
    riskClass: "confirm"
  },
  {
    path: "risk.strategy.weeklyLossStopPct",
    label: "Strategy Weekly Loss Stop",
    helpText: "Weekly drawdown limit that places the strategy into a 48h cooldown.",
    unit: "%",
    min: 1.0,
    max: 20.0,
    defaultValue: 6.0,
    riskClass: "confirm"
  },
  {
    path: "risk.strategy.maxDrawdownPct",
    label: "Strategy Max Drawdown Auto-Demotion",
    helpText: "Drawdown from strategy High-Water Mark that flattens and demotes to Forward Shadow.",
    unit: "%",
    min: 3.0,
    max: 30.0,
    defaultValue: 15.0,
    riskClass: "locked-in-live"
  },
  {
    path: "risk.strategy.maxTradesPerDay",
    label: "Max Strategy Trades per Day",
    helpText: "Maximum opening round-trip trades allowed per strategy per UTC day.",
    unit: "trades",
    min: 1,
    max: 50,
    defaultValue: 6,
    riskClass: "safe"
  },
  {
    path: "risk.strategy.dailyFeeBudgetPct",
    label: "Daily Strategy Fee Budget",
    helpText:
      "Maximum daily exchange fees as a percentage of strategy equity before pausing entries.",
    unit: "%",
    min: 0.05,
    max: 2.0,
    defaultValue: 0.4,
    riskClass: "safe"
  },
  {
    path: "risk.portfolio.maxGrossLeverage",
    label: "Portfolio Max Gross Leverage",
    helpText: "Maximum combined gross notional across all strategies relative to portfolio equity.",
    unit: "x",
    min: 0.5,
    max: 3.0,
    defaultValue: 2.0,
    riskClass: "locked-in-live"
  },
  {
    path: "risk.portfolio.maxNetDirectionalExposure",
    label: "Portfolio Net Directional Exposure Cap",
    helpText: "Maximum signed long-minus-short crypto beta across all active strategies.",
    unit: "x",
    min: 0.25,
    max: 2.5,
    defaultValue: 1.25,
    riskClass: "locked-in-live"
  },
  {
    path: "risk.portfolio.maxSingleInstrumentExposure",
    label: "Single-Instrument Concentration Cap",
    helpText: "Maximum combined notional in any single perpetual contract across strategies.",
    unit: "x",
    min: 0.25,
    max: 2.0,
    defaultValue: 1.0,
    riskClass: "confirm"
  },
  {
    path: "risk.portfolio.dailyLossStopPct",
    label: "Portfolio Daily Loss Stop",
    helpText: "Portfolio-wide daily loss percentage that flattens all positions until 00:00 UTC.",
    unit: "%",
    min: 1.0,
    max: 12.0,
    defaultValue: 4.0,
    riskClass: "locked-in-live"
  },
  {
    path: "risk.portfolio.maxDrawdownKillSwitchPct",
    label: "Portfolio Max Drawdown Kill Switch",
    helpText: "Portfolio drawdown from High-Water Mark that trips the global Kill Switch.",
    unit: "%",
    min: 3.0,
    max: 25.0,
    defaultValue: 12.0,
    riskClass: "locked-in-live"
  },
  {
    path: "risk.portfolio.venueEquityDriftTolerancePct",
    label: "Venue Equity Drift Tolerance",
    helpText:
      "How far Venue Book equity may exceed the OKX account balance before exchange entries are refused until the book is rebased.",
    unit: "%",
    min: 0.1,
    max: 10.0,
    defaultValue: 1.0,
    riskClass: "locked-in-live"
  },
  {
    path: "promotionLadder.replayMinTrades",
    label: "Replay Minimum Trade Sample",
    helpText: "Minimum closed trades across walk-forward folds required for Replay-Validated gate.",
    unit: "trades",
    min: 100,
    max: 5000,
    defaultValue: 150,
    riskClass: "confirm"
  },
  {
    path: "promotionLadder.replayMinWalkForwardFolds",
    label: "Replay Minimum Walk-Forward Folds",
    helpText: "Minimum purged and embargoed walk-forward folds required in Replay.",
    unit: "folds",
    min: 3,
    max: 20,
    defaultValue: 5,
    riskClass: "confirm"
  },
  {
    path: "promotionLadder.replayMinSharpe",
    label: "Replay Minimum Net Out-of-Sample Sharpe",
    helpText: "Minimum annualized net Sharpe ratio across walk-forward folds.",
    min: 0.8,
    max: 5.0,
    defaultValue: 1.0,
    riskClass: "confirm"
  },
  {
    path: "promotionLadder.replayMinDeflatedSharpeConfidence",
    label: "Minimum Deflated Sharpe Confidence",
    helpText: "Multiple-testing-adjusted DSR probability threshold required to pass Replay.",
    min: 0.8,
    max: 0.999,
    defaultValue: 0.9,
    riskClass: "confirm"
  },
  {
    path: "promotionLadder.replayCostStressMultiplier",
    label: "Replay Cost-Stress Multiplier",
    helpText: "Fee and slippage multiplier under which net expectancy must remain positive.",
    unit: "x",
    min: 1.25,
    max: 5.0,
    defaultValue: 2.0,
    riskClass: "confirm"
  },
  {
    path: "promotionLadder.shadowMinDays",
    label: "Forward Shadow Minimum Duration",
    helpText: "Minimum calendar days in Forward Shadow before Paper Capital eligibility.",
    unit: "days",
    min: 7,
    max: 180,
    defaultValue: 14,
    riskClass: "confirm"
  },
  {
    path: "promotionLadder.shadowMinTrades",
    label: "Forward Shadow Minimum Trade Decisions",
    helpText: "Minimum shadow trade decisions required before Paper Capital promotion.",
    unit: "trades",
    min: 10,
    max: 500,
    defaultValue: 30,
    riskClass: "confirm"
  },
  {
    path: "promotionLadder.aiMinDisagreementSample",
    label: "AI Minimum Uncontaminated Disagreements",
    helpText: "Minimum forward shadow decisions where AI and Baseline Chooser differed.",
    unit: "decisions",
    min: 20,
    max: 500,
    defaultValue: 50,
    riskClass: "confirm"
  },
  {
    path: "promotionLadder.aiMaxBootstrapPValue",
    label: "AI Maximum One-Sided Bootstrap p-value",
    helpText: "Maximum p-value proving positive AI value-add over Baseline Chooser.",
    min: 0.01,
    max: 0.25,
    defaultValue: 0.1,
    riskClass: "confirm"
  },
  {
    path: "promotionLadder.paperMinDays",
    label: "Paper Capital Minimum Duration",
    helpText: "Minimum days in Paper Capital before Live-Ramp eligibility.",
    unit: "days",
    min: 14,
    max: 365,
    defaultValue: 30,
    riskClass: "confirm"
  },
  {
    path: "promotionLadder.paperMinTrades",
    label: "Paper Capital Minimum Closed Trades",
    helpText: "Minimum closed paper trades required before Live-Ramp eligibility.",
    unit: "trades",
    min: 20,
    max: 1000,
    defaultValue: 50,
    riskClass: "confirm"
  },
  {
    path: "promotionLadder.liveDemotionDrawdownPct",
    label: "Live Auto-Demotion Drawdown Threshold",
    helpText: "Realized live drawdown percentage that flattens and demotes to Forward Shadow.",
    unit: "%",
    min: 3.0,
    max: 25.0,
    defaultValue: 12.0,
    riskClass: "locked-in-live"
  },
  {
    path: "promotionLadder.liveRampDemotionDrawdownPct",
    label: "Live-Ramp Auto-Demotion Drawdown Threshold",
    helpText: "Drawdown percentage in Live-Ramp that auto-flattens and demotes back to Demo.",
    unit: "%",
    min: 1.0,
    max: 10.0,
    defaultValue: 3.0,
    riskClass: "confirm"
  },
  {
    path: "promotionLadder.demoPromotionMinTrades",
    label: "Demo Promotion Min Trades",
    helpText: "Minimum closed paper/demo trades required to become eligible for Live-Ramp.",
    unit: "trades",
    min: 5,
    max: 100,
    defaultValue: 20,
    riskClass: "confirm"
  },
  {
    path: "promotionLadder.demoPromotionMaxDrawdownPct",
    label: "Demo Promotion Max Drawdown",
    helpText: "Maximum paper/demo drawdown percentage permitted to enter Live-Ramp.",
    unit: "%",
    min: 1.0,
    max: 15.0,
    defaultValue: 8.0,
    riskClass: "confirm"
  },
  {
    path: "promotionLadder.liveRampPromotionMinTrades",
    label: "Live-Ramp Promotion Min Trades",
    helpText: "Minimum closed live trades required to progress from Live-Ramp to full Live.",
    unit: "trades",
    min: 10,
    max: 200,
    defaultValue: 50,
    riskClass: "confirm"
  },
  {
    path: "promotionLadder.aiDemotionEdgeDecayR",
    label: "AI Auto-Demotion Rolling Edge Decay",
    helpText: "Rolling 50-decision net R deficit vs Baseline Chooser that demotes an AI advisor.",
    unit: "R",
    min: -1.0,
    max: -0.01,
    defaultValue: -0.15,
    riskClass: "confirm"
  },
  {
    path: "promotionLadder.slippageDriftMultiplierCap",
    label: "Realized Slippage Drift Auto-Demotion Multiplier",
    helpText:
      "Ratio of realized implementation shortfall to modeled replay cost triggering demotion.",
    unit: "x",
    min: 1.5,
    max: 5.0,
    defaultValue: 2.5,
    riskClass: "confirm"
  },
  {
    path: "ai.provider",
    label: "Active LLM Gateway Provider",
    helpText: "Configured LLM provider adapter (Google Gemini).",
    defaultValue: "gemini",
    riskClass: "confirm"
  },
  {
    path: "ai.fastModel",
    label: "Gemini Fast Structured Model",
    helpText: "Pinned Gemini model identifier for Shadow Advisor and Context Analyst.",
    defaultValue: "gemini-2.5-flash",
    riskClass: "confirm"
  },
  {
    path: "ai.reasoningModel",
    label: "Gemini Deep Reasoning Model",
    helpText: "Pinned Gemini model identifier for Strategy Lab and Post-Trade Analyst.",
    defaultValue: "gemini-2.5-pro",
    riskClass: "confirm"
  },
  {
    path: "ai.trainingCutoffDate",
    label: "Model Training Cutoff Date",
    helpText:
      "ISO date before which historical LLM evaluations are flagged as Training Contamination.",
    defaultValue: "2025-03-01",
    riskClass: "confirm"
  },
  {
    path: "ai.monthlyBudgetUsd",
    label: "Monthly Gemini Budget Cap",
    helpText: "Hard monthly AI spend limit in USD; exceeding degrades cleanly to Baseline Chooser.",
    unit: "USD",
    min: 0,
    max: 500,
    defaultValue: 15.0,
    riskClass: "safe"
  },
  {
    path: "ai.dailyBudgetUsd",
    label: "Daily Gemini Budget Cap",
    helpText: "Daily AI pacing limit in USD.",
    unit: "USD",
    min: 0,
    max: 50,
    defaultValue: 0.75,
    riskClass: "safe"
  },
  {
    path: "ai.subBudgets.contextAnalystPct",
    label: "Context Analyst Budget Share",
    helpText: "Percentage of AI budget allocated to Context Analyst extraction.",
    unit: "%",
    min: 0,
    max: 100,
    defaultValue: 40,
    riskClass: "safe"
  },
  {
    path: "ai.subBudgets.shadowAdvisorPct",
    label: "Shadow Advisor Budget Share",
    helpText: "Percentage of AI budget allocated to Shadow Advisor menu evaluation.",
    unit: "%",
    min: 0,
    max: 100,
    defaultValue: 30,
    riskClass: "safe"
  },
  {
    path: "ai.subBudgets.strategyLabPct",
    label: "Strategy Lab Budget Share",
    helpText: "Percentage of AI budget allocated to Strategy Lab candidate generation.",
    unit: "%",
    min: 0,
    max: 100,
    defaultValue: 20,
    riskClass: "safe"
  },
  {
    path: "ai.subBudgets.postTradeAndCopilotPct",
    label: "Post-Trade Analyst & Copilot Budget Share",
    helpText: "Percentage of AI budget allocated to Post-Trade Analyst and Risk/Ops Copilot.",
    unit: "%",
    min: 0,
    max: 100,
    defaultValue: 10,
    riskClass: "safe"
  },
  {
    path: "ai.shadowAdvisorEnabled",
    label: "Enable Shadow Advisor",
    helpText: "Run the menu-based Shadow Advisor alongside the deterministic Baseline Chooser.",
    defaultValue: true,
    riskClass: "safe"
  },
  {
    path: "ai.contextAnalystEnabled",
    label: "Enable Context Analyst",
    helpText: "Ingest and structure OKX announcements, RSS news, and macro events.",
    defaultValue: true,
    riskClass: "safe"
  },
  {
    path: "ai.botDesignerModel",
    label: "Bot Designer Claude Model",
    helpText:
      "Claude model that drafts bot propositions in the Shipyard. Needs the Anthropic API key in the vault; without it the Shipyard drafts sample propositions.",
    defaultValue: "claude-opus-5-5",
    riskClass: "safe"
  },
  {
    path: "ai.strategyLabEnabled",
    label: "Enable Strategy Lab",
    helpText: "Allow on-demand sandboxed AI strategy candidate generation.",
    defaultValue: false,
    riskClass: "confirm"
  },
  {
    path: "ai.postTradeAnalystEnabled",
    label: "Enable Post-Trade Analyst",
    helpText: "Run statistical hypothesis generation over the Decision Journal.",
    defaultValue: false,
    riskClass: "safe"
  },
  {
    path: "ai.eventGateAdvisorEnabled",
    label: "Enable Catalyst Stand-Down Filter (EventGateAdvisor)",
    helpText: "Evaluate breaking Context Features for abnormal catalyst volatility stand-downs.",
    defaultValue: true,
    riskClass: "safe"
  },
  {
    path: "notifications.discordEnabled",
    label: "Enable Discord Webhook Alerts",
    helpText:
      "Send CRITICAL, WARNING, and INFO digest notifications to the configured Discord webhook.",
    defaultValue: false,
    riskClass: "safe"
  },
  {
    path: "notifications.routeCritical",
    label: "Route CRITICAL Alerts to Discord",
    helpText: "Immediately deliver kill-switch, reconciliation, and stop-failure alerts.",
    defaultValue: true,
    riskClass: "confirm"
  },
  {
    path: "notifications.routeWarning",
    label: "Route WARNING Alerts to Discord",
    helpText: "Deliver deduplicated feed, rate-limit, budget, and demotion warnings.",
    defaultValue: true,
    riskClass: "safe"
  },
  {
    path: "notifications.routeInfoDigest",
    label: "Route INFO & Daily Digest to Discord",
    helpText: "Deliver trade fills, gate promotions, and daily summaries.",
    defaultValue: true,
    riskClass: "safe"
  },
  {
    path: "notifications.warningCooldownMinutes",
    label: "Warning Deduplication Cooldown",
    helpText: "Minimum minutes between identical WARNING notifications.",
    unit: "min",
    min: 1,
    max: 240,
    defaultValue: 15,
    riskClass: "safe"
  },
  {
    path: "fleet.digestEnabled",
    label: "Daily Fleet Digest",
    helpText: "Send a Discord summary of every boat once a day.",
    defaultValue: true,
    riskClass: "safe"
  },
  {
    path: "fleet.digestHourUtc",
    label: "Digest Hour (UTC)",
    helpText: "The hour the daily Fleet digest is sent.",
    unit: "h",
    min: 0,
    max: 23,
    defaultValue: 7,
    riskClass: "safe"
  },
  {
    path: "fleet.driftWatchEnabled",
    label: "Drift Watch",
    helpText:
      "Dock a paper boat whose live results fall clearly outside what its sea trial expected.",
    defaultValue: true,
    riskClass: "safe"
  },
  {
    path: "fleet.autopilotEnabled",
    label: "Autopilot",
    helpText:
      "Launch seaworthy propositions onto paper by themselves, funded only from the Autopilot wallet.",
    defaultValue: false,
    riskClass: "confirm"
  },
  {
    path: "fleet.autopilotWalletName",
    label: "Autopilot Wallet",
    helpText:
      "The paper wallet the Autopilot draws from; its balance is the Autopilot's whole cap.",
    defaultValue: "Autopilot",
    riskClass: "confirm"
  },
  {
    path: "fleet.autopilotMinScore",
    label: "Autopilot Minimum Score",
    helpText: "The sea-trial score a seaworthy proposition needs before the Autopilot launches it.",
    min: 45,
    max: 100,
    defaultValue: 65,
    riskClass: "confirm"
  },
  {
    path: "fleet.autopilotStakePct",
    label: "Autopilot Stake per Boat",
    helpText: "Each boat's stake, as a share of the Autopilot wallet's total value.",
    unit: "%",
    min: 1,
    max: 100,
    defaultValue: 10,
    riskClass: "confirm"
  },
  {
    path: "fleet.nightShiftEnabled",
    label: "Night Shift",
    helpText: "Draw up a Shipyard brief on a schedule, so new ideas arrive on their own.",
    defaultValue: false,
    riskClass: "safe"
  },
  {
    path: "fleet.nightShiftCadence",
    label: "Night Shift Cadence",
    helpText: "How often the night shift drafts a brief.",
    defaultValue: "weekly",
    riskClass: "safe"
  },
  {
    path: "fleet.nightShiftHourUtc",
    label: "Night Shift Hour (UTC)",
    helpText: "The hour the night shift starts.",
    unit: "h",
    min: 0,
    max: 23,
    defaultValue: 2,
    riskClass: "safe"
  },
  {
    path: "fleet.nightShiftCount",
    label: "Night Shift Ideas",
    helpText: "How many propositions each night shift asks for.",
    min: 2,
    max: 6,
    defaultValue: 4,
    riskClass: "safe"
  },
  {
    path: "fleet.nightShiftMode",
    label: "Night Shift Mode",
    helpText: "Blueprints fill reviewed shapes; Inventor has Claude write new rules.",
    defaultValue: "inventor",
    riskClass: "safe"
  },
  {
    path: "fleet.rebalanceEnabled",
    label: "Weekly Stake Rebalancing",
    helpText:
      "Every Monday, move paper stake between a wallet's running boats so each risks the same share.",
    defaultValue: false,
    riskClass: "confirm"
  },
  {
    path: "ai.simulateResponses",
    label: "Simulate AI Responses",
    helpText:
      "Explicitly return deterministic simulated responses without calling Google Gemini API.",
    defaultValue: false,
    riskClass: "safe"
  }
];

export const CONFIG_FIELD_REGISTRY: readonly ConfigFieldMetadata[] = RAW_FIELD_SPECS.map(
  (spec) => ({
    ...spec,
    key: spec.path
  })
);

const REGISTRY_BY_PATH = new Map<string, ConfigFieldMetadata>(
  CONFIG_FIELD_REGISTRY.map((item) => [item.path, item])
);

export function createDefaultConfig(): KeelConfig {
  return KeelConfigSchema.parse({});
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalizeValue(record[key]);
    }
    return result;
  }
  return value;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/**
 * Pure isomorphic FIPS 180-4 SHA-256 hex digest (runs identically in Node, Workers, and Browser).
 */
export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const totalBytes = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(totalBytes);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(totalBytes - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(totalBytes - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < totalBytes; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] ?? 0;
      const w2 = w[i - 2] ?? 0;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
}

/**
 * Produces a deterministic SHA-256 hex digest of a configuration object,
 * invariant to property key ordering.
 */
export function computeConfigHash(config: KeelConfig): string {
  const canonicalJson = JSON.stringify(canonicalizeValue(config));
  return sha256Hex(canonicalJson);
}

export interface ConfigChangeEntry {
  readonly path: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly riskClass: ConfigRiskClass;
}

export interface ConfigDiffResult {
  readonly changes: readonly ConfigChangeEntry[];
  readonly highestRiskClass: ConfigRiskClass;
  readonly allowed: boolean;
  readonly blockedPaths: readonly string[];
  readonly requiresStepUp: boolean;
  readonly requiresRestart: boolean;
  readonly beforeHash: string;
  readonly afterHash: string;
}

export function flattenConfigPaths(
  obj: unknown,
  prefix = "",
  out: Map<string, unknown> = new Map()
): Map<string, unknown> {
  if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const nextPath = prefix ? `${prefix}.${k}` : k;
      flattenConfigPaths(v, nextPath, out);
    }
  } else {
    out.set(prefix, obj);
  }
  return out;
}

/**
 * Computes field-by-field differences between two validated configs, determines the
 * highest required ConfigRiskClass, and blocks `locked-in-live` edits when activeMode
 * is `Live-Ramp` or `Live`.
 */
export function diffConfigs(
  before: KeelConfig,
  after: KeelConfig,
  activeMode: ExecutionMode
): ConfigDiffResult {
  const flatBefore = flattenConfigPaths(before);
  const flatAfter = flattenConfigPaths(after);
  const allPaths = new Set([...flatBefore.keys(), ...flatAfter.keys()]);

  const changes: ConfigChangeEntry[] = [];
  let highestRiskClass: ConfigRiskClass = "safe";
  const blockedPaths: string[] = [];
  const isLiveMode = activeMode === "Live" || activeMode === "Live-Ramp";

  for (const path of Array.from(allPaths).sort()) {
    const prevVal = flatBefore.get(path);
    const nextVal = flatAfter.get(path);
    if (JSON.stringify(prevVal) !== JSON.stringify(nextVal)) {
      const meta = REGISTRY_BY_PATH.get(path);
      const riskClass: ConfigRiskClass = meta?.riskClass ?? "confirm";
      changes.push({
        path,
        before: prevVal,
        after: nextVal,
        riskClass
      });

      if (RISK_CLASS_SEVERITY[riskClass] > RISK_CLASS_SEVERITY[highestRiskClass]) {
        highestRiskClass = riskClass;
      }

      if (isLiveMode && riskClass === "locked-in-live") {
        blockedPaths.push(path);
      }
    }
  }

  return {
    changes,
    highestRiskClass,
    allowed: blockedPaths.length === 0,
    blockedPaths,
    requiresStepUp: changes.length > 0 && highestRiskClass !== "safe",
    requiresRestart: changes.some((c) => c.riskClass === "restart-required"),
    beforeHash: computeConfigHash(before),
    afterHash: computeConfigHash(after)
  };
}
