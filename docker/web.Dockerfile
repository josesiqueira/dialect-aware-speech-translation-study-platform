# syntax=docker/dockerfile:1
#
# Web app image (Next.js 16, standalone output). Build from the repository root:
#   docker build -f docker/web.Dockerfile -t dialect-web .
#
# The image contains no secrets, no .env file and no participant data. All
# configuration comes from environment variables at run time (docs/DEPLOYMENT.md).

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------
# base: Node 22 with pnpm through corepack. The pnpm version is the one pinned
# in the "packageManager" field of the root package.json.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------------------
# deps: install every workspace dependency from the lockfile. Only the manifest
# files are copied first, so this layer is reused until a dependency changes.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/ai/package.json packages/ai/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/research/package.json packages/research/
COPY packages/storage/package.json packages/storage/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build: next build with standalone output. No runtime secret is needed here:
# apps/web/instrumentation.ts skips the environment check during a build.
# ---------------------------------------------------------------------------
FROM deps AS build
COPY . .
ENV NODE_ENV=production \
    NEXT_OUTPUT=standalone
RUN pnpm --filter @dialect/web build

# ---------------------------------------------------------------------------
# runtime: the standalone server, static assets, public files, the migration
# files (the Settings page reads the migration journal) and ffmpeg.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# ffmpeg and ffprobe validate compressed recordings and derive WAV files.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

WORKDIR /app

# Files belong to user "node" (uid 1000) and to group 0. A platform that runs the
# container with an arbitrary user id in group 0 (OpenShift) can still read them.
COPY --from=build --chown=node:0 /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:0 /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:0 /repo/apps/web/public ./apps/web/public
# The repository root is found by walking up to pnpm-workspace.yaml. The Settings
# page reads packages/db/migrations/meta/_journal.json below that root.
COPY --from=build --chown=node:0 /repo/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=build --chown=node:0 /repo/packages/db/migrations ./packages/db/migrations

# Mount point for the local storage driver (LOCAL_STORAGE_ROOT=/data/media).
RUN mkdir -p /data/media \
    && chown -R node:0 /data \
    && chmod -R g+rwX /data

USER 1000
EXPOSE 3000

# Liveness only. Readiness (database, configuration, storage) is /api/health/ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "apps/web/server.js"]
