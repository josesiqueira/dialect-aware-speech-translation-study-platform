# syntax=docker/dockerfile:1
#
# Worker image. It also carries the database commands (migrate, seed), because it
# contains the TypeScript source of packages/db and the tsx loader.
# Build from the repository root:
#   docker build -f docker/worker.Dockerfile -t dialect-worker .
#
# Commands (working directory /app/apps/worker):
#   worker:   node --import tsx src/main.ts                           (default)
#   migrate:  node --import tsx ../../packages/db/src/migrate.ts
#   seed:     node --import tsx ../../packages/db/src/seed/index.ts
#
# The image contains no secrets, no .env file and no participant data. All
# configuration comes from environment variables at run time (docs/DEPLOYMENT.md).

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------
# base: Node 22 with pnpm through corepack (version pinned in package.json).
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------------------
# build: production dependencies of the worker and of the workspace packages it
# uses, from the lockfile, then the TypeScript source. The workspace layout is
# kept as it is in development, so paths resolve the same way.
# ---------------------------------------------------------------------------
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/ai/package.json packages/ai/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/research/package.json packages/research/
COPY packages/storage/package.json packages/storage/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@dialect/worker..."

COPY tsconfig.base.json ./
COPY apps/worker/tsconfig.json apps/worker/
COPY apps/worker/src apps/worker/src
COPY packages/ai/tsconfig.json packages/ai/
COPY packages/ai/src packages/ai/src
COPY packages/db/tsconfig.json packages/db/
COPY packages/db/src packages/db/src
COPY packages/db/migrations packages/db/migrations
COPY packages/domain/tsconfig.json packages/domain/
COPY packages/domain/src packages/domain/src
COPY packages/research/tsconfig.json packages/research/
COPY packages/research/src packages/research/src
COPY packages/storage/tsconfig.json packages/storage/
COPY packages/storage/src packages/storage/src

# Test files are not part of the running worker. The web app manifest was only
# needed so that the lockfile matches the workspace.
RUN find apps/worker/src packages/ai/src packages/db/src packages/domain/src \
      packages/research/src packages/storage/src -type f -name '*.test.ts' -delete \
    && rm -rf apps/web

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# ffmpeg and ffprobe derive WAV files from compressed recordings.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

# Files belong to user "node" (uid 1000) and to group 0. A platform that runs the
# container with an arbitrary user id in group 0 (OpenShift) can still read them.
COPY --from=build --chown=node:0 /repo /app

# Mount point for the local storage driver (LOCAL_STORAGE_ROOT=/data/media).
RUN mkdir -p /data/media \
    && chown -R node:0 /data \
    && chmod -R g+rwX /data

WORKDIR /app/apps/worker
USER 1000

# No HEALTHCHECK: the worker has no network port. The process exits when it cannot
# run, and it writes a heartbeat row that the admin Dashboard and Settings show.
CMD ["node", "--import", "tsx", "src/main.ts"]
