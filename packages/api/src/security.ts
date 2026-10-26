import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { argon2id } from "@noble/hashes/argon2";
import {
  ALL_SECRET_KEY_NAMES,
  type AuthRepository,
  type AuthSessionResponse,
  type Clock,
  type KeelConfig,
  type SecretKeyName,
  type SecretMetadataRecord,
  type SecretVaultRepository
} from "@keel/core";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31] ?? "A";
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31] ?? "A";
  }
  return output;
}

export function decodeBase32(encoded: string): Buffer {
  const cleaned = encoded.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error(`Invalid Base32 character: ${ch}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * Pure RFC 6238 / RFC 4226 TOTP implementation (HMAC-SHA1, 30s period, 6 digits).
 */
export const TotpEngine = {
  generateSecretBase32(): string {
    return encodeBase32(randomBytes(20));
  },

  buildOtpAuthUri(username: string, secretBase32: string, issuer = "Keel"): string {
    const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(username)}`;
    return `otpauth://totp/${label}?secret=${encodeURIComponent(secretBase32)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  },

  generateCode(secretBase32: string, timestampMs: number, stepSeconds = 30): string {
    const key = decodeBase32(secretBase32);
    const counter = Math.floor(timestampMs / 1000 / stepSeconds);
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeBigUInt64BE(BigInt(counter), 0);

    const hmac = createHmac("sha1", key).update(counterBuf).digest();
    const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
    const binary =
      (((hmac[offset] ?? 0) & 0x7f) << 24) |
      (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
      (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
      ((hmac[offset + 3] ?? 0) & 0xff);

    const otp = binary % 1_000_000;
    return String(otp).padStart(6, "0");
  },

  verifyCode(
    secretBase32: string,
    code: string,
    timestampMs: number,
    windowSteps = 1,
    stepSeconds = 30
  ): boolean {
    if (!/^\d{6}$/.test(code)) {
      return false;
    }
    const candidateBuf = Buffer.from(code, "utf8");
    for (let delta = -windowSteps; delta <= windowSteps; delta++) {
      const checkTs = timestampMs + delta * stepSeconds * 1000;
      const expected = this.generateCode(secretBase32, checkTs, stepSeconds);
      const expectedBuf = Buffer.from(expected, "utf8");
      if (
        candidateBuf.length === expectedBuf.length &&
        timingSafeEqual(candidateBuf, expectedBuf)
      ) {
        return true;
      }
    }
    return false;
  }
};

function maskSecretPreview(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (trimmed.length <= 8) {
    return "****";
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

export const LEGACY_DEFAULT_MASTER_KEY = "keel-default-local-dev-master-key-change-in-prod";

export class RateLimitError extends Error {
  public readonly isRateLimited = true;
  public readonly statusCode = 429;
  public readonly retryAfterSeconds: number;

  public constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

export function validateMasterKey(masterKeyMaterial: string | undefined): {
  valid: boolean;
  reason?: string;
} {
  if (!masterKeyMaterial || masterKeyMaterial.trim().length === 0) {
    return {
      valid: false,
      reason: "KEEL_MASTER_KEY environment variable or masterKeyMaterial must be set"
    };
  }
  if (masterKeyMaterial.trim() === LEGACY_DEFAULT_MASTER_KEY) {
    return {
      valid: false,
      reason: "Default development master key is prohibited. Please set a secure KEEL_MASTER_KEY"
    };
  }
  if (masterKeyMaterial.length < 32) {
    return {
      valid: false,
      reason: "KEEL_MASTER_KEY must be at least 32 characters long"
    };
  }
  return { valid: true };
}

export interface SecretVaultOptions {
  readonly repo: SecretVaultRepository;
  readonly clock: Clock;
  readonly masterKeyMaterial?: string | undefined;
  readonly allowUnconfigured?: boolean | undefined;
}

/**
 * AES-256-GCM encrypted secret vault backed by SecretVaultRepository.
 */
export class SecretVault {
  private readonly repo: SecretVaultRepository;
  private readonly clock: Clock;
  private readonly derivedKey: Buffer | null = null;
  private readonly legacyDerivedKey: Buffer | null = null;
  private readonly unconfiguredReason: string | null = null;

  public constructor(options: SecretVaultOptions) {
    this.repo = options.repo;
    this.clock = options.clock;
    const rawMaterial = options.masterKeyMaterial ?? process.env["KEEL_MASTER_KEY"];
    const validation = validateMasterKey(rawMaterial);

    if (!validation.valid || typeof rawMaterial !== "string") {
      if (options.allowUnconfigured) {
        this.unconfiguredReason = validation.reason ?? "Invalid master key";
        return;
      }
      throw new Error(validation.reason ?? "Invalid master key");
    }

    // RFC 5869 HKDF standard key derivation for AES-256-GCM
    this.derivedKey = Buffer.from(
      hkdfSync("sha256", rawMaterial, "keel-vault-salt-v1", "keel-aes-256-gcm-v1", 32)
    );
    this.legacyDerivedKey = createHash("sha256")
      .update(`keel-aes-256-gcm-v1:${rawMaterial}`)
      .digest();
  }

  public upsertSecret(input: {
    keyName: SecretKeyName;
    plaintextValue: string;
    actor: string;
  }): SecretMetadataRecord {
    if (this.unconfiguredReason || !this.derivedKey) {
      throw new Error(
        `Vault operations disabled: ${this.unconfiguredReason ?? "Invalid master key"}`
      );
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.derivedKey, iv);
    cipher.setAAD(Buffer.from(input.keyName, "utf8"));
    const encrypted = Buffer.concat([cipher.update(input.plaintextValue, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const maskedPreview = maskSecretPreview(input.plaintextValue);
    const nowMs = this.clock.nowMs();

    this.repo.upsertSecret({
      keyName: input.keyName,
      ciphertextBase64: `v1:${encrypted.toString("base64")}`,
      ivBase64: iv.toString("base64"),
      authTagBase64: authTag.toString("base64"),
      maskedPreview,
      updatedAtMs: nowMs,
      updatedBy: input.actor
    });

    return {
      keyName: input.keyName,
      isConfigured: true,
      maskedPreview,
      updatedAtMs: nowMs,
      updatedBy: input.actor
    };
  }

  public getDecryptedSecret(keyName: SecretKeyName): string | null {
    if (this.unconfiguredReason || !this.derivedKey) {
      throw new Error(
        `Vault operations disabled: ${this.unconfiguredReason ?? "Invalid master key"}`
      );
    }
    const record = this.repo.getSecret(keyName);
    if (!record) {
      return null;
    }
    const iv = Buffer.from(record.ivBase64, "base64");
    const authTag = Buffer.from(record.authTagBase64, "base64");

    const isV1 = record.ciphertextBase64.startsWith("v1:");
    const rawCiphertextB64 = isV1 ? record.ciphertextBase64.slice(3) : record.ciphertextBase64;
    const ciphertext = Buffer.from(rawCiphertextB64, "base64");

    if (isV1) {
      const decipher = createDecipheriv("aes-256-gcm", this.derivedKey, iv);
      decipher.setAAD(Buffer.from(keyName, "utf8"));
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return decrypted.toString("utf8");
    }

    // Legacy fallback without v1: prefix
    try {
      if (this.legacyDerivedKey) {
        const decipher = createDecipheriv("aes-256-gcm", this.legacyDerivedKey, iv);
        decipher.setAAD(Buffer.from(keyName, "utf8"));
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return decrypted.toString("utf8");
      }
    } catch {
      // Fall through to try derivedKey
    }

    const decipher = createDecipheriv("aes-256-gcm", this.derivedKey, iv);
    decipher.setAAD(Buffer.from(keyName, "utf8"));
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  }

  public listMetadata(): readonly SecretMetadataRecord[] {
    const storedByKey = new Map(this.repo.listSecrets().map((s) => [s.keyName, s]));
    return ALL_SECRET_KEY_NAMES.map((keyName) => {
      const found = storedByKey.get(keyName);
      if (!found) {
        return {
          keyName,
          isConfigured: false,
          maskedPreview: "",
          updatedAtMs: null,
          updatedBy: null
        };
      }
      return {
        keyName,
        isConfigured: true,
        maskedPreview: found.maskedPreview,
        updatedAtMs: found.updatedAtMs,
        updatedBy: found.updatedBy
      };
    });
  }
}

function hashSessionToken(token: string): string {
  return createHash("sha256").update(`keel-session-v1:${token}`).digest("hex");
}

/**
 * RFC 9106 Argon2id memory-hard password derivation (ADR-0003, ADR-0013).
 * Modern versioned format: argon2id$v=1$m=19456,t=2,p=1$<saltHex>$<hashHex>
 */
export function hashPasswordArgon2idV1(password: string, saltHex: string): string {
  const salt = Buffer.from(saltHex, "hex");
  // OWASP Password Storage Guidelines (RFC 9106 Argon2id): m=19456 KiB (19 MiB), t=2, p=1, dkLen=32
  const digest = argon2id(password, salt, { t: 2, m: 19456, p: 1, dkLen: 32 });
  const hashHex = Buffer.from(digest).toString("hex");
  return `argon2id$v=1$m=19456,t=2,p=1$${saltHex}$${hashHex}`;
}

export function verifyPasswordConstantTime(
  password: string,
  saltHex: string,
  storedHash: string
): { valid: boolean; needsUpgrade: boolean } {
  if (storedHash.startsWith("argon2id$v=1$m=19456,t=2,p=1$")) {
    const parts = storedHash.split("$");
    const expectedSaltHex = parts[3] ?? saltHex;
    const expectedHashHex = parts[4] ?? "";
    const salt = Buffer.from(expectedSaltHex, "hex");
    const digest = argon2id(password, salt, { t: 2, m: 19456, p: 1, dkLen: 32 });
    const candidateHex = Buffer.from(digest).toString("hex");
    const a = Buffer.from(candidateHex, "hex");
    const b = Buffer.from(expectedHashHex, "hex");
    const valid = a.length === b.length && timingSafeEqual(a, b);
    return { valid, needsUpgrade: false };
  }

  // Legacy format: raw 64-hex string using m=4096 (or m=19456)
  const salt = Buffer.from(saltHex, "hex");
  const digest4096 = argon2id(password, salt, { t: 2, m: 4096, p: 1, dkLen: 32 });
  const a4096 = Buffer.from(digest4096);
  const b = Buffer.from(storedHash, "hex");
  if (a4096.length === b.length && timingSafeEqual(a4096, b)) {
    return { valid: true, needsUpgrade: true };
  }

  const digest19456 = argon2id(password, salt, { t: 2, m: 19456, p: 1, dkLen: 32 });
  const a19456 = Buffer.from(digest19456);
  if (a19456.length === b.length && timingSafeEqual(a19456, b)) {
    return { valid: true, needsUpgrade: true };
  }

  return { valid: false, needsUpgrade: false };
}

export interface AuthManagerOptions {
  readonly authRepo: AuthRepository;
  readonly clock: Clock;
  readonly sessionTtlMs?: number | undefined;
  readonly stepUpWindowMs?: number | undefined;
  readonly initialBootstrapToken?: string | undefined;
  readonly onBootstrapToken?: ((token: string) => void) | undefined;
}

export class AuthManager {
  private readonly authRepo: AuthRepository;
  private readonly clock: Clock;
  private readonly sessionTtlMs: number;
  private readonly stepUpWindowMs: number;
  private activeBootstrapToken: string | null = null;

  public constructor(options: AuthManagerOptions) {
    this.authRepo = options.authRepo;
    this.clock = options.clock;
    this.sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
    this.stepUpWindowMs = options.stepUpWindowMs ?? 5 * 60 * 1000;

    if (!this.isBootstrapped()) {
      this.activeBootstrapToken =
        options.initialBootstrapToken ??
        process.env["KEEL_BOOTSTRAP_TOKEN"] ??
        randomBytes(24).toString("hex");
      options.onBootstrapToken?.(this.activeBootstrapToken);
    }
  }

  public isBootstrapped(): boolean {
    return this.authRepo.getAdminUser() !== null;
  }

  public bootstrapAdmin(input: {
    bootstrapToken: string;
    username: string;
    password: string;
    clientIp?: string | undefined;
  }): {
    username: string;
    totpSecretBase32: string;
    otpauthUri: string;
  } {
    const nowMs = this.clock.nowMs();
    const rateLimitKey = `bootstrap:${input.clientIp ?? "127.0.0.1"}:${input.username.trim()}`;
    const rateLimit = this.authRepo.getRateLimit(rateLimitKey);
    if (rateLimit && rateLimit.lockedUntilMs > nowMs) {
      const retryAfter = Math.ceil((rateLimit.lockedUntilMs - nowMs) / 1000);
      throw new RateLimitError("Too many failed bootstrap attempts.", retryAfter);
    }
    if (this.isBootstrapped()) {
      throw new Error("Admin account is already bootstrapped");
    }
    if (!this.activeBootstrapToken) {
      throw new Error("No active bootstrap token available");
    }
    const candidateBuf = Buffer.from(input.bootstrapToken.trim(), "utf8");
    const expectedBuf = Buffer.from(this.activeBootstrapToken, "utf8");
    if (candidateBuf.length !== expectedBuf.length || !timingSafeEqual(candidateBuf, expectedBuf)) {
      this.authRepo.recordRateLimitAttempt(rateLimitKey, nowMs, 15 * 60 * 1000);
      throw new Error("Invalid bootstrap token");
    }

    const saltHex = randomBytes(16).toString("hex");
    const passwordHashHex = hashPasswordArgon2idV1(input.password, saltHex);
    const totpSecretBase32 = TotpEngine.generateSecretBase32();

    this.authRepo.upsertAdminUser({
      username: input.username.trim(),
      passwordHashHex,
      passwordSaltHex: saltHex,
      totpSecretBase32,
      totpEnabled: false,
      createdAtMs: nowMs,
      updatedAtMs: nowMs
    });

    this.authRepo.resetRateLimit(rateLimitKey);
    this.activeBootstrapToken = null;

    return {
      username: input.username.trim(),
      totpSecretBase32,
      otpauthUri: TotpEngine.buildOtpAuthUri(input.username.trim(), totpSecretBase32)
    };
  }

  public login(input: {
    username: string;
    password: string;
    totpCode?: string | undefined;
    clientIp: string;
  }): {
    sessionToken: string;
    username: string;
    totpEnabled: boolean;
  } {
    const nowMs = this.clock.nowMs();
    const rateLimitKey = `login:${input.clientIp}:${input.username.trim()}`;
    const rateLimit = this.authRepo.getRateLimit(rateLimitKey);
    if (rateLimit && rateLimit.lockedUntilMs > nowMs) {
      const retryAfter = Math.ceil((rateLimit.lockedUntilMs - nowMs) / 1000);
      throw new RateLimitError(`Too many failed attempts. Account locked.`, retryAfter);
    }

    const user = this.authRepo.getAdminUser();
    if (!user || user.username !== input.username.trim()) {
      this.authRepo.recordRateLimitAttempt(rateLimitKey, nowMs, 15 * 60 * 1000);
      throw new Error("Invalid username or password");
    }
    const verifyRes = verifyPasswordConstantTime(
      input.password,
      user.passwordSaltHex,
      user.passwordHashHex
    );
    if (!verifyRes.valid) {
      this.authRepo.recordRateLimitAttempt(rateLimitKey, nowMs, 15 * 60 * 1000);
      throw new Error("Invalid username or password");
    }

    if (verifyRes.needsUpgrade) {
      const upgradedHash = hashPasswordArgon2idV1(input.password, user.passwordSaltHex);
      this.authRepo.upsertAdminUser({
        ...user,
        passwordHashHex: upgradedHash,
        updatedAtMs: nowMs
      });
    }

    let stepUpAtMs: number | null = null;
    if (user.totpEnabled && user.totpSecretBase32) {
      if (!input.totpCode || !TotpEngine.verifyCode(user.totpSecretBase32, input.totpCode, nowMs)) {
        this.authRepo.recordRateLimitAttempt(rateLimitKey, nowMs, 15 * 60 * 1000);
        throw new Error("Invalid or missing TOTP code");
      }
      stepUpAtMs = nowMs;
    }

    // Success - reset rate limits
    this.authRepo.resetRateLimit(rateLimitKey);

    this.authRepo.pruneExpiredSessions(nowMs);
    const sessionToken = randomBytes(32).toString("hex");
    const sessionIdHash = hashSessionToken(sessionToken);

    this.authRepo.createSession({
      sessionIdHash,
      username: user.username,
      clientIp: input.clientIp,
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.sessionTtlMs,
      lastStepUpAtMs: stepUpAtMs
    });

    return {
      sessionToken,
      username: user.username,
      totpEnabled: user.totpEnabled
    };
  }

  public logout(sessionToken: string | null): void {
    if (!sessionToken) {
      return;
    }
    this.authRepo.deleteSession(hashSessionToken(sessionToken));
  }

  public enrollTotp(
    sessionToken: string,
    password: string
  ): {
    totpSecretBase32: string;
    otpauthUri: string;
  } {
    const user = this.requireAuthenticatedUser(sessionToken);
    const verifyRes = verifyPasswordConstantTime(
      password,
      user.passwordSaltHex,
      user.passwordHashHex
    );
    if (!verifyRes.valid) {
      throw new Error("Invalid password for TOTP enrollment");
    }
    const nowMs = this.clock.nowMs();
    if (verifyRes.needsUpgrade) {
      const upgradedHash = hashPasswordArgon2idV1(password, user.passwordSaltHex);
      this.authRepo.upsertAdminUser({
        ...user,
        passwordHashHex: upgradedHash,
        updatedAtMs: nowMs
      });
    }
    const totpSecretBase32 = TotpEngine.generateSecretBase32();
    this.authRepo.upsertAdminUser({
      ...user,
      totpSecretBase32,
      totpEnabled: false,
      updatedAtMs: nowMs
    });
    return {
      totpSecretBase32,
      otpauthUri: TotpEngine.buildOtpAuthUri(user.username, totpSecretBase32)
    };
  }

  public enableTotp(sessionToken: string, code: string): void {
    const user = this.requireAuthenticatedUser(sessionToken);
    if (!user.totpSecretBase32) {
      throw new Error("No TOTP secret enrolled");
    }
    const nowMs = this.clock.nowMs();
    if (!TotpEngine.verifyCode(user.totpSecretBase32, code, nowMs)) {
      throw new Error("Invalid TOTP verification code");
    }
    this.authRepo.upsertAdminUser({
      ...user,
      totpEnabled: true,
      updatedAtMs: nowMs
    });
    this.authRepo.updateSessionStepUp(hashSessionToken(sessionToken), nowMs);
  }

  public verifyStepUp(input: {
    sessionToken: string | null;
    password?: string | undefined;
    totpCode?: string | undefined;
    clientIp?: string | undefined;
  }): boolean {
    if (!input.sessionToken) {
      return false;
    }
    const session = this.getValidSessionRecord(input.sessionToken);
    const user = this.authRepo.getAdminUser();
    if (!session || !user) {
      return false;
    }
    const nowMs = this.clock.nowMs();
    const rateLimitKey = `stepup:${input.clientIp ?? session.clientIp}:${user.username}`;
    const rateLimit = this.authRepo.getRateLimit(rateLimitKey);
    if (rateLimit && rateLimit.lockedUntilMs > nowMs) {
      const retryAfter = Math.ceil((rateLimit.lockedUntilMs - nowMs) / 1000);
      throw new RateLimitError("Too many failed step-up attempts.", retryAfter);
    }

    // When TOTP is enabled on the account, password alone cannot bypass TOTP step-up
    if (user.totpEnabled && user.totpSecretBase32) {
      if (input.totpCode) {
        if (TotpEngine.verifyCode(user.totpSecretBase32, input.totpCode, nowMs)) {
          this.authRepo.resetRateLimit(rateLimitKey);
          this.authRepo.updateSessionStepUp(session.sessionIdHash, nowMs);
          return true;
        }
        this.authRepo.recordRateLimitAttempt(rateLimitKey, nowMs, 15 * 60 * 1000);
        return false;
      }
      return (
        session.lastStepUpAtMs !== null && nowMs - session.lastStepUpAtMs <= this.stepUpWindowMs
      );
    }

    if (input.password) {
      const verifyRes = verifyPasswordConstantTime(
        input.password,
        user.passwordSaltHex,
        user.passwordHashHex
      );
      if (verifyRes.valid) {
        if (verifyRes.needsUpgrade) {
          const upgradedHash = hashPasswordArgon2idV1(input.password, user.passwordSaltHex);
          this.authRepo.upsertAdminUser({
            ...user,
            passwordHashHex: upgradedHash,
            updatedAtMs: nowMs
          });
        }
        this.authRepo.resetRateLimit(rateLimitKey);
        this.authRepo.updateSessionStepUp(session.sessionIdHash, nowMs);
        return true;
      }
      this.authRepo.recordRateLimitAttempt(rateLimitKey, nowMs, 15 * 60 * 1000);
      return false;
    }
    if (session.lastStepUpAtMs !== null && nowMs - session.lastStepUpAtMs <= this.stepUpWindowMs) {
      return true;
    }
    return false;
  }

  public resolveSessionStatus(
    sessionToken: string | null,
    cfAuthenticated: boolean
  ): AuthSessionResponse {
    const user = this.authRepo.getAdminUser();
    if (!user) {
      return {
        bootstrapped: false,
        authenticated: false,
        username: null,
        totpEnabled: false,
        stepUpValid: false,
        cfAuthenticated
      };
    }
    if (!sessionToken) {
      return {
        bootstrapped: true,
        authenticated: false,
        username: null,
        totpEnabled: user.totpEnabled,
        stepUpValid: false,
        cfAuthenticated
      };
    }
    const session = this.getValidSessionRecord(sessionToken);
    if (!session) {
      return {
        bootstrapped: true,
        authenticated: false,
        username: null,
        totpEnabled: user.totpEnabled,
        stepUpValid: false,
        cfAuthenticated
      };
    }
    const nowMs = this.clock.nowMs();
    const stepUpValid =
      session.lastStepUpAtMs !== null && nowMs - session.lastStepUpAtMs <= this.stepUpWindowMs;

    return {
      bootstrapped: true,
      authenticated: true,
      username: user.username,
      totpEnabled: user.totpEnabled,
      stepUpValid,
      cfAuthenticated
    };
  }

  private getValidSessionRecord(sessionToken: string) {
    const sessionIdHash = hashSessionToken(sessionToken);
    const session = this.authRepo.getSession(sessionIdHash);
    if (!session) {
      return null;
    }
    const nowMs = this.clock.nowMs();
    if (session.expiresAtMs <= nowMs) {
      this.authRepo.deleteSession(sessionIdHash);
      return null;
    }
    return session;
  }

  private requireAuthenticatedUser(sessionToken: string) {
    const session = this.getValidSessionRecord(sessionToken);
    const user = this.authRepo.getAdminUser();
    if (!session || !user) {
      throw new Error("Authentication required");
    }
    return user;
  }
}

export interface IngressContext {
  readonly clientIp: string;
  readonly forwardedProto: "http" | "https";
  readonly cloudflareTunnelActive: boolean;
  readonly sessionToken: string | null;
  readonly session: AuthSessionResponse;
}

function parseSessionTokenFromHeaders(
  headers: Record<string, string | string[] | undefined>
): string | null {
  const cookieHeader = headers["cookie"];
  if (typeof cookieHeader === "string") {
    for (const part of cookieHeader.split(";")) {
      const [rawName, ...rest] = part.trim().split("=");
      if (rawName === "keel_session" && rest.length > 0) {
        return rest.join("=").trim();
      }
    }
  }
  return null;
}

/**
 * Validates a Cloudflare Zero Trust Access JWT (`Cf-Access-Jwt-Assertion`)
 * against the configured `cloudflareTeamDomain`, `cloudflareAudienceTag`,
 * expiration (`exp`), not-before (`nbf`), and optional signing secret.
 */
export function verifyCloudflareAccessJwt(input: {
  jwt: string;
  config: KeelConfig;
  nowMs: number;
  signingSecret?: string | undefined;
}): boolean {
  const parts = input.jwt.trim().split(".");
  if (parts.length !== 3) {
    return false;
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  if (!headerB64 || !payloadB64 || !signatureB64) {
    return false;
  }

  try {
    const payloadJson = Buffer.from(payloadB64, "base64url").toString("utf8");
    const claims = JSON.parse(payloadJson) as {
      iss?: unknown;
      aud?: unknown;
      exp?: unknown;
      nbf?: unknown;
    };

    const nowSec = Math.floor(input.nowMs / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= nowSec) {
      return false;
    }
    if (typeof claims.nbf === "number" && claims.nbf > nowSec) {
      return false;
    }

    const teamDomain = input.config.system.cloudflareTeamDomain.trim();
    if (teamDomain.length > 0) {
      const expectedIssuer = teamDomain.startsWith("https://")
        ? teamDomain
        : `https://${teamDomain}`;
      if (claims.iss !== expectedIssuer) {
        return false;
      }
    }

    const expectedAud = input.config.system.cloudflareAudienceTag.trim();
    if (expectedAud.length > 0) {
      const audMatch =
        claims.aud === expectedAud ||
        (Array.isArray(claims.aud) && claims.aud.includes(expectedAud));
      if (!audMatch) {
        return false;
      }
    }

    const secret = input.signingSecret ?? process.env["KEEL_CF_ACCESS_SECRET"];
    if (secret && secret.length > 0) {
      const expectedSig = createHmac("sha256", secret)
        .update(`${headerB64}.${payloadB64}`)
        .digest("base64url");
      const a = Buffer.from(signatureB64, "utf8");
      const b = Buffer.from(expectedSig, "utf8");
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Deep IngressGuard seam resolving Cloudflare Tunnel headers (`CF-Connecting-IP`,
 * `X-Forwarded-Proto`, `Cf-Access-Jwt-Assertion`) and local Argon2id session state.
 */
export function resolveIngressContext(input: {
  headers: Record<string, string | string[] | undefined>;
  fallbackIp: string;
  config: KeelConfig;
  authManager: AuthManager;
  nowMs?: number | undefined;
}): IngressContext {
  const trustCf = input.config.system.trustCloudflareHeaders;
  const cfIp = input.headers["cf-connecting-ip"];
  const xff = input.headers["x-forwarded-for"];
  const xfp = input.headers["x-forwarded-proto"];
  const cfJwt = input.headers["cf-access-jwt-assertion"];

  let clientIp = input.fallbackIp;
  if (trustCf) {
    if (typeof cfIp === "string" && cfIp.trim().length > 0) {
      clientIp = cfIp.trim();
    } else if (typeof xff === "string" && xff.trim().length > 0) {
      const firstHop = xff.split(",")[0]?.trim();
      if (firstHop) {
        clientIp = firstHop;
      }
    }
  }

  let forwardedProto: "http" | "https" = "http";
  if (trustCf && typeof xfp === "string") {
    const proto = xfp.split(",")[0]?.trim().toLowerCase();
    if (proto === "https") {
      forwardedProto = "https";
    }
  }

  const cloudflareTunnelActive =
    typeof cfIp === "string" || typeof input.headers["cf-ray"] === "string";

  const cfAuthenticated =
    trustCf &&
    typeof cfJwt === "string" &&
    verifyCloudflareAccessJwt({
      jwt: cfJwt,
      config: input.config,
      nowMs: input.nowMs ?? Date.now()
    });

  const sessionToken = parseSessionTokenFromHeaders(input.headers);
  const session = input.authManager.resolveSessionStatus(sessionToken, cfAuthenticated);

  return {
    clientIp,
    forwardedProto,
    cloudflareTunnelActive,
    sessionToken,
    session
  };
}

export function formatSessionCookieHeader(
  sessionToken: string,
  forwardedProto: "http" | "https",
  maxAgeSeconds = 12 * 60 * 60
): string {
  const parts = [
    `keel_session=${sessionToken}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`
  ];
  if (forwardedProto === "https" || process.env["NODE_ENV"] === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function formatClearSessionCookieHeader(): string {
  return "keel_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";
}
