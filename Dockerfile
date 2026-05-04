# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install deps first (layer-cached unless package.json changes)
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Prune dev deps
RUN npm prune --production

# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Non-root user for security
RUN addgroup -S openclaw && adduser -S openclaw -G openclaw

WORKDIR /app

# Copy compiled output and production deps from builder
COPY --from=builder --chown=openclaw:openclaw /app/dist      ./dist
COPY --from=builder --chown=openclaw:openclaw /app/node_modules ./node_modules
COPY --from=builder --chown=openclaw:openclaw /app/package.json ./

# /data  → session & settings storage (mount as volume)
# /skills → .md skill files (mount as volume)
RUN mkdir -p /data /skills && chown -R openclaw:openclaw /data /skills

# Environment defaults (override in docker-compose or -e flags)
ENV NODE_ENV=production \
    APP_ENV=production \
    LOG_LEVEL=info \
    APP_DATA_DIR=/data \
    SKILLS_DIR=/skills \
    STORAGE_BACKEND=file

USER openclaw

# Mark persistent directories
VOLUME ["/data", "/skills"]

# Interactive TTY required for the readline REPL
ENTRYPOINT ["node", "dist/index.js"]
