# Product Requirements Document (PRD)

# Native OpenClaw — Modular Autonomous Agent Runtime

| Metadata | Value |
|---|---|
| Product | Native OpenClaw |
| Document | Product Requirements Document |
| Version | 1.0 (Roadmap Baseline) |
| Status | Proposed — for product and technical planning |
| Baseline repository | `https://github.com/farisi55/native-openclaw` |
| Baseline branch | `main` |
| Baseline review date | 13 November 2026 |
| Primary implementation language | TypeScript / Node.js |
| Primary deployment model | Local-first runtime, with optional remote services |
| Special deployment target | Android / Termux ARM32 (X98 Mini) |

---

## 1. Executive Summary

Native OpenClaw is a modular, multi-provider autonomous AI agent runtime. It is intended to help users complete multi-step work through a consistent agent interface, with access to tools, local files, automation, memory, skills, external agents and communication channels.

The project already has a substantial foundation: provider adapters and routing, an orchestrator, tool execution, MCP client support, sessions, semantic memory, Markdown skills, workspace management, scheduling, Telegram integration, HTTP API, Web UI, self-improvement and self-healing components.

The next stage is not a rewrite and not a literal clone of Hermes Agent. The objective is to strengthen the existing core, close the most important capability gaps, and preserve Native OpenClaw's differentiators:

1. Lightweight TypeScript-first architecture.
2. Multi-provider routing and automatic fallback.
3. Local-first data and workspace ownership.
4. Self-improvement, self-healing and self-upgrade.
5. Extensible tools, MCP and agent connectors.
6. Ability to run on constrained environments, including a specifically validated Termux ARM32 target.

This PRD defines the target product, requirements, architecture direction, priorities, phased delivery, acceptance criteria and release gates.

## 2. Product Vision

Build a lightweight, modular and reliable autonomous agent runtime that can:

- Understand a user's objective and plan the required work.
- Select and execute tools through a provider-independent tool interface.
- Perform multi-step tasks and delegate bounded work to subagents.
- Search the web and operate a real browser when configured.
- Work with files, terminals and project context within explicit security boundaries.
- Retain useful memory across turns and sessions.
- Learn reusable procedures through a controlled skills system.
- Run scheduled workflows and deliver results through supported channels.
- Recover from failures safely and improve its own code through auditable workflows.
- Run locally without requiring Docker, while allowing optional remote execution services.

### Product positioning

**Native OpenClaw is a lightweight, local-first, multi-provider autonomous agent runtime with extensible execution backends and self-maintenance capabilities.**

It should be useful as:

- An interactive personal AI agent.
- A coding and repository assistant.
- A local automation and workflow engine.
- A multi-channel assistant gateway.
- A modular runtime that can run on desktop/server and, after validation, Android Termux ARM32.

## 3. Product Principles

1. **Extend, do not rewrite.** Reuse working modules and introduce abstractions around them. Refactor only when a clear requirement or measurable reliability issue justifies it.
2. **Local-first, remote-optional.** Core chat, sessions, skills, workspace and supported local tools must not depend on a remote control plane.
3. **Capability-based modularity.** Browser, terminal, messaging, memory and subagents must be behind replaceable interfaces.
4. **Provider independence.** Agent behavior must not depend on one LLM vendor's proprietary tool-call format.
5. **Safe by default.** External content is untrusted; privileged actions are controlled by policy and approval.
6. **Progressive capability loading.** Load only the tools, skills and context necessary for the current task.
7. **Observable execution.** Every task must expose status, steps, tool outcomes, errors and traceable identifiers without exposing private reasoning.
8. **Constrained-device compatibility.** Avoid unnecessary native dependencies in the core runtime. Optional heavy capabilities must be remotely executable or independently installable.
9. **Backward compatibility.** Existing CLI commands, settings, session data and workspace files should remain usable through planned migrations.
10. **Honest capability reporting.** A feature is not considered implemented because a scaffold, configuration flag or connector exists. Runtime behavior must pass acceptance tests.

## 4. Current Product Baseline

This section describes the repository state observed during a static review of `main` on 13 November 2026. It is not a claim that every feature has been validated in a running environment.

### 4.1 Existing capabilities

| Domain | Existing implementation | Baseline assessment |
|---|---|---|
| LLM providers | Multiple provider adapters, model discovery, health tracking, routing and fallback | Strong foundation |
| Orchestration | Reasoning engine, orchestrator, tool loop, context compression | Present; execution contract needs modernization |
| Tools | Built-in tools, manifest-based plugin registry, tool validation | Present |
| MCP | MCP client, configuration, server manager and tool adapter | Present; process environment requires hardening |
| Sessions | JSON-backed session CRUD and resume | Present; cross-session search is missing |
| Memory | Key/value memory, keyword-based semantic chunks, workspace memory files | Basic-to-intermediate |
| Skills | Markdown skills, registry, relevance selection, extraction and evaluation | Present; discovery/loading standardization needed |
| Workspace | Local workspace, core context files, reports, artifacts, backup and trash | Strong foundation |
| Scheduler | Natural-language scheduling, cron/interval/daily/weekly/monthly jobs | Strong foundation |
| Integrations | Telegram, HTTP API, Web UI, Brevo email | Limited channel coverage |
| Agent gateway | Internal and external connectors, capability routing and result validation | Present; not yet a generic child-agent runtime |
| Self-maintenance | Self-healing, patch generation, QA, rollback and self-upgrade | Differentiating capability |
| Browser | Search/fetch tools and a browser-agent scaffold | Real browser runtime not implemented |
| Research worker | External worker scaffold | Crawler/backend adapter not implemented |
| Spreadsheet worker | External worker scaffold | Google Sheets/MCP adapter not implemented |
| Terminal | Local shell execution with risk classification and approval | Present; isolated backend abstraction missing |
| Streaming | Provider base currently sends non-streaming requests | Missing in core provider contract |
| Native structured tools | Tool calls are currently represented through a structured JSON response contract in the agent loop | Vendor-native function/tool calling abstraction missing |
| Termux ARM32 | No dedicated verified build/test pipeline identified | Unverified |

### 4.2 Existing modules to reuse

The following are existing implementation anchors. New work should extend these modules or add adapters around them rather than duplicating their responsibilities.

| Module | Repository path |
|---|---|
| Agent orchestration | `src/agents/orchestrator.ts` |
| Tool loop and parser | `src/agents/tool-loop.ts` |
| Reasoning engine | `src/agents/reasoning-engine.ts` |
| Provider adapters | `src/providers/` |
| Provider routing | `src/router/` |
| Tool registry and executor | `src/tools/tool-registry.ts`, `src/tools/tool-executor.ts` |
| MCP | `src/mcp/` |
| Session storage | `src/storage/session-manager.ts`, `src/storage/json-store.ts` |
| Memory | `src/memory/`, `src/storage/memory-manager.ts` |
| Skills | `src/skills/` |
| Workspace | `src/workspace/` |
| Scheduler | `src/scheduler/` |
| Agent gateway | `src/agent-gateway/` |
| Telegram | `src/integrations/telegram.ts` |
| API and Web UI | `src/api/`, `src/web-ui/` |
| Self-healing | `src/self-healing/` |

### 4.3 Baseline gaps to close

1. Provider-independent tool/function calling and streaming response support.
2. Searchable session history and stronger long-term memory lifecycle.
3. Context discovery from repository/project directories.
4. MCP subprocess environment isolation and stronger security boundaries.
5. Actual browser, research and spreadsheet worker implementations.
6. Generic subagent lifecycle and bounded parallel execution.
7. Isolated terminal backends and background process management.
8. Unified messaging adapter architecture beyond Telegram.
9. Progressive skill loading and Agent Skills compatibility.
10. Multimodal tool contracts, credential management and a more capable TUI.
11. Dedicated ARM32/Bionic compatibility testing and Termux packaging.

## 5. Goals and Success Metrics

### 5.1 Product goals

- G1: Make the core agent loop reliable across different LLM providers.
- G2: Make multi-step execution observable, resumable and safe.
- G3: Make conversation history and memory useful across sessions.
- G4: Support complex tasks through subagents and parallel execution.
- G5: Provide real browser and terminal automation through replaceable backends.
- G6: Make tools, skills and communication channels extensible through stable contracts.
- G7: Preserve self-healing, self-improvement and self-upgrade as first-class capabilities.
- G8: Validate a no-PRoot/no-QEMU Termux ARM32 deployment path.

### 5.2 Success metrics

Metrics below are target acceptance thresholds. They are not current measured performance claims. Baselines must be collected before optimization claims are made.

| Metric | Target |
|---|---|
| Existing core regression tests | 100% passing before each release candidate |
| Provider non-streaming compatibility | No regression for existing supported providers |
| Streaming event correctness | Ordered events; one terminal completion/error event per request |
| Tool invocation correctness | Validated tool name and schema before execution; no silent unknown-tool execution |
| Session search | Search result includes session ID, timestamp, role and matching excerpt |
| Memory provenance | Every stored memory item includes source, timestamp and confidence/importance metadata |
| Subagent isolation | Child session and task context do not mutate parent conversation history |
| Parallel execution | Enforces configured concurrency, timeout and cancellation limits |
| Privileged action safety | Dangerous operation cannot run without policy approval |
| MCP environment | Only explicitly configured environment variables reach MCP child processes |
| Browser execution | Acceptance flows pass against a controlled test website |
| Termux ARM32 | Install, build, run, provider smoke test and core tests execute on the physical target without PRoot/QEMU |
| Portability | Core build and test remain independent of Docker |

### 5.3 Non-goals

The following are not required for the first three phases:

- Reaching complete feature parity with Hermes or any other agent framework.
- Building a hosted SaaS control plane or multi-tenant cloud service.
- Implementing a public skills marketplace with billing and payments.
- Training or fine-tuning proprietary foundation models.
- Building a custom browser engine.
- Requiring Kubernetes, a vector database or a cloud database for core operation.
- Bundling Chromium, large models or heavy media runtimes into the core Termux installation.
- Enabling unrestricted autonomous shell execution or unrestricted self-modification.

## 6. Users and Primary Use Cases

### 6.1 Primary users

1. **Developer / technical operator:** uses Native OpenClaw to inspect repositories, fix code, run tests, automate repetitive technical tasks and manage workflows.
2. **Power user / entrepreneur:** uses it for research, reports, scheduling, data processing and recurring tasks.
3. **Local-device operator:** runs the agent on a local machine or constrained Android device and expects data/control to remain local unless remote execution is explicitly configured.

### 6.2 Primary use cases

- Ask a question that requires several tools and receive a verified answer.
- Search a previous conversation and resume a project using relevant context.
- Ask the agent to inspect a repository, make a bounded code change and run tests.
- Ask the agent to navigate a web application, fill a form or collect information through a browser.
- Split a complex task into research, coding and verification sub-tasks.
- Schedule a recurring task and receive its result on a supported messaging channel.
- Store and reuse a skill for a repeated procedure.
- Detect a failure, propose a patch, run QA and present the result for approval.
- Run the core runtime directly in Termux ARM32 without a Linux userspace emulator.

## 7. Target Architecture

### 7.1 Logical architecture

```text
                         User Interfaces
             CLI / TUI / Web UI / HTTP API / Messaging
                               |
                               v
                       Messaging / API Gateway
                               |
                               v
                        Agent Orchestrator
                 Intent / Plan / Context / Policy
                               |
             +-----------------+------------------+
             |                 |                  |
             v                 v                  v
        Memory Service     Skill Service      Session Service
             |                 |                  |
             +-----------------+------------------+
                               |
                               v
                      Execution Coordinator
                               |
             +-----------------+------------------+
             |                 |                  |
             v                 v                  v
         Tool Runtime      Subagent Manager   Workflow/Scheduler
             |                 |
      +------+------+          +-----------------------+
      |      |      |          |          |            |
      v      v      v          v          v            v
    MCP   Browser  Terminal  Research   Coding      Other agents
      |   Backend  Backend   Agent      Agent
      |
      v
  Provider Abstraction / Native Tool Calling / Streaming
      |
      v
  Provider Router / LLM Adapters / Model Registry

Cross-cutting services:
  Security Policy | Credential Store | Audit Log | Telemetry | Config
  Local Storage  | Optional Remote Backends | Lifecycle Manager
```

### 7.2 Architectural boundaries

- **Core runtime:** orchestrator, provider abstraction, tool contracts, session, memory, skill loading, policy and storage interfaces.
- **Execution adapters:** MCP, browser, terminal, file operations, external agents and background processes.
- **Interfaces:** CLI/TUI, Web UI, HTTP API and messaging channels.
- **Optional services:** remote browser, remote research, remote terminal, external model endpoints and third-party integrations.
- **Platform adapters:** desktop/server and Android/Termux. Platform-specific behavior must not leak into domain logic.

### 7.3 Proposed core interfaces

All interfaces below are conceptual contracts. Implementation details and exact types should be finalized in the Technical Design Document (TDD) before coding.

```typescript
interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: unknown;
  riskLevel: "safe" | "warning" | "dangerous";
  execute(input: TInput, context: ToolExecutionContext): Promise<TOutput>;
}

interface ProviderCapabilities {
  streaming: boolean;
  nativeToolCalling: boolean;
  vision: boolean;
  audioInput: boolean;
  audioOutput: boolean;
}

interface ProviderAdapter {
  id: string;
  capabilities: ProviderCapabilities;
  chat(request: ChatRequest): Promise<ChatResponse>;
  stream?(request: ChatRequest): AsyncIterable<ChatEvent>;
}

interface ExecutionBackend {
  id: string;
  capabilities: string[];
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
  startProcess?(request: ProcessRequest): Promise<ProcessHandle>;
}

interface MemoryStore {
  search(query: string, options?: MemorySearchOptions): Promise<MemorySearchResult[]>;
  store(item: MemoryItem): Promise<void>;
  update(id: string, patch: Partial<MemoryItem>): Promise<void>;
  delete(id: string): Promise<void>;
}

interface MessagingAdapter {
  id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<DeliveryResult>;
  onMessage(handler: (message: InboundMessage) => Promise<void>): void;
}
```

### 7.4 Compatibility strategy

- Existing provider `chat()` behavior remains supported.
- Streaming is additive through a new event contract; callers may fall back to non-streaming when unsupported.
- Tool calling is normalized into a provider-independent internal representation.
- A provider can support native tool/function calls or the existing structured-text fallback.
- Existing session JSON remains readable; schema changes use versioned migrations or compatibility readers.
- Existing CLI commands remain aliases where practical.
- Existing tools and MCP integrations are adapted to the new tool contract incrementally.

## 8. Functional Requirements

Priority definitions:
- **P0:** required for the phase to be considered complete.
- **P1:** important capability, may follow after P0 acceptance.
- **P2:** enhancement, not release-blocking for the first target release.

### 8.1 Phase 1 — Core Agent Reliability

**Objective:** establish a consistent execution contract, durable context and safe process boundaries.

#### FR-CORE-001 — Provider-independent tool calling (P0)

The runtime shall expose one internal tool-call model independent of vendor API schemas.

Requirements:
- Convert provider-native tool calls into a normalized internal representation.
- Convert normalized tool definitions into each provider's supported schema.
- Validate tool name, arguments and JSON schema before executing a tool.
- Support multiple tool calls in one assistant response when the provider supports it.
- Preserve the existing structured JSON response mode as a compatibility fallback.
- Return structured tool result messages to the model with correct call identifiers where supported.
- Reject malformed, unknown or unauthorized tool calls safely.
- Record tool call ID, tool name, input summary, execution time, result status and error classification.

Acceptance criteria:
- At least one provider using native tool/function calling completes a multi-tool task.
- A provider without native tool calling continues to work through the fallback adapter.
- Invalid schema, unknown tool and duplicate tool-call ID tests are covered.
- Existing provider and tool-loop tests remain green.

#### FR-CORE-002 — Streaming provider responses (P0)

The runtime shall stream model output and execution status to supported interfaces.

Requirements:
- Define normalized events such as `message_start`, `text_delta`, `tool_call`, `tool_result`, `usage`, `message_complete` and `error`.
- Support cancellation through `AbortSignal`.
- Expose provider capability detection and non-streaming fallback.
- Avoid duplicating or reordering streamed text.
- Persist the final assembled assistant response and tool trace consistently.

Acceptance criteria:
- CLI displays text before the model has completed the whole response for a streaming provider.
- Tool-call events appear in order relative to their results.
- Cancellation stops upstream work when the provider supports cancellation.
- Non-streaming providers still produce the same final response contract.

#### FR-CORE-003 — Searchable sessions with SQLite FTS5 (P0)

The runtime shall index conversations for full-text search.

Requirements:
- Introduce a `SessionSearchStore` abstraction.
- Implement a SQLite FTS5 backend with a configurable local database path.
- Index session ID, message ID, timestamp, role, provider/model and searchable message text.
- Provide search by query, date range, role and optional session/project filters.
- Return relevant excerpts with session references; never silently inject an entire historical session.
- Keep the source session store authoritative and provide reindex/rebuild support.
- Add CLI and agent tool operations for search and retrieval of matching messages.

Acceptance criteria:
- Search finds known phrases in old sessions after application restart.
- Search results include session ID, timestamp, role and excerpt.
- Deleted sessions/messages are removed from or reconciled with the index.
- Rebuilding the index produces the same searchable records.
- If the selected SQLite implementation needs a native module, its installation is validated on all declared target platforms, including Termux ARM32, before adoption.

#### FR-CORE-004 — Memory lifecycle and consolidation (P0)

The runtime shall distinguish raw conversation history from durable memory.

Requirements:
- Support memory categories: user preference, user profile, project fact, decision, procedure, environment note and temporary fact.
- Store provenance: source session/message, timestamp, extractor, confidence and importance.
- Detect possible duplicates and conflicting values.
- Consolidate candidate memories into reviewed durable memory.
- Provide explicit inspect, update, forget and export operations.
- Apply retention policy separately to raw chunks, session index and durable memory.
- Do not treat keyword similarity as true semantic understanding; expose retrieval method and score type.
- Allow memory extraction to be disabled and memory writes to be reviewed.

Acceptance criteria:
- A memory can be traced to its source.
- Conflicting profile facts are surfaced rather than silently overwritten.
- User-requested deletion removes the item from the durable store and search index.
- Consolidation does not delete source sessions.
- A test suite covers duplicate, conflict, stale and low-confidence memory candidates.

#### FR-CORE-005 — User profile model (P1)

The runtime shall manage a structured, editable user profile independently from conversation transcripts.

Requirements:
- Separate durable preferences and project facts from inferred or temporary observations.
- Allow the user to inspect and edit profile entries.
- Support opt-out for specific memory categories.
- Do not persist secrets, authentication factors or sensitive information without an explicit product requirement and user consent.

Acceptance criteria:
- Profile facts are readable and editable through CLI/API.
- Every profile change is auditable.
- Disabling profile memory prevents new profile extraction.

#### FR-CORE-006 — MCP environment isolation (P0)

MCP subprocesses shall receive only the environment variables explicitly required by their configuration and the runtime allowlist.

Requirements:
- Replace blanket inheritance of `process.env` with an explicit environment builder.
- Support per-server `env` values and named secret references.
- Deny forwarding common secret-bearing environment variables unless explicitly approved.
- Redact credentials from logs and error messages.
- Validate command, arguments, working directory and package source before launching a server.
- Provide per-server permission and lifecycle controls.

Acceptance criteria:
- Unit test proves an unrelated API key in the parent environment is not visible to an MCP child process.
- Explicitly configured MCP variables are available to the child process.
- Secrets do not appear in application logs or tool results.
- Existing MCP startup, call and shutdown tests remain green.

#### FR-CORE-007 — Project context discovery (P0)

The runtime shall discover relevant instruction files based on the active working directory and project root.

Requirements:
- Discover supported files such as `AGENTS.md`, `CLAUDE.md`, `.claude/` project rules and Native OpenClaw-specific context files.
- Define a deterministic precedence order for global, workspace, repository-root and nested-directory instructions.
- Respect file size limits and context token budgets.
- Do not follow symlinks outside permitted roots without policy approval.
- Treat repository instructions and fetched content as untrusted data; they cannot override runtime security policy.
- Cache discovered context with file modification invalidation.

Acceptance criteria:
- A project-root instruction file is loaded for a repository task.
- A nested instruction file applies only to files/tasks within its scope.
- Conflicting instructions follow documented precedence.
- Context files cannot disable approval requirements or leak secrets.

#### FR-CORE-008 — Execution trace and task state (P1)

Every user task shall have a stable task ID and observable lifecycle.

Requirements:
- Track queued, running, waiting-for-approval, completed, failed, cancelled and timed-out states.
- Persist safe execution metadata and tool results.
- Provide a task detail view and trace export.
- Keep private model reasoning out of user-visible traces.

Acceptance criteria:
- A task can be inspected after restart.
- Tool error and timeout are distinguishable from model failure.
- Trace contains no raw secrets or private reasoning.

### 8.2 Phase 2 — Autonomous Agent Capability

**Objective:** allow Native OpenClaw to perform complex work through real browser interaction, delegation and controlled execution backends.

#### FR-AUTO-001 — Real browser automation (P0)

The runtime shall operate a real browser through a replaceable browser backend.

Requirements:
- Define `BrowserBackend` independent of Playwright, CDP or remote browser vendor.
- Support navigation, wait, click, type, select, scroll, screenshot and page inspection.
- Support downloads/uploads under workspace policy.
- Support multiple named browser sessions with explicit persistence behavior.
- Capture page URL, title, relevant content, screenshot references and action outcomes.
- Provide timeouts and cancellation for each operation.
- Treat web page text, DOM content and downloads as untrusted input.
- Do not expose cookies, passwords or access tokens in model context, logs or screenshots by default.
- Keep authentication credentials in a separate credential mechanism.
- Browser worker health check must verify actual runtime readiness, not only HTTP process readiness.

Deployment options:
- Local Playwright/CDP backend on capable desktop/server systems.
- Remote browser backend for constrained systems such as Termux ARM32.
- Browser runtime must remain optional and must not inflate the core runtime package.

Acceptance criteria:
- Browser worker can navigate a controlled test site and extract a specified value.
- Click/type/select flow passes against a deterministic test fixture.
- Screenshot is stored in the configured artifact directory.
- Session isolation and authentication redaction tests pass.
- The old `BROWSER_RUNTIME_NOT_IMPLEMENTED` scaffold response is eliminated for an enabled, supported backend.

#### FR-AUTO-002 — Generic subagent manager (P0)

The runtime shall delegate bounded tasks to child agents.

Requirements:
- Introduce a `SubagentManager` independent of specific agent connectors.
- Create a child task with its own ID, session/context boundary and execution budget.
- Support explicit capability, provider/model and tool allowlists.
- Limit delegation depth and prevent unbounded recursive delegation.
- Support wait, poll, cancel and result retrieval.
- Return concise result, artifacts, changed files, status and validation metadata to the parent.
- Child agents must not automatically inherit privileged tools or parent secrets.
- Record parent-child task relationships.

Acceptance criteria:
- Parent can delegate a bounded research task and receive a structured result.
- Child messages do not appear in the parent session transcript unless summarized/attached.
- Child cannot access forbidden paths or unapproved tools.
- Timeout and cancellation propagate correctly.

#### FR-AUTO-003 — Bounded parallel execution (P0)

The runtime shall execute independent sub-tasks concurrently.

Requirements:
- Support a task graph with dependencies.
- Enforce global and per-user concurrency limits.
- Enforce per-task timeout and resource budgets.
- Cancel dependent tasks when prerequisites fail, according to task policy.
- Aggregate completed, failed and cancelled results without losing partial output.
- Avoid concurrent writes to the same file unless an explicit conflict strategy exists.

Acceptance criteria:
- Two independent test tasks execute concurrently within configured limits.
- A dependent task waits for required predecessors.
- File-write conflict is detected and not silently overwritten.
- A failed child does not incorrectly mark all other completed tasks as failed.

#### FR-AUTO-004 — Terminal backend abstraction (P0)

Shell execution shall be provided by replaceable execution backends.

Requirements:
- Define local, Docker and SSH backend adapters; additional cloud adapters may follow.
- Keep the current `system-execute` risk classifier and approval semantics as policy inputs.
- Support per-task working directory, environment allowlist, timeout and output limits.
- Enforce workspace/path restrictions and prohibit implicit access to secret files.
- Docker backend shall use non-root user, bounded CPU/memory, restricted mounts and network policy where supported.
- SSH backend shall use configured host credentials and host allowlists.
- Backend capability must be reported accurately; unavailable backend must fail closed.
- Local backend is required for supported native Termux execution; Docker is optional and not a Termux prerequisite.

Acceptance criteria:
- Local backend executes approved test commands.
- Docker backend executes in an isolated container on supported host.
- A forbidden path is inaccessible from the sandboxed backend.
- Dangerous commands cannot bypass approval by selecting another backend.

#### FR-AUTO-005 — Background process manager (P1)

The runtime shall manage long-running commands and agent jobs.

Requirements:
- Start process and return a stable process handle.
- Support status, output tail, wait, interrupt and terminate operations.
- Store stdout/stderr in bounded log files or streams.
- Record process owner, task ID, working directory and creation time.
- Enforce timeout and cleanup orphan policy after restart.
- Do not require `node-pty` or other native dependencies in the core unless platform compatibility is proven.

Acceptance criteria:
- A background command can be started, inspected and terminated.
- Process output can be retrieved after command completion.
- Orphaned processes are detected and handled according to policy.

#### FR-AUTO-006 — Robust file operations (P0)

The runtime shall support safe repository and workspace file operations.

Requirements:
- Read files with size and encoding limits.
- List and search directories while respecting ignore patterns and path boundaries.
- Write files atomically where possible.
- Apply unified diffs with context validation.
- Produce preview/diff before modification when policy requires it.
- Preserve backups or rollback metadata for agent-generated changes.
- Never permanently delete files without explicit policy authorization.

Acceptance criteria:
- Patch applies only when expected context matches.
- Invalid or stale patch is rejected without partial corruption.
- Path traversal and symlink escape tests pass.
- Modified file list and diff summary are attached to the task trace.

#### FR-AUTO-007 — Research and spreadsheet adapters (P1)

Existing worker scaffolds shall become functional only when a real backend is configured.

Requirements:
- Research agent must use an actual crawler/search backend and return source URLs, retrieval timestamps and evidence excerpts.
- Spreadsheet agent must support a defined Google Sheets or MCP API contract with read/write scopes.
- Both must validate inputs, enforce authentication and provide operational health checks.
- No placeholder 501 worker may be reported as available.

Acceptance criteria:
- Research worker returns verifiable source records for a test query.
- Spreadsheet worker reads and writes a controlled test sheet when configured.
- Missing credentials/backend produces a clear unavailable status.

### 8.3 Phase 3 — Agent Ecosystem

**Objective:** make Native OpenClaw accessible through more channels and easier to extend, operate and personalize.

#### FR-ECO-001 — Unified messaging gateway (P0)

The runtime shall expose one channel-independent message contract.

Requirements:
- Define normalized inbound/outbound message envelope.
- Include channel, account, chat, sender, message ID, attachments and reply/thread metadata.
- Implement a common adapter lifecycle: start, stop, health, receive, send and delivery status.
- Route channel messages to isolated sessions according to configured identity and access policy.
- Support allowlists, rate limits, retries and idempotency.
- Preserve current Telegram integration through an adapter migration.
- Add new channels incrementally; WhatsApp, Discord and Slack are initial candidates.

Acceptance criteria:
- Telegram works through the new gateway without losing existing user/session mapping.
- A second channel can be integrated without modifying the core orchestrator.
- Unauthorized sender cannot invoke agent tools.
- Retry does not create duplicate task execution for the same inbound message ID.

#### FR-ECO-002 — Progressive skill loading (P0)

The runtime shall load skill metadata first and full skill instructions only when relevant.

Requirements:
- Keep skill metadata small and searchable.
- Add an operation to load/view a selected skill body on demand.
- Support skill activation/deactivation at session or user scope.
- Add skill provenance, version, compatibility and trust metadata.
- Do not auto-execute arbitrary scripts included by untrusted skills.

Acceptance criteria:
- Irrelevant skill bodies are not injected into the prompt.
- A relevant skill can be discovered and loaded on demand.
- Disabled or untrusted skill cannot execute tools outside policy.

#### FR-ECO-003 — Agent Skills compatibility and skill catalog (P1)

The skill system shall support a documented portable format and import/export process.

Requirements:
- Define and validate supported frontmatter and directory conventions.
- Provide compatibility tests for the selected Agent Skills specification.
- Support local skill directories and packaged skills.
- Add install, update, disable, remove and inspect operations.
- Record source, version, checksum and trust status for imported skills.
- Provide a local catalog first; remote catalog integration is optional.

Acceptance criteria:
- A valid external-format skill loads with equivalent metadata and instructions.
- Invalid or unsafe skill package is rejected with a reason.
- Skill update does not silently overwrite local modifications.

#### FR-ECO-004 — Enhanced TUI (P1)

The terminal interface shall support interactive use for long-running agent tasks.

Requirements:
- Multiline input and command history.
- Streaming assistant output.
- Visible task status and tool progress.
- Interrupt/cancel current task.
- Approval prompt for privileged actions.
- Session search and selection.
- Graceful fallback to basic readline when TTY features are unavailable.

Acceptance criteria:
- User can interrupt a running task without terminating the application.
- TUI displays streamed text and tool status in correct order.
- Non-TTY/pipe execution remains supported.

#### FR-ECO-005 — Multimodal adapter contracts (P1)

The runtime shall define modality capability interfaces without forcing all providers to support them.

Requirements:
- File attachment metadata and secure storage.
- Image input and vision analysis.
- Audio transcription and text-to-speech adapters.
- Optional image generation and video analysis/generation tools.
- Provider capability negotiation and fallback messages.
- File-size, MIME type and content safety checks.

Acceptance criteria:
- Unsupported modality is clearly reported instead of silently discarded.
- Image input works with a configured vision provider.
- Audio/image data is not written to public logs.

#### FR-ECO-006 — Credential and OAuth management (P1)

The runtime shall centralize credential references and authorization lifecycle.

Requirements:
- Distinguish API keys, OAuth access tokens, refresh tokens and user-provided secrets.
- Provide a secret-provider interface for environment variables, local encrypted store and platform-specific secure stores where available.
- Never put raw secrets into prompts, session history, memory or ordinary logs.
- Support OAuth authorization, refresh and revocation for integrations that require it.
- Provide credential scope and rotation metadata.
- For Termux, define a secure fallback that does not assume Android Keystore integration is available.

Acceptance criteria:
- Tools receive only credentials in their declared scope.
- Secret redaction tests cover nested tool payloads and error output.
- Expired OAuth credential can be refreshed or reported as requiring reauthorization.

#### FR-ECO-007 — Observability and diagnostics (P1)

The runtime shall provide operational diagnostics across modules.

Requirements:
- Structured logs with task/session/provider/tool correlation IDs.
- Health checks distinguish process health from capability readiness.
- Provide diagnostics for configured provider, MCP server, messaging adapter and execution backend.
- Add exportable redacted support bundle.
- Provide metrics for latency, token usage, error category and tool success/failure.

Acceptance criteria:
- A failed browser backend is reported as not ready even when its HTTP worker is running.
- Diagnostic export contains no configured secrets.
- A task trace can be correlated across parent and child agents.

## 9. Special Platform Track — X98 Mini / Termux ARM32

This track is a platform validation and packaging initiative. It must not fork the agent domain logic.

### 9.1 Target environment

Known device observations from prior diagnostics:

- Device: X98 Mini, Amlogic S4 / AP201.
- Android 11, SDK 30.
- CPU is ARMv8-capable, but Android exposes 32-bit ABI: `armeabi-v7a`.
- Termux reports `arm` architecture and `uname -m` reports `armv8l`.
- Target is native Termux execution: no PRoot, QEMU, Debian userspace, root access or firmware replacement.

These details must be revalidated on the target before release because firmware and installed package versions can change.

### 9.2 Platform requirements

#### FR-TERMUX-001 — Native runtime verification (P0)

- Verify a supported Node.js ARM32/Bionic build can run on the device.
- Verify `node`, `npm`, `tsc`, application startup and process signals.
- Verify all runtime dependencies install without unsupported native binaries.
- Record Android API level, ABI, Node version, package manager version and architecture in a compatibility report.

#### FR-TERMUX-002 — Docker-free installation and build (P0)

- Install and build from Termux package manager and npm.
- Do not require Docker, systemd, PRoot or QEMU.
- Provide scripts for install, configure, update, start, stop, status and backup.
- Keep generated state under configurable Termux home/data locations.

#### FR-TERMUX-003 — Android lifecycle compatibility (P0)

- Handle SIGINT/SIGTERM and clean shutdown.
- Persist sessions and pending task state before shutdown where possible.
- Document Android background process limitations and user-controlled keep-awake options.
- Do not claim guaranteed 24/7 background operation without device-level validation.

#### FR-TERMUX-004 — Resource budget and capability profile (P1)

- Measure idle and active memory, startup time, disk footprint and response overhead on the physical device.
- Offer a low-memory profile that disables optional services by default.
- Prefer remote browser, remote subagents and remote inference when local resources are insufficient.
- Make resource budgets configurable and report measured values in release notes.

#### FR-TERMUX-005 — Native package verification (P0)

- All required binaries must target Android ARM32/Bionic, not Debian ARMHF/glibc.
- No AArch64-only binary may be required for core functionality.
- Test MCP server subprocess requirements independently; do not assume every npm MCP server supports ARM32.
- Browser and heavy media runtimes are optional remote capabilities on this target unless physically validated.

### 9.3 Termux acceptance gate

The Termux track is complete only when the following are demonstrated on the physical X98 Mini:

1. Install Native OpenClaw from a clean Termux environment.
2. Run the TypeScript build without PRoot or QEMU.
3. Start CLI and complete a direct LLM conversation.
4. Complete a native tool call or documented fallback tool call.
5. Save and resume a session after application restart.
6. Search session history if Phase 1 search is included in the release.
7. Run one configured MCP server known to support Android ARM32, or clearly report that MCP subprocess capability is unavailable.
8. Execute an approved local command and verify dangerous-command approval.
9. Start, stop and restart the service cleanly.
10. Confirm the Android TV remains usable and no firmware changes are required.

## 10. Security and Trust Model

Security is a cross-cutting product requirement, not a later optional feature.

### 10.1 Trust boundaries

Treat the following as untrusted:

- Web pages, search results, email bodies and downloaded files.
- Repository source files, README instructions and project context files.
- Imported skills and MCP server descriptions.
- Subagent outputs and external agent results.
- Tool output that may contain instruction-like text.

Untrusted content must never override system policy, approval policy, credential scope or data access restrictions.

### 10.2 Required controls

- Least-privilege tool and subagent capabilities.
- Explicit tool input schema validation.
- Environment and credential allowlists.
- Redaction of secrets from logs, session traces and exported diagnostics.
- Workspace root and symlink boundary enforcement.
- Explicit approval for dangerous commands and high-impact external actions.
- Per-channel user authorization.
- Per-task timeout, cancellation and resource limits.
- Browser download/upload restrictions.
- Audit records for file modifications and privileged actions.
- Secure defaults for API exposure, CORS and authentication.
- No automatic execution of scripts from newly imported skills.

### 10.3 Security acceptance tests

- Prompt-injection content in a web page cannot authorize a shell command.
- MCP subprocess cannot access undeclared parent process secrets.
- Child agent cannot access parent-only credentials or forbidden paths.
- Browser page cannot cause an upload/download outside permitted paths.
- Dangerous shell command cannot run without approval.
- Unauthorized messaging sender cannot trigger agent execution.
- Secrets do not appear in logs, session history or diagnostics.

## 11. Data and Storage Strategy

### 11.1 Storage boundaries

| Data | Recommended storage | Notes |
|---|---|---|
| Conversation/session source | Existing JSON store initially | Preserve compatibility; evaluate SQLite migration separately |
| Session search index | SQLite FTS5 | Rebuildable index; source sessions remain authoritative |
| Durable memory | Versioned local store | Provenance, confidence and retention metadata |
| Workspace documents | Filesystem | User-readable and portable |
| Skills | Markdown and package metadata | Versioned, inspectable and exportable |
| Scheduler jobs | Existing store with schema version | Preserve current scheduler model |
| Task/subagent state | Persistent task store | Parent-child references and lifecycle state |
| Execution logs/artifacts | Workspace or configured data directory | Bounded retention and redaction |
| Credentials | Secret provider abstraction | Never stored in ordinary session JSON |

### 11.2 Migration principles

- Back up user data before any storage migration.
- Use schema version fields for persisted structures.
- Migrations must be repeatable or safely resumable.
- Search indexes must be rebuildable from source data.
- Do not migrate all session data to SQLite solely to obtain full-text search; introduce an index first and measure operational benefit.

## 12. CLI, API and Tool Contract Changes

New capabilities must be accessible through a consistent command/API/tool surface.

Proposed CLI commands (names may be adjusted during TDD):

| Command | Purpose | Phase |
|---|---|---|
| `/session search <query>` | Search historical sessions | 1 |
| `/memory search <query>` | Search stored memory | 1 |
| `/memory review` | Review memory candidates | 1 |
| `/context inspect` | Show discovered project context sources | 1 |
| `/task list` | List active/recent tasks | 1 |
| `/task show <id>` | Inspect task and execution trace | 1 |
| `/task cancel <id>` | Cancel task | 1/2 |
| `/agents run <task>` | Delegate work to an agent | 2 |
| `/agents status` | Show subagent status | 2 |
| `/browser status` | Browser backend readiness | 2 |
| `/browser session list` | List browser sessions | 2 |
| `/process list` | List background processes | 2 |
| `/process stop <id>` | Stop a background process | 2 |
| `/channels` | List messaging adapters | 3 |
| `/skills view <id>` | Read complete skill instructions | 3 |
| `/diagnostics` | Run runtime diagnostics | 3 |

API endpoints should use versioned routes and the same normalized contracts as the CLI. Avoid implementing business logic separately in the CLI and HTTP server.

## 13. Quality Attributes / Non-Functional Requirements

### Reliability
- A provider timeout or tool failure must not corrupt the session.
- Task failures must be classified and recoverable where possible.
- Shutdown must flush pending writes and stop owned child processes where possible.
- Scheduler misfires and retries must follow explicit policy.

### Performance
- Core startup must not initialize optional heavy services unnecessarily.
- Skill and context loading must respect configurable budgets.
- Search indexes must be incremental and rebuildable.
- Streaming must not cause unbounded buffering.
- Concurrency, output size and process count must be limited.

### Maintainability
- Core domain logic must not import platform-specific code directly.
- Provider, execution, browser and messaging adapters must have contract tests.
- New features must include unit, integration and failure-path tests.
- TypeScript strictness and lint rules remain enabled.

### Portability
- Core runtime must run without Docker.
- Docker is an optional supported deployment backend, not a hard dependency.
- Platform-specific functionality must be capability-detected.
- Avoid native Node dependencies in core unless they are proven on the declared platform matrix.

### Usability
- The agent must accurately report unsupported capabilities.
- Long-running tasks must expose status and cancellation where supported.
- Approval requests must explain the operation, target and risk.
- Existing CLI and settings workflows should remain familiar.

## 14. Delivery Roadmap and Dependencies

The phases are ordered by dependency, not by feature count. Phase 1 is the prerequisite for reliable execution in Phase 2. Phase 3 builds on stable task, memory, tool and policy contracts.

### Phase 1 — Core Agent Reliability

| Workstream | Scope | Priority | Dependencies |
|---|---|---|---|
| P1.1 Tool contract | Native tool/function calling abstraction, normalized results, validation | P0 | Existing provider and tool loop |
| P1.2 Streaming | Provider stream events, cancellation, UI event plumbing | P0 | Provider abstraction |
| P1.3 Session search | SQLite FTS5 index, search/retrieve commands and tools | P0 | Session store |
| P1.4 Memory | Provenance, categories, consolidation, review and deletion | P0 | Memory manager and workspace |
| P1.5 MCP hardening | Environment allowlist, secret redaction and command validation | P0 | MCP client/config |
| P1.6 Context discovery | Project-root and nested instruction discovery with precedence | P0 | Workspace/context builder |
| P1.7 Task trace | Task lifecycle and persisted execution trace | P1 | Orchestrator/tool loop |

**Phase 1 exit gate:** all P0 requirements pass; existing features continue to work; migration/rollback procedures are documented.

### Phase 2 — Autonomous Agent Capability

| Workstream | Scope | Priority | Dependencies |
|---|---|---|---|
| P2.1 Browser | Browser backend interface, real browser worker, remote browser connector | P0 | Tool contract, task lifecycle, credentials |
| P2.2 Subagents | Child task/session, delegation API and result aggregation | P0 | Task trace, tool policy, session isolation |
| P2.3 Parallelism | Task graph, concurrency control, cancellation and dependency handling | P0 | Subagent manager |
| P2.4 Terminal backends | Local/Docker/SSH adapters and policy enforcement | P0 | Execution policy, task lifecycle |
| P2.5 Processes | Background process manager | P1 | Terminal backend |
| P2.6 File operations | Safe read/write/search/patch and diff/rollback | P0 | Workspace and terminal policy |
| P2.7 Research/sheets | Functional external worker adapters | P1 | Tool contract and external agent protocol |

**Phase 2 exit gate:** browser, subagent, parallel execution and terminal P0 scenarios pass on at least one desktop/server environment; remote execution works independently of the Termux target.

### Phase 3 — Agent Ecosystem

| Workstream | Scope | Priority | Dependencies |
|---|---|---|---|
| P3.1 Messaging gateway | Normalized channel interface; migrate Telegram | P0 | Session routing and task lifecycle |
| P3.2 Skills | Progressive loading and skill view | P0 | Tool contract and context builder |
| P3.3 Skills compatibility | External format, import/export and local catalog | P1 | Progressive skill loader |
| P3.4 TUI | Multiline, streaming, task status, approvals and interrupt | P1 | Streaming and task trace |
| P3.5 Multimodal | Attachments, vision, audio and optional media adapters | P1 | Provider capabilities and secure file storage |
| P3.6 Credentials | Secret provider and OAuth lifecycle | P1 | Security policy and integrations |
| P3.7 Observability | Diagnostics, redacted support bundle and metrics | P1 | Task IDs and structured logs |

**Phase 3 exit gate:** Telegram migration is backward-compatible, a second messaging adapter is operational, and skills/TUI/credential contracts are documented and tested.

### Special Track — Termux ARM32

This track can run in parallel with Phase 1 discovery, but a production-ready Termux release depends on Phase 1 core contracts and platform validation.

| Workstream | Scope | Priority | Dependencies |
|---|---|---|---|
| T.1 Compatibility spike | Node ARM32/Bionic, npm install, dependencies, TypeScript build | P0 | Physical X98 Mini |
| T.2 Docker-free scripts | Install, configure, start, stop, status, update and backup | P0 | T.1 |
| T.3 Lifecycle | Signals, storage paths, shutdown and Android limitations | P0 | T.1 |
| T.4 Functional smoke test | Provider, tool call, sessions, MCP, scheduler and local shell | P0 | Phase 1 and T.1 |
| T.5 Resource profile | Measure memory, startup, disk and optional feature cost | P1 | T.4 |
| T.6 Release package | Termux installer and compatibility matrix | P0 | T.1–T.5 |

**Termux exit gate:** physical device acceptance checklist in Section 9.3 passes without PRoot/QEMU/root/firmware changes.

## 15. Testing Strategy

### 15.1 Test layers

1. **Unit tests:** provider normalization, tool schema validation, memory conflict detection, context precedence, policy evaluation and adapter parsing.
2. **Contract tests:** every provider, execution backend, browser backend, messaging adapter and MCP connector.
3. **Integration tests:** orchestrator with tools, sessions, memory, scheduler and task lifecycle.
4. **Security tests:** prompt injection, path traversal, credential exposure, tool escalation, subprocess environment and sender authorization.
5. **End-to-end tests:** repository coding task, browser automation flow, parallel research task, scheduled delivery and interrupted task recovery.
6. **Platform tests:** Windows/Linux/macOS where declared, plus physical Termux ARM32 for the special target.

### 15.2 Required regression suite

- Existing provider and routing tests.
- Existing CLI/session tests.
- Existing MCP tests.
- Existing system-execute and security tests.
- Existing workspace, scheduler, Telegram and API tests.
- Existing self-healing/self-improving tests.
- New streaming, native tool-calling, session search, memory lifecycle, context discovery, subagent and browser tests.

### 15.3 Release quality gate

A release candidate cannot be declared complete when:
- Any P0 acceptance test is failing.
- A feature is represented only by a scaffold or configuration flag.
- A migration has no backup or rollback process.
- A known security test can bypass approval or expose secrets.
- Platform compatibility is inferred from CPU architecture without executing on the target ABI.

## 16. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Scope grows into a full Hermes clone | Delivery slows; architecture becomes inconsistent | Use this PRD's phase gates; defer P2 features |
| Native tool calling differs across providers | Unreliable agent behavior | Normalize internal tool contracts and keep fallback mode |
| SQLite package requires unsupported native binaries | Termux install failure | Run compatibility spike before selecting driver; keep search-store interface replaceable |
| Browser runtime is too heavy for X98 Mini | Memory/storage exhaustion | Use remote browser backend on constrained devices |
| Subagents leak context or credentials | Security/privacy incident | Isolated child context, least privilege and explicit tool allowlists |
| Autonomous shell execution damages data | Data loss or system compromise | Backend policy, approval, restricted mounts and audit log |
| Skills contain malicious instructions/scripts | Prompt injection or code execution | Trust metadata, progressive loading, no automatic script execution |
| Android background limits terminate jobs | Missed schedules or incomplete tasks | Document limitations; persist state; provide foreground operation and recovery |
| Too many messaging adapters create maintenance load | Fragile integrations | Standard adapter contract and conformance suite |
| Self-healing modifies its own runtime unsafely | Regression or unrecoverable startup | Snapshot, patch review, isolated QA, explicit promotion and rollback |

## 17. Decisions to Make During Technical Design

These are deliberate technical decisions that should be resolved in a TDD, not silently assumed during implementation.

1. SQLite driver: `node:sqlite`, a pure-JS/WASM implementation or a native addon. The selected driver must pass the ARM32/Bionic compatibility spike.
2. Native tool-calling contract: exact normalized schema for parallel tool calls, tool result IDs, retries and malformed provider payloads.
3. Streaming contract: event naming, ordering, persistence and reconnect behavior.
4. Memory ranking: retain keyword retrieval, add embeddings, or use a hybrid strategy. The initial design should remain local and replaceable.
5. Context-file precedence and maximum prompt budget.
6. Browser implementation: local Playwright, CDP, remote browser service or a hybrid strategy.
7. Subagent isolation: process/container/remote worker boundaries per deployment target.
8. Terminal sandbox strategy on each host platform.
9. Messaging adapter selection after Telegram migration.
10. Credential encryption mechanism per operating system, especially Termux where secure-store support may differ.

## 18. Definition of Done

A feature is done only when all applicable conditions are met:

- Requirement and user-facing behavior are documented.
- Interface and configuration are defined.
- Implementation is integrated into the orchestrator or relevant service.
- Unit, integration and failure-path tests pass.
- Security and data-boundary implications are tested.
- Logs and diagnostics are redacted and correlated.
- CLI/API/tool documentation is updated.
- Migration and backward compatibility are addressed.
- Feature readiness is based on a working runtime, not a placeholder scaffold.
- Platform support is explicitly stated and validated.

## 19. Final Product Direction

Native OpenClaw should not pursue feature parity for its own sake. It should become a smaller, composable and reliable agent runtime with strong execution primitives.

The recommended strategic priorities are:

1. **Reliability first:** normalize tool calling, streaming, sessions, memory and context.
2. **Execution second:** implement real browser automation, generic subagents, parallel task execution and isolated terminal backends.
3. **Ecosystem third:** unify messaging, improve skills, TUI, multimodal and credential management.
4. **Portability throughout:** prove the core can run without Docker and validate the special ARM32/Bionic target on the actual device.
5. **Preserve differentiation:** keep multi-provider routing, scheduler/workflows, self-improvement, self-healing and local-first storage central to the product.

The intended outcome is not a copy of Hermes Agent. It is a distinct product: **Native OpenClaw — a lightweight, modular, multi-provider autonomous agent runtime built for local-first operation and extensible execution.**

---

## Appendix A — Repository References

- Repository: https://github.com/farisi55/native-openclaw
- Agent orchestrator: https://github.com/farisi55/native-openclaw/blob/main/src/agents/orchestrator.ts
- Tool loop: https://github.com/farisi55/native-openclaw/blob/main/src/agents/tool-loop.ts
- Provider base: https://github.com/farisi55/native-openclaw/blob/main/src/providers/base.ts
- Provider router: https://github.com/farisi55/native-openclaw/tree/main/src/router
- Memory: https://github.com/farisi55/native-openclaw/tree/main/src/memory
- Skills: https://github.com/farisi55/native-openclaw/tree/main/src/skills
- MCP client: https://github.com/farisi55/native-openclaw/blob/main/src/mcp/mcp-client.ts
- Agent gateway: https://github.com/farisi55/native-openclaw/tree/main/src/agent-gateway
- Browser worker scaffold: https://github.com/farisi55/native-openclaw/blob/main/agents/browser-agent/src/index.js
- Research worker scaffold: https://github.com/farisi55/native-openclaw/blob/main/agents/research-agent/src/index.js
- Spreadsheet worker scaffold: https://github.com/farisi55/native-openclaw/blob/main/agents/spreadsheet-agent/src/index.js
- Scheduler: https://github.com/farisi55/native-openclaw/tree/main/src/scheduler
- Self-healing: https://github.com/farisi55/native-openclaw/tree/main/src/self-healing

## Appendix B — Document Governance

This PRD defines product direction and acceptance requirements. It does not replace:

- **TDD:** detailed component design, interfaces, data models, sequence diagrams and deployment topology.
- **Backlog:** epics, stories, estimates, dependencies and sprint planning.
- **Threat model:** detailed attack surfaces, abuse cases and mitigations.
- **Test plan:** executable test cases, fixtures and platform matrix.

Recommended next artifacts are a Technical Design Document (TDD), an implementation backlog mapped to the FR IDs in this PRD, and a Termux ARM32 compatibility spike report.
