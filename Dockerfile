# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/api/package.json ./packages/api/package.json
COPY packages/web/package.json ./packages/web/package.json

RUN pnpm install --frozen-lockfile

COPY packages/core ./packages/core
COPY packages/api ./packages/api
COPY packages/web ./packages/web

RUN pnpm build

FROM node:22-alpine AS runner
WORKDIR /app

RUN apk add --no-cache su-exec tini wget sqlite && \
    corepack enable && corepack prepare pnpm@9.15.4 --activate

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    BACKUPS_DIR=/backups \
    PUID=99 \
    PGID=100 \
    UMASK=022

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/api/package.json ./packages/api/package.json

RUN pnpm install --prod --frozen-lockfile --filter @keel/api... && pnpm store prune

COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/api/dist ./packages/api/dist
COPY --from=builder /app/packages/web/dist ./packages/web/dist
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh && \
    mkdir -p /data /backups

VOLUME ["/data", "/backups"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "packages/api/dist/cli.js"]

