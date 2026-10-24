import { z } from "zod";
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

export interface AuthRepository {
  getAdminUser(): AdminUserRecord | null;
  upsertAdminUser(user: AdminUserRecord): void;
  createSession(session: AdminSessionRecord): void;
  getSession(sessionIdHash: string): AdminSessionRecord | null;
  updateSessionStepUp(sessionIdHash: string, stepUpAtMs: number): void;
  deleteSession(sessionIdHash: string): void;
  pruneExpiredSessions(nowMs: number): number;
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
