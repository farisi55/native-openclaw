# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG no_proxy

ENV HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY} \
    NO_PROXY=${NO_PROXY} \
    http_proxy=${http_proxy} \
    https_proxy=${https_proxy} \
    no_proxy=${no_proxy}

WORKDIR /app

COPY package.json package-lock.json* ./

# Configure npm proxy only when env is provided.
RUN if [ -n "$HTTP_PROXY" ]; then npm config set proxy "$HTTP_PROXY"; fi \
 && if [ -n "$HTTPS_PROXY" ]; then npm config set https-proxy "$HTTPS_PROXY"; fi \
 && npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
COPY tools/ ./tools/
COPY skills/ ./skills/
COPY workspace/ ./workspace/

RUN npm run build
RUN mkdir -p dist/web-ui/public \
 && cp -r src/web-ui/public/. dist/web-ui/public/

RUN npm prune --production

# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG no_proxy
ARG INSTALL_OPENCODE=false

ENV HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY} \
    NO_PROXY=${NO_PROXY} \
    http_proxy=${http_proxy} \
    https_proxy=${https_proxy} \
    no_proxy=${no_proxy}
    
RUN addgroup -S openclaw && adduser -S openclaw -G openclaw

WORKDIR /app

COPY --from=builder --chown=openclaw:openclaw /app/dist ./dist
COPY --from=builder --chown=openclaw:openclaw /app/node_modules ./node_modules
COPY --from=builder --chown=openclaw:openclaw /app/package.json ./
COPY --from=builder --chown=openclaw:openclaw /app/tools ./tools
COPY --from=builder --chown=openclaw:openclaw /app/skills ./skills
COPY --from=builder --chown=openclaw:openclaw /app/workspace ./workspace

RUN mkdir -p /data /skills /workspace \
 && chown -R openclaw:openclaw /data /skills /workspace

ENV NODE_ENV=production \
    HOME=/home/openclaw \
    APP_ENV=production \
    LOG_LEVEL=info \
    APP_DATA_DIR=/data \
    SKILLS_DIR=/skills \
    WORKSPACE_DIR=/workspace \
    WORKFLOW_FILE=/workspace/WORKFLOW.md \
    TOOLS_DIR=/app/tools \
    MCP_CONFIG_PATH=/data/mcp.json \
    STORAGE_BACKEND=file

USER openclaw

VOLUME ["/data", "/skills", "/workspace"]

EXPOSE 18789 18790

ENTRYPOINT ["node", "--enable-source-maps", "dist/index.js"]
