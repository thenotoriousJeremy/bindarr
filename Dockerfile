# =========================================
# Bindarr Dockerfile
# Stage 1: Build Frontend Assets
# =========================================
FROM node:24-alpine AS frontend-builder
WORKDIR /app/frontend

# Copy frontend packages and lockfiles. The native detector is a local
# `file:` dependency (the app's Capacitor plugin), so npm ci needs its manifest;
# it has no JavaScript, and its native code only matters to the mobile builds.
COPY frontend/package*.json ./
COPY frontend/native-detector/package.json ./native-detector/package.json
RUN npm ci

# Copy frontend source files
COPY frontend/ ./
# Shared JSON tables imported via ../../../shared/*.json (resolves to /app/shared)
COPY shared/ /app/shared/
# The mobile app's device mode runs the backend's own route modules, bundled into
# the frontend by scripts/build-device-backend.mjs, so the build needs their
# source (and package.json, for the version). Not their dependencies: the bundler
# resolves those against frontend/node_modules.
COPY backend/package.json /app/backend/package.json
COPY backend/src/ /app/backend/src/
# Build production bundles
RUN npm run build

# =========================================
# Stage 2: Backend dependencies, built where the compilers are
# =========================================
# python3, make and g++ are needed only to recompile sqlite3, so they live in this
# stage and only node_modules is carried into the image (about 97 MB the server
# never used). Same base image as the production stage below, so the recompiled
# sqlite3 is linked against the glibc it will run on.
FROM node:24-slim AS backend-deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/package*.json ./
# Production dependencies only (prebuilt native binaries).
# ONNXRUNTIME_NODE_INSTALL_CUDA=skip: onnxruntime-node's postinstall otherwise
# fetches the CUDA/DirectML native packages from api.nuget.org, which fails on any
# build host without access to it. Inference here is CPU-only (two small models),
# and the CPU binaries ship inside the npm package itself.
# Then recompile ONLY sqlite3 from source: its node-pre-gyp prebuilt is linked
# against a newer glibc (GLIBC_2.38) than this Debian base provides, so the
# prebuilt aborts at startup with ERR_DLOPEN_FAILED. Building here links against
# the image's own glibc. Scoped to sqlite3 so sharp keeps its prebuilt (sharp
# can't build from source without libvips-dev).
# The npm cache is cleaned in the same step that filled it.
RUN ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci --omit=dev \
  && npm rebuild sqlite3 --build-from-source \
  && npm cache clean --force

# =========================================
# Stage 3: Set up Production Server
# =========================================
# Debian (glibc), NOT alpine. The original reason was onnxruntime-node (pulled in
# by @huggingface/transformers for CLIP inference), which shipped glibc-linked
# prebuilts and failed to dlopen on musl — issue #19. That dependency is gone with
# CLIP, so alpine may now be viable.
# ponytail: not switched, because sqlite3 and sharp prebuilts have their own
# glibc assumptions and proving that out is a separate job from removing CLIP.
FROM node:24-slim AS production
WORKDIR /app

# gosu to drop root in the entrypoint, plus wget (healthcheck) and
# ca-certificates (HTTPS to the card APIs). No compiler: see backend-deps.
RUN apt-get update && apt-get install -y --no-install-recommends \
      gosu wget ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Set environment to production
ENV NODE_ENV=production
ENV PORT=3001
# Card scanning needs a secure context, and a container reached at
# http://<host>:3001 is not one, so TLS is served alongside HTTP. The cert is
# self-signed into /app/database/ssl on first start (persisted with the volume)
# unless SSL_CERT_PATH/SSL_KEY_PATH point at a real one. Set HTTPS_PORT="" to
# serve plain HTTP only.
ENV HTTPS_PORT=3443
# Upgrades from an image that used pokemon_cards.db keep their data: the app
# renames the old file (and its WAL sidecars) into place on first start.
ENV DB_PATH=/app/database/bindarr.db
# Scan models and catalogs live on the persisted volume, both so a build has a
# writable target under the non-root `node` user and so an image update does not
# discard them. The two ONNX models are NOT in the image — they are AGPL-3.0 while
# Bindarr is MIT, so the operator fetches them into this directory deliberately:
#   docker exec <container> node scripts/fetch-models.mjs
ENV CV_MODEL_DIR=/app/database/models

# The app's directories, owned by `node` so a fresh named volume mounted at
# /app/database inherits node-writable permissions on first init. Only these
# directories here, not a `chown -R` of /app: that rewrote every file into a
# second copy of the whole tree (142 MB). The files are copied in owned by node
# (COPY --chown) instead. Nothing is created inside /app/database: a subdirectory
# made here as root inside a volume the entrypoint has already handed over to
# `node` is one the server can never write into. The server creates its own at
# startup, as its own user.
RUN mkdir -p /app/database /app/backend /app/frontend \
  && chown node:node /app /app/database /app/backend /app/frontend

WORKDIR /app/backend
COPY --chown=node:node backend/package*.json ./
COPY --from=backend-deps --chown=node:node /app/backend/node_modules ./node_modules

# Copy backend source files
COPY --chown=node:node backend/src/ ./src/

# Nothing here is on a runtime path — the server never loads these — but they
# are the operator's tools inside a running container: fetch-models.mjs
# downloads the scan models, reset-password.js is the way back in for a locked-out
# admin, build-catalog.mjs runs a long catalog build from a terminal, and the
# rest are one-off repairs and measurements.
COPY --chown=node:node backend/scripts/ ./scripts/

# Shared JSON tables required at runtime by backend/src/utils/compartmentSort.js
# via ../../../shared/*.json (resolves to /app/shared)
COPY --chown=node:node shared/ /app/shared/

# Copy compiled frontend assets from Stage 1 to the location server.js expects
# (../../frontend/dist relative to backend/src, i.e. /app/frontend/dist)
COPY --from=frontend-builder --chown=node:node /app/frontend/dist /app/frontend/dist

# The container starts as root and the entrypoint drops to the unprivileged
# `node` user AFTER chowning the mounted volume (a legacy root-owned volume
# would otherwise be unwritable); started as a non-root user (--user, or
# Kubernetes' runAsNonRoot) it runs the server as that user directly. sed strips
# any CRLF from a checkout made before .gitattributes pinned *.sh to LF, so the
# shebang works.
COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]

# Expose HTTP, TLS for camera scanning, and the optional Prometheus listener.
EXPOSE 3001 3443 9100

# Liveness/readiness probe. start-period covers startup (set sync + price job).
# wget is installed above (slim has no wget by default). Shell form, so it asks
# whatever PORT the container was started with.
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3001}/api/health || exit 1

# Command to start Express server
CMD ["node", "src/server.js"]
