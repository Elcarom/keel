import { z } from "zod";
import type { ConfigRiskClass, KeelConfig } from "./config.js";

export const SecretKeyNameSchema = z.enum([
  "okxApiKey",
  "okxSecretKey",
  "okxPassphrase",
  "geminiApiKey",
  "discordWebhookUrl"
]);
export type SecretKeyName = z.infer<typeof SecretKeyNameSchema>;

export const ALL_SECRET_KEY_NAMES: readonly SecretKeyName[] = SecretKeyNameSchema.options;

export interface ConfigSnapshotRecord {
  readonly version: number;
  readonly configHash: string;
  readonly config: KeelConfig;
  readonly actor: string;
  readonly reason: string;
  readonly highestRiskClass: ConfigRiskClass;
  readonly createdAtMs: number;
}

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

export interface AuditEventRecord {
  readonly id: number;
  readonly ts: number;
  readonly actor: string;
  readonly clientIp: string;
  readonly action: string;
  readonly riskClass: ConfigRiskClass;
  readonly configHash: string;
  readonly details: Record<string, unknown>;
}

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

export interface SecretMetadataRecord {
  readonly keyName: SecretKeyName;
  readonly isConfigured: boolean;
  readonly maskedPreview: string;
  readonly updatedAtMs: number | null;
  readonly updatedBy: string | null;
}

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

export interface NotificationDeliveryResult {
  readonly delivered: boolean;
  readonly suppressedReason?:
    "disabled" | "severity_filtered" | "cooldown_active" | "missing_webhook" | undefined;
  readonly error?: string | undefined;
}

export interface NotificationChannel {
  send(message: NotificationMessage): Promise<NotificationDeliveryResult>;
}

export interface BackupRecord {
  readonly fileName: string;
  readonly filePath: string;
  readonly sizeBytes: number;
  readonly createdAtMs: number;
  readonly integrityOk: boolean;
}
