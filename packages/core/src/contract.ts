import { initContract } from "@ts-rest/core";
import { z } from "zod";
import { ConfigRiskClassSchema, ExecutionModeSchema, KeelConfigSchema } from "./config.js";
import { SecretKeyNameSchema } from "./ports.js";

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

export const ConfigSnapshotRecordSchema = z.object({
  version: z.number().int().positive(),
  configHash: z.string().regex(/^[a-f0-9]{64}$/),
  config: KeelConfigSchema,
  actor: z.string(),
  reason: z.string(),
  highestRiskClass: ConfigRiskClassSchema,
  createdAtMs: z.number().int()
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

export const SecretMetadataRecordSchema = z.object({
  keyName: SecretKeyNameSchema,
  isConfigured: z.boolean(),
  maskedPreview: z.string(),
  updatedAtMs: z.number().int().nullable(),
  updatedBy: z.string().nullable()
});

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

export const BackupRecordSchema = z.object({
  fileName: z.string(),
  filePath: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  createdAtMs: z.number().int(),
  integrityOk: z.boolean()
});

export const NotificationDeliveryResultSchema = z.object({
  delivered: z.boolean(),
  suppressedReason: z
    .enum(["disabled", "severity_filtered", "cooldown_active", "missing_webhook"])
    .optional(),
  error: z.string().optional()
});

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
  }
});
