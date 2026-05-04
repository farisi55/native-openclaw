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

### Build and run

```bash
# Build the image
docker build -t native-openclaw .

# Run interactively (TTY required for REPL)
docker run -it \
  -v $(pwd)/data:/data \
  -v $(pwd)/skills:/skills \
  --env-file .env \
  native-openclaw
```

### Docker Compose

```bash
# Build and start
docker compose up --build

# One-shot interactive session
docker compose run openclaw

# Stop
docker compose down
```

Volumes:

| Host path | Container path | Purpose |
|-----------|---------------|---------|
| `./data` | `/data` | Session JSON, settings |
| `./skills` | `/skills` | Skill Markdown files |

### Optional: Ollama sidecar

Uncomment the `ollama` service block in `docker-compose.yml`, then:

```bash
docker compose up ollama -d
docker compose exec ollama ollama pull llama3.3
docker compose run openclaw
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
