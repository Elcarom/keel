import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock, createDefaultConfig } from "@keel/core";
import { createSqliteDataStore, type SqliteDataStore } from "@keel/data";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthManager, SecretVault, TotpEngine, resolveIngressContext } from "../src/security.js";

describe("M1-2 — IngressGuard, AuthManager, RFC 6238 TOTP, & AES-256-GCM SecretVault", () => {
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

  it("enforces one-time bootstrap token, password hashing, session lifecycle, and step-up verification", () => {
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

    // Second bootstrap attempt is rejected
    expect(() =>
      auth.bootstrapAdmin({
        bootstrapToken: emittedToken,
        username: "admin2",
        password: "another-strong-password"
      })
    ).toThrow(/already bootstrapped/i);

    // Login with wrong password fails
    expect(() =>
      auth.login({
        username: "admin",
        password: "wrong-password",
        clientIp: "198.51.100.7"
      })
    ).toThrow(/Invalid credentials/i);

    // Login with correct password issues session token
    const loginRes = auth.login({
      username: "admin",
      password: "correct-horse-battery-staple",
      clientIp: "198.51.100.7"
    });
    expect(loginRes.sessionToken.length).toBeGreaterThanOrEqual(32);

    // Verify TOTP enrollment and step-up confirmation
    const validTotp = TotpEngine.generateCode(bootRes.totpSecretBase32, clock.nowMs());
    auth.enableTotp(loginRes.sessionToken, validTotp);

    const stepUpOk = auth.verifyStepUp({
      sessionToken: loginRes.sessionToken,
      totpCode: validTotp
    });
    expect(stepUpOk).toBe(true);

    // Resolve ingress context from Cloudflare headers + session cookie
    const cfg = createDefaultConfig();
    const ingress = resolveIngressContext({
      headers: {
        "cf-connecting-ip": "198.51.100.7",
        "x-forwarded-proto": "https",
        cookie: `keel_session=${loginRes.sessionToken}`
      },
      fallbackIp: "127.0.0.1",
      config: cfg,
      authManager: auth
    });

    expect(ingress.clientIp).toBe("198.51.100.7");
    expect(ingress.forwardedProto).toBe("https");
    expect(ingress.cloudflareTunnelActive).toBe(true);
    expect(ingress.session.authenticated).toBe(true);
    expect(ingress.session.username).toBe("admin");
    expect(ingress.session.totpEnabled).toBe(true);
    expect(ingress.session.stepUpValid).toBe(true);
  });
});
