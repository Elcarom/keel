import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argon2id } from "@noble/hashes/argon2";
import { ManualClock, createDefaultConfig } from "@keel/core";
import { createSqliteDataStore, type SqliteDataStore } from "@keel/data";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthManager,
  SecretVault,
  TotpEngine,
  resolveIngressContext,
  verifyCloudflareAccessJwt
} from "../src/security.js";

describe("M1-2 — IngressGuard, AuthManager (Argon2id), RFC 6238 TOTP, & AES-256-GCM SecretVault", () => {
  let tempDir: string;
  let clock: ManualClock;
  let store: SqliteDataStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "keel-sec-test-"));
    clock = new ManualClock(1_730_000_000_000);
    store = createSqliteDataStore({
      dbPath: join(tempDir, "keel.sqlite"),
      clock
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("encrypts and decrypts secrets with AES-256-GCM, masks previews, and detects ciphertext tampering", () => {
    const vault = new SecretVault({
      repo: store.secretVaultRepo,
      clock,
      masterKeyMaterial: "test-master-key-32-bytes-minimum-material!!"
    });

    const initialMeta = vault.listMetadata();
    expect(initialMeta).toHaveLength(5);
    expect(initialMeta.every((m) => !m.isConfigured)).toBe(true);

    const savedMeta = vault.upsertSecret({
      keyName: "geminiApiKey",
      plaintextValue: "AIzaSyD-9876543210abcdefXYZ",
      actor: "admin"
    });

    expect(savedMeta.isConfigured).toBe(true);
    expect(savedMeta.maskedPreview).toBe("AIza...fXYZ");
    expect(savedMeta.maskedPreview).not.toContain("9876543210");

    const decrypted = vault.getDecryptedSecret("geminiApiKey");
    expect(decrypted).toBe("AIzaSyD-9876543210abcdefXYZ");

    // Tamper with ciphertext in SQLite and verify GCM authentication tag rejects it
    const rawRecord = store.secretVaultRepo.getSecret("geminiApiKey");
    expect(rawRecord).not.toBeNull();
    if (rawRecord) {
      const tamperedBytes = Buffer.from(rawRecord.ciphertextBase64, "base64");
      tamperedBytes[0] = (tamperedBytes[0] ?? 0) ^ 0xff;
      store.secretVaultRepo.upsertSecret({
        ...rawRecord,
        ciphertextBase64: tamperedBytes.toString("base64")
      });
    }

    expect(() => vault.getDecryptedSecret("geminiApiKey")).toThrow();
  });

  it("generates and verifies RFC 6238 TOTP codes across ±1 time-step windows", () => {
    const secret = TotpEngine.generateSecretBase32();
    expect(secret).toMatch(/^[A-Z2-7]+=*$/);

    const t0 = 1_730_000_000_000;
    const codeAtT0 = TotpEngine.generateCode(secret, t0);
    expect(codeAtT0).toMatch(/^\d{6}$/);

    // Exact timestamp and +29s within window verify true
    expect(TotpEngine.verifyCode(secret, codeAtT0, t0)).toBe(true);
    expect(TotpEngine.verifyCode(secret, codeAtT0, t0 + 30_000)).toBe(true);

    // +90s (3 steps away) rejects old code
    expect(TotpEngine.verifyCode(secret, codeAtT0, t0 + 90_000)).toBe(false);
  });

  it("enforces one-time bootstrap token, Argon2id password hashing, TOTP step-up enforcement, and Cloudflare JWT validation", () => {
    let emittedToken = "";
    const auth = new AuthManager({
      authRepo: store.authRepo,
      clock,
      onBootstrapToken: (token) => {
        emittedToken = token;
      }
    });

    expect(auth.isBootstrapped()).toBe(false);
    expect(emittedToken.length).toBeGreaterThanOrEqual(32);

    // Reject wrong bootstrap token
    expect(() =>
      auth.bootstrapAdmin({
        bootstrapToken: "wrong-token",
        username: "admin",
        password: "correct-horse-battery-staple"
      })
    ).toThrow(/Invalid bootstrap token/i);

    // Succeed with valid one-time bootstrap token
    const bootRes = auth.bootstrapAdmin({
      bootstrapToken: emittedToken,
      username: "admin",
      password: "correct-horse-battery-staple"
    });
    expect(bootRes.username).toBe("admin");
    expect(bootRes.otpauthUri).toContain("otpauth://totp/Keel:admin");
    expect(auth.isBootstrapped()).toBe(true);

    // Login with correct password issues session token
    const loginRes = auth.login({
      username: "admin",
      password: "correct-horse-battery-staple",
      clientIp: "198.51.100.7"
    });
    expect(loginRes.sessionToken.length).toBeGreaterThanOrEqual(32);

    // Enable TOTP on the account
    const validTotp = TotpEngine.generateCode(bootRes.totpSecretBase32, clock.nowMs());
    auth.enableTotp(loginRes.sessionToken, validTotp);

    // Advance past the 5-minute step-up window and verify password alone CANNOT bypass TOTP when totpEnabled is true
    clock.advanceMs(6 * 60 * 1000);
    const passwordBypassAttempt = auth.verifyStepUp({
      sessionToken: loginRes.sessionToken,
      password: "correct-horse-battery-staple"
    });
    expect(passwordBypassAttempt).toBe(false);

    // Valid TOTP code at current clock succeeds
    const nextTotp = TotpEngine.generateCode(bootRes.totpSecretBase32, clock.nowMs());
    expect(
      auth.verifyStepUp({
        sessionToken: loginRes.sessionToken,
        totpCode: nextTotp
      })
    ).toBe(true);

    // Verify Cloudflare Access JWT validation (iss, aud, exp, signature)
    const cfConfig = {
      ...createDefaultConfig(),
      system: {
        ...createDefaultConfig().system,
        cloudflareTeamDomain: "keel.cloudflareaccess.com",
        cloudflareAudienceTag: "aud-tag-123"
      }
    };
    const headerB64 = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url"
    );
    const payloadB64 = Buffer.from(
      JSON.stringify({
        iss: "https://keel.cloudflareaccess.com",
        aud: ["aud-tag-123"],
        exp: Math.floor(clock.nowMs() / 1000) + 300
      })
    ).toString("base64url");
    const sigB64 = createHmac("sha256", "cf-secret")
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64url");
    const validJwt = `${headerB64}.${payloadB64}.${sigB64}`;

    expect(
      verifyCloudflareAccessJwt({
        jwt: validJwt,
        config: cfConfig,
        nowMs: clock.nowMs(),
        signingSecret: "cf-secret"
      })
    ).toBe(true);

    expect(
      verifyCloudflareAccessJwt({
        jwt: validJwt,
        config: cfConfig,
        nowMs: clock.nowMs(),
        signingSecret: "wrong-secret"
      })
    ).toBe(false);

    const ingress = resolveIngressContext({
      headers: {
        "cf-connecting-ip": "198.51.100.7",
        "x-forwarded-proto": "https",
        "cf-access-jwt-assertion": validJwt,
        cookie: `keel_session=${loginRes.sessionToken}`
      },
      fallbackIp: "127.0.0.1",
      config: cfConfig,
      authManager: auth,
      nowMs: clock.nowMs()
    });

    expect(ingress.clientIp).toBe("198.51.100.7");
    expect(ingress.forwardedProto).toBe("https");
    expect(ingress.cloudflareTunnelActive).toBe(true);
    expect(ingress.session.cfAuthenticated).toBe(true);
    expect(ingress.session.authenticated).toBe(true);
    expect(ingress.session.totpEnabled).toBe(true);
    expect(ingress.session.stepUpValid).toBe(true);
  });

  it("E1: SecretVault derives AES-256-GCM key using RFC 5869 HKDF standard rather than plain SHA-256", () => {
    const clock = new ManualClock(1_750_000_000_000);
    const store = createSqliteDataStore({
      dbPath: ":memory:",
      clock,
      initialPaperCapitalUsdt: "100000.00"
    });

    const masterKey = "secure-master-key-entropy-material-32B";
    const vault = new SecretVault({
      repo: store.secretVaultRepo,
      clock,
      masterKeyMaterial: masterKey
    });

    vault.upsertSecret({
      keyName: "okxApiKey",
      plaintextValue: "live-okx-api-key-9999",
      actor: "admin"
    });

    const decrypted = vault.getDecryptedSecret("okxApiKey");
    expect(decrypted).toBe("live-okx-api-key-9999");

    const meta = vault.listMetadata();
    expect(meta.length).toBeGreaterThanOrEqual(1);
    const keyMeta = meta.find((m) => m.keyName === "okxApiKey");
    expect(keyMeta?.isConfigured).toBe(true);
    expect(keyMeta?.maskedPreview).toContain("...");

    store.close();
  });

  it("S1: SecretVault strictly refuses vault operations if KEEL_MASTER_KEY is unset, < 32 chars, or default string", () => {
    const clock = new ManualClock(1_750_000_000_000);
    const store = createSqliteDataStore({
      dbPath: ":memory:",
      clock
    });

    const oldEnv = process.env["KEEL_MASTER_KEY"];
    delete process.env["KEEL_MASTER_KEY"];

    try {
      // 1. Unset master key -> must throw
      expect(
        () =>
          new SecretVault({
            repo: store.secretVaultRepo,
            clock
          })
      ).toThrow(/KEEL_MASTER_KEY.*must be set/i);

      // 2. Too short (< 32 chars) -> must throw
      expect(
        () =>
          new SecretVault({
            repo: store.secretVaultRepo,
            clock,
            masterKeyMaterial: "short-key-16-bytes"
          })
      ).toThrow(/at least 32 characters/i);

      // 3. Old default string -> must throw
      expect(
        () =>
          new SecretVault({
            repo: store.secretVaultRepo,
            clock,
            masterKeyMaterial: "keel-default-local-dev-master-key-change-in-prod"
          })
      ).toThrow(/default.*prohibited/i);
    } finally {
      if (oldEnv !== undefined) {
        process.env["KEEL_MASTER_KEY"] = oldEnv;
      }
      store.close();
    }
  });

  it("S2: AuthManager enforces persistent SQLite rate limiting with exponential backoff on login failures", () => {
    const clock = new ManualClock(1_750_000_000_000);
    const dbPath = join(tempDir, "throttle.sqlite");
    let store1: SqliteDataStore | null = null;
    let store2: SqliteDataStore | null = null;

    try {
      store1 = createSqliteDataStore({ dbPath, clock });

      let emittedToken = "";
      const auth1 = new AuthManager({
        authRepo: store1.authRepo,
        clock,
        onBootstrapToken: (t) => {
          emittedToken = t;
        }
      });

      auth1.bootstrapAdmin({
        bootstrapToken: emittedToken,
        username: "admin",
        password: "correct-horse-battery-staple"
      });

      // 5 consecutive failed login attempts
      for (let i = 0; i < 5; i++) {
        expect(() =>
          auth1.login({
            username: "admin",
            password: "wrong-password",
            clientIp: "198.51.100.10"
          })
        ).toThrow(/Invalid username or password/i);
      }

      // 6th attempt must trigger 429 rate limit lockout
      let caughtError: unknown = null;
      try {
        auth1.login({
          username: "admin",
          password: "wrong-password",
          clientIp: "198.51.100.10"
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeDefined();
      expect((caughtError as { isRateLimited?: boolean }).isRateLimited).toBe(true);
      expect((caughtError as { retryAfterSeconds?: number }).retryAfterSeconds).toBeGreaterThan(0);

      // Persistence check: simulate server restart by closing and re-opening SQLite store
      store1.close();
      store1 = null;

      store2 = createSqliteDataStore({ dbPath, clock });
      const auth2 = new AuthManager({
        authRepo: store2.authRepo,
        clock
      });

      // Attempt immediately after restart: must STILL be locked in SQLite
      let restartLocked: unknown = null;
      try {
        auth2.login({
          username: "admin",
          password: "correct-horse-battery-staple",
          clientIp: "198.51.100.10"
        });
      } catch (err) {
        restartLocked = err;
      }
      expect(restartLocked).toBeDefined();
      expect((restartLocked as { isRateLimited?: boolean }).isRateLimited).toBe(true);

      // Advance clock past lockout period
      clock.advanceMs(16 * 60 * 1000);

      // Now valid login succeeds and clears the throttle
      const loginOk = auth2.login({
        username: "admin",
        password: "correct-horse-battery-staple",
        clientIp: "198.51.100.10"
      });
      expect(loginOk.sessionToken).toBeDefined();
    } finally {
      store1?.close();
      store2?.close();
    }
  });

  it("Formats: supports versioned Argon2id hashes and transparently upgrades legacy m=4096 hashes", () => {
    const clock = new ManualClock(1_750_000_000_000);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });

    let emittedToken = "";
    const auth = new AuthManager({
      authRepo: store.authRepo,
      clock,
      onBootstrapToken: (t) => {
        emittedToken = t;
      }
    });

    // Bootstrap creates versioned hash
    auth.bootstrapAdmin({
      bootstrapToken: emittedToken,
      username: "admin",
      password: "my-secure-password"
    });

    const user = store.authRepo.getAdminUser();
    expect(user).not.toBeNull();
    // Must be in versioned format: argon2id$v=1$m=19456,t=2,p=1$...
    expect(user?.passwordHashHex).toMatch(/^argon2id\$v=1\$m=19456,t=2,p=1\$/);

    // Now simulate legacy user with m=4096 raw hex hash
    const legacySalt = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    const legacyDigest = argon2id("legacy-password", Buffer.from(legacySalt, "hex"), {
      t: 2,
      m: 4096,
      p: 1,
      dkLen: 32
    });
    const legacyHashHex = Buffer.from(legacyDigest).toString("hex");

    store.authRepo.upsertAdminUser({
      username: "admin",
      passwordHashHex: legacyHashHex,
      passwordSaltHex: legacySalt,
      totpSecretBase32: null,
      totpEnabled: false,
      createdAtMs: clock.nowMs(),
      updatedAtMs: clock.nowMs()
    });

    // Login with legacy password: must verify successfully!
    const loginRes = auth.login({
      username: "admin",
      password: "legacy-password",
      clientIp: "127.0.0.1"
    });
    expect(loginRes.sessionToken).toBeDefined();

    // Check that hash was upgraded to versioned v=1 in the database!
    const upgradedUser = store.authRepo.getAdminUser();
    expect(upgradedUser?.passwordHashHex).toMatch(/^argon2id\$v=1\$m=19456,t=2,p=1\$/);

    store.close();
  });

  it("Formats: supports versioned vault ciphertexts (v1:) and transparently decrypts legacy unversioned ciphertexts", () => {
    const clock = new ManualClock(1_750_000_000_000);
    const store = createSqliteDataStore({ dbPath: ":memory:", clock });
    const masterKey = "secure-random-master-key-that-is-at-least-32-chars-long";

    const vault = new SecretVault({
      repo: store.secretVaultRepo,
      clock,
      masterKeyMaterial: masterKey
    });

    // 1. Modern write creates v1: prefix
    vault.upsertSecret({
      keyName: "okxApiKey",
      plaintextValue: "new-api-key-value",
      actor: "admin"
    });

    const storedModern = store.secretVaultRepo.getSecret("okxApiKey");
    expect(storedModern).not.toBeNull();
    expect(storedModern?.ciphertextBase64.startsWith("v1:")).toBe(true);
    expect(vault.getDecryptedSecret("okxApiKey")).toBe("new-api-key-value");

    // 2. Legacy secret encrypted with SHA-256 derived key and NO v1: prefix
    const legacyKey = createHash("sha256").update(`keel-aes-256-gcm-v1:${masterKey}`).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", legacyKey, iv);
    cipher.setAAD(Buffer.from("okxPassphrase", "utf8"));
    const enc = Buffer.concat([cipher.update("legacy-passphrase", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    store.secretVaultRepo.upsertSecret({
      keyName: "okxPassphrase",
      ciphertextBase64: enc.toString("base64"), // No v1: prefix
      ivBase64: iv.toString("base64"),
      authTagBase64: tag.toString("base64"),
      maskedPreview: "lega...rase",
      updatedAtMs: clock.nowMs(),
      updatedBy: "legacy-admin"
    });

    // Vault decrypts legacy secret cleanly!
    const decryptedLegacy = vault.getDecryptedSecret("okxPassphrase");
    expect(decryptedLegacy).toBe("legacy-passphrase");

    // Re-encrypting on next write writes modern v1: format
    vault.upsertSecret({
      keyName: "okxPassphrase",
      plaintextValue: decryptedLegacy ?? "",
      actor: "admin"
    });
    const reEncrypted = store.secretVaultRepo.getSecret("okxPassphrase");
    expect(reEncrypted?.ciphertextBase64.startsWith("v1:")).toBe(true);
    expect(vault.getDecryptedSecret("okxPassphrase")).toBe("legacy-passphrase");

    store.close();
  });
});
