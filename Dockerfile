# =========================================
# Bindarr Dockerfile
# Stage 1: Build Frontend Assets
# =========================================
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

# Copy frontend packages and lockfiles
COPY frontend/package*.json ./
RUN npm ci

# Copy frontend source files
COPY frontend/ ./
# Shared JSON tables imported via ../../../shared/*.json (resolves to /app/shared)
COPY shared/ /app/shared/
# Build production bundles
RUN npm run build

# =========================================
# Stage 2: Set up Production Server
# =========================================
FROM node:20-alpine AS production
WORKDIR /app

# Install native compilation dependencies for SQLite3 (alpine needs build tools)
RUN apk add --no-cache python3 make g++ 

# Set environment to production
ENV NODE_ENV=production
ENV PORT=3001
ENV DB_PATH=/app/database/pokemon_cards.db

# Create database volume mount target directory
RUN mkdir -p /app/database

# Copy backend configuration
COPY backend/package*.json ./backend/
WORKDIR /app/backend
# Install production backend dependencies (compiling sqlite3 on alpine)
RUN npm ci --omit=dev

# Copy backend source files
COPY backend/src/ ./src/

# Shared JSON tables required at runtime by backend/src/utils/compartmentSort.js
# via ../../../shared/*.json (resolves to /app/shared)
COPY shared/ /app/shared/

# Copy compiled frontend assets from Stage 1 to the location server.js expects
# (../../frontend/dist relative to backend/src, i.e. /app/frontend/dist)
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist

# Drop root: run as the built-in unprivileged `node` user. Ownership of the
# database dir is set here so a fresh named volume mounted at /app/database
# inherits node-writable permissions on first init.
RUN chown -R node:node /app
USER node

# Expose port
EXPOSE 3001

# Liveness/readiness probe. start-period covers startup (set sync + price job).
# busybox wget ships with the alpine base image.
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

# Command to start Express server
CMD ["node", "src/server.js"]
