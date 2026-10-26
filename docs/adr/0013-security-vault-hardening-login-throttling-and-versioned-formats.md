# ADR-0013: Security Vault Hardening, Persistent Login Throttling, & Versioned Cryptographic Formats

## Status

Accepted

## Context

A second independent security review identified the following operational risks:

1. **Master Key Vulnerability (S1)**: `SecretVault` contained a fallback default string (`"keel-default-local-dev-master-key-change-in-prod"`). If `KEEL_MASTER_KEY` was missing, short, or left as the default, production secrets could be encrypted with predictable entropy.
2. **Credential Brute-Force & Rate Limiting (S2)**: Login, step-up, and bootstrap endpoints lacked persistent, stateful rate-limiting. Ephemeral in-memory counters reset on server restarts.
3. **Cryptographic Format Upgrades**: The repository upgraded Argon2id parameters from `m=4096` to OWASP `m=19456` and derived vault keys via HKDF. Existing database records containing legacy unversioned formats must verify/decrypt cleanly and be transparently re-encrypted in modern versioned envelopes.

## Decision

1. **Enforce Strict `KEEL_MASTER_KEY` Validation (S1)**:
   - `SecretVault` and server startup strictly reject any master key that is missing, fewer than 32 characters, or equal to the legacy default string.
   - The server logs a critical startup error and refuses vault operations.
   - `KEEL_MASTER_KEY` is documented as mandatory in `docker-compose.yml`, `README.md`, and `docs/runbooks/go-live-checklist.md`.
2. **Persistent Rate Limiting with Exponential Backoff (S2)**:
   - Persist rate-limit tracking in SQLite table `auth_rate_limits`:
     `(key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, first_attempt_ms INTEGER NOT NULL, locked_until_ms INTEGER NOT NULL)`.
   - Key: `ip:username:action` (covering login, step-up, and bootstrap).
   - Rules: 5 failed attempts within 15 minutes triggers lock with exponential backoff up to 15 minutes.
   - Returns HTTP 429 Too Many Requests with standard `Retry-After` header.
3. **Versioned Cryptographic Formats**:
   - **Password Hashes**: Format `argon2id$v=1$m=19456,t=2,p=1$<saltHex>$<hashHex>`. Legacy 64-hex SHA/Argon hashes verify using legacy parameters (`m=4096`) and re-hash to `v=1` format on successful login.
   - **Vault Ciphertexts**: Format `v1:<ivBase64>:<ciphertextBase64>:<authTagBase64>`. Legacy unversioned ciphertexts decrypt using legacy raw hash key derivation, and re-encrypt into `v1` envelopes using HKDF key derivation on the next write.

## Consequences

- Eliminates insecure master key defaults.
- Prevents offline and online credential brute-forcing with durable SQLite state across process restarts.
- Provides seamless, zero-downtime migration for existing databases and users.
