FROM node:24-slim AS base
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
ENV SKIP_ENV_VALIDATION=1

COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache bun install

ENV NODE_ENV=production
RUN cd apps/server && bun run build
ENV SKIP_ENV_VALIDATION=

EXPOSE 3000

# Readiness, not liveness: a container that cannot reach Postgres should be kept
# out of rotation, and restarting it would not help. Any runtime that reads this
# gets the same signal docker-compose already polls.
HEALTHCHECK --interval=10s --timeout=5s --retries=5 --start-period=10s \
	CMD node -e "fetch('http://localhost:3000/ready').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

WORKDIR /app/apps/server

# Exec form, so bun is PID 1 and receives SIGTERM directly. The shell form would
# put /bin/sh at PID 1, which does not forward signals, and every deploy would
# hard-kill in-flight requests instead of draining.
CMD ["bun", "dist/index.mjs"]
