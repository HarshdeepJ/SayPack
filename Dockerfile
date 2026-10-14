# syntax=docker/dockerfile:1

# Multi-stage build: each FROM starts a fresh stage, and only what a later stage
# COPYs --from an earlier one ends up in it. The final image carries the built
# app, not compilers, dev dependencies or source.
#
#   docker build -t saypack .                       -> runner (the app)
#   docker build -t saypack-tools --target tools .  -> maintenance scripts

# Debian (glibc), not Alpine (musl): better-sqlite3 and @node-rs/argon2 ship
# prebuilt glibc binaries. x64 matches the Azure VM.
ARG NODE_IMAGE=node:24-bookworm-slim

# ---- deps: install packages on Linux so native modules are Linux binaries ----
FROM ${NODE_IMAGE} AS deps
# npm compiles better-sqlite3 from C++ on install (it has a binding.gyp), so this
# stage needs a toolchain. The runner stage starts from a clean image without it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Copy only the manifests first. This layer (and the slow npm ci) is reused from
# cache until package.json or package-lock.json changes.
COPY package.json package-lock.json ./
RUN npm ci

# ---- source: dependencies plus the code ----
FROM deps AS source
COPY . .

# ---- build: compile Next.js into a self-contained server ----
FROM source AS build
ENV NEXT_TELEMETRY_DISABLED=1 SAYPACK_STANDALONE=1
RUN npm run build

# ---- tools: create-admin, backup, restore, sweep-photos (run via tsx) ----
FROM source AS tools
ENV SAYPACK_DATA_DIR=/app/data SAYPACK_BACKUP_DIR=/app/backups
# Same user as the app, so files it creates in the shared volume stay writable by the app.
RUN mkdir -p /app/data /app/backups && chown node:node /app/data /app/backups
USER node
ENTRYPOINT ["npm", "run", "--silent"]

# ---- runner: the image that is deployed ----
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
# HOSTNAME: Docker sets it to the container ID, and server.js would listen only
# on that; 0.0.0.0 accepts connections from outside the container.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    SAYPACK_DATA_DIR=/app/data

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# Read at startup by openDatabase(); the build's file tracing does not include them.
COPY --chown=node:node migrations ./migrations
# The data volume mounts here. A new named volume copies this directory's owner.
RUN mkdir -p /app/data && chown node:node /app/data

# Run as the unprivileged "node" user that the base image provides, not root.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/login').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.js"]
