# native-openclaw

> Multi-provider AI agent terminal — native TypeScript, zero framework lock-in.

Runs a fully interactive chat REPL against any combination of Groq, Mistral, OpenRouter, OpenAI, Anthropic, Gemini, or a local Ollama server. Conversation history persists to disk as plain JSON. Skills are plain Markdown files with YAML frontmatter injected into every system prompt.

---

## Quick Start

```bash
git clone https://github.com/your-org/native-openclaw.git
cd native-openclaw
npm install

cp .env.example .env
$EDITOR .env   # add at least one API key

npm run dev    # development (no build)
# or
npm run build && npm start
```

---

## Requirements

| Tool | Version |
|------|---------|
| Node.js | >= 20.0.0 |
| npm | >= 10.0.0 |

---

## Providers

Set the appropriate key in `.env`. Multiple providers can be active simultaneously. Switch at runtime with `/provider <id>`.

| Provider | Env Variable | Notes |
|----------|-------------|-------|
| Groq | `GROQ_API_KEY` | Fastest inference |
| OpenRouter | `OPENROUTER_API_KEY` | 200+ models |
| Mistral | `MISTRAL_API_KEY` | EU-hosted |
| OpenAI | `OPENAI_API_KEY` | GPT-4o, o1 |
| Anthropic | `ANTHROPIC_API_KEY` | Claude |
| Gemini | `GEMINI_API_KEY` | Gemini 2.0 |
| Ollama | *(none)* | `OLLAMA_BASE_URL` default: `http://localhost:11434` |

---

## CLI Commands

Type `/help` inside the REPL to see all commands.

| Command | Description |
|---------|-------------|
| `/help` | Show command reference |
| `/models [provider]` | List all models, or filter by provider |
| `/skills` | Show registered skills and status |
| `/skills on <id>` | Activate a skill |
| `/skills off <id>` | Deactivate a skill |
| `/session` | Show current session info |
| `/session new` | Start a fresh session |
| `/session list` | List all saved sessions |
| `/session <id>` | Resume a session by partial ID |
| `/provider` | Show current + all available providers |
| `/provider <id>` | Switch provider |
| `/exit` | Quit |

---

## Web UI (smooth)

`smooth` is an optional lightweight Web Chat UI (vanilla HTML/CSS/JS) that shares the same orchestrator pipeline as the CLI and HTTP API.

Enable in `.env`:

```env
WEB_UI_ENABLED=true
WEB_UI_HOST=0.0.0.0
WEB_UI_PORT=18790
WEB_UI_USERNAME=admin
WEB_UI_PASSWORD=change-me
WEB_UI_SESSION_SECRET=change-this-secret
```

Run `npm start`, then open `http://localhost:18790`.

### Puter Provider Mode

Puter.ai can be used as the preferred model provider for Web UI requests while keeping all orchestration (tools, memory, scheduler, self-healing) on the backend.

```env
PUTER_ENABLED=true
PUTER_API_KEY=
PUTER_BASE_URL=
PUTER_DEFAULT_MODEL=gpt-5.5
PUTER_DISABLE_TEMPERATURE=true   # some Puter models reject custom temperature

WEB_UI_PUTER_ENABLED=true
WEB_UI_PUTER_PROVIDER_ID=puter
WEB_UI_PUTER_DEFAULT_MODEL=gpt-5-nano
```

**Notes:**
- CLI, Telegram, and direct API clients are unaffected unless they explicitly pass `preferredProvider=puter`.
- If Puter fails, ProviderRouter falls back to normal backend providers.
- Direct frontend Puter.js final-answer mode is not supported (it bypasses orchestration).
- To opt in to temperature on a supported model: set `PUTER_DISABLE_TEMPERATURE=false` and `PUTER_TEMPERATURE=0.2`.

---

## OpenCode Agent Tool

OpenCode is an optional external coding agent — not a general chat fallback provider.

**Use cases:** self-healing patch generation, self-upgrade, code review, coding task analysis.

### Setup

```bash
# Manual auth
opencode run /connect

# Or bootstrap via .env
OPENCODE_AUTH_BOOTSTRAP=true
OPENCODE_ZEN_API_KEY=your_key_here
OPENCODE_AUTH_PROVIDER=opencode   # must be "opencode", not "opencode-zen"
```

### Core Config

```env
OPENCODE_AGENT_ENABLED=true
OPENCODE_AGENT_COMMAND=opencode
OPENCODE_AGENT_DIRECT_MODE=true
OPENCODE_AGENT_INJECT_SAFETY_PREAMBLE=false
OPENCODE_AGENT_ARGS_TEMPLATE=run --dangerously-skip-permissions "{{task}}"
OPENCODE_AGENT_TIMEOUT_MS=900000
OPENCODE_AGENT_IDLE_TIMEOUT_MS=0    # disable idle timer in direct mode
OPENCODE_AGENT_KILL_GRACE_MS=10000
OPENCODE_AGENT_KILL_TREE=true
OPENCODE_AGENT_USE_FOR_SELF_HEALING=true
OPENCODE_AGENT_USE_FOR_SELF_UPGRADE=true
```

> **Warning:** `--dangerously-skip-permissions` auto-approves all OpenCode permissions. Use only in trusted environments. For safer mode: `OPENCODE_AGENT_ARGS_TEMPLATE=run "{{task}}"`.

### Model Config (`opencode.jsonc`)

```jsonc
{
  "$schema": "https://opencode.ai",
  "model": "opencode/deepseek-v4-flash-free",
  "small_model": "opencode/mimo-v2.5-free",
  "permission": { "edit": "ask", "bash": "ask" }
}
```

> Use prefix `opencode/`, **not** `opencode-zen/`. Common error: `Model not found: opencode-zen/...`.

### Working Directory

`OPENCODE_AGENT_CWD` is optional. When empty, smooth auto-detects the project root by scanning upward for `package.json`, `tsconfig.json`, `src/`, `dist/`, `workspace/`, or `skills/`. In Docker (`WORKDIR /app`) this typically resolves to `/app`.

Manual override: `OPENCODE_AGENT_CWD=/app`

Windows: if `opencode --version` works but smooth logs `spawn opencode ENOENT`, set:
```env
OPENCODE_AGENT_COMMAND=opencode.cmd
```

### Auto Install

Preferred: `npm install -g opencode-ai`

Or let smooth install it:
```env
OPENCODE_AUTO_INSTALL=true
OPENCODE_INSTALL_STRATEGY=npm-global
OPENCODE_INSTALL_REQUIRE_APPROVAL=true
```

In Docker, install in the Dockerfile instead (runtime auto-install does not persist across rebuilds):
```dockerfile
RUN npm install -g opencode-ai
```

### Diagnostics

```bash
/opencode doctor
/opencode doctor --smoke
opencode run "hello"   # smoke test
```

Checklist:
- `Args preview` should include `run` and `--dangerously-skip-permissions`
- `Args template` must **not** contain `--prompt` (use positional args)
- `Auth provider` should be `opencode`

---

## Skills

Skills are Markdown files in `skills/`. They are parsed at startup and injected into every system prompt.

### Frontmatter Schema

```yaml
---
name: Code Reviewer        # required
description: Reviews code  # required
version: 1.0.0
tags: [coding, review]
priority: 10               # higher = injected first (default: 0)
enabled: true
---

Markdown body injected verbatim into the system prompt.
```

### Example

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
│   ├── index.ts               # Bootstrap entry point
│   ├── cli/
│   │   ├── index.ts           # Interactive REPL loop
│   │   └── commands.ts        # Slash-command handlers
│   ├── agents/
│   │   ├── orchestrator.ts    # Turn loop: input -> provider -> persist
│   │   ├── prompt-builder.ts  # System prompt + skill injection
│   │   └── message-assembler.ts  # Sliding-window context prep
│   ├── providers/
│   │   ├── base.ts            # Shared fetch + OpenAI-compat logic
│   │   ├── groq.ts
│   │   ├── mistral.ts
│   │   ├── openrouter.ts
│   │   └── ollama.ts
│   ├── skills/
│   │   ├── parser.ts          # YAML frontmatter parser (zero deps)
│   │   ├── loader.ts          # Scan /skills dir
│   │   └── registry.ts        # In-memory registry + activation
│   ├── storage/
│   │   ├── json-store.ts      # Atomic JSON collection + KV store
│   │   └── session-manager.ts # Session CRUD
│   ├── config/
│   │   ├── env.ts             # dotenv loader + typed accessors
│   │   └── validator.ts       # Zod config schema
│   ├── types/
│   │   ├── global.ts          # JsonValue, Result<T,E>
│   │   ├── message.ts         # Message schema (Zod)
│   │   └── provider.ts        # IProvider interface
│   └── utils/
│       ├── logger.ts          # Namespaced structured logger
│       └── helpers.ts         # ID gen, safe JSON read/write
├── skills/                    # Drop .md skill files here
├── data/                      # Auto-created: sessions, settings
├── Dockerfile
├── docker-compose.yml
├── package.sh                 # Build + zip packaging script
└── .env.example
```

---

## Docker

Docker Compose is the recommended deployment mode — it keeps `data`, `skills`, and `workspace` persistent on the host.

### Deployment Steps

**1. Prepare persistent folders**

```bash
sudo mkdir -p data skills workspace
sudo chmod -R 775 data skills workspace
```

| Host path | Container path | Purpose |
|-----------|----------------|---------|
| `./data` | `/data` | Sessions, settings, MCP config |
| `./skills` | `/skills` | Markdown skills |
| `./workspace` | `/workspace` | Memory, workflow, artifacts |

**2. Configure `.env`**

```bash
cp .env.example .env && nano .env
```

Minimum production values:

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

WEB_UI_ENABLED=false
WEB_UI_PORT=18790
WEB_UI_USERNAME=admin
WEB_UI_PASSWORD=change-me
WEB_UI_SESSION_SECRET=change-this-secret

# Proxy — leave empty if not required
HTTP_PROXY=
HTTPS_PROXY=
NO_PROXY=localhost,127.0.0.1,::1,openclaw,ollama,host.docker.internal

# Provider keys — fill only what you use
GROQ_API_KEY=
OPENROUTER_API_KEY=
MISTRAL_API_KEY=
GEMINI_API_KEY=
ZAI_API_KEY=
ZAI_BASE_URL=https://api.z.ai/api/paas/v4
ZAI_MODEL=glm-4.5

OLLAMA_BASE_URL=http://host.docker.internal:11434

# Optional integrations
TAVILY_API_KEY=
TELEGRAM_ENABLED=false
TELEGRAM_BOT_TOKEN=
BREVO_API_KEY=
```

> Never commit `.env`: `echo ".env" >> .gitignore`

**3. Fix bind-mount permissions**

```bash
docker compose run --rm --entrypoint id openclaw
# example output: uid=100(openclaw) gid=101(openclaw)
sudo chown -R 100:101 data skills workspace
```

On SELinux servers, add `:Z` to volume mounts in `docker-compose.yml`.

**4. Build and start**

```bash
docker compose build --no-cache
docker compose up -d
docker compose ps         # check status
docker compose logs -f openclaw
```

**5. Access the CLI**

```bash
docker attach native-openclaw
# Detach without stopping: Ctrl+P, then Ctrl+Q
# Do NOT use Ctrl+C — it stops the Node process
```

**6. Test the HTTP API**

```bash
curl -X POST "http://127.0.0.1:18789/native-openclaw/v1/chat" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_token" \
  -d '{"message":"halo"}'
```

Expected response:

```json
{
  "model": "glm-4.5",
  "provider": "zai",
  "result": "...",
  "sessionId": "...",
  "responseTime": "1234 ms"
}
```

### Docker Compose Example

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

    image: native-openclaw:latest
    container_name: native-openclaw
    stdin_open: true
    tty: true

    env_file: .env

    environment:
      APP_ENV: production
      NODE_ENV: production
      APP_DATA_DIR: /data
      SKILLS_DIR: /skills
      WORKSPACE_DIR: /workspace
      API_HOST: ${API_HOST:-0.0.0.0}
      API_PORT: ${API_PORT:-18789}
      OLLAMA_BASE_URL: ${OLLAMA_BASE_URL:-http://host.docker.internal:11434}

    volumes:
      - ./data:/data:Z
      - ./skills:/skills:Z
      - ./workspace:/workspace:Z

    ports:
      - "${API_PORT:-18789}:18789"
      - "${WEB_UI_PORT:-18790}:18790"

    extra_hosts:
      - "host.docker.internal:host-gateway"

    restart: unless-stopped
```

### Common Docker Operations

```bash
docker compose up -d                    # Start
docker compose down                     # Stop
docker compose restart openclaw         # Restart service
docker compose build --no-cache && docker compose up -d  # Rebuild
docker compose logs -f openclaw         # Logs
docker compose exec openclaw sh         # Shell access
docker attach native-openclaw           # Attach to CLI
```

### Self-Upgrade Auto Restart

When `SELF_UPGRADE_AUTO_RESTART=true`, a successful self-upgrade exits with code `42` after writing a run report. Docker Compose `restart: unless-stopped` handles the restart automatically.

Disable:
```env
SELF_UPGRADE_AUTO_RESTART=false
AUTONOMOUS_RESTART_MODE=disabled
```

To receive notifications before restart (useful when running with `npm start` without a supervisor):

```env
RESTART_NOTIFICATION_ENABLED=true
RESTART_NOTIFY_TELEGRAM=true
RESTART_NOTIFY_EMAIL=true
RESTART_EMAIL_RECIPIENT=you@example.com
```

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Run with ts-node (no build) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled output |
| `npm run type-check` | Type-check without emitting |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run clean` | Remove `dist/` |
| `bash package.sh` | Build + zip for distribution |

---

## Environment Variables

Copy `.env.example` to `.env`.

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
| `AGENT_TEMPERATURE` | `0.7` | Default temperature (0–2) |
| `AGENT_MAX_TOKENS` | `4096` | Default max output tokens |
| `AGENT_SYSTEM_PROMPT` | `You are a helpful AI assistant.` | Base system prompt |

### Skills

| Variable | Default | Description |
|----------|---------|-------------|
| `SKILLS_DIR` | `<cwd>/skills` | Path to skills directory |

---

## Storage

Sessions persist as plain JSON in `APP_DATA_DIR` (default: `.data/`).

```
.data/
└── sessions.json   # All session records (history, provider/model, active skills)
```

- `/session list` — browse sessions
- `/session <id>` — resume by partial ID
- `/session new` — start fresh

---

## Architecture

```
User input
    │
    ▼
 CLI REPL  ──/command──▶  Command handlers
    │
    │ message
    ▼
 Orchestrator
    ├── PromptBuilder    ← base prompt + active skill blocks
    └── MessageAssembler ← sliding window, strip system messages
    │
    ▼
 IProvider.chat()        ← groq / mistral / openrouter / ollama / ...
    │
    ▼
 SessionManager.appendMessage()  ← JSON file on disk
    │
    ▼
 Print reply to terminal
```

---

## Troubleshooting

### OpenCode: `Model not found: opencode-zen/...`

Use the `opencode/` prefix, not `opencode-zen/`:

```jsonc
"model": "opencode/deepseek-v4-flash-free"
```

### OpenCode: `Unexpected server error` or auth error

```bash
opencode run /connect
```

Or set in `.env`:
```env
OPENCODE_AUTH_BOOTSTRAP=true
OPENCODE_ZEN_API_KEY=your_key_here
OPENCODE_AUTH_PROVIDER=opencode
```

### OpenCode hangs

Enable timeouts:
```env
OPENCODE_AGENT_TIMEOUT_MS=900000
OPENCODE_AGENT_KILL_GRACE_MS=10000
OPENCODE_AGENT_KILL_TREE=true
```

Windows — check and kill hanging process:
```powershell
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "opencode" }
taskkill /PID <PID> /T /F
```

### Windows: `spawn opencode ENOENT`

```env
OPENCODE_AGENT_COMMAND=opencode.cmd
```

### Docker: `EACCES: permission denied, mkdir '/workspace/state'`

```bash
docker compose down
sudo mkdir -p data skills workspace
sudo chmod -R 775 data skills workspace
docker compose run --rm --entrypoint id openclaw
sudo chown -R 100:101 data skills workspace   # replace with actual UID:GID
docker compose up -d
```

On SELinux: use `:Z` or `:z` on volume definitions.

### Docker: `.env not found` warning

Safe to ignore when using `env_file` in Compose — variables are injected into `process.env`, the file is not copied to `/app/.env`. To suppress the warning, mount it explicitly:

```yaml
volumes:
  - ./.env:/app/.env:ro,Z
```

Verify variables are loaded:
```bash
docker compose exec openclaw env | grep -E "API|GROQ|WORKSPACE"
```

### Docker: `curl: (56) Recv failure: Connection reset by peer`

Common causes: container still restarting, API not listening on `0.0.0.0`, runtime crash.

Check:
```bash
docker compose ps
docker compose logs --tail=100 openclaw
docker compose exec openclaw env | grep -E "API_ENABLED|API_HOST|API_PORT"
```

Ensure `.env`:
```env
API_ENABLED=true
API_HOST=0.0.0.0
API_PORT=18789
```

### Docker: Provider returns `fetch failed`

Usually a proxy or network issue, not the API key.

```bash
# Test proxy from host
curl -x "http://IP:port" -I https://api.z.ai/api/paas/v4/models

# Check proxy inside container
docker compose exec openclaw env | grep -Ei "HTTP_PROXY|HTTPS_PROXY|NO_PROXY"

# Retry chat directly
curl -X POST "http://127.0.0.1:18789/native-openclaw/v1/chat" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer xxx" \
  -d '{"message":"halo"}'
```

A `401` from the proxy means the path works — check the API key. Startup logs should show `Global HTTP proxy enabled`.

### Docker: API returns `401 Unauthorized`

Ensure `API_AUTH_TOKEN` in `.env` matches the `Authorization: Bearer` header in your request.

### Docker: Cannot access host folders (e.g. Downloads)

The container only sees mounted paths. Add a bind mount:

```yaml
volumes:
  - /home/user/Downloads:/host/Downloads:ro,Z
```

Then ask the agent to use `/host/Downloads`.

### Self-upgrade restart: container stays stopped after exit

If started with `npm start` (no supervisor), restart manually:

```bash
npm start
# or
docker compose up -d
pm2 restart smooth
```

Use `restart: unless-stopped` in Docker Compose for automatic recovery.

---

## License

MIT