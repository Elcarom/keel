# 0003. Cloudflare Tunnel Ingress with Defense-in-Depth Authentication

**Status**: accepted

Remote and mobile access to the Unraid container is served through a **Cloudflare Tunnel (`cloudflared`)** routing to the container's single HTTP port (`8080`). Because Cloudflare terminates TLS at the edge and proxies requests over the local Docker network, the server is configured specifically for Cloudflare Tunnel semantics while retaining defense-in-depth application authentication:

1. **Cloudflare Headers & Stream Keep-Alive**: The Fastify server trusts the local `cloudflared` proxy hop, extracts client IPs from `CF-Connecting-IP` for audit logging and rate limiting, honors `X-Forwarded-Proto: https` for `Secure` cookies, and sends a **15-second heartbeat frame** on all SSE/WebSocket streams so Cloudflare's 100-second edge idle timeout never drops live dashboard streams.
2. **Optional Cloudflare Access JWT Verification + Mandatory App Auth**: If Cloudflare Zero Trust Access is enabled on the tunnel hostname, the API can verify `Cf-Access-Jwt-Assertion` against the configured Cloudflare Team JWKS endpoint. Regardless of tunnel-layer auth, the app still enforces its own local admin session (`Argon2id`, initialized via a one-time bootstrap token printed to container logs) and step-up password/TOTP confirmation for `confirm` and `locked-in-live` actions, with all API keys encrypted at rest via `AES-256-GCM`.

## Consequences

- No ports need to be port-forwarded on the home router; `cloudflared` connects outbound from Unraid.
- A misconfigured Cloudflare Access policy cannot expose an unauthenticated dashboard or plaintext keys because application-level session auth and step-up confirmation remain mandatory.

