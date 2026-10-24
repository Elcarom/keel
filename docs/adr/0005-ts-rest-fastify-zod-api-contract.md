# 0005. Shared Typed API Contract via ts-rest, Fastify, and Zod

**Status**: accepted

We use **`@ts-rest/core`**, **`@ts-rest/fastify`**, and **`@ts-rest/react-query`** backed by shared **Zod** schemas in `core` for the HTTP API between `api` and `web`, paired with Server-Sent Events (SSE) for live server-to-browser state streams.

## Context & Trade-offs

- **Considered Options**: `tRPC` vs. `ts-rest` vs. hand-rolled OpenAPI/REST.
- **Why `ts-rest`**: Like `tRPC`, it provides zero-codegen, end-to-end TypeScript type safety and React Query hooks directly from our Zod schemas. Unlike `tRPC`'s RPC-style URLs, `ts-rest` maps to standard, human-readable REST paths and HTTP verbs (`GET /api/v1/positions`, `POST /api/v1/risk/kill-switch`), making audit logging, curl debugging, Playwright network assertions, and webhook integrations straightforward.

