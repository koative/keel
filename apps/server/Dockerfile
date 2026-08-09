# The build needs node:24-slim with bun copied in rather than an official bun image,
# because parts of the toolchain still shell out to node. The runtime does not, so it
# gets a bun image and none of this stage.
FROM node:24-slim AS builder
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

# @keel/env validates at import, and the build imports it. Real values arrive at
# runtime, so validating here would force secrets into the build.
ENV SKIP_ENV_VALIDATION=1

COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile

ENV NODE_ENV=production
RUN cd apps/server && bun run build

# Runtime dependencies only, resolved from the same lockfile the build used. Filtered
# to the server so the web app's React tree does not ship with the API.
#
# `dist/` bundles the @keel/* workspace packages and inlines pg, but leaves hono,
# zod, drizzle-orm, better-auth, evlog and the two @hono/@scalar packages external —
# hence this stage rather than copying dist alone.
FROM node:24-slim AS deps
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache \
	bun install --frozen-lockfile --production --filter=server

FROM oven/bun:1-slim AS runner
WORKDIR /app/apps/server

# Only three things reach the runtime: the bundle, the modules it imports, and the
# migration SQL. No source, no toolchain, no lockfile, nothing that can be executed
# by accident. That is the point of the split — the build stage above is 1.3 GB.
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/apps/server/node_modules /app/apps/server/node_modules
COPY --from=builder /app/apps/server/dist ./dist
COPY packages/db/src/migrations ./dist/migrations

ENV NODE_ENV=production

# The base image ships a non-root `bun` user. Nothing here is written to at runtime,
# so root buys the container nothing and costs it a privilege boundary.
USER bun

EXPOSE 3000

# Readiness, not liveness: a container that cannot reach Postgres should be kept out
# of rotation, and restarting it would not help. This is the same signal compose and
# any orchestrator poll.
HEALTHCHECK --interval=10s --timeout=5s --retries=5 --start-period=10s \
	CMD bun -e "fetch('http://localhost:3000/ready').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Exec form, so bun is PID 1 and receives SIGTERM directly. The shell form would put
# /bin/sh at PID 1, which does not forward signals, and every deploy would hard-kill
# in-flight requests instead of draining.
#
# Migrations are deliberately not run here: `bun dist/migrate.mjs` is a separate
# command so a rolling deploy migrates once instead of racing N booting instances.
CMD ["bun", "dist/index.mjs"]
