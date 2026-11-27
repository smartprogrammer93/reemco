# syntax=docker/dockerfile:1
# infra/Dockerfile — REEA-1044 self-hosted production image.
#
# Built by .github/workflows/deploy-selfhosted.yml from the repo root:
#   docker build -f infra/Dockerfile --build-arg REEMCO_COMMIT=<sha> .
# and run by infra/compose.prod.yml. The image tag IS the commit sha, so a
# rollback is "redeploy the previous tag" — nothing is edited on the host.
#
# Reproducibility: base image is pinned by digest, npm ci is lockfile-exact.
# Bump the digest deliberately (record the new one in the deploy comment).
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG REEMCO_COMMIT
RUN test -n "$REEMCO_COMMIT" || { echo "REEMCO_COMMIT build arg is required (the deployed sha)" >&2; exit 1; }

# REEA-729 stamp parity: next.config.ts generateBuildId() reads
# VERCEL_GIT_COMMIT_SHA first, so setting it here makes the RSC build id and
# public/__commit.txt name the same artifact — the same chain the Vercel
# buildCommand uses. NEXT_OUTPUT=standalone asks Next for the traced bundle
# that `node server.js` runs (next.config.ts honours it; Vercel ignores it).
ENV VERCEL_GIT_COMMIT_SHA=$REEMCO_COMMIT \
    NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1
RUN printf '%s\n' "$REEMCO_COMMIT" > public/__commit.txt \
 && npm run build

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS runtime
# The runtime env deliberately does NOT set VERCEL: event-store.ts,
# metrics.ts and collect/store.ts treat VERCEL/AWS_LAMBDA as "use /tmp",
# while compose injects the durable EVENTS_DIR/METRICS_DIR/COLLECT_CACHE_DIR.
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# REEA-1226 — the REEA-1221 browser-clearance tier runs headless Chromium in
# this container. Chromium's NSS certificate store needs libsqlite3, which
# bookworm-slim does not ship: without it every navigation aborts with
# "FATAL: nss_util.cc ... libsqlite3.so.0: cannot open shared object file"
# (SIGTRAP) and the tier silently degrades. Installed here so the dependency
# ships with the image instead of relying on a host package.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libsqlite3-0 \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 reemco \
 && useradd --system --uid 1001 --gid reemco --home-dir /app --shell /usr/sbin/nologin reemco \
 && mkdir -p /data/events /data/metrics /data/collect \
 && chown -R reemco:reemco /data

WORKDIR /app
COPY --from=build --chown=reemco:reemco /app/.next/standalone ./
COPY --from=build --chown=reemco:reemco /app/.next/static ./.next/static
COPY --from=build --chown=reemco:reemco /app/public ./public

# REEA-1226 — HOME is /app; give the service user a writable home so Chromium
# can create its persistent NSS database (/app/.local/share/pki/nssdb) instead
# of logging "Failed to create ... directory" on every launch.
RUN mkdir -p /app/.local/share && chown -R reemco:reemco /app/.local

USER reemco
EXPOSE 3000
# REEA-1250 — explicit V8 heap cap. The container's cgroup is 6 GiB and the
# browser-clearance tier holds a headless Chromium (~0.7 GiB of children) next
# to this Node process. Without a cap V8 sizes its old space from the HOST's
# memory (measured: heap_size_limit 4,144 MiB on the 32 GB box), so the Node
# process alone could ratchet past 4.7 GiB VmRSS before the kernel's OOM kill.
# 2048 MiB leaves room for Chromium, the RSC/streaming buffers and page cache
# while keeping a single fan-out inside the cgroup. /api/echo reports the
# effective limit (heapLimitBytes + heapCapOk) and the deploy gate asserts it;
# do not change this value without updating NODE_HEAP_CAP_BYTES in
# src/lib/runtime-memory.ts.
CMD ["node", "--max-old-space-size=2048", "server.js"]
