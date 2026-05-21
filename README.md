# native-openclaw

> Multi-provider AI agent terminal — native TypeScript, zero framework lock-in.

Runs a fully interactive chat REPL against any combination of Groq, Mistral,
OpenRouter, OpenAI, Anthropic, Gemini, or a local Ollama server.
Conversation history persists to disk as plain JSON. Skills are plain Markdown
files with YAML frontmatter injected into every system prompt.

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/your-org/native-openclaw.git
cd native-openclaw
npm install

# 2. Configure
cp .env.example .env
$EDITOR .env          # add at least one API key

# 3. Run (development)
npm run dev

# 4. Or build + run
npm run build
npm start
```

---

## Requirements

| Tool | Version |
|------|---------|
| Node.js | >= 20.0.0 |
| npm | >= 10.0.0 |

---

## Providers

Set the appropriate environment variables in `.env`:

| Provider | Key variable | Notes |
|----------|-------------|-------|
| **Groq** | `GROQ_API_KEY` | Fastest inference |
| **OpenRouter** | `OPENROUTER_API_KEY` | 200+ models |
| **Mistral** | `MISTRAL_API_KEY` | EU-hosted |
| **OpenAI** | `OPENAI_API_KEY` | GPT-4o, o1 |
| **Anthropic** | `ANTHROPIC_API_KEY` | Claude |
| **Gemini** | `GEMINI_API_KEY` | Gemini 2.0 |
| **Ollama** | *(none)* | `OLLAMA_BASE_URL` default: `http://localhost:11434` |

Multiple providers can be active simultaneously. Switch between them at runtime
with `/provider <id>`.

---

## CLI Commands

Once the REPL is running, type `/help` to see all commands.

| Command | Description |
|---------|-------------|
| `/help` | Show command reference |
| `/models` | List all models across all providers |
| `/models <provider>` | List models for one provider |
| `/skills` | Show registered skills and status |
| `/skills on <id>` | Activate a skill |
| `/skills off <id>` | Deactivate a skill |
| `/session` | Show current session info |
| `/session new` | Start a fresh session |
| `/session list` | List all saved sessions |
| `/session <id>` | Resume a session by partial ID |
| `/provider` | Show current provider + all available |
| `/provider <id>` | Switch to a different provider |
| `/exit` | Quit |

---

## Skills

Skills are plain Markdown files placed in the `skills/` directory. They are
parsed at startup and injected into the system prompt.

### Frontmatter schema

```yaml
---
name: Code Reviewer          # Display name (required)
description: Reviews code    # One-line description (required)
version: 1.0.0               # Semver
tags: [coding, review]       # Arbitrary tags
priority: 10                 # Higher = injected first (default: 0)
enabled: true                # Set to false to disable without deleting
---

Markdown body here.
Everything below the closing --- is injected verbatim into the system prompt.
```

### Example skill

```markdown
---
name: Concise Responder
description: Always responds concisely and in bullet points
priority: 5
enabled: true
---

## Rules
- Keep every response under 150 words.
- Prefer bullet points over prose.
- Skip preambles and sign-offs.
```

---

## Project Structure

```
native-openclaw/
├── src/
│   ├── index.ts              # Bootstrap entry point
│   ├── cli/
│   │   ├── index.ts          # Interactive REPL loop
│   │   └── commands.ts       # Slash-command handlers
│   ├── agents/
│   │   ├── orchestrator.ts   # Turn loop: input -> provider -> persist
│   │   ├── prompt-builder.ts # System prompt + skill injection
│   │   └── message-assembler.ts  # Sliding-window context prep
│   ├── providers/
│   │   ├── base.ts           # Shared fetch + OpenAI-compat logic
│   │   ├── groq.ts
│   │   ├── mistral.ts
│   │   ├── openrouter.ts
│   │   └── ollama.ts
│   ├── skills/
│   │   ├── parser.ts         # YAML frontmatter parser (zero deps)
│   │   ├── loader.ts         # Scan /skills dir
│   │   └── registry.ts       # In-memory registry + activation
│   ├── storage/
│   │   ├── json-store.ts     # Atomic JSON collection + KV store
│   │   └── session-manager.ts # Session CRUD
│   ├── config/
│   │   ├── env.ts            # dotenv loader + typed accessors
│   │   └── validator.ts      # Zod config schema
│   ├── types/
│   │   ├── global.ts         # JsonValue, Result<T,E>
│   │   ├── message.ts        # Message schema (Zod)
│   │   └── provider.ts       # IProvider interface
│   └── utils/
│       ├── logger.ts         # Namespaced structured logger
│       └── helpers.ts        # ID gen, safe JSON read/write
├── skills/                   # Drop .md skill files here
├── data/                     # Auto-created: sessions, settings
├── Dockerfile
├── docker-compose.yml
├── package.sh                # Build + zip packaging script
└── .env.example
```

---

## Docker

Native OpenClaw can run in Docker or Docker Compose. Docker Compose is the
recommended mode for server deployment because it keeps `data`, `skills`, and
`workspace` persistent on the host.

### Docker Compose deployment

#### 1. Prepare project directory

```bash
cd /path/to/native-openclaw
```

Make sure these files exist:

```bash
ls -la
```

Expected minimum files:

```text
Dockerfile
docker-compose.yml
package.json
package-lock.json
src/
tools/
skills/
workspace/
```

#### 2. Create persistent folders

These folders are bind-mounted into the container:

```bash
sudo mkdir -p data skills workspace
sudo chmod -R 775 data skills workspace
```

Purpose:

| Host path | Container path | Purpose |
|-----------|----------------|---------|
| `./data` | `/data` | Sessions, settings, MCP config, JSON storage |
| `./skills` | `/skills` | Markdown skills |
| `./workspace` | `/workspace` | Memory, workflow, reports, artifacts, workspace state |

#### 3. Create and configure `.env`

```bash
cp .env.example .env
nano .env
```

Minimum recommended values:

```env
APP_ENV=production
NODE_ENV=production
LOG_LEVEL=info

APP_DATA_DIR=/data
SKILLS_DIR=/skills
WORKSPACE_DIR=/workspace
WORKFLOW_FILE=/workspace/WORKFLOW.md
TOOLS_DIR=/app/tools
MCP_CONFIG_PATH=/data/mcp.json
STORAGE_BACKEND=file

API_ENABLED=true
API_HOST=0.0.0.0
API_PORT=18789
API_AUTH_TOKEN=change_this_token

# Proxy, only if your server requires proxy access.
HTTP_PROXY=http://IP:port
HTTPS_PROXY=http://IP:port
NO_PROXY=localhost,127.0.0.1,::1,openclaw,ollama,host.docker.internal,.local,.internal

# Provider keys, fill only what you use.
GROQ_API_KEY=
OPENROUTER_API_KEY=
MISTRAL_API_KEY=
GEMINI_API_KEY=
SAMBANOVA_API_KEY=
ZAI_API_KEY=
ZAI_BASE_URL=https://api.z.ai/api/paas/v4
ZAI_MODEL=glm-4.5

# Browsing / workflow tools.
TAVILY_API_KEY=
FIRECRAWL_API_KEY=

# Brevo email, optional.
BREVO_API_KEY=
BREVO_SENDER_EMAIL=
BREVO_SENDER_NAME=Native OpenClaw
BREVO_RECIPIENT_EMAIL=
BREVO_RECIPIENT_NAME=

# Telegram, optional.
TELEGRAM_ENABLED=false
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_CHAT_IDS=

# Ollama running on host machine.
OLLAMA_BASE_URL=http://host.docker.internal:11434

SYSTEM_EXECUTE_ENABLED=true
SYSTEM_EXECUTE_TIMEOUT=30000
SYSTEM_EXECUTE_DEFAULT_CWD=workspace
```

If the server does not require proxy, leave proxy variables empty:

```env
HTTP_PROXY=
HTTPS_PROXY=
NO_PROXY=localhost,127.0.0.1,::1,openclaw,ollama,host.docker.internal
```

Do not commit `.env` because it contains API keys and proxy credentials.

```bash
echo ".env" >> .gitignore
```

#### 4. Fix bind-mount permissions

The container may run as a non-root user. Check the container UID/GID:

```bash
docker compose run --rm --entrypoint id openclaw
```

Example output:

```text
uid=100(openclaw) gid=101(openclaw) groups=101(openclaw)
```

Then apply ownership on the host folders using the returned UID/GID:

```bash
sudo chown -R 100:101 data skills workspace
```

If your UID/GID is different, replace `100:101` with the actual value from the
`id` command.

On SELinux-based servers, use `:Z` or `:z` on bind mounts in
`docker-compose.yml`:

```yaml
volumes:
  - ./data:/data:Z
  - ./skills:/skills:Z
  - ./workspace:/workspace:Z
```

Use `:Z` for a private container mount. Use `:z` only if multiple containers
need to share the same mounted folder.

#### 5. Build the image

```bash
docker compose build --no-cache
```

If the server is behind a proxy, make sure `HTTP_PROXY`, `HTTPS_PROXY`, and
`NO_PROXY` exist in `.env`. The Compose file should pass those variables to both
`build.args` and runtime `environment`.

#### 6. Start the container

```bash
docker compose up -d
```

Check status:

```bash
docker compose ps
```

Expected status:

```text
native-openclaw   Up
```

Follow logs:

```bash
docker compose logs -f openclaw
```

#### 7. Enter the interactive CLI

Because the service is configured with `stdin_open: true` and `tty: true`, attach
to the running container:

```bash
docker attach native-openclaw
```

Try:

```text
/help
/providers
/models
/session list
/workspace info
/tools
```

To detach without stopping the container, press:

```text
Ctrl + P, then Ctrl + Q
```

Do not use `Ctrl+C` inside `docker attach` unless you intend to stop the Node
process.

#### 8. Test the HTTP API

If `API_ENABLED=true` and `API_HOST=0.0.0.0`, test from the Docker host:

```bash
curl -X POST "http://127.0.0.1:18789/native-openclaw/v1/chat"   -H "Content-Type: application/json"   -H "Authorization: Bearer xxx"   -d '{"message":"halo"}'
```

Expected response shape:

```json
{
  "model": "glm-4.5",
  "provider": "zai",
  "result": "Halo, saya Jarpis...",
  "token": null,
  "responseTime": "1234 ms",
  "tools": [],
  "flow": [],
  "sessionId": "...",
  "error_detail": []
}
```

### Docker Compose example

A typical production Compose file should keep secrets in `.env`, not hardcoded
inside `docker-compose.yml`.

```yaml
version: "3.9"

services:
  openclaw:
    build:
      context: .
      dockerfile: Dockerfile
      target: runtime
      args:
        HTTP_PROXY: ${HTTP_PROXY:-}
        HTTPS_PROXY: ${HTTPS_PROXY:-}
        NO_PROXY: ${NO_PROXY:-}
        http_proxy: ${HTTP_PROXY:-}
        https_proxy: ${HTTPS_PROXY:-}
        no_proxy: ${NO_PROXY:-}

    image: native-openclaw:latest
    container_name: native-openclaw

    stdin_open: true
    tty: true

    env_file:
      - .env

    environment:
      APP_ENV: production
      NODE_ENV: production
      LOG_LEVEL: ${LOG_LEVEL:-info}

      APP_DATA_DIR: /data
      SKILLS_DIR: /skills
      WORKSPACE_DIR: /workspace
      WORKFLOW_FILE: /workspace/WORKFLOW.md
      TOOLS_DIR: /app/tools
      MCP_CONFIG_PATH: /data/mcp.json
      STORAGE_BACKEND: file

      API_HOST: ${API_HOST:-0.0.0.0}
      API_PORT: ${API_PORT:-18789}

      HTTP_PROXY: ${HTTP_PROXY:-}
      HTTPS_PROXY: ${HTTPS_PROXY:-}
      NO_PROXY: ${NO_PROXY:-localhost,127.0.0.1,::1,openclaw,ollama,host.docker.internal}
      http_proxy: ${HTTP_PROXY:-}
      https_proxy: ${HTTPS_PROXY:-}
      no_proxy: ${NO_PROXY:-localhost,127.0.0.1,::1,openclaw,ollama,host.docker.internal}

      npm_config_proxy: ${HTTP_PROXY:-}
      npm_config_https_proxy: ${HTTPS_PROXY:-}
      npm_config_noproxy: ${NO_PROXY:-localhost,127.0.0.1,::1,openclaw,ollama,host.docker.internal}

      OLLAMA_BASE_URL: ${OLLAMA_BASE_URL:-http://host.docker.internal:11434}

    volumes:
      - ./data:/data:Z
      - ./skills:/skills:Z
      - ./workspace:/workspace:Z

    ports:
      - "${API_PORT:-18789}:18789"

    extra_hosts:
      - "host.docker.internal:host-gateway"

    restart: unless-stopped
```

If your server does not use SELinux, the volume suffix can be removed:

```yaml
volumes:
  - ./data:/data
  - ./skills:/skills
  - ./workspace:/workspace
```

### Docker Compose operations

```bash
# Start
docker compose up -d

# Stop
docker compose down

# Restart only Native OpenClaw
docker compose restart openclaw

# Rebuild after code changes
docker compose down
docker compose build --no-cache
docker compose up -d

# Logs
docker compose logs -f openclaw

# Enter shell
docker compose exec openclaw sh

# Attach to CLI
docker attach native-openclaw
```

### Proxy validation

Validate that proxy variables are visible inside the container:

```bash
docker compose exec openclaw env | grep -Ei "HTTP_PROXY|HTTPS_PROXY|NO_PROXY"
```

Test Z.ai through the proxy from the host:

```bash
curl -x "http://IP:port"   -H "Authorization: Bearer <ZAI_API_KEY>"   https://api.z.ai/api/paas/v4/models
```

If this succeeds but provider calls inside Native OpenClaw return `fetch failed`,
ensure the app initializes global Node.js proxy support before providers are
created. The startup log should show a message similar to:

```text
Global HTTP proxy enabled
```

### Optional: Ollama sidecar

If you want Ollama to run inside Docker as well, add or uncomment an `ollama`
service, then set:

```env
OLLAMA_BASE_URL=http://ollama:11434
```

Example commands:

```bash
docker compose up -d ollama
docker compose exec ollama ollama pull llama3.3
docker compose restart openclaw
```

### Troubleshooting Docker Compose

#### `EACCES: permission denied, mkdir '/workspace/state'`

The container cannot write to the bind-mounted workspace folder.

Fix:

```bash
docker compose down
sudo mkdir -p data skills workspace
sudo chmod -R 775 data skills workspace
docker compose run --rm --entrypoint id openclaw
sudo chown -R 100:101 data skills workspace
docker compose up -d
```

Replace `100:101` with the UID/GID returned by:

```bash
docker compose run --rm --entrypoint id openclaw
```

On SELinux servers, also use `:Z` or `:z` in the volume definitions.

#### `[env] Warning: .env not found at /app/.env. Falling back to process.env.`

This is usually safe when using:

```yaml
env_file:
  - .env
```

`env_file` injects variables into `process.env`; it does not copy `.env` to
`/app/.env`.

To verify variables are loaded:

```bash
docker compose exec openclaw env | grep -E "API|GROQ|ZAI|WORKSPACE|HTTP_PROXY|HTTPS_PROXY"
```

If you want to remove the warning, mount `.env` read-only:

```yaml
volumes:
  - ./.env:/app/.env:ro,Z
  - ./data:/data:Z
  - ./skills:/skills:Z
  - ./workspace:/workspace:Z
```

#### `curl: (56) Recv failure: Connection reset by peer`

Most common causes:

1. Container is still restarting.
2. API server is not listening on `0.0.0.0`.
3. Runtime crash inside API handler.

Check:

```bash
docker compose ps
docker compose logs --tail=100 openclaw
docker compose exec openclaw env | grep -E "API_ENABLED|API_HOST|API_PORT"
```

Make sure `.env` contains:

```env
API_ENABLED=true
API_HOST=0.0.0.0
API_PORT=18789
```

#### Provider returns `fetch failed`

If every provider fails, this is usually outbound network/proxy, not API key.

Check proxy from host:

```bash
curl -x "http://IP:port" -I https://api.z.ai/api/paas/v4/models
```

A response such as `HTTP/1.1 200 Connection established` followed by `401` means
the proxy path works, but the request needs API authorization.

Check proxy inside container:

```bash
docker compose exec openclaw env | grep -Ei "HTTP_PROXY|HTTPS_PROXY|NO_PROXY"
```

Then retry chat through the API:

```bash
curl -X POST "http://127.0.0.1:18789/native-openclaw/v1/chat"   -H "Content-Type: application/json"   -H "Authorization: Bearer xxx"   -d '{"message":"halo"}'
```

#### API returns `401 Unauthorized`

Check the API token:

```env
API_AUTH_TOKEN=your_token
```

Curl must include the same value:

```bash
-H "Authorization: Bearer your_token"
```

#### Cannot access host folders such as Downloads

The container only sees folders mounted into it. Add a bind mount if the agent
needs to read a host folder.

Linux example:

```yaml
volumes:
  - ./data:/data:Z
  - ./skills:/skills:Z
  - ./workspace:/workspace:Z
  - /home/bayu.salman/Downloads:/host/Downloads:ro,Z
```

Then ask the agent to use:

```text
/host/Downloads
```

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Run with ts-node (no build step) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled output |
| `npm run type-check` | Type-check without emitting |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run clean` | Remove `dist/` |
| `bash package.sh` | Build + zip for distribution |

---

## Environment Variables

Copy `.env.example` to `.env` and fill in values.

### App

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_ENV` | `development` | `development`, `production`, or `test` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `APP_DATA_DIR` | `.data` | Storage directory for sessions |
| `STORAGE_BACKEND` | `file` | `file` or `memory` |

### Agent

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_MAX_TURNS` | `20` | Max conversation turns per session |
| `AGENT_TEMPERATURE` | `0.7` | Default temperature (0-2) |
| `AGENT_MAX_TOKENS` | `4096` | Default max output tokens |
| `AGENT_SYSTEM_PROMPT` | `You are a helpful AI assistant.` | Base system prompt |

### Skills

| Variable | Default | Description |
|----------|---------|-------------|
| `SKILLS_DIR` | `<cwd>/skills` | Path to skills directory |

---

## Storage

Sessions are stored as plain JSON files in `APP_DATA_DIR` (default: `.data/`).

```
.data/
└── sessions.json    # All session records
```

Each session contains the full message history, provider/model info, active
skill IDs, and timestamps. Sessions persist across restarts.

Use `/session list` to browse, `/session <id>` to resume, and `/session new`
to start fresh.

---

## Architecture

```
User input
    |
    v
 CLI REPL  --/command-->  Command handlers
    |
    | message
    v
 Orchestrator
    |-- PromptBuilder    <- base prompt + active skill blocks
    |-- MessageAssembler <- sliding window, strip system messages
    |
    v
 IProvider.chat()        <- groq / mistral / openrouter / ollama / ...
    |
    v
 SessionManager.appendMessage()   <- JSON file on disk
    |
    v
 Print reply to terminal
```

---

## License

MIT
