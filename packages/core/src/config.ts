import { createHash } from "node:crypto";
import { z } from "zod";

export const ExecutionModeSchema = z.enum(["Replay", "Paper", "Demo", "Live-Ramp", "Live"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

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
  maxDrawdownKillSwitchPct: z.number().min(3.0).max(25.0).default(12.0)
});

export const RiskConfigSchema = z.object({
  paperPortfolioEquityUsdt: z.number().min(100).max(10_000_000).default(10000),
  liveRampMultipliers: z.tuple([z.number(), z.number(), z.number()]).default([0.25, 0.5, 1.0]),
  strategy: StrategyRiskConfigSchema.default({}),
  portfolio: PortfolioRiskConfigSchema.default({})
});

export const PromotionLadderConfigSchema = z.object({
  replayMinTrades: z.number().int().min(30).max(5000).default(150),
  replayMinWalkForwardFolds: z.number().int().min(3).max(20).default(5),
  replayMinSharpe: z.number().min(0.2).max(5.0).default(1.0),
  replayMinDeflatedSharpeConfidence: z.number().min(0.5).max(0.999).default(0.9),
  replayMaxPbo: z.number().min(0.01).max(0.5).default(0.2),
  replayCostStressMultiplier: z.number().min(1.25).max(5.0).default(2.0),
  shadowMinDays: z.number().int().min(7).max(180).default(14),
  shadowMinTrades: z.number().int().min(10).max(500).default(30),
  aiMinDisagreementSample: z.number().int().min(20).max(500).default(50),
  aiMaxBootstrapPValue: z.number().min(0.01).max(0.25).default(0.1),
  paperMinDays: z.number().int().min(14).max(365).default(30),
  paperMinTrades: z.number().int().min(20).max(1000).default(50),
  liveDemotionDrawdownPct: z.number().min(3.0).max(25.0).default(12.0),
  aiDemotionEdgeDecayR: z.number().min(-1.0).max(-0.01).default(-0.15),
  slippageDriftMultiplierCap: z.number().min(1.5).max(5.0).default(2.5)
});

export const AiGatewayConfigSchema = z.object({
  provider: z.literal("gemini").default("gemini"),
  fastModel: z.string().min(1).default("gemini-2.5-flash"),
  reasoningModel: z.string().min(1).default("gemini-2.5-pro"),
  trainingCutoffDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .default("2025-03-01"),
  monthlyBudgetUsd: z.number().min(0).max(500).default(15.0),
  dailyBudgetUsd: z.number().min(0).max(50).default(0.75),
  shadowAdvisorEnabled: z.boolean().default(true),
  contextAnalystEnabled: z.boolean().default(true),
  strategyLabEnabled: z.boolean().default(false),
  postTradeAnalystEnabled: z.boolean().default(false),
  eventGateAdvisorEnabled: z.boolean().default(true)
});

export const NotificationsConfigSchema = z.object({
  discordEnabled: z.boolean().default(false),
  routeCritical: z.boolean().default(true),
  routeWarning: z.boolean().default(true),
  routeInfoDigest: z.boolean().default(true),
  warningCooldownMinutes: z.number().int().min(1).max(240).default(15)
});

export const KeelConfigSchema = z.object({
  system: SystemConfigSchema.default({}),
  risk: RiskConfigSchema.default({}),
  promotionLadder: PromotionLadderConfigSchema.default({}),
  ai: AiGatewayConfigSchema.default({}),
  notifications: NotificationsConfigSchema.default({})
});

export type KeelConfig = z.infer<typeof KeelConfigSchema>;

export interface ConfigFieldMetadata {
  readonly path: string;
  readonly label: string;
  readonly helpText: string;
  readonly unit?: string;
  readonly min?: number;
  readonly max?: number;
  readonly riskClass: ConfigRiskClass;
}

export const CONFIG_FIELD_REGISTRY: readonly ConfigFieldMetadata[] = [
  {
    path: "system.executionMode",
    label: "Execution Mode",
    helpText: "Active operating environment (Replay, Paper, Demo, Live-Ramp, or Live).",
    riskClass: "confirm"
  },
  {
    path: "system.port",
    label: "HTTP Port",
    helpText: "Single container port serving the Fastify API and React dashboard.",
    min: 1024,
    max: 65535,
    riskClass: "restart-required"
  },
  {
    path: "system.trustCloudflareHeaders",
    label: "Trust Cloudflare Tunnel Headers",
    helpText: "Honor CF-Connecting-IP and X-Forwarded-Proto from local cloudflared ingress.",
    riskClass: "restart-required"
  },
  {
    path: "system.sseHeartbeatMs",
    label: "Live Stream Heartbeat Interval",
    helpText: "Keep-alive frame interval for SSE streams behind Cloudflare's 100s timeout.",
    unit: "ms",
    min: 5000,
    max: 60000,
    riskClass: "safe"
  },
  {
    path: "system.shutdownPolicy",
    label: "Container Shutdown Policy",
    helpText: "Whether to hold open positions with exchange stops or flatten on SIGTERM.",
    riskClass: "confirm"
  },
  {
    path: "risk.paperPortfolioEquityUsdt",
    label: "Paper Portfolio Starting Equity",
    helpText: "Simulated portfolio capital allocated across strategies in Paper mode.",
    unit: "USDT",
    min: 100,
    max: 10_000_000,
    riskClass: "confirm"
  },
  {
    path: "risk.strategy.riskPerTradePct",
    label: "Strategy Unit Risk per Trade (1R)",
    helpText: "Maximum percentage of strategy equity lost if an initial Protective Stop is hit.",
    unit: "%",
    min: 0.1,
    max: 1.5,
    riskClass: "confirm"
  },
  {
    path: "risk.strategy.maxGrossLeverage",
    label: "Strategy Max Gross Leverage",
    helpText: "Maximum isolated notional exposure per strategy relative to strategy equity.",
    unit: "x",
    min: 0.5,
    max: 3.0,
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
    riskClass: "confirm"
  },
  {
    path: "risk.strategy.weeklyLossStopPct",
    label: "Strategy Weekly Loss Stop",
    helpText: "Weekly drawdown limit that places the strategy into a 48h cooldown.",
    unit: "%",
    min: 1.0,
    max: 20.0,
    riskClass: "confirm"
  },
  {
    path: "risk.strategy.maxDrawdownPct",
    label: "Strategy Max Drawdown Auto-Demotion",
    helpText: "Drawdown from strategy High-Water Mark that flattens and demotes to Forward Shadow.",
    unit: "%",
    min: 3.0,
    max: 30.0,
    riskClass: "locked-in-live"
  },
  {
    path: "risk.strategy.maxTradesPerDay",
    label: "Max Strategy Trades per Day",
    helpText: "Maximum opening round-trip trades allowed per strategy per UTC day.",
    unit: "trades",
    min: 1,
    max: 50,
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
    riskClass: "safe"
  },
  {
    path: "risk.portfolio.maxGrossLeverage",
    label: "Portfolio Max Gross Leverage",
    helpText: "Maximum combined gross notional across all strategies relative to portfolio equity.",
    unit: "x",
    min: 0.5,
    max: 3.0,
    riskClass: "locked-in-live"
  },
  {
    path: "risk.portfolio.maxNetDirectionalExposure",
    label: "Portfolio Net Directional Exposure Cap",
    helpText: "Maximum signed long-minus-short crypto beta across all active strategies.",
    unit: "x",
    min: 0.25,
    max: 2.5,
    riskClass: "locked-in-live"
  },
  {
    path: "risk.portfolio.maxSingleInstrumentExposure",
    label: "Single-Instrument Concentration Cap",
    helpText: "Maximum combined notional in any single perpetual contract across strategies.",
    unit: "x",
    min: 0.25,
    max: 2.0,
    riskClass: "confirm"
  },
  {
    path: "risk.portfolio.dailyLossStopPct",
    label: "Portfolio Daily Loss Stop",
    helpText: "Portfolio-wide daily loss percentage that flattens all positions until 00:00 UTC.",
    unit: "%",
    min: 1.0,
    max: 12.0,
    riskClass: "locked-in-live"
  },
  {
    path: "risk.portfolio.maxDrawdownKillSwitchPct",
    label: "Portfolio Max Drawdown Kill Switch",
    helpText: "Portfolio drawdown from High-Water Mark that trips the global Kill Switch.",
    unit: "%",
    min: 3.0,
    max: 25.0,
    riskClass: "locked-in-live"
  },
  {
    path: "promotionLadder.replayMinTrades",
    label: "Replay Minimum Trade Sample",
    helpText: "Minimum closed trades across walk-forward folds required for Replay-Validated gate.",
    unit: "trades",
    min: 30,
    max: 5000,
    riskClass: "confirm"
  },
  {
    path: "promotionLadder.replayMinDeflatedSharpeConfidence",
    label: "Minimum Deflated Sharpe Confidence",
    helpText: "Multiple-testing-adjusted DSR probability threshold required to pass Replay.",
    min: 0.5,
    max: 0.999,
    riskClass: "confirm"
  },
  {
    path: "promotionLadder.aiMinDisagreementSample",
    label: "AI Minimum Uncontaminated Disagreements",
    helpText: "Minimum forward shadow decisions where AI and Baseline Chooser differed.",
    unit: "decisions",
    min: 20,
    max: 500,
    riskClass: "confirm"
  },
  {
    path: "ai.monthlyBudgetUsd",
    label: "Monthly Gemini Budget Cap",
    helpText: "Hard monthly AI spend limit in USD; exceeding degrades cleanly to Baseline Chooser.",
    unit: "USD",
    min: 0,
    max: 500,
    riskClass: "safe"
  },
  {
    path: "ai.dailyBudgetUsd",
    label: "Daily Gemini Budget Cap",
    helpText: "Daily AI pacing limit in USD.",
    unit: "USD",
    min: 0,
    max: 50,
    riskClass: "safe"
  },
  {
    path: "notifications.discordEnabled",
    label: "Enable Discord Webhook Alerts",
    helpText:
      "Send CRITICAL, WARNING, and INFO digest notifications to the configured Discord webhook.",
    riskClass: "safe"
  }
];

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

/**
 * Produces a deterministic SHA-256 hex digest of a configuration object,
 * invariant to property key ordering.
 */
export function computeConfigHash(config: KeelConfig): string {
  const canonicalJson = JSON.stringify(canonicalizeValue(config));
  return createHash("sha256").update(canonicalJson).digest("hex");
}

export interface ConfigChangeEntry {
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly riskClass: ConfigRiskClass;
}

export interface ConfigDiffResult {
  readonly changes: readonly ConfigChangeEntry[];
  readonly highestRiskClass: ConfigRiskClass;
  readonly allowed: boolean;
  readonly blockedPaths: readonly string[];
}

function flattenConfig(
  obj: unknown,
  prefix = "",
  out: Map<string, unknown> = new Map()
): Map<string, unknown> {
  if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const nextPath = prefix ? `${prefix}.${k}` : k;
      flattenConfig(v, nextPath, out);
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
  const flatBefore = flattenConfig(before);
  const flatAfter = flattenConfig(after);
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
    blockedPaths
  };
}
