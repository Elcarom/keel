# Pull Request: Ticket T1 — Security Vault Hardening, Persistent Login Throttling, & Versioned Cryptographic Formats

## Summary of Changes

### 1. S1: Strict Master Key Validation & Enforcement
- Added `validateMasterKey(masterKeyMaterial)` in `@keel/api`:
  - Rejects unset, blank, or whitespace-only keys.
  - Rejects keys shorter than 32 characters.
  - Strictly prohibits the legacy development default key string (`"keel-default-local-dev-master-key-change-in-prod"`).
- `SecretVault` constructor enforces `validateMasterKey`. When `allowUnconfigured: true` is passed (by server startup in non-configured environments), vault operations (`upsertSecret` and `getDecryptedSecret`) are disabled with descriptive errors, and startup logs a critical security error.
- Removed all hard-coded fallback master key defaults from codebase.
- Updated `docker-compose.yml`, `README.md`, and `docs/runbooks/go-live-checklist.md` with required `KEEL_MASTER_KEY` environment documentation.

### 2. S2: Persistent SQLite Rate Limiting (Exponential Backoff & 429)
- Extended `AuthRepository` port in `@keel/core` with `getRateLimit`, `recordRateLimitAttempt`, and `resetRateLimit`.
- Implemented `auth_rate_limits` table in `@keel/data` backed by SQLite WAL with composite primary key `key TEXT PRIMARY KEY`.
- Configured 5 failed attempts per (IP, username) window (15 minutes). After 5 failed attempts, exponential backoff locks the account/action up to 15 minutes.
- Implemented `RateLimitError` in `@keel/api` carrying `isRateLimited: true` and `retryAfterSeconds: number`.
- Wired throttling into `login`, `bootstrapAdmin`, and `verifyStepUp` routes in `@keel/api`, returning HTTP 429 with standard `Retry-After` header.

### 3. Versioned Cryptographic Envelopes & Seamless Legacy Migration
- **Password Hashes**:
  - Implemented versioned RFC 9106 Argon2id envelope `argon2id$v=1$m=19456,t=2,p=1$<saltHex>$<hashHex>`.
  - Legacy hashes (`m=4096`) verify cleanly and are transparently rehashed to `v=1` on successful login or step-up.
- **Vault Ciphertexts**:
  - Implemented versioned AES-256-GCM envelope `v1:<base64>`.
  - Legacy ciphertexts without `v1:` prefix decrypt using fallback key derivation and are transparently re-encrypted with `v1:` and HKDF on next write.

## Verification
- Unit & regression tests added in `packages/api/test/security.test.ts` covering S1, S2, and versioned format upgrade flows.
- Full workspace test suite passes (116 tests across 16 test files).
- Prettier, strict TypeScript (`no-explicit-any`), and ESLint clean.
