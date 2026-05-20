# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install deps first (layer-cached unless package.json changes)
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/
# tools/ contains installed tool manifests and plugins required at runtime.
# Do NOT mount this as a volume — it should come from the image.
COPY tools/ ./tools/
COPY skills/ ./skills/
COPY workspace/ ./workspace/
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
COPY --from=builder --chown=openclaw:openclaw /app/tools      ./tools
COPY --from=builder --chown=openclaw:openclaw /app/skills     ./skills
COPY --from=builder --chown=openclaw:openclaw /app/workspace  ./workspace

# /data  → session & settings storage (mount as volume)
# /skills → .md skill files (mount as volume)
RUN mkdir -p /data /skills /workspace && chown -R openclaw:openclaw /data /skills /workspace

# Environment defaults (override in docker-compose or -e flags)
ENV NODE_ENV=production \
    APP_ENV=production \
    LOG_LEVEL=info \
    APP_DATA_DIR=/data \
    SKILLS_DIR=/skills \
    WORKSPACE_DIR=/workspace \
    TOOLS_DIR=/app/tools \
    STORAGE_BACKEND=file

USER openclaw

# Mark persistent directories
VOLUME ["/data", "/skills", "/workspace"]

# Interactive TTY required for the readline REPL
ENTRYPOINT ["node", "--enable-source-maps", "dist/index.js"]
