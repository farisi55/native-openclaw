# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:24.16.0-alpine AS builder

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG no_proxy
ARG SELF_HEALING_RUNTIME=true

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
COPY test/ ./test/
COPY scripts/ ./scripts/
COPY docs/ ./docs/
COPY README.md ./
COPY validate.sh ./
COPY package.sh ./
COPY Dockerfile ./
COPY docker-compose.yml ./docker-compose.yml

RUN npm run build

RUN mkdir -p dist/web-ui/public \
 && cp -r src/web-ui/public/. dist/web-ui/public/

# In normal production image, prune devDependencies.
# In self-healing runtime, keep devDependencies because npm run build/npm test need them.
RUN if [ "$SELF_HEALING_RUNTIME" != "true" ]; then \
      npm prune --production; \
    else \
      echo "Keeping devDependencies because SELF_HEALING_RUNTIME=true"; \
    fi


# ─── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:24.16.0-alpine AS runtime

# su-exec is used by entrypoint.sh to fix bind-mount ownership as root,
# then drop privileges to the non-root openclaw user.
RUN apk add --no-cache su-exec

ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ARG http_proxy
ARG https_proxy
ARG no_proxy

ARG SELF_HEALING_RUNTIME=true
ARG OPENCODE_AUTO_INSTALL=true
ARG OPENCODE_DEFAULT_MODEL=opencode/deepseek-v4-flash-free
ARG OPENCODE_DEFAULT_SMALL_MODEL=opencode/mimo-v2.5-free
ARG MCP_SMOKE_SERVERS_INSTALL=false

ENV HTTP_PROXY=${HTTP_PROXY} \
    HTTPS_PROXY=${HTTPS_PROXY} \
    NO_PROXY=${NO_PROXY} \
    http_proxy=${http_proxy} \
    https_proxy=${https_proxy} \
    no_proxy=${no_proxy}

RUN addgroup -S openclaw && adduser -S openclaw -G openclaw

WORKDIR /app

# Runtime compiled app
COPY --from=builder --chown=openclaw:openclaw /app/dist ./dist

# Keep node_modules from builder.
# If SELF_HEALING_RUNTIME=true, this includes devDependencies.
# If false, this is production-pruned.
COPY --from=builder --chown=openclaw:openclaw /app/node_modules ./node_modules

# Project metadata and runtime assets
COPY --from=builder --chown=openclaw:openclaw /app/package.json ./package.json
COPY --from=builder --chown=openclaw:openclaw /app/package-lock.json* ./
COPY --from=builder --chown=openclaw:openclaw /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=openclaw:openclaw /app/README.md ./README.md
COPY --from=builder --chown=openclaw:openclaw /app/validate.sh ./validate.sh
COPY --from=builder --chown=openclaw:openclaw /app/package.sh ./package.sh
COPY --from=builder --chown=openclaw:openclaw /app/Dockerfile ./Dockerfile
COPY --from=builder --chown=openclaw:openclaw /app/docker-compose.yml ./docker-compose.yml

# Source files are required for self-healing/self-upgrade.
COPY --from=builder --chown=openclaw:openclaw /app/src ./src
COPY --from=builder --chown=openclaw:openclaw /app/test ./test
COPY --from=builder --chown=openclaw:openclaw /app/tools ./tools
COPY --from=builder --chown=openclaw:openclaw /app/skills ./skills
COPY --from=builder --chown=openclaw:openclaw /app/workspace ./workspace
COPY --from=builder --chown=openclaw:openclaw /app/scripts ./scripts
COPY --from=builder --chown=openclaw:openclaw /app/docs ./docs

# Data, workspace, skills, and OpenCode runtime directories.
RUN mkdir -p /data \
             /skills \
             /workspace \
             /home/openclaw/.npm/_logs \
             /home/openclaw/.config/opencode \
             /home/openclaw/.local/state \
             /home/openclaw/.local/share/opencode \
             /home/openclaw/.cache/opencode \
 && chown -R openclaw:openclaw /data \
                                /skills \
                                /workspace \
                                /home/openclaw

ENV NPM_CONFIG_CACHE=/home/openclaw/.npm

# Optional OpenCode CLI install for Docker runtime.
# Install as root before switching to non-root openclaw user.
# @opencode-ai/plugin is preinstalled to avoid runtime background install through corporate proxy.
RUN if [ "$OPENCODE_AUTO_INSTALL" = "true" ]; then \
      if [ -n "$HTTP_PROXY" ]; then npm config set proxy "$HTTP_PROXY"; fi; \
      if [ -n "$HTTPS_PROXY" ]; then npm config set https-proxy "$HTTPS_PROXY"; fi; \
      npm install -g opencode-ai @opencode-ai/plugin; \
      npm cache clean --force; \
      opencode --version; \
    else \
      echo "Skipping OpenCode install. Set OPENCODE_AUTO_INSTALL=true to include it in the image."; \
    fi

# Optional MCP smoke servers. Disabled by default to keep the runtime image small.
RUN if [ "$MCP_SMOKE_SERVERS_INSTALL" = "true" ]; then \
      npm install -g \
        @modelcontextprotocol/server-everything \
        @modelcontextprotocol/server-filesystem; \
    else \
      echo "Skipping MCP smoke server install. Set MCP_SMOKE_SERVERS_INSTALL=true to include it."; \
    fi

# Project-level OpenCode config.
# This is read when running OpenCode from /app.
RUN cat > /app/opencode.jsonc <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "${OPENCODE_DEFAULT_MODEL}",
  "small_model": "${OPENCODE_DEFAULT_SMALL_MODEL}",
  "permission": {
    "edit": "ask",
    "bash": "ask"
  }
}
EOF

# Minimal user-level OpenCode config.
# Keep it minimal to avoid user-level plugin dependency install surprises.
RUN cat > /home/openclaw/.config/opencode/opencode.jsonc <<EOF
{
  "\$schema": "https://opencode.ai/config.json"
}
EOF

RUN chown -R openclaw:openclaw /app /home/openclaw

ENV NODE_ENV=production \
    HOME=/home/openclaw \
    XDG_CONFIG_HOME=/home/openclaw/.config \
    XDG_STATE_HOME=/home/openclaw/.local/state \
    XDG_DATA_HOME=/home/openclaw/.local/share \
    XDG_CACHE_HOME=/home/openclaw/.cache \
    APP_ENV=production \
    LOG_LEVEL=info \
    APP_DATA_DIR=/data \
    SKILLS_DIR=/skills \
    WORKSPACE_DIR=/workspace \
    WORKFLOW_FILE=/workspace/WORKFLOW.md \
    TOOLS_DIR=/app/tools \
    MCP_CONFIG_PATH=/app/mcp_agent.config.yaml \
    MCP_AGENT_ENABLED=true \
    MCP_AGENT_CONFIG_PATH=/app/mcp_agent.config.yaml \
    MCP_AGENT_ALLOW_CONFIG_WRITE=true \
    STORAGE_BACKEND=file

COPY --chown=root:root entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Keep runtime entrypoint as root so it can repair bind-mount ownership,
# then entrypoint.sh drops to the non-root openclaw user with su-exec.
ENTRYPOINT ["/entrypoint.sh"]

VOLUME ["/data", "/skills", "/workspace"]

EXPOSE 18789 18790
