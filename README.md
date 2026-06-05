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

## Web UI

Native OpenClaw includes `smooth`, an optional lightweight Web Chat UI. It uses
vanilla HTML/CSS/JS, a signed HTTP-only cookie, and the same orchestrator
pipeline as the CLI and HTTP API.

`smooth` is an autonomous AI agent console designed to make workflows feel
effortless. The name means smooth, mulus, and lancar, while preserving the
ant-inspired philosophy of hard work, persistence, collaboration, and
intelligent automation.

Tagline:

```text
Make your life easier
```

Enable it in `.env`:

```env
WEB_UI_ENABLED=true
WEB_UI_HOST=0.0.0.0
WEB_UI_PORT=18790
WEB_UI_USERNAME=admin
WEB_UI_PASSWORD=change-me
WEB_UI_SESSION_SECRET=change-this-secret
```

Run:

```bash
npm start
```

Open:

```text
http://localhost:18790
```

Login using the username/password from `.env`. The UI is optional; when
`WEB_UI_ENABLED=false`, no Web UI listener is started.

For Docker Compose, expose the port when needed:

```yaml
ports:
  - "${API_PORT:-18789}:18789"
  - "${WEB_UI_PORT:-18790}:18790"
```

### Web UI Puter Provider Mode

Puter.ai can be configured as the preferred model provider for Web UI requests.
The Web UI still sends every message to the smooth backend, so the orchestrator,
prompt optimizer, reasoning engine, tool-loop, tools, memory, scheduler,
self-healing, self-upgrade, and ProviderRouter fallback all remain available.

```env
PUTER_ENABLED=true
PUTER_API_KEY=
PUTER_BASE_URL=
PUTER_DEFAULT_MODEL=gpt-5.5
PUTER_DISABLE_TEMPERATURE=true
PUTER_TEMPERATURE=
PUTER_REASONING_MODELS_DISABLE_TEMPERATURE=true

WEB_UI_PUTER_ENABLED=true
WEB_UI_PUTER_PROVIDER_ID=puter
WEB_UI_PUTER_DEFAULT_MODEL=gpt-5-nano
```

Behavior:

- Web UI requests include `preferredProvider=puter` and the configured model.
- Puter is used through the backend ProviderRouter when the backend provider is
  registered.
- If Puter is unavailable or fails, ProviderRouter can fall back to the normal
  backend providers.
- CLI, Telegram, and direct API clients remain unaffected unless they explicitly
  pass a preferred provider.

Direct frontend Puter.js final-answer mode is not supported because it bypasses
Native OpenClaw tools and orchestration.

Some Puter models, including GPT-5-style reasoning models, reject custom
temperature values. By default, smooth omits temperature for Puter requests:

```env
PUTER_DISABLE_TEMPERATURE=true
```

If you know a Puter model supports temperature, opt in explicitly:

```env
PUTER_DISABLE_TEMPERATURE=false
PUTER_TEMPERATURE=0.2
```

---

## OpenCode Agent Tool

OpenCode can be integrated as an optional external coding agent tool. It is not
a normal LLM provider and is not used as general chat fallback.

Example:

```env
OPENCODE_AGENT_ENABLED=true
OPENCODE_AGENT_COMMAND=opencode
OPENCODE_AGENT_CWD=
OPENCODE_AGENT_DIRECT_MODE=true
OPENCODE_AGENT_INJECT_SAFETY_PREAMBLE=false
OPENCODE_AGENT_ARGS_TEMPLATE=run --dangerously-skip-permissions "{{task}}"
OPENCODE_AGENT_TIMEOUT_MS=900000
OPENCODE_AGENT_IDLE_TIMEOUT_MS=0
OPENCODE_AGENT_KILL_GRACE_MS=10000
OPENCODE_AGENT_KILL_TREE=true
OPENCODE_AGENT_USE_FOR_SELF_HEALING=true
OPENCODE_AGENT_USE_FOR_SELF_UPGRADE=true
```

Use cases:

- self-healing patch generation
- self-upgrade implementation work
- code review
- coding task analysis

For general fallback models, configure the actual ProviderRouter providers
directly. If OpenCode is disabled or fails, Native OpenClaw continues through
the existing self-healing/self-upgrade coding flow.

### OpenCode Agent Setup

Manual auth setup:

```bash
opencode run /connect
```

Or configure OpenCode Zen auth through smooth `.env`:

```env
OPENCODE_AUTH_BOOTSTRAP=true
OPENCODE_ZEN_API_KEY=your_key_here
OPENCODE_AUTH_PROVIDER=opencode
```

`OPENCODE_AUTH_PROVIDER` should be `opencode`, not `opencode-zen`.
smooth never logs `OPENCODE_ZEN_API_KEY`.

### OpenCode Working Directory

`OPENCODE_AGENT_CWD` is optional. Recommended:

```env
OPENCODE_AGENT_CWD=
```

When empty, smooth auto-detects the project root by walking upward from
`process.cwd()` and looking for `package.json`, `tsconfig.json`, `src/`,
`dist/`, `workspace/`, or `skills/` markers. In Docker, because the Dockerfile
uses `WORKDIR /app`, this usually resolves to `/app`.

Manual override is still available if auto-detection picks the wrong folder:

```env
OPENCODE_AGENT_CWD=/app
```

On Windows, Linux, and macOS, auto-detection uses native path resolution and
does not assume `/app`.

Windows troubleshooting:

- If `opencode --version` works in your terminal but smooth logs
  `spawn opencode ENOENT`, smooth will try to reuse the detected execution
  strategy by resolving `opencode.cmd` or using a Windows shell fallback.
- If your environment still cannot resolve it, set:

```env
OPENCODE_AGENT_COMMAND=opencode.cmd
```

- You may also use the absolute path to `opencode.cmd`.

### OpenCode Model Config

Use the `opencode/` provider prefix in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai",
  "model": "opencode/deepseek-v4-flash-free",
  "small_model": "opencode/mimo-v2.5-free",
  "permission": {
    "edit": "ask",
    "bash": "ask"
  }
}
```

Common error:

```text
Model not found: opencode-zen/deepseek-v4-flash-free
```

Fix:

- Use `opencode/deepseek-v4-flash-free`.
- Do not use `opencode-zen/deepseek-v4-flash-free`.

If OpenCode returns `Unexpected server error` or auth/API key errors, connect
the CLI or enable auth bootstrap:

```bash
opencode run /connect
```

```env
OPENCODE_AUTH_BOOTSTRAP=true
OPENCODE_ZEN_API_KEY=your_key_here
OPENCODE_AUTH_PROVIDER=opencode
```

Smoke test:

```bash
opencode run "hello"
```

OpenCode `run` uses positional message arguments. Do not configure
`OPENCODE_AGENT_ARGS_TEMPLATE` with `run --prompt "{{task}}"`.

For manual-equivalent OpenCode execution, keep direct mode enabled. In this
mode smooth sends the raw task through your `OPENCODE_AGENT_ARGS_TEMPLATE`,
adds only the project path, does not prepend the internal safety wrapper, and
disables idle timeout by default. The hard timeout and process-tree kill remain
active so runaway OpenCode processes are still terminated.

For smooth automation in trusted dev or isolated environments:

```env
OPENCODE_AGENT_DIRECT_MODE=true
OPENCODE_AGENT_INJECT_SAFETY_PREAMBLE=false
OPENCODE_AGENT_ARGS_TEMPLATE=run --dangerously-skip-permissions "{{task}}"
OPENCODE_AGENT_TIMEOUT_MS=900000
OPENCODE_AGENT_IDLE_TIMEOUT_MS=0
OPENCODE_AGENT_KILL_GRACE_MS=10000
OPENCODE_AGENT_KILL_TREE=true
```

This template is supported and intentionally passes
`--dangerously-skip-permissions` to OpenCode. Warning:
`--dangerously-skip-permissions` auto-approves OpenCode permissions. Use it
only where the repository and runtime environment are trusted.

For safer mode:

```env
OPENCODE_AGENT_DIRECT_MODE=true
OPENCODE_AGENT_ARGS_TEMPLATE=run "{{task}}"
```

You can also run:

```text
/opencode doctor
/opencode doctor --smoke
```

Troubleshooting checks:

- `Args preview` should include `run` and `--dangerously-skip-permissions`
  when the automation template above is configured.
- `Args template` must not contain `--prompt`; OpenCode 1.15.x uses
  positional message arguments.
- `Auth provider` should be `opencode`.
- OpenCode Zen model IDs should use the `opencode/` prefix, for example
  `opencode/deepseek-v4-flash-free`.

If OpenCode hangs, smooth enforces both a hard timeout and an idle timeout:

```env
OPENCODE_AGENT_TIMEOUT_MS=900000
OPENCODE_AGENT_IDLE_TIMEOUT_MS=0
OPENCODE_AGENT_KILL_GRACE_MS=10000
OPENCODE_AGENT_KILL_TREE=true
```

`OPENCODE_AGENT_IDLE_TIMEOUT_MS=0` disables the idle timer. This is recommended
for direct mode because OpenCode can work silently for long periods. Set a
positive idle timeout only when you explicitly want silent work to be killed.

On Windows, smooth terminates OpenCode with `taskkill /PID <pid> /T /F` so the
shell and child process tree are stopped. On Unix-like systems, smooth starts
OpenCode in a detached process group when process-tree killing is enabled and
terminates that group on timeout.

Manual Windows diagnosis:

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match "opencode" } |
  Select-Object ProcessId, CommandLine
```

Manual Windows kill:

```powershell
taskkill /PID <PID> /T /F
```

### OpenCode Auto Install

If OpenCode is not installed, smooth can detect it and optionally install it.

Recommended manual install:

```bash
npm install -g opencode-ai
```

Auto-install:

```env
OPENCODE_AUTO_INSTALL=true
OPENCODE_INSTALL_STRATEGY=npm-global
OPENCODE_INSTALL_REQUIRE_APPROVAL=true
```

Windows:

- Requires Node.js/npm.
- Default install command is `npm install -g opencode-ai`.

Linux/macOS:

- Uses npm global install by default.
- If permission is denied, install manually, configure a user npm prefix, or
  install in your deployment image.
- smooth does not automatically use `sudo` unless explicitly configured and
  approved.

Docker:

- Preferred production approach is installing OpenCode in the Dockerfile:

```dockerfile
RUN npm install -g opencode-ai
```

- Or use an optional build argument in your own Dockerfile:

```dockerfile
ARG INSTALL_OPENCODE=false
RUN if [ "$INSTALL_OPENCODE" = "true" ]; then npm install -g opencode-ai; fi
```

Runtime auto-install inside Docker is possible, but it installs inside the
running container and may not persist across rebuilds or recreated containers.

For non-interactive Docker auth, either bootstrap from env:

```env
OPENCODE_AUTH_BOOTSTRAP=true
OPENCODE_ZEN_API_KEY=your_key_here
OPENCODE_AUTH_PROVIDER=opencode
```

or mount the OpenCode auth directory:

```yaml
volumes:
  - ./data/opencode:/home/openclaw/.local/share/opencode
```

The runtime image sets `HOME=/home/openclaw`, so the default OpenCode auth file
is `/home/openclaw/.local/share/opencode/auth.json`.

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

WEB_UI_ENABLED=false
WEB_UI_HOST=0.0.0.0
WEB_UI_PORT=18790
WEB_UI_USERNAME=admin
WEB_UI_PASSWORD=change-me
WEB_UI_SESSION_SECRET=change-this-secret

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

      WEB_UI_ENABLED: ${WEB_UI_ENABLED:-false}
      WEB_UI_HOST: ${WEB_UI_HOST:-0.0.0.0}
      WEB_UI_PORT: ${WEB_UI_PORT:-18790}
      WEB_UI_USERNAME: ${WEB_UI_USERNAME:-admin}
      WEB_UI_PASSWORD: ${WEB_UI_PASSWORD:-change-me}
      WEB_UI_SESSION_SECRET: ${WEB_UI_SESSION_SECRET:-change-this-secret}

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
      - "${WEB_UI_PORT:-18790}:18790"

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

### Self-upgrade auto restart

When `SELF_UPGRADE_AUTO_RESTART=true` and a self-upgrade passes QA after
modifying source files, Native OpenClaw writes the final run report, then exits
with `AUTONOMOUS_RESTART_EXIT_CODE` (default `42`) after
`AUTONOMOUS_RESTART_DELAY_MS` (default `1500`).

Docker Compose should use `restart: unless-stopped`, as shown above. With that
policy, the container starts again automatically after the process exits, and
the newly added capability is available after restart.

Disable this behavior with:

```env
SELF_UPGRADE_AUTO_RESTART=false
AUTONOMOUS_RESTART_MODE=disabled
```

### Restart Notifications

When self-healing or self-upgrade passes QA and a restart is required, smooth
can notify you before it exits with code `42`. This is especially useful when
running manually with `npm start`, where no supervisor may restart the process.

Enable notifications:

```env
RESTART_NOTIFICATION_ENABLED=true
RESTART_NOTIFY_TELEGRAM=true
RESTART_NOTIFY_EMAIL=true
```

Telegram can use an explicit chat ID:

```env
RESTART_TELEGRAM_CHAT_ID=123456789
```

Email can use a restart-specific recipient:

```env
RESTART_EMAIL_RECIPIENT=you@example.com
```

or the normal Brevo default recipient:

```env
BREVO_RECIPIENT_EMAIL=you@example.com
RESTART_EMAIL_USE_BREVO_DEFAULTS=true
```

If smooth was started with `npm start`, it may exit and stay stopped after a
successful self-healing or self-upgrade restart request. Restart manually with:

```bash
npm start
npm run start:watch:win
npm run start:watch:unix
docker compose up -d
pm2 restart smooth
```

Docker Compose should use:

```yaml
restart: unless-stopped
```

With `RESTART_NOTIFY_AFTER_START=true`, smooth writes a small
`restart-pending.json` marker before exit and sends a best-effort "restarted
successfully" notification after the next startup.

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
