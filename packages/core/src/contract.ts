import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { ConfigRiskClassSchema, ExecutionModeSchema, KeelConfigSchema } from "./config.js";
import {
  AuditEventRecordSchema,
  BackupRecordSchema,
  BarTimeframeSchema,
  CircuitBreakerRecordSchema,
  ConfigSnapshotRecordSchema,
  ContextFeatureRecordSchema,
  DataSnapshotMetadataSchema,
  DmsStatusSchema,
  EventGateEvaluationSchema,
  ExchangeOrderInputSchema,
  ExchangeOrderResultSchema,
  ExperimentRecordSchema,
  LedgerTrialBalanceSchema,
  LookbackValidationResultSchema,
  MarkoutForensicReportSchema,
  NarrativeClusterRecordSchema,
  NotificationDeliveryResultSchema,
  PaperOrderRecordSchema,
  PaperPositionRecordSchema,
  ReconciliationResultSchema,
  SecretKeyNameSchema,
  SecretMetadataRecordSchema,
  StrategyPromotionRecordSchema
} from "./ports.js";

const c = initContract();

export const ApiErrorSchema = z.object({
  error: z.string(),
  blockedPaths: z.array(z.string()).optional(),
  requiresStepUp: z.boolean().optional()
});

export const SystemStatusResponseSchema = z.object({
  appName: z.literal("Keel"),
  version: z.string(),
  executionMode: ExecutionModeSchema,
  configHash: z.string().regex(/^[a-f0-9]{64}$/),
  configVersion: z.number().int().positive().default(1),
  serverTimeMs: z.number().int(),
  serverTimeIso: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  cloudflareTunnelActive: z.boolean(),
  forwardedProto: z.enum(["http", "https"]),
  clientIp: z.string(),
  status: z.literal("ok")
});
export type SystemStatusResponse = z.infer<typeof SystemStatusResponseSchema>;

export const AuthSessionResponseSchema = z.object({
  bootstrapped: z.boolean(),
  authenticated: z.boolean(),
  username: z.string().nullable(),
  totpEnabled: z.boolean(),
  stepUpValid: z.boolean(),
  cfAuthenticated: z.boolean()
});
export type AuthSessionResponse = z.infer<typeof AuthSessionResponseSchema>;

export const ConfigChangeEntrySchema = z.object({
  path: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  riskClass: ConfigRiskClassSchema
});

export const ConfigDiffResultSchema = z.object({
  changes: z.array(ConfigChangeEntrySchema),
  highestRiskClass: ConfigRiskClassSchema,
  allowed: z.boolean(),
  blockedPaths: z.array(z.string()),
  requiresStepUp: z.boolean(),
  requiresRestart: z.boolean(),
  beforeHash: z.string(),
  afterHash: z.string()
});

export const ConfigFieldMetadataSchema = z.object({
  key: z.string(),
  path: z.string(),
  label: z.string(),
  helpText: z.string(),
  unit: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  defaultValue: z.unknown(),
  riskClass: ConfigRiskClassSchema
});

export const InstrumentCoverageSummarySchema = z.object({
  instrumentId: z.string(),
  barCounts: z.record(BarTimeframeSchema, z.number().int().nonnegative()),
  fundingCount: z.number().int().nonnegative(),
  earliestOpenTs: z.number().int().nullable(),
  latestCloseTs: z.number().int().nullable()
});
export type InstrumentCoverageSummary = z.infer<typeof InstrumentCoverageSummarySchema>;

export const StrategyDescriptorSchema = z.object({
  id: z.string(),
  version: z.string(),
  name: z.string(),
  description: z.string(),
  lookbackRequirements: z.record(z.string(), z.number().int().positive()),
  lookbackStatusByInstrument: z.record(z.string(), LookbackValidationResultSchema)
});
export type StrategyDescriptor = z.infer<typeof StrategyDescriptorSchema>;

export const MarketSummaryResponseSchema = z.object({
  instruments: z.array(InstrumentCoverageSummarySchema),
  strategies: z.array(StrategyDescriptorSchema)
});
export type MarketSummaryResponse = z.infer<typeof MarketSummaryResponseSchema>;

export const keelApiContract = c.router({
  system: {
    getStatus: {
      method: "GET",
      path: "/api/v1/system/status",
      responses: {
        200: SystemStatusResponseSchema
      },
      summary: "Get Keel system health, execution mode, and config hash"
    },
    createBackup: {
      method: "POST",
      path: "/api/v1/system/backup",
      body: z.object({}),
      responses: {
        200: z.object({ backup: BackupRecordSchema }),
        401: ApiErrorSchema
      },
      summary: "Trigger an atomic online SQLite VACUUM INTO backup"
    }
  },
  auth: {
    getSession: {
      method: "GET",
      path: "/api/v1/auth/session",
      responses: {
        200: AuthSessionResponseSchema
      },
      summary: "Get current authentication and bootstrap status"
    },
    bootstrap: {
      method: "POST",
      path: "/api/v1/auth/bootstrap",
      body: z.object({
        bootstrapToken: z.string().min(8),
        username: z.string().min(3).max(64),
        password: z.string().min(10).max(256)
      }),
      responses: {
        200: z.object({
          ok: z.literal(true),
          username: z.string(),
          totpSecretBase32: z.string(),
          otpauthUri: z.string()
        }),
        400: ApiErrorSchema,
        403: ApiErrorSchema
      },
      summary: "Initialize the first admin account using the one-time container bootstrap token"
    },
    login: {
      method: "POST",
      path: "/api/v1/auth/login",
      body: z.object({
        username: z.string().min(1),
        password: z.string().min(1),
        totpCode: z.string().optional()
      }),
      responses: {
        200: z.object({
          ok: z.literal(true),
          username: z.string(),
          totpEnabled: z.boolean()
        }),
        401: ApiErrorSchema
      },
      summary: "Authenticate admin user and issue HttpOnly session cookie"
    },
    logout: {
      method: "POST",
      path: "/api/v1/auth/logout",
      body: z.object({}),
      responses: {
        200: z.object({ ok: z.literal(true) })
      },
      summary: "Invalidate current admin session and clear cookie"
    },
    enrollTotp: {
      method: "POST",
      path: "/api/v1/auth/totp/enroll",
      body: z.object({
        password: z.string().min(1)
      }),
      responses: {
        200: z.object({
          totpSecretBase32: z.string(),
          otpauthUri: z.string()
        }),
        401: ApiErrorSchema
      },
      summary: "Generate or rotate RFC 6238 TOTP secret for the authenticated admin"
    },
    verifyTotp: {
      method: "POST",
      path: "/api/v1/auth/totp/verify",
      body: z.object({
        code: z.string().regex(/^\d{6}$/)
      }),
      responses: {
        200: z.object({
          ok: z.literal(true),
          totpEnabled: z.literal(true)
        }),
        400: ApiErrorSchema,
        401: ApiErrorSchema
      },
      summary: "Verify 6-digit RFC 6238 TOTP code and enable TOTP on the admin account"
    }
  },
  config: {
    getActive: {
      method: "GET",
      path: "/api/v1/config",
      responses: {
        200: z.object({
          active: ConfigSnapshotRecordSchema,
          registry: z.array(ConfigFieldMetadataSchema)
        }),
        401: ApiErrorSchema
      },
      summary: "Get active versioned configuration and field registry metadata"
    },
    previewDiff: {
      method: "POST",
      path: "/api/v1/config/diff",
      body: z.object({
        config: KeelConfigSchema
      }),
      responses: {
        200: ConfigDiffResultSchema,
        401: ApiErrorSchema
      },
      summary: "Preview field-level diffs, highest ConfigRiskClass, and live-lock status"
    },
    updateConfig: {
      method: "PUT",
      path: "/api/v1/config",
      body: z.object({
        config: KeelConfigSchema,
        reason: z.string().min(3).max(500),
        stepUpPassword: z.string().optional(),
        stepUpTotpCode: z.string().optional()
      }),
      responses: {
        200: z.object({
          snapshot: ConfigSnapshotRecordSchema,
          diff: ConfigDiffResultSchema
        }),
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema
      },
      summary:
        "Persist a new versioned configuration snapshot with ConfigRiskClass & step-up enforcement"
    },
    getHistory: {
      method: "GET",
      path: "/api/v1/config/history",
      responses: {
        200: z.object({
          history: z.array(ConfigSnapshotRecordSchema)
        }),
        401: ApiErrorSchema
      },
      summary: "List versioned configuration snapshots"
    },
    rollbackConfig: {
      method: "POST",
      path: "/api/v1/config/rollback",
      body: z.object({
        targetVersion: z.number().int().positive(),
        reason: z.string().min(3).max(500),
        stepUpPassword: z.string().optional(),
        stepUpTotpCode: z.string().optional()
      }),
      responses: {
        200: z.object({
          snapshot: ConfigSnapshotRecordSchema,
          diff: ConfigDiffResultSchema
        }),
        400: ApiErrorSchema,
        401: ApiErrorSchema,
        403: ApiErrorSchema,
        404: ApiErrorSchema
      },
      summary: "Rollback active configuration to a previous version snapshot"
    }
  },
  secrets: {
    listMetadata: {
      method: "GET",
      path: "/api/v1/secrets",
      responses: {
        200: z.object({
          secrets: z.array(SecretMetadataRecordSchema)
        }),
        401: ApiErrorSchema
      },
      summary: "List masked secret metadata (never returns plaintext values)"
    },
    upsertSecret: {
      method: "PUT",
      path: "/api/v1/secrets",
      body: z.object({
        keyName: SecretKeyNameSchema,
        plaintextValue: z.string().min(1).max(2048),
        stepUpPassword: z.string().optional(),
        stepUpTotpCode: z.string().optional()
      }),
      responses: {
        200: z.object({
          secret: SecretMetadataRecordSchema
        }),
        401: ApiErrorSchema,
        403: ApiErrorSchema
      },
      summary: "Encrypt and store a secret in the AES-256-GCM vault with step-up confirmation"
    }
  },
  audit: {
    listRecent: {
      method: "GET",
      path: "/api/v1/audit",
      responses: {
        200: z.object({
          events: z.array(AuditEventRecordSchema)
        }),
        401: ApiErrorSchema
      },
      summary: "List recent immutable audit trail entries"
    }
  },
  notifications: {
    sendTest: {
      method: "POST",
      path: "/api/v1/notifications/test",
      body: z.object({
        title: z.string().optional(),
        body: z.string().optional()
      }),
      responses: {
        200: NotificationDeliveryResultSchema,
        401: ApiErrorSchema
      },
      summary: "Send a test notification through the configured Discord Webhook channel"
    }
  },
  market: {
    getSummary: {
      method: "GET",
      path: "/api/v1/market/summary",
      responses: {
        200: MarketSummaryResponseSchema,
        401: ApiErrorSchema
      },
      summary: "Get confirmed market bar coverage and strategy lookback readiness"
    },
    seedSynthetic: {
      method: "POST",
      path: "/api/v1/market/seed-synthetic",
      body: z.object({
        instrumentId: z.string().default("BTC-USDT-SWAP"),
        barCount1H: z.number().int().min(100).max(5000).default(720)
      }),
      responses: {
        200: z.object({
          snapshot: DataSnapshotMetadataSchema
        }),
        401: ApiErrorSchema
      },
      summary:
        "Seed deterministic confirmed bars and 8h settled funding rates for research & replay"
    }
  },
  replay: {
    runBacktest: {
      method: "POST",
      path: "/api/v1/replay/run",
      body: z.object({
        strategyId: z.string().min(1),
        instrumentId: z.string().default("BTC-USDT-SWAP"),
        timeframe: BarTimeframeSchema.default("1H")
      }),
      responses: {
        200: z.object({
          experiment: ExperimentRecordSchema
        }),
        400: ApiErrorSchema,
        401: ApiErrorSchema
      },
      summary: "Run an event-driven Replay backtest with 2x cost-stress and Purged Walk-Forward"
    },
    listExperiments: {
      method: "GET",
      path: "/api/v1/replay/experiments",
      responses: {
        200: z.object({
          experiments: z.array(ExperimentRecordSchema)
        }),
        401: ApiErrorSchema
      },
      summary: "List recorded replay experiments from the append-only ExperimentRegistry"
    }
  },
  paper: {
    getStatus: {
      method: "GET",
      path: "/api/v1/paper/status",
      responses: {
        200: z.object({
          circuitBreaker: CircuitBreakerRecordSchema,
          trialBalance: LedgerTrialBalanceSchema,
          openPositions: z.array(PaperPositionRecordSchema),
          recentOrders: z.array(PaperOrderRecordSchema),
          promotions: z.array(StrategyPromotionRecordSchema)
        }),
        401: ApiErrorSchema
      },
      summary: "Get live Paper Execution status, circuit breaker, ledger balance, and positions"
    },
    executeTick: {
      method: "POST",
      path: "/api/v1/paper/execute-tick",
      body: z.object({
        instrumentId: z.string().default("BTC-USDT-SWAP"),
        strategyId: z.string().default("donchian-trend")
      }),
      responses: {
        200: z.object({
          ok: z.literal(true),
          positionsOpenedCount: z.number().int().nonnegative(),
          positionsClosedCount: z.number().int().nonnegative(),
          trialBalance: LedgerTrialBalanceSchema,
          openPositions: z.array(PaperPositionRecordSchema)
        }),
        400: ApiErrorSchema,
        401: ApiErrorSchema
      },
      summary: "Simulate a live confirmed bar tick through RiskGuardian and PaperBroker"
    },
    flatten: {
      method: "POST",
      path: "/api/v1/paper/flatten",
      body: z.object({
        reason: z.string().min(3).max(500).default("Manual operator flatten")
      }),
      responses: {
        200: z.object({
          ok: z.literal(true),
          flattenedCount: z.number().int().nonnegative()
        }),
        401: ApiErrorSchema
      },
      summary: "Emergency flatten all open paper positions"
    },
    setCircuitBreaker: {
      method: "POST",
      path: "/api/v1/paper/circuit-breaker",
      body: z.object({
        status: z.enum([
          "NORMAL",
          "DAILY_LOSS_HALT",
          "WEEKLY_LOSS_HALT",
          "DRAWDOWN_KILL_SWITCH",
          "MANUAL_KILL_SWITCH"
        ]),
        reason: z.string().min(3).max(500)
      }),
      responses: {
        200: z.object({
          circuitBreaker: CircuitBreakerRecordSchema
        }),
        401: ApiErrorSchema
      },
      summary: "Manually arm or trip the system CircuitBreaker / Kill Switch"
    }
  },
  promotion: {
    evaluate: {
      method: "POST",
      path: "/api/v1/promotion/evaluate",
      body: z.object({
        strategyId: z.string().min(1)
      }),
      responses: {
        200: z.object({
          promotion: StrategyPromotionRecordSchema
        }),
        400: ApiErrorSchema,
        401: ApiErrorSchema
      },
      summary: "Evaluate ADR-0007 promotion gates for a strategy"
    }
  },
  ai: {
    getStatus: {
      method: "GET",
      path: "/api/v1/ai/status",
      responses: {
        200: z.object({
          enabled: z.boolean(),
          provider: z.string(),
          fastModel: z.string(),
          reasoningModel: z.string(),
          remainingDailyBudgetUsd: z.number(),
          remainingMonthlyBudgetUsd: z.number(),
          dailyBudgetUsd: z.number(),
          monthlyBudgetUsd: z.number()
        }),
        401: ApiErrorSchema
      },
      summary: "Get AI Gateway status, model configuration, and remaining budgets"
    },
    extractContext: {
      method: "POST",
      path: "/api/v1/ai/extract-context",
      body: z.object({
        text: z.string().min(5).max(10000),
        source: z.string().min(1).default("Operator News Feed"),
        instrumentId: z.string().default("BTC-USDT-SWAP")
      }),
      responses: {
        200: z.object({
          feature: ContextFeatureRecordSchema
        }),
        400: ApiErrorSchema,
        401: ApiErrorSchema
      },
      summary: "Extract structured ContextFeature record from market announcement or news text"
    },
    shadowEvaluate: {
      method: "POST",
      path: "/api/v1/ai/shadow-evaluate",
      body: z.object({
        strategyId: z.string().min(1).default("donchian-trend-v1"),
        instrumentId: z.string().default("BTC-USDT-SWAP")
      }),
      responses: {
        200: z.object({
          strategyId: z.string(),
          instrumentId: z.string(),
          asOfMs: z.number(),
          candidateCount: z.number(),
          baselineChosenProposalId: z.string().nullable(),
          shadowChosenProposalId: z.string().nullable(),
          shadowConfidence: z.number(),
          shadowRationale: z.string(),
          agreement: z.boolean(),
          trainingContaminated: z.boolean()
        }),
        400: ApiErrorSchema,
        401: ApiErrorSchema
      },
      summary: "Evaluate active ProposalMenu through ShadowAdvisor alongside BaselineChooser"
    },
    evaluateEventGate: {
      method: "POST",
      path: "/api/v1/ai/event-gate",
      body: z.object({
        eventText: z.string().min(3),
        affectedInstruments: z.array(z.string()).optional(),
        openPositionsCount: z.number().int().nonnegative().optional()
      }),
      responses: {
        200: z.object({
          evaluation: EventGateEvaluationSchema
        }),
        400: ApiErrorSchema,
        401: ApiErrorSchema
      },
      summary: "Evaluate event shock volatility risk and gating recommendation (M6)"
    },
    clusterNarratives: {
      method: "POST",
      path: "/api/v1/ai/narratives",
      body: z.object({
        announcements: z.array(z.string().min(1)).min(1)
      }),
      responses: {
        200: z.object({
          clusters: z.array(NarrativeClusterRecordSchema)
        }),
        400: ApiErrorSchema,
        401: ApiErrorSchema
      },
      summary: "Group context announcements into thematic narrative clusters (M6)"
    },
    analyzeMarkoutForensics: {
      method: "POST",
      path: "/api/v1/ai/markout-forensics",
      body: z.object({
        orderId: z.string().min(1),
        instrumentId: z.string().min(1),
        side: z.enum(["long", "short"]),
        fillPrice: z.string().min(1),
        markoutPrices: z
          .object({
            price5m: z.string().optional(),
            price15m: z.string().optional(),
            price1h: z.string().optional()
          })
          .optional()
      }),
      responses: {
        200: z.object({
          report: MarkoutForensicReportSchema
        }),
        400: ApiErrorSchema,
        401: ApiErrorSchema
      },
      summary: "Analyze post-fill markout price drift and adverse selection (M6)"
    }
  },
  broker: {
    getStatus: {
      method: "GET",
      path: "/api/v1/broker/status",
      responses: {
        200: z.object({
          connected: z.boolean(),
          venue: z.string(),
          dms: DmsStatusSchema,
          openPositionsCount: z.number(),
          openOrdersCount: z.number()
        }),
        401: ApiErrorSchema
      },
      summary: "Get exchange broker connection, active DMS countdown, and position count"
    },
    submitOrder: {
      method: "POST",
      path: "/api/v1/broker/orders",
      body: ExchangeOrderInputSchema,
      responses: {
        200: z.object({
          order: ExchangeOrderResultSchema
        }),
        400: ApiErrorSchema,
        401: ApiErrorSchema
      },
      summary: "Submit order with mandatory attached protective stop (ADR-0006)"
    },
    reconcile: {
      method: "POST",
      path: "/api/v1/broker/reconcile",
      body: z.object({}),
      responses: {
        200: z.object({
          reconciliation: ReconciliationResultSchema
        }),
        401: ApiErrorSchema
      },
      summary: "Run position and order reconciliation between local ledger and exchange"
    },
    dmsHeartbeat: {
      method: "POST",
      path: "/api/v1/broker/dms-heartbeat",
      body: z.object({}),
      responses: {
        200: z.object({
          ok: z.boolean(),
          countdownSeconds: z.number(),
          dms: DmsStatusSchema
        }),
        400: ApiErrorSchema,
        401: ApiErrorSchema
      },
      summary: "Send 60-second cancel-all-after Dead-Man's Switch heartbeat (ADR-0006)"
    },
    flatten: {
      method: "POST",
      path: "/api/v1/broker/flatten",
      body: z.object({
        reason: z.string().default("Operator manual emergency flatten")
      }),
      responses: {
        200: z.object({
          flattenedCount: z.number().int().nonnegative(),
          positions: z.array(PaperPositionRecordSchema)
        }),
        401: ApiErrorSchema
      },
      summary: "Emergency flatten all exchange positions via market orders (ADR-0006)"
    }
  }
});
