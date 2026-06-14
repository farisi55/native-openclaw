# native-openclaw

> Multi-provider AI agent terminal — native TypeScript, zero framework lock-in.

Interactive chat REPL dengan arsitektur reasoning-first yang mendukung 10 provider LLM secara bersamaan. Setiap percakapan disimpan sebagai plain JSON. Skill system berbasis file Markdown. Dilengkapi HTTP API, Web UI, Telegram bot, cronjob scheduler, semantic memory, self-healing, dan self-upgrade.

---

## Features

- **Multi-provider router** — 12 provider aktif bersamaan, auto-fallback, task-aware routing
- **Reasoning-first orchestrator** — internal reasoning sebelum setiap tool call
- **Semantic memory** — TF-IDF local (tanpa vector DB eksternal), persisten antar sesi
- **ReAct loop** — Reason → Action → Observe → Answer, hingga 4 steps per turn
- **Prompt optimizer** — compresses context, classifies intent, optimizes token usage
- **Workspace** — local-first agent home dengan MEMORY.md, WORKFLOW.md, HEARTBEAT.md
- **Scheduler** — cronjob dari natural language, timezone-aware, email notification
- **Self-Improving** — ekstraksi skill otomatis dari setiap percakapan
- **Self-Healing** — deteksi bug → patch → QA → rollback, fully autonomous
- **Self-Upgrade** — implementasi fitur baru ke codebase sendiri
- **MCP** — Model Context Protocol dengan preset server (tavily, firecrawl, brevo, e2b)
- **HTTP API** — REST endpoint dengan auth token dan rate limiting
- **Web UI** — lightweight chat UI (smooth) berbasis vanilla HTML/CSS/JS
- **Telegram** — full bot integration dengan polling dan queue management

---

## Requirements

| Tool | Minimum |
|------|---------|
| Node.js | >= 20.0.0 |
| npm | >= 10.0.0 |

---

## Quick Start

```bash
git clone https://github.com/your-org/native-openclaw.git
cd native-openclaw
npm install

cp .env.example .env
# Edit .env — tambahkan minimal satu API key provider

npm run dev      # development, tanpa build step
# atau
npm run build && npm start
```

---

## Providers

Set API key di `.env`. Beberapa provider bisa aktif bersamaan. Switch saat runtime dengan `/provider <id>`.

| Provider | Env Variable | Default Model | Notes |
|----------|-------------|---------------|-------|
| Groq | `GROQ_API_KEY` | `llama-3.3-70b-versatile` | Fastest inference |
| OpenRouter | `OPENROUTER_API_KEY` | `openai/gpt-4o` | 200+ models |
| Mistral | `MISTRAL_API_KEY` | `mistral-large-latest` | EU-hosted |
| OpenAI | `OPENAI_API_KEY` | `gpt-4o` | GPT-4o, o1 |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-opus-4-20250514` | Claude |
| Gemini | `GEMINI_API_KEY` | `gemini-2.0-flash` | Vision support |
| Z.ai | `ZAI_API_KEY` | `glm-4.5` | `ZAI_BASE_URL` required |
| SambaNova | `SAMBANOVA_API_KEY` | `DeepSeek-V3.1` | Reasoning-optimized |
| Puter | `PUTER_API_KEY` | `gpt-5.5` | Backend ProviderRouter only |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` | `@cf/meta/llama-3.1-8b-instruct` | Requires account ID and enable flag |
| GitHub Models | `GITHUB_MODELS_API_KEY` | `openai/gpt-4.1` | Token needs Models read access |
| Ollama | *(none)* | — | `OLLAMA_BASE_URL=http://localhost:11434` |

Cloudflare and GitHub Models are normal LLM providers. They run through `ProviderRouter`
and participate in its fallback path; they are not AgentGateway connectors.

```env
CLOUDFLARE_AI_ENABLED=true
CLOUDFLARE_API_KEY=your-cloudflare-token
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_DEFAULT_MODEL=@cf/meta/llama-3.1-8b-instruct

GITHUB_MODELS_ENABLED=true
GITHUB_MODELS_API_KEY=your-github-token
GITHUB_MODELS_DEFAULT_MODEL=openai/gpt-4.1
```

Switch manually with `/provider cloudflare` or `/provider github-models`. Run a
minimal live diagnostic with `/provider doctor cloudflare` or
`/provider doctor github-models`.

### Smart Router

`ProviderRouter` memilih provider terbaik per task secara otomatis:

| Task Type | Priority Order |
|-----------|----------------|
| `fast_chat` | groq → sambanova → cloudflare → github-models → openrouter → mistral → ollama |
| `reasoning` | sambanova → gemini → github-models → cloudflare → openrouter → groq → ollama |
| `coding` | sambanova → groq → github-models → mistral → cloudflare → openrouter → ollama |
| `vision` | gemini → github-models → openrouter → ollama |
| `local` | ollama |

Router melacak health setiap provider (latency, error rate). Jika provider utama gagal, auto-fallback ke provider berikutnya — transparan tanpa interrupsi.

```env
ROUTER_ENABLED=true    # aktifkan multi-provider router
AUTO_FALLBACK=true     # auto-switch ke provider lain saat gagal
AUTO_SWITCH=true       # proactive switching berdasarkan task type
PROVIDER_ORDER=groq,mistral,cloudflare,github-models,gemini,openrouter,ollama
```

---

## Architecture

```
User Input
    │
    ▼
Memory Extractor       ← extract & persist learned facts from conversation
    │
    ▼
Capability Installer   ← deteksi natural-language install intent
    │
    ▼
Action Handler         ← CLI management actions (/session, /skills, dst)
    │
    ▼
Reasoning Engine       ← internal micro-LLM: tool needed? which one? (temp=0)
    │
    ▼
Context Compressor     ← TF-IDF semantic retrieval + sliding window
    │
    ▼
Prompt Builder         ← base prompt + memory + workspace + skills + tools
    │
    ▼
ReAct Loop / ToolLoop  ← LLM via ProviderRouter → tool calls → observe → repeat
    │
    ▼
Semantic Memory Store  ← index exchange untuk future retrieval
    │
    ▼
Response
```

**ReAct Loop** internal per turn:
1. **REASON** — LLM memutuskan action (JSON internal, `temp=0`)
2. **ACTION** — jalankan tool / browse / shell command / direct answer
3. **OBSERVE** — inject tool result ke LLM
4. **REASON** — LLM bisa ambil step berikutnya (maks `REACT_MAX_STEPS=4`)
5. **ANSWER** — LLM generate final response ke user

---

## CLI Reference

Jalankan `/help` di dalam REPL untuk melihat semua command.

### Providers & Models

| Command | Keterangan |
|---------|-----------|
| `/provider` | Tampilkan provider aktif |
| `/providers` | Tampilkan semua provider |
| `/provider <id>` | Ganti provider |
| `/provider doctor <id>` | Smoke test minimal untuk provider |
| `/model` | Tampilkan model aktif |
| `/model <model-id>` | Ganti model |
| `/models` | List semua model dari semua provider |
| `/models <provider>` | List model untuk satu provider |

### Sessions

| Command | Keterangan |
|---------|-----------|
| `/session` | Info session aktif |
| `/session new` | Mulai session baru |
| `/session list` | List semua session tersimpan |
| `/session <id>` | Resume session |
| `/session switch <id>` | Resume session by ID |
| `/session delete <id>` | Hapus session |

### Skills

| Command | Keterangan |
|---------|-----------|
| `/skills` | List semua skill dan status |
| `/skills on <id>` | Aktifkan skill |
| `/skills off <id>` | Nonaktifkan skill |

### Workspace

| Command | Keterangan |
|---------|-----------|
| `/workspace` | Info workspace |
| `/workspace info` | Status workspace |
| `/workspace init` | Buat file workspace yang hilang |
| `/workspace reload` | Reload workspace context |
| `/workspace list` | List file workspace |
| `/workspace tree` | Tampilkan tree workspace |
| `/workspace read <file>` | Baca file workspace |
| `/workspace write <file> <text>` | Tulis file workspace |
| `/workspace append <file> <text>` | Append ke file workspace |
| `/workspace mkdir <folder>` | Buat folder workspace |
| `/workspace trash <file>` | Pindah path ke trash |
| `/workspace backup` | Buat backup workspace |

### Memory

| Command | Keterangan |
|---------|-----------|
| `/memory` | Tampilkan perintah memory |
| `/memory show` | Baca MEMORY.md |
| `/memory daily` | Baca daily memory log hari ini |
| `/heartbeat` | Tampilkan HEARTBEAT.md checklist |

### MCP

| Command | Keterangan |
|---------|-----------|
| `/mcp` | Tampilkan help MCP |
| `/mcp list` | List MCP server yang dikonfigurasi |
| `/mcp add <name> [json]` | Tambah MCP server preset atau custom |
| `/mcp start <name>` | Start MCP server |
| `/mcp stop <name>` | Stop MCP server |
| `/mcp tools [name]` | List MCP tools |

### Workflows & Scheduler

| Command | Keterangan |
|---------|-----------|
| `/workflow` | Help workflow |
| `/workflow show` | Tampilkan ringkasan WORKFLOW.md |
| `/workflow run` | Eksekusi WORKFLOW.md |
| `/workflow validate` | Validasi WORKFLOW.md |
| `/cron` | Help cronjob |
| `/cron list` | List semua cronjob |
| `/cron create <text>` | Buat cronjob dari natural language |
| `/cron run <id-or-name>` | Jalankan cronjob sekarang |

### Self-Improve, Self-Heal, Upgrade

| Command | Keterangan |
|---------|-----------|
| `/self-improve status` | Status self-improvement loop |
| `/self-improve skills` | List auto-generated skills |
| `/self-improve evaluate` | Jalankan skill self-evaluation |
| `/heal` | Trigger self-healing (debug mode) |
| `/upgrade` | Trigger self-upgrade |

### Tools, Settings, Network

| Command | Keterangan |
|---------|-----------|
| `/tools` | List semua tool terinstall |
| `/tools install <name>` | Install tool dari `tools/available/` |
| `/tools enable <name>` | Enable tool yang dinonaktifkan |
| `/tools disable <name>` | Disable tool (tetap terinstall) |
| `/settings` | Tampilkan persistent settings |
| `/settings default-model <id>` | Set default model untuk provider aktif |
| `/settings default-provider <id>` | Set default provider |
| `/network` | Help network diagnostics |
| `/network dns` | DNS server yang dikonfigurasi |
| `/network check <host>` | Resolve hostname |
| `/network proxy` | Tampilkan proxy config |
| `/exit` | Keluar |

### Natural Language Actions (Tanpa Slash)

```text
list skills               → sama seperti /skills
use skill <id>            → aktifkan skill
install skill <id>        → install skill
disable skill <id>        → nonaktifkan skill
delete session <id>       → hapus session
what time is it?          → system time (via tool)
what is the news?         → web search (via browsing tool)
fetch url <url>           → web fetch
get data from API /path   → internal API client
```

---

## Built-in Tools

Tool tersedia otomatis untuk LLM selama percakapan.

| Tool | Fungsi |
|------|--------|
| `web-fetch` | Fetch URL dan ekstrak konten (Tavily → Firecrawl fallback) |
| `system-execute` | Eksekusi shell command lokal dengan risk classification |
| `api-client` | HTTP request ke internal/external API |
| `opencode-agent` | External coding agent (opsional, perlu instalasi) |
| `system-time` | Waktu dan tanggal sistem |
| `brevo-email` | Kirim email via Brevo API |
| `workspace-read` | Baca file workspace |
| `workspace-write` | Tulis file workspace |
| `workspace-append` | Append ke file workspace |
| `workspace-list` | List isi workspace |
| `workspace-tree` | Tree struktur workspace |
| `workspace-info` | Info dan statistik workspace |
| `workspace-mkdir` | Buat direktori workspace |
| `workspace-trash` | Pindah file ke trash |
| `workspace-backup` | Backup workspace |

### System Execute Security

`system-execute` menggunakan risk-based policy:

```env
SYSTEM_EXECUTE_ENABLED=true
SYSTEM_EXECUTE_POLICY=risk-based
SYSTEM_EXECUTE_ALLOW_ARBITRARY=true
SYSTEM_EXECUTE_REQUIRE_APPROVAL_FOR_DANGEROUS=true   # dangerous commands perlu approval
SYSTEM_EXECUTE_TIMEOUT=30000
SYSTEM_EXECUTE_REDACT_SECRETS=true                   # redact env var dari logs
```

### Browsing

Tavily sebagai primary, Firecrawl sebagai fallback:

```env
TAVILY_API_KEY=
FIRECRAWL_API_KEY=
BROWSING_TIMEOUT_MS=15000
BROWSING_MAX_RESULTS=5
```

---

## Skills

Skill adalah file Markdown di direktori `skills/` yang diinjeksi ke setiap system prompt.

### Frontmatter Schema

```yaml
---
name: Code Reviewer          # wajib
description: Reviews code    # wajib
version: 1.0.0
tags: [coding, review]
priority: 10                 # lebih tinggi = diinjeksi lebih awal (default: 0)
enabled: true
---

Konten Markdown — diinjeksi verbatim ke system prompt.
```

### Contoh Skill

```markdown
---
name: Concise Responder
description: Selalu menjawab secara singkat dan dalam poin-poin
priority: 5
enabled: true
---

## Rules
- Maksimal 150 kata per respons.
- Gunakan bullet points, bukan prosa panjang.
- Skip preamble dan sign-off.
```

### Self-Improving Skills

Ketika `SELF_IMPROVING=true`, engine secara otomatis mengekstrak skill baru dari setiap percakapan yang selesai, mengevaluasi kualitasnya, dan mendaftarkan skill yang lolos threshold ke registry.

```env
SELF_IMPROVING=false
SELF_IMPROVING_EVAL_THRESHOLD=10     # jumlah turn sebelum evaluasi dijalankan
SELF_IMPROVING_MODEL=                # opsional: provider/model untuk evaluasi
```

Skill auto-generated disimpan di `SKILLS_DIR/auto-generated/`. Monitor dengan `/self-improve status`.

---

## Workspace

Local-first agent home. Setiap instance menyimpan state, memory, report, dan artifact di sini.

### Struktur Direktori

```
workspace/
├── IDENTITY.md      # identitas dan persona agent
├── SOUL.md          # nilai dan prinsip agent
├── AGENTS.md        # definisi multi-agent
├── USER.md          # preferensi dan info user
├── TOOLS.md         # panduan penggunaan tool
├── MEMORY.md        # long-term memory yang dikurasi
├── WORKFLOW.md      # instruksi workflow otomatis
├── HEARTBEAT.md     # recurring checklist
├── state/           # session state
├── memory/          # daily memory logs (YYYY-MM-DD.md)
├── reports/         # output workflow dan laporan
├── artifacts/       # file hasil kerja agent
├── backup/          # backup otomatis
└── trash/           # file yang dihapus (recoverable)
```

### Workspace Memory

Agent otomatis menulis ke `MEMORY.md` ketika mendeteksi informasi penting (preferensi user, keputusan project, event signifikan). Daily log tersimpan di `memory/YYYY-MM-DD.md`.

```env
WORKSPACE_MEMORY_ENABLED=true
WORKSPACE_DAILY_MEMORY_ENABLED=true
WORKSPACE_DIR=./workspace
WORKSPACE_ALLOW_OUTSIDE_PATHS=false   # blokir path traversal
```

---

## Semantic Memory

Implementasi TF-IDF tanpa vector database eksternal. Setiap exchange diindeks berdasarkan keyword dan timestamp, diambil kembali menggunakan cosine-like similarity saat context baru masuk.

- Storage: local JSON (`APP_DATA_DIR/semantic-memory.json`)
- Retrieval: keyword overlap + recency weighting
- Kompresi otomatis saat context window mendekati batas

```env
SEMANTIC_MEMORY=true
PROMPT_OPTIMIZER_ENABLED=true
PROMPT_OPTIMIZER_MODE=balanced    # off | fast | balanced | strict
```

---

## Prompt Optimizer

Sebelum setiap turn, optimizer menganalisis input dan mengompres context untuk efisiensi token.

| Mode | Keterangan |
|------|-----------|
| `off` | Disabled |
| `fast` | Minimal processing, low overhead |
| `balanced` | Default — intent classification + context compression |
| `strict` | Full analysis, ambiguity detection, risk flagging |

```env
PROMPT_OPTIMIZER_MODE=balanced
PROMPT_OPTIMIZER_MAX_INPUT_CHARS=12000
PROMPT_OPTIMIZER_MAX_CONTEXT_CHARS=24000
PROMPT_MAX_ACTIVE_SKILLS=3            # maksimal skill yang diinjeksi per turn
PROMPT_SKILL_RELEVANCE_ENABLED=true   # injeksi skill berdasarkan relevansi
```

---

## Scheduler (Cron Jobs)

Buat dan jalankan cronjob dari natural language. Job dieksekusi oleh orchestrator dengan konteks session penuh.

```bash
/cron create "setiap pagi jam 7 cek berita teknologi dan simpan ke workspace"
/cron list
/cron run morning-news
```

Schedule types yang didukung: `once`, `cron`, `interval`, `daily`, `weekly`, `monthly`.

```env
SCHEDULER_ENABLED=true
SCHEDULER_TICK_MS=30000
SCHEDULER_TIMEZONE=Asia/Jakarta
SCHEDULER_MISFIRE_POLICY=skip          # skip | run_once | run_all
SCHEDULER_SESSION_MODE=dedicated       # dedicated | last_active | new_each_run
SCHEDULER_MAX_CONCURRENT_JOBS=2
```

Job yang membutuhkan email otomatis generate subject dan HTML content via LLM, lalu kirim melalui Brevo.

---

## Self-Healing

Autonomous bug-fix loop. Ketika diaktifkan dan error terdeteksi:

1. **Bug Analyzer** — analisis error log dan isolasi root cause
2. **Patch Planner** — rencanakan perubahan file
3. **Snapshot** — buat snapshot sebelum apply patch
4. **Patch Applier** — terapkan diff ke source code
5. **Dependency Resolver** — install missing packages jika dibutuhkan
6. **Test Runner** — jalankan test commands (build + test)
7. **QA Agent** — review hasil test
8. **Rollback** — jika gagal, rollback ke snapshot otomatis

```env
SELF_HEALING_ENABLED=false
SELF_HEALING_MAX_LOOPS=3
SELF_HEALING_AUTO_APPLY=true
SELF_HEALING_AUTO_ROLLBACK=true
SELF_HEALING_TEST_COMMANDS=npm run build,npm test
SELF_HEALING_TIMEOUT_MS=120000
SELF_HEALING_REDACT_SECRETS=true
SELF_HEALING_MODEL=                  # opsional: provider/model khusus
```

Run reports disimpan di `SELF_HEALING_RUNS_DIR=./workspace/self-healing/runs`.

---

## Self-Upgrade

Extends self-healing untuk autonomous feature implementation. Agent membaca request upgrade, menulis kode baru, menjalankan QA, lalu restart otomatis jika lolos.

```env
SELF_UPGRADE_ENABLED=false
SELF_UPGRADE_MAX_LOOPS=3
SELF_UPGRADE_AUTO_APPLY=true
SELF_UPGRADE_AUTO_ROLLBACK=true
SELF_UPGRADE_AUTO_RESTART=true          # exit code 42 → Docker restart
SELF_UPGRADE_AUTO_REGISTER=true
SELF_UPGRADE_ALLOWED_TARGETS=repo
```

Setelah upgrade berhasil, proses exit dengan code `42`. Docker Compose dengan `restart: unless-stopped` akan menjalankan ulang container secara otomatis.

### Restart Notifications

```env
RESTART_NOTIFICATION_ENABLED=true
RESTART_NOTIFY_TELEGRAM=true
RESTART_NOTIFY_EMAIL=true
RESTART_EMAIL_RECIPIENT=you@example.com
RESTART_NOTIFY_AFTER_START=true     # kirim konfirmasi setelah restart berhasil
```

---

## Agent Gateway

Agent Gateway adalah lapisan delegasi ringan untuk capability khusus. Native OpenClaw tetap menjadi
orchestrator utama; connector hanya dijalankan on-demand dan tidak hidup sebagai daemon.

```text
Native OpenClaw
-> capability router
-> connector registry (priority + enabled flags)
-> timeout / AbortSignal guard
-> fallback connector
-> capability-specific result validation
-> QA dan rollback oleh self-healing/self-upgrade
```

Capability yang didukung:

- `coding.patch`: OpenCode lebih dahulu, lalu Internal CodingAgent jika OpenCode disabled, gagal,
  timeout, atau tidak menghasilkan perubahan.
- `coding.review`, `coding.test`: OpenCode lebih dahulu, lalu provider Internal CodingAgent sebagai
  fallback. Fallback test internal diberi tanda skipped karena menghasilkan analisis, bukan menjalankan
  command lokal.
- `coding.refactor`: memakai urutan OpenCode lalu Internal CodingAgent ketika task membawa konteks
  patch self-healing/self-upgrade yang aman.
- `mcp.config`, `mcp.server.list`, `mcp.server.start`, `mcp.server.stop`: Internal MCP Agent.

Connector hanya dijalankan bila task benar-benar didelegasikan; normal chat tidak melewati Agent
Gateway.

```env
AGENT_GATEWAY_ENABLED=true
AGENT_GATEWAY_MAX_DELEGATION_DEPTH=1
AGENT_GATEWAY_DEFAULT_TIMEOUT_MS=900000
AGENT_GATEWAY_MAX_FALLBACKS=2
AGENT_GATEWAY_VALIDATE_RESULTS=true
AGENT_OPENCODE_ENABLED=true
AGENT_INTERNAL_CODING_ENABLED=true
AGENT_INTERNAL_CODING_MAX_PROMPT_CHARS=24000
AGENT_MCP_ENABLED=true
```

Hasil gateway selalu dinormalisasi dan mencantumkan connector terpilih, fallback chain, connector yang
gagal, serta status validasi. `coding.patch` tidak boleh sukses tanpa changed files atau patch artifact.
Perubahan ke path terlarang dan dependency manifest tanpa izin ditolak serta dipulihkan sebelum fallback.

Environment OpenCode lama tetap berlaku. `OPENCODE_AGENT_ENABLED` dan flag
`OPENCODE_AGENT_USE_FOR_SELF_HEALING`/`OPENCODE_AGENT_USE_FOR_SELF_UPGRADE` tetap menentukan apakah
connector OpenCode dapat dipilih.

Agent Gateway tidak menjalankan external agent saat startup. OpenCode hanya dipanggil on-demand untuk
task coding, sedangkan MCP server hanya dijalankan oleh `/mcp start <name>` atau bila
`MCP_AUTO_START=true`. Nonaktifkan seluruh delegasi dengan `AGENT_GATEWAY_ENABLED=false`, atau hanya
OpenCode dengan `AGENT_OPENCODE_ENABLED=false`.

---

## Optional External Agents

Phase 3 menyediakan connector HTTP dan Docker profile opsional untuk:

- `browser-agent`: `browser.automation`, `browser.ui-test`
- `research-agent`: `research.web`, `research.market`
- `spreadsheet-agent`: `spreadsheet.read`, `spreadsheet.write`, `spreadsheet.report`

Ketiganya disabled secara default. `docker compose up -d` hanya menjalankan core Native OpenClaw;
service opsional tidak menjadi `depends_on` core dan tidak dimulai otomatis.

Aktifkan worker yang diperlukan:

```bash
docker compose --profile browser up -d
docker compose --profile research up -d
docker compose --profile spreadsheet up -d
docker compose --profile external-agents up -d
```

Aktifkan connector core yang sesuai di `.env`:

```env
AGENT_BROWSER_ENABLED=true
AGENT_BROWSER_BASE_URL=http://browser-agent:3101
AGENT_BROWSER_TIMEOUT_MS=300000
AGENT_BROWSER_API_KEY=

AGENT_RESEARCH_ENABLED=true
AGENT_RESEARCH_BASE_URL=http://research-agent:3102
AGENT_RESEARCH_TIMEOUT_MS=600000
AGENT_RESEARCH_API_KEY=

AGENT_SPREADSHEET_ENABLED=true
AGENT_SPREADSHEET_BASE_URL=http://spreadsheet-agent:3103
AGENT_SPREADSHEET_TIMEOUT_MS=300000
AGENT_SPREADSHEET_API_KEY=
```

Gunakan `/agents` atau `/agents list` untuk melihat registry. `/agents health` memanggil `GET /health`
hanya untuk connector enabled; command ini tidak menyalakan worker yang disabled.

Payload eksternal tidak menyertakan `.env`, API key, token, password, cookie, authorization, atau
credential dari context. API key worker dikirim hanya melalui header Authorization. Artifact harus
berada di `/workspace/artifacts/<agent-id>/<task-id>/`.

Scaffold Phase 3 sengaja ringan:

- browser-agent belum membawa Playwright/Chromium dan mengembalikan
  `BROWSER_RUNTIME_NOT_IMPLEMENTED`;
- research-agent belum membawa crawler dan memerlukan adapter backend terpisah;
- spreadsheet-agent memerlukan Google credentials atau MCP Google Sheets, lalu adapter backend
  terpisah.

Runtime tersebut dapat ditambahkan kemudian hanya ke image worker masing-masing, tanpa menambah
dependency atau ukuran image core Native OpenClaw.

### Phase 3.5 Stabilization and QA

Phase 3.5 mengeraskan integrasi yang sudah ada tanpa menambah runtime berat. Jalur utama tetap
terpisah:

```text
Normal chat:
User -> PromptOptimizer -> ProviderRouter -> ToolLoop -> response

Self-healing / self-upgrade:
User -> IntentRouter -> AgentGateway -> OpenCode
     -> fallback InternalCoding -> QA -> report / rollback

MCP configuration:
User -> AgentGateway -> MCP Agent -> mcp_agent.config.yaml -> /mcp list

Optional external capability:
User -> AgentGateway -> External HTTP connector -> Docker profile worker
```

Normal chat tidak memanggil AgentGateway, OpenCode, MCP server, atau external worker. ProviderRouter
menyimpan metadata attempt yang teredaksi: provider terpilih, fallback chain, failed providers, dan
error code. API key, Bearer token, request body sensitif, serta isi file protected tidak ditulis ke
laporan.

Self-healing dan self-upgrade menulis laporan konsisten di
`workspace/self-healing/runs/<runId>/final-report.md` dengan:

- agent terpilih, fallback chain, dan failed agents;
- hasil validasi AgentGateway;
- provider/model serta provider fallback;
- changed files dan per-file diff;
- command QA, status, serta stdout/stderr preview saat gagal;
- status rollback dan lokasi report.

Jalankan QA terfokus:

```bash
npm run qa:agent-gateway
npm run qa:provider-router
npm run qa:mcp
npm run qa:security
npm run qa:phase3.5
```

Validasi Docker profile tanpa menyalakan container:

```bash
npm run qa:docker-profiles
```

Perintah tersebut menjalankan `docker compose config --services` untuk konfigurasi default serta
profile `browser`, `research`, `spreadsheet`, dan `external-agents`. Validasi runtime container tetap
dapat dilakukan manual:

```bash
docker compose up -d
docker compose ps
docker compose down

docker compose --profile browser up -d
docker compose --profile research up -d
docker compose --profile spreadsheet up -d
docker compose --profile external-agents up -d
```

Jika capability eksternal diminta saat worker disabled, respons hanya memberi instruksi profile dan
env yang perlu diaktifkan. Sistem tidak mengklaim browser, riset, atau spreadsheet sudah dijalankan.

---

## OpenCode Agent

Integrasi opsional dengan OpenCode sebagai external coding agent — bukan provider chat biasa.

**Use cases**: self-healing patch generation, self-upgrade, code review, analisis task coding.

### Setup

```bash
# Autentikasi manual
opencode run /connect

# Atau via .env bootstrap
OPENCODE_AUTH_BOOTSTRAP=true
OPENCODE_ZEN_API_KEY=your_key
OPENCODE_AUTH_PROVIDER=opencode       # gunakan "opencode", bukan "opencode-zen"
```

### Konfigurasi Utama

```env
OPENCODE_AGENT_ENABLED=false
OPENCODE_AGENT_COMMAND=opencode
OPENCODE_AGENT_DIRECT_MODE=true
OPENCODE_AGENT_INJECT_SAFETY_PREAMBLE=false
OPENCODE_AGENT_ARGS_TEMPLATE=run --dangerously-skip-permissions "{{task}}"
OPENCODE_AGENT_TIMEOUT_MS=900000
OPENCODE_AGENT_IDLE_TIMEOUT_MS=0       # nonaktifkan idle timer di direct mode
OPENCODE_AGENT_KILL_GRACE_MS=10000
OPENCODE_AGENT_KILL_TREE=true
OPENCODE_AGENT_USE_FOR_SELF_HEALING=false
OPENCODE_AGENT_USE_FOR_SELF_UPGRADE=false
```

> **Peringatan**: `--dangerously-skip-permissions` auto-approve semua permission OpenCode. Gunakan hanya di environment terisolasi yang terpercaya.

### Model Config (`opencode.jsonc`)

```jsonc
{
  "$schema": "https://opencode.ai",
  "model": "opencode/deepseek-v4-flash-free",
  "small_model": "opencode/mimo-v2.5-free",
  "permission": { "edit": "ask", "bash": "ask" }
}
```

> Gunakan prefix `opencode/`, bukan `opencode-zen/`.

### Diagnostics

```bash
/opencode doctor
/opencode doctor --smoke
opencode run "hello"    # smoke test
```

---

## MCP (Model Context Protocol)

Integrasi external tools via MCP server. Runtime `/mcp` dan MCP Agent memakai sumber konfigurasi yang
sama: `mcp_agent.config.yaml`.

### Preset Server

```bash
/mcp add tavily       # web search via Tavily
/mcp add firecrawl    # web scraping via Firecrawl
/mcp add brevo        # email via Brevo
/mcp add e2b          # sandboxed code execution
/mcp add console      # console automation
```

### Custom Server

```bash
/mcp add my-server '{"command":"node","args":["/path/to/server.js"]}'
```

Launcher yang diizinkan: `npx`, `uvx`, `node`, `python`, `python3`, `deno`.

```env
MCP_ENABLED=true
MCP_CONFIG_PATH=./mcp_agent.config.yaml
MCP_AUTO_START=false
```

### MCP Agent Self-Configuration

`mcp-agent` mengelola file YAML `mcp_agent.config.yaml` secara deterministik. Permintaan ini masuk jalur
`self-configuration`, bukan self-healing atau self-upgrade. Agent membaca YAML yang ada, mempertahankan
server lama, menambah atau memperbarui server, menulis secara atomik, lalu memvalidasi hasilnya.

```env
MCP_AGENT_ENABLED=true
MCP_AGENT_CONFIG_PATH=./mcp_agent.config.yaml
MCP_AGENT_ALLOW_CONFIG_WRITE=true
```

MCP server tidak dijalankan otomatis secara default. Gunakan `/mcp start <name>` atau set
`MCP_AUTO_START=true`. Jika `mcp_agent.config.yaml` belum ada tetapi `data/mcp.json` ditemukan,
Native OpenClaw memigrasikan konfigurasi legacy itu ke YAML saat startup.

Contoh chat:

```text
Tolong tambahkan server MCP google-sheets ke dalam file mcp_agent.config.yaml.
Gunakan perintah eksekusi "npx -y @modelcontextprotocol/server-google-sheets".
```

Contoh hasil konfigurasi:

```yaml
mcpServers:
  filesystem:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
  canva:
    url: "https://canva.com"
  google-sheets:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-google-sheets"]
```

Path kustom harus tetap berada di dalam project root, berekstensi `.yaml`/`.yml`, dan tidak boleh menunjuk
ke `.env`, secret, key, `.git`, `node_modules`, atau `dist`. Command hanya disimpan sebagai konfigurasi;
MCP Agent tidak mengeksekusi command saat mengubah YAML.

Di Docker, gunakan `MCP_AGENT_CONFIG_PATH=/app/mcp_agent.config.yaml`. Image menjalankan aplikasi sebagai
user non-root `openclaw`, dan `/app` dimiliki user tersebut sehingga file dapat ditulis tanpa akses root.
Untuk persistensi lintas pembuatan ulang container, bind-mount file itu dari host.

---

## HTTP API

REST endpoint untuk integrasi eksternal.

**Endpoint**: `POST /native-openclaw/v1/chat`  
**Port**: `18789` (default)

```env
API_ENABLED=false
API_HOST=127.0.0.1
API_PORT=18789
API_AUTH_TOKEN=your_secret_token
RATE_LIMIT_ENABLED=true
RATE_LIMIT_MAX=10                    # requests per menit per IP
```

**Request**:

```bash
curl -X POST "http://127.0.0.1:18789/native-openclaw/v1/chat" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_secret_token" \
  -d '{"message": "halo", "preferredProvider": "groq", "preferredModel": "llama-3.3-70b-versatile"}'
```

**Response**:

```json
{
  "model": "llama-3.3-70b-versatile",
  "provider": "groq",
  "result": "Halo! Ada yang bisa saya bantu?",
  "token": null,
  "responseTime": "842 ms",
  "tools": [],
  "flow": [],
  "sessionId": "sess_abc123",
  "error_detail": [],
  "fallbackUsed": false
}
```

Field `preferredProvider` dan `preferredModel` opsional — tanpa keduanya, router memilih provider terbaik secara otomatis.

---

## Web UI (smooth)

Optional lightweight chat UI berbasis vanilla HTML/CSS/JS. Menggunakan pipeline yang sama dengan CLI dan HTTP API (orchestrator, tools, memory, scheduler semuanya aktif).

```env
WEB_UI_ENABLED=false
WEB_UI_HOST=0.0.0.0
WEB_UI_PORT=18790
WEB_UI_USERNAME=admin
WEB_UI_PASSWORD=change-me
WEB_UI_SESSION_SECRET=change-this-secret
```

Jalankan `npm start`, buka `http://localhost:18790`.

### Puter Provider Mode (Web UI)

Gunakan Puter.ai sebagai provider khusus untuk request dari Web UI, sementara semua orchestration tetap di backend.

```env
WEB_UI_PUTER_ENABLED=false
WEB_UI_PUTER_PROVIDER_ID=puter
WEB_UI_PUTER_DEFAULT_MODEL=gpt-5-nano

PUTER_ENABLED=false
PUTER_API_KEY=
PUTER_DEFAULT_MODEL=gpt-5.5
PUTER_DISABLE_TEMPERATURE=true    # beberapa model Puter menolak custom temperature
```

- Jika Puter gagal, ProviderRouter fallback ke provider backend normal.
- CLI dan Telegram tidak terpengaruh kecuali secara eksplisit meneruskan `preferredProvider=puter`.

---

## Telegram Integration

Full bot integration dengan polling, queue, dan acknowledgment.

```env
TELEGRAM_ENABLED=false
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_CHAT_IDS=123456789,987654321   # whitelist chat ID
TELEGRAM_ALLOW_ALL=false

TELEGRAM_ACK_ENABLED=true
TELEGRAM_ACK_MESSAGE=Sedang diproses...
TELEGRAM_PROCESS_TIMEOUT_MS=90000
TELEGRAM_SUPPRESS_CONFLICT_ERRORS=true           # suppress polling conflict log
```

Pastikan hanya satu instance yang berjalan dengan bot token yang sama — polling conflict terjadi jika ada dua consumer sekaligus.

---

## Docker

Dockerfile menggunakan 2-stage build (builder → runtime). Runtime berjalan sebagai non-root user `openclaw`.

### Docker Compose — Deployment

**1. Buat folder persistent**

```bash
sudo mkdir -p data skills workspace
sudo chmod -R 775 data skills workspace
```

| Host | Container | Isi |
|------|-----------|-----|
| `./data` | `/data` | Sessions, settings, MCP config, JSON storage |
| `./skills` | `/skills` | Markdown skill files |
| `./workspace` | `/workspace` | Memory, reports, artifacts, workflow state |

**2. Konfigurasi `.env`**

```bash
cp .env.example .env && nano .env
```

Minimum untuk production:

```env
APP_ENV=production
NODE_ENV=production
APP_DATA_DIR=/data
SKILLS_DIR=/skills
WORKSPACE_DIR=/workspace
MCP_CONFIG_PATH=/app/mcp_agent.config.yaml
MCP_AGENT_CONFIG_PATH=/app/mcp_agent.config.yaml
STORAGE_BACKEND=file

API_ENABLED=true
API_HOST=0.0.0.0
API_PORT=18789
API_AUTH_TOKEN=ganti_token_ini

# Proxy — kosongkan jika tidak dibutuhkan
HTTP_PROXY=
HTTPS_PROXY=
NO_PROXY=localhost,127.0.0.1,::1,openclaw,ollama,host.docker.internal

# Provider keys — isi yang digunakan saja
GROQ_API_KEY=
OPENROUTER_API_KEY=
ZAI_API_KEY=
OLLAMA_BASE_URL=http://host.docker.internal:11434
```

> Jangan commit `.env`: `echo ".env" >> .gitignore`

**3. Fix bind-mount permissions**

```bash
docker compose run --rm --entrypoint id openclaw
# contoh output: uid=100(openclaw) gid=101(openclaw)
sudo chown -R 100:101 data skills workspace
```

Ganti `100:101` dengan UID/GID aktual dari output perintah di atas.

**Jika `SELF_HEALING_ENABLED=true` atau `SELF_UPGRADE_ENABLED=true`**, self-healing engine perlu menulis patch langsung ke source code (`/app/src`, `/app/test`, dll) yang di-bind-mount dari host. Direktori-direktori ini juga harus dimiliki oleh user `openclaw`:

```bash
sudo chown -R 100:101 src/ test/ tools/ scripts/ docs/ \
  package.json package-lock.json tsconfig.json Dockerfile docker-compose.yml README.md
sudo chmod -R 775 src/ test/ tools/ scripts/ docs/
```

Agar host user tetap bisa mengedit file-file tersebut tanpa `sudo`, tambahkan host user ke group `openclaw` (GID 101):

```bash
sudo groupadd -g 101 openclaw 2>/dev/null || true
sudo usermod -aG openclaw $(whoami)
newgrp openclaw   # aktifkan tanpa logout
```

> **Catatan**: Setelah `git pull` atau operasi yang me-reset ownership (misalnya `npm install` sebagai root), jalankan ulang `chown` di atas.

Untuk SELinux server, tambahkan `:Z` pada volume mount di `docker-compose.yml`.

**4. Build dan start**

```bash
docker compose build --no-cache
docker compose up -d
docker compose ps
docker compose logs -f openclaw
```

**5. Akses CLI**

```bash
docker attach native-openclaw
# Detach tanpa stop: Ctrl+P, lalu Ctrl+Q
# JANGAN Ctrl+C — akan menghentikan Node process
```

**6. Install OpenCode di Docker (opsional)**

Preferred approach: install di Dockerfile sebelum build.

```dockerfile
ARG INSTALL_OPENCODE=false
RUN if [ "$INSTALL_OPENCODE" = "true" ]; then npm install -g opencode-ai; fi
```

Atau gunakan build arg:

```bash
INSTALL_OPENCODE=true docker compose build --no-cache
```

### Docker Compose Referensi

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
        INSTALL_OPENCODE: ${INSTALL_OPENCODE:-false}

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
      WORKFLOW_FILE: /workspace/WORKFLOW.md
      TOOLS_DIR: /app/tools
      MCP_CONFIG_PATH: /app/mcp_agent.config.yaml
      MCP_AGENT_CONFIG_PATH: /app/mcp_agent.config.yaml
      STORAGE_BACKEND: file
      API_HOST: ${API_HOST:-0.0.0.0}
      API_PORT: ${API_PORT:-18789}
      OLLAMA_BASE_URL: ${OLLAMA_BASE_URL:-http://host.docker.internal:11434}

    volumes:
      - ./data:/data
      - ./skills:/skills
      - ./workspace:/workspace
      - ./data/opencode:/home/openclaw/.local/share/opencode

    ports:
      - "${API_PORT:-18789}:18789"
      - "${WEB_UI_PORT:-18790}:18790"

    extra_hosts:
      - "host.docker.internal:host-gateway"

    restart: unless-stopped
```

### Docker Compose Operations

```bash
docker compose up -d                              # Start
docker compose down                               # Stop
docker compose restart openclaw                   # Restart service
docker compose build --no-cache && docker compose up -d   # Rebuild
docker compose logs -f openclaw                   # Logs
docker compose exec openclaw sh                   # Shell
docker attach native-openclaw                     # Attach ke CLI
```

---

## Scripts

| Command | Keterangan |
|---------|-----------|
| `npm run dev` | Run dengan ts-node (tanpa build) |
| `npm run build` | Compile TypeScript ke `dist/` |
| `npm start` | Jalankan compiled output |
| `npm run start:watch:win` | Watch mode (Windows PowerShell) |
| `npm run start:watch:unix` | Watch mode (Unix/bash) |
| `npm run type-check` | Type-check tanpa emit |
| `npm run lint` | Jalankan ESLint |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run clean` | Hapus `dist/` |
| `npm test` | Jalankan full test suite |
| `npm run test:workspace` | Test workspace saja |
| `npm run test:scheduler` | Test scheduler saja |
| `npm run qa:phase3.5` | QA AgentGateway, ProviderRouter, MCP, security, dan report consistency |
| `npm run qa:docker-profiles` | Validasi service set Docker Compose per profile tanpa start container |
| `npm run package` | Build + zip untuk distribusi |

---

## Environment Variables

Salin `.env.example` ke `.env`. Referensi lengkap:

### App & Storage

| Variable | Default | Keterangan |
|----------|---------|-----------|
| `APP_ENV` | `development` | `development`, `production`, `test` |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `APP_DATA_DIR` | `.data` | Direktori storage (sessions, semantic memory) |
| `STORAGE_BACKEND` | `file` | `file` atau `memory` |
| `WORKSPACE_DIR` | `./workspace` | Root direktori workspace |
| `WORKSPACE_ALLOW_OUTSIDE_PATHS` | `false` | Izinkan path di luar workspace |

### Agent

| Variable | Default | Keterangan |
|----------|---------|-----------|
| `AGENT_MAX_TURNS` | `20` | Maks turns per session |
| `AGENT_TEMPERATURE` | `0.7` | Default temperature (0–2) |
| `AGENT_MAX_TOKENS` | `4096` | Default max output tokens |
| `AGENT_SYSTEM_PROMPT` | `You are a helpful AI assistant.` | Base system prompt |
| `REASONING_ENABLED` | `true` | Aktifkan reasoning-first step |
| `SEMANTIC_MEMORY` | `true` | Aktifkan semantic context compression |
| `REACT_ENABLED` | `true` | Aktifkan ReAct loop |
| `REACT_MAX_STEPS` | `4` | Maks steps per turn di ReAct |

### Skills

| Variable | Default | Keterangan |
|----------|---------|-----------|
| `SKILLS_DIR` | `./skills` | Direktori file skill |
| `SELF_IMPROVING` | `false` | Aktifkan auto skill extraction |
| `SELF_IMPROVING_EVAL_THRESHOLD` | `10` | Turns sebelum evaluasi |

### Router

| Variable | Default | Keterangan |
|----------|---------|-----------|
| `ROUTER_ENABLED` | `true` | Multi-provider router |
| `AUTO_FALLBACK` | `true` | Auto-switch saat provider gagal |
| `AUTO_SWITCH` | `true` | Proactive provider switching |

### Scheduler

| Variable | Default | Keterangan |
|----------|---------|-----------|
| `SCHEDULER_ENABLED` | `true` | Aktifkan scheduler |
| `SCHEDULER_TIMEZONE` | `Asia/Jakarta` | Timezone default cronjob |
| `SCHEDULER_TICK_MS` | `30000` | Interval check scheduler |
| `SCHEDULER_MAX_CONCURRENT_JOBS` | `2` | Maks job paralel |

### Self-Healing & Self-Upgrade

| Variable | Default | Keterangan |
|----------|---------|-----------|
| `SELF_HEALING_ENABLED` | `false` | Aktifkan self-healing |
| `SELF_HEALING_MAX_LOOPS` | `3` | Maks loop per healing run |
| `SELF_HEALING_AUTO_ROLLBACK` | `true` | Rollback otomatis jika gagal |
| `SELF_UPGRADE_ENABLED` | `false` | Aktifkan self-upgrade |
| `SELF_UPGRADE_AUTO_RESTART` | `true` | Exit code 42 setelah upgrade |
| `AUTONOMOUS_CODING_TEMPERATURE` | `0.1` | Temperature untuk coding agent |

---

## Troubleshooting

### OpenCode: `Model not found: opencode-zen/...`

Gunakan prefix `opencode/`, bukan `opencode-zen/`:

```jsonc
"model": "opencode/deepseek-v4-flash-free"
```

### OpenCode: `Unexpected server error` atau auth error

```bash
opencode run /connect
```

Atau via `.env`:

```env
OPENCODE_AUTH_BOOTSTRAP=true
OPENCODE_ZEN_API_KEY=your_key
OPENCODE_AUTH_PROVIDER=opencode
```

### OpenCode: `spawn opencode ENOENT` di Windows

```env
OPENCODE_AGENT_COMMAND=opencode.cmd
```

### OpenCode: Proses hang tidak berhenti

```env
OPENCODE_AGENT_TIMEOUT_MS=900000
OPENCODE_AGENT_KILL_GRACE_MS=10000
OPENCODE_AGENT_KILL_TREE=true
```

Windows — cek dan kill proses:

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "opencode" }
taskkill /PID <PID> /T /F
```

### Docker: `EACCES: permission denied, mkdir '/workspace/state'`

Container tidak bisa menulis ke bind-mounted folder.

```bash
docker compose down
sudo mkdir -p data skills workspace
sudo chmod -R 775 data skills workspace
docker compose run --rm --entrypoint id openclaw     # ambil UID/GID
sudo chown -R 100:101 data skills workspace          # ganti 100:101 dengan UID:GID aktual
docker compose up -d
```

Untuk SELinux: tambahkan `:Z` pada setiap volume di `docker-compose.yml`.

### Docker: Self-Healing `EACCES: permission denied, copyfile ... -> /app/src/...`

Error ini berbeda dari EACCES pada `/workspace`. Self-healing engine mencoba menulis patch hasil analisis ke `/app/src/` (atau `/app/test/`, `/app/tools/`, dst), namun direktori-direktori tersebut di-bind-mount dari host dengan kepemilikan host user — bukan user `openclaw` di container.

**Gejala di log:**
```
Error: EACCES: permission denied, copyfile
  'workspace/self-healing/runs/heal-xxx/snapshot/files/src/...'
  -> '/app/src/...'
```

**Penyebab:** Bind mount `./src:/app/src` di `docker-compose.yml` mewarisi ownership host (UID host, biasanya 1000). Container berjalan sebagai `openclaw` (UID ~100) yang tidak punya write access ke file-file tersebut.

**Fix:**

```bash
docker compose down

# 1. Ambil UID/GID openclaw dari image
docker compose run --rm --entrypoint id openclaw
# contoh: uid=100(openclaw) gid=101(openclaw)

# 2. Chown semua source bind-mount directories di host
sudo chown -R 100:101 src/ test/ tools/ scripts/ docs/ \
  package.json package-lock.json tsconfig.json Dockerfile docker-compose.yml README.md
sudo chmod -R 775 src/ test/ tools/ scripts/ docs/

# 3. Agar host user tetap bisa edit tanpa sudo
sudo groupadd -g 101 openclaw 2>/dev/null || true
sudo usermod -aG openclaw $(whoami)
newgrp openclaw

docker compose up -d
```

**Fix permanen via entrypoint** (tidak perlu chown ulang setelah git pull):

Buat file `entrypoint.sh` di root project:

```bash
#!/bin/sh
# Fix ownership bind-mounted source dirs agar self-healing bisa write patch
chown -R openclaw:openclaw /app/src /app/test /app/tools /app/scripts /app/docs 2>/dev/null || true
exec su-exec openclaw node --enable-source-maps dist/index.js
```

Lalu modifikasi `Dockerfile` di runtime stage, tepat sebelum `USER openclaw`:

```dockerfile
COPY --chown=root:root entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
# USER openclaw   ← baris ini tetap ada di bawahnya

ENTRYPOINT ["/entrypoint.sh"]
# (hapus baris: ENTRYPOINT ["node", "--enable-source-maps", "dist/index.js"])
```

Rebuild container:

```bash
docker compose build --no-cache && docker compose up -d
```

### Docker: Warning `.env not found at /app/.env`

Aman diabaikan jika menggunakan `env_file` di Compose — variabel sudah diinjeksi ke `process.env`. Untuk menghilangkan warning, mount eksplisit:

```yaml
volumes:
  - ./.env:/app/.env:ro
```

Verifikasi variabel ter-load:

```bash
docker compose exec openclaw env | grep -E "API|GROQ|ZAI"
```

### Docker: `curl: (56) Recv failure: Connection reset by peer`

Penyebab umum: container masih restart, API tidak listen di `0.0.0.0`, atau crash di handler.

```bash
docker compose ps
docker compose logs --tail=100 openclaw
docker compose exec openclaw env | grep -E "API_ENABLED|API_HOST|API_PORT"
```

Pastikan `.env` memiliki:

```env
API_ENABLED=true
API_HOST=0.0.0.0
API_PORT=18789
```

### Docker: Provider `fetch failed`

Biasanya masalah proxy atau network, bukan API key.

```bash
# Test proxy dari host
curl -x "http://IP:port" -I https://api.groq.com/v1

# Cek proxy di dalam container
docker compose exec openclaw env | grep -Ei "HTTP_PROXY|HTTPS_PROXY|NO_PROXY"
```

Startup log harus menampilkan `Global HTTP proxy enabled` jika proxy terkonfigurasi.

### Docker: API `401 Unauthorized`

Pastikan `API_AUTH_TOKEN` di `.env` sama persis dengan header `Authorization: Bearer` di request.

### Docker: Cannot access host folder (misalnya Downloads)

Container hanya melihat path yang di-mount. Tambahkan bind mount di `docker-compose.yml`:

```yaml
volumes:
  - /home/user/Downloads:/host/Downloads:ro
```

Lalu minta agent mengakses `/host/Downloads`.

### Telegram: Polling conflict

Hanya satu instance yang boleh berjalan dengan bot token yang sama. Pastikan tidak ada container atau proses lain yang menggunakan token yang sama. Jika pernah menggunakan webhook, hapus terlebih dahulu via Telegram Bot API.

### Self-upgrade: Container berhenti dan tidak restart

Gunakan `restart: unless-stopped` di Docker Compose. Jika menggunakan `npm start` tanpa supervisor:

```bash
npm start
# atau
docker compose up -d
pm2 restart smooth
```

Aktifkan notifikasi agar tahu kapan restart terjadi:

```env
RESTART_NOTIFICATION_ENABLED=true
RESTART_NOTIFY_TELEGRAM=true
```

---

## Project Structure

```
native-openclaw/
├── src/
│   ├── index.ts                    # Bootstrap v8 — entry point
│   ├── agents/
│   │   ├── orchestrator.ts         # Reasoning-first turn loop
│   │   ├── reasoning-engine.ts     # Internal tool decision layer
│   │   ├── react-loop.ts           # ReAct (Reason→Action→Observe→Answer)
│   │   ├── tool-loop.ts            # LLM + tool call execution
│   │   ├── prompt-builder.ts       # System prompt assembly
│   │   └── message-assembler.ts    # Sliding-window context prep
│   ├── providers/                  # groq, mistral, openrouter, ollama,
│   │   └── ...                     # zai, sambanova, puter, gemini, dll
│   ├── router/
│   │   ├── provider-router.ts      # Central router
│   │   ├── provider-health.ts      # Health tracking per provider
│   │   ├── routing-strategy.ts     # Task-aware scoring
│   │   └── fallback-manager.ts     # Auto-fallback logic
│   ├── memory/
│   │   ├── semantic-memory.ts      # TF-IDF local semantic store
│   │   └── context-compressor.ts   # Context window management
│   ├── skills/
│   │   ├── registry.ts             # Skill activation & injection
│   │   ├── self-improving-engine.ts # Auto skill extraction loop
│   │   └── skill-evaluator.ts      # Quality evaluation
│   ├── self-healing/
│   │   ├── self-healing-engine.ts  # Autonomous bug-fix orchestrator
│   │   ├── self-upgrade-engine.ts  # Autonomous feature implementor
│   │   ├── bug-analyzer-agent.ts   # Root cause analysis
│   │   ├── patch-planner.ts        # Diff planning
│   │   ├── patch-applier.ts        # File modification
│   │   ├── qa-agent.ts             # Post-patch quality check
│   │   └── snapshot-manager.ts     # Rollback checkpoint
│   ├── prompt-optimizer/           # Context compression & intent classification
│   ├── scheduler/                  # Cronjob engine, store, types
│   ├── tools/
│   │   ├── tool-registry.ts        # Plugin-based tool registry
│   │   ├── plugins/                # Built-in tool plugins
│   │   └── opencode-agent.ts       # External coding agent wrapper
│   ├── mcp/                        # Model Context Protocol integration
│   ├── api/                        # HTTP REST API server
│   ├── web-ui/                     # smooth — Web chat UI
│   ├── integrations/               # Telegram bot integration
│   ├── workflows/                  # WORKFLOW.md runner
│   ├── workspace/                  # Local-first agent workspace
│   ├── storage/                    # Session, settings, memory managers
│   ├── network/                    # Proxy & DNS configuration
│   └── config/                     # Env loader & Zod validator
├── skills/                         # Drop .md skill files here
├── workspace/                      # Agent workspace (auto-created)
├── data/                           # Storage: sessions, semantic memory
├── tools/                          # Installed external tools
├── Dockerfile                      # 2-stage build (builder → runtime)
├── docker-compose.yml
└── .env.example
```

---

## License

MIT
