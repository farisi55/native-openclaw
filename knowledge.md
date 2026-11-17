---
project: Native OpenClaw
version: 1.0.1
source: prd
last_updated: 2026-11-15
project_shape: fullstack
simple_mode: false
external_assets: false
existing_codebase: false
high_scale_target: false
# project_shape: fullstack — PRD does not explicitly label Project Shape; classified as fullstack because the single local-first Node.js runtime includes both an HTTP API and Web UI, alongside CLI/TUI and messaging interfaces. This is one deployable with multiple interfaces, not a microservices decomposition.
# simple_mode: false — PRD does not specify a 6-month concurrent-user/usage target or a numeric initial target in §6.1, so the <=100 condition cannot be established. No regulated compliance requirement is stated.
# external_assets: false — PRD includes a Web UI, but does not require client/venue photography, third-party logos, licensed fonts, or other externally supplied visual assets.
# existing_codebase: false — PRD §1 does not contain the exact Prompt 05 provenance line required by the extraction rule. Repository baseline details are still documented in the PRD, but this flag follows the specified exact-signal rule.
# high_scale_target: false — PRD does not specify peak RPS/TPS or burst/high-concurrency requirements.
---

## TDD Reference

- This document cross-references **`TDD.md`** for task lifecycle states, execution traces, regression/coverage baselines, test isolation requirements, and test-isolation criteria. When reading `knowledge.md` automatically, the system should load `TDD.md` as the authoritative companion for task/trace management.

## 1. Project Identity

- **Project name:** Native OpenClaw.
- **Purpose:** Lightweight, modular, local-first, multi-provider autonomous agent runtime with extensible execution backends and self-maintenance capabilities.
- **Primary users / actors:**
  - Developer / technical operator — repository inspection, code changes, test execution, technical automation and workflow management.
  - Power user / entrepreneur — research, reporting, scheduling and data-processing tasks.
  - Local-device operator — runs the agent locally and keeps data/control local unless remote execution is explicitly configured.
- **Project shape:** Fullstack, as an extraction classification. The product has an HTTP API and Web UI as well as CLI/TUI and messaging interfaces. The PRD does not provide a formal Project Shape field.
- **Deployment interpretation:** One local-first Node.js runtime with optional interfaces and optional remote execution services; do not split it into microservices by default.
- **Phase applicability:**
  - Phase 1 — core runtime reliability, provider/tool contracts, storage, memory, MCP and context.
  - Phase 2 — browser, subagents, parallel tasks, execution backends and file operations.
  - Phase 3 — messaging gateway, skills ecosystem, TUI, multimodal, credentials and observability.
  - Special platform track — native Android / Termux ARM32 validation and packaging.
  - The PRD does not contain a formal “Phase Applicability Matrix” in §9; phase applicability is taken from the delivery roadmap in §14.
- **External API consumers:** The PRD confirms an HTTP API exists, but does not enumerate external consumer applications or clients.

## 2. Tech Stack

- **Primary language:** TypeScript.
- **Runtime:** Node.js. The PRD does not specify a minimum or pinned Node.js version; verify the repository's package metadata before changing runtime requirements.
- **Frameworks:** No mandatory application framework is specified in the PRD.
- **Provider integrations:** Multiple LLM provider adapters behind a common provider abstraction and provider router. The PRD does not enumerate the full provider list in its stack section.
- **Tool and integration protocols:** Model Context Protocol (MCP); normalized internal tool contract; optional external agent connectors.
- **Browser technologies under consideration:** Local Playwright, Chrome DevTools Protocol (CDP), remote browser service, or a hybrid. No final implementation choice is made in the PRD.
- **Session storage:** Existing JSON-backed session store remains authoritative initially.
- **Session search:** SQLite FTS5 search index; the SQLite driver is undecided and must pass the Termux ARM32/Bionic compatibility spike before adoption.
- **Memory storage:** Versioned local store with provenance, confidence, importance, retention and review metadata. Exact persistence format is not specified.
- **Workspace and skills:** Local filesystem; Markdown skill files and workspace documents.
- **Scheduler storage:** Existing scheduler store with schema versioning; exact storage engine/schema is not specified.
- **Task and subagent storage:** Persistent task store with parent/child task references and lifecycle state; exact storage engine/schema is not specified.
- **Artifacts and execution logs:** Workspace or configured local data directory, with bounded retention and secret redaction.
- **Credential storage:** Secret-provider abstraction supporting environment variables, local encrypted storage and platform-specific secure stores where available. Termux must have a documented fallback and must not assume Android Keystore availability.
- **Deployment targets:** Local desktop/server environments and, after physical-device validation, Android / Termux ARM32 on the X98 Mini.
- **Remote services:** Optional remote browser, research, terminal and other execution services; external model endpoints and third-party integrations.
- **Containers:** Docker is optional and must not be a core runtime requirement. Docker is an execution backend on supported hosts, not a Termux prerequisite.
- **Container orchestration:** No Kubernetes or other orchestration platform is required by the PRD.
- **Third-party services / APIs:** LLM provider APIs; configured MCP servers; Telegram integration; Brevo email integration in the current baseline; optional Google Sheets integration for the spreadsheet worker; optional remote browser/terminal services.
- **Webhook providers:** No inbound webhook provider or signature-verification scheme is specified in the PRD.
- **Package manager and lockfile strategy:** Not specified in the PRD. Preserve the repository's existing package-manager and lockfile conventions unless a separate decision is approved.
- **Git hooks:** Husky is a dev dependency; `npm install` installs the committed `.husky/pre-commit` hook, which runs `scripts/check-staged-files.mjs` to reject staged secrets, keys/certificates identified by extension, and AI-agent local state. The hook must not ignore shared `.claude/` content, `CLAUDE.md` or `AGENTS.md`.

## 3. Architecture

- **Architecture principles:**
  - Extend existing modules; do not rewrite working components without a measurable reason.
  - Keep the core local-first; remote services remain optional.
  - Place browser, terminal, messaging, memory and subagent capabilities behind replaceable interfaces.
  - Keep the core domain independent of platform-specific code.
  - Use provider-independent tool calling and streaming contracts.
  - Load only the tools, skills and context needed for the current task.
  - Expose task status and execution traces without exposing private model reasoning.
  - Detect platform capabilities instead of assuming that a feature is available.
- **Repository module structure identified by the PRD:**
  - `src/agents/` — orchestration, reasoning engine and tool loop.
  - `src/providers/` — provider adapters.
  - `src/router/` — provider routing and fallback.
  - `src/tools/` — tool registry and tool executor.
  - `src/mcp/` — MCP configuration, client and server management.
  - `src/storage/` — session and JSON storage primitives.
  - `src/memory/` — memory retrieval and lifecycle components.
  - `src/skills/` — skill registry, selection and self-improvement components.
  - `src/workspace/` — workspace files and workspace operations.
  - `src/scheduler/` — scheduled workflow execution.
  - `src/agent-gateway/` — internal/external agent connectors and capability routing.
  - `src/integrations/` — current Telegram integration.
  - `src/api/` — HTTP API.
  - `src/web-ui/` — Web UI.
  - `src/self-healing/` — self-healing, patch/QA/rollback workflow.
  - `agents/browser-agent/` — current browser worker scaffold; a scaffold is not a working browser runtime.
  - `agents/research-agent/` — current research worker scaffold; a scaffold is not a working research backend.
  - `agents/spreadsheet-agent/` — current spreadsheet worker scaffold; a scaffold is not a working Sheets/MCP adapter.
- **Layer responsibilities:**
  - Interfaces — CLI/TUI, Web UI, HTTP API and messaging adapters accept user input and render task progress/results.
  - Gateway — normalizes inbound requests and routes them to the correct user/session/task.
  - Orchestrator — coordinates intent, planning, context, policy, tool calls and final response.
  - Provider layer — adapts model-specific request/response formats and capability reporting.
  - Provider router — selects providers/models and handles health/fallback behavior.
  - Tool runtime — registers tools, validates inputs, applies authorization/policy and executes tools.
  - Execution adapters — MCP, browser, terminal, file operations, background processes and external agents.
  - Memory/session/skill services — persist and retrieve conversation state, durable knowledge and reusable procedures.
  - Workflow/scheduler — executes scheduled jobs and workflow definitions.
  - Cross-cutting services — security policy, credential access, audit, telemetry, configuration, local storage and lifecycle management.
- **Design patterns and constraints:**
  - Adapter interfaces for providers, execution backends, browser backends and messaging channels.
  - Capability detection and capability-based routing.
  - Provider-independent normalized contracts.
  - Replaceable storage interfaces for session search and memory.
  - Local-first persistence with optional remote execution adapters.
  - Compatibility adapters for existing provider `chat()` calls, structured-JSON tool calls, CLI commands and JSON session records.
- **State management:**
  - Keep source conversation sessions in the existing JSON store initially.
  - Maintain SQLite FTS5 as a rebuildable search index, not the authoritative conversation store.
  - Keep workspace and skills as inspectable local files.
  - Persist task/subagent lifecycle state and safe execution metadata.
  - Keep credentials outside ordinary session JSON, memory and logs.
- **High-level data flow:**
  - User interface or messaging channel receives a request.
  - Gateway resolves identity, authorization and session/task context.
  - Orchestrator loads relevant memory, skills, project context and tool capabilities.
  - Provider abstraction/router sends the model request using native tool calling where supported, or the compatibility fallback.
  - Tool runtime validates and authorizes each tool call before dispatching to an adapter.
  - Tool results are normalized and returned to the model loop.
  - Final response, session messages and safe task trace are persisted.
  - Scheduled jobs use the same execution/runtime contracts and deliver output through a configured channel.
- **Architectural decisions/constraints stated across the PRD:**
  - Extend existing modules instead of rewriting the application — preserves working capabilities and backward compatibility.
  - Keep JSON session records authoritative and add a rebuildable SQLite FTS5 index — avoids migrating all conversation data solely to gain search.
  - Keep Docker optional and core runtime local-first — supports native execution and constrained environments.
  - Use replaceable browser/terminal/messaging/provider adapters — avoids binding domain logic to one implementation or vendor.
  - Keep heavy browser/media runtimes and large models out of the core Termux package — reduces constrained-device footprint and permits remote execution where necessary.
- **Explicit architecture decisions still open in the PRD:**
  - SQLite driver: `node:sqlite`, pure-JS/WASM implementation or native addon.
  - Exact normalized tool-call schema, parallel-call handling, IDs and malformed-payload behavior.
  - Streaming event names/order, persistence and reconnect semantics.
  - Memory ranking: keyword, embeddings or hybrid.
  - Context-file precedence and maximum prompt budget.
  - Browser implementation choice.
  - Subagent isolation boundary per deployment target.
  - Terminal sandbox strategy by host platform.
  - Messaging adapter selection after Telegram migration.
  - Credential encryption mechanism per operating system, especially Termux.

## 4. Code Standards

- **Language:** TypeScript.
- **Type checking:** TypeScript strictness must remain enabled.
- **Platform separation:** Core domain logic must not import platform-specific implementations directly.
- **Error handling:** Provider errors, tool failures, timeouts and task failures must be classified; a provider/tool failure must not corrupt the session.
- **Async/cancellation:** Streaming and long-running operations must support cancellation where the provider/backend supports it; use bounded execution and process cleanup.
- **Input validation:** Validate tool names, arguments and schemas before tool execution; reject malformed, unknown or unauthorized calls safely.
- **Logging:** Structured logs must correlate task, session, provider and tool identifiers; logs and diagnostics must redact secrets.
- **Testing layers:**
  - Unit tests for provider normalization, tool schema validation, memory conflict detection, context precedence, policy evaluation and adapter parsing.
  - Contract tests for every provider, execution backend, browser backend, messaging adapter and MCP connector.
  - Integration tests for orchestrator, tools, sessions, memory, scheduler and task lifecycle.
  - Security tests for prompt injection, path traversal, credential exposure, tool escalation, subprocess environment and sender authorization.
  - End-to-end tests for repository coding, browser automation, parallel research, scheduled delivery and interrupted-task recovery.
  - Platform tests for declared desktop/server platforms and physical Termux ARM32.
- **Regression tests:** Preserve existing provider/routing, CLI/session, MCP, system-execute/security, workspace, scheduler, Telegram, API, self-healing and self-improving test coverage.
- **Coverage target:** The PRD requires all existing core regression tests to pass before release candidates, but does not specify a numeric code-coverage percentage.
- **Test isolation requirement:** Not specified as a separate rule in the PRD.
- **Formatter/linter:** Not specified by the PRD; do not introduce or replace formatting tools without checking repository conventions.
- **Documentation requirement:** Update CLI/API/tool documentation, configuration details, migration guidance and platform support statements with each applicable feature.

## 5. API & Data Contracts

- **API surfaces:** Existing HTTP API and Web UI are part of the baseline. New capabilities must be accessible through consistent CLI/API/tool surfaces.
- **Base URL:** Not specified in the PRD.
- **Endpoint naming/versioning:** API routes must be versioned; exact version prefix and endpoint paths are not specified.
- **Business logic boundary:** CLI and HTTP server must use the same normalized contracts; do not duplicate business logic between interfaces.
- **Backward compatibility:** Existing CLI commands, settings, session data and workspace files should remain usable through planned compatibility readers, aliases or migrations.
- **Authentication/authorization:** Secure defaults for API exposure, authentication and CORS are required. Exact authentication scheme, token format, lifetime and authorization model are not specified in the PRD.
- **Rate limiting:** Rate limiting exists in the current baseline, but the storage implementation and detailed policy are not specified in the PRD.
- **Inbound webhooks:** No provider or signature-verification contract is specified.
- **Request/response schema:** New APIs should expose the same normalized contracts as their CLI/tool equivalents. Exact request/response fields are not specified.
- **Task state values:** `queued`, `running`, `waiting-for-approval`, `completed`, `failed`, `cancelled` and `timed-out`.
- **Tool-call contract requirements:** Normalize vendor-native calls; validate tool name and JSON schema; preserve tool-call identifiers; support multiple calls when provider supports them; reject malformed/unknown/unauthorized calls; record safe execution metadata.
- **Streaming event contract candidates:** `message_start`, `text_delta`, `tool_call`, `tool_result`, `usage`, `message_complete` and `error`. Final ordering/persistence semantics remain an explicit design decision.
- **Messaging envelope:** Include channel, account, chat, sender, message ID, attachments and reply/thread metadata.
- **Error response format:** Must be classified and traceable; exact API error body and `request_id` field requirement are not specified by the PRD.
- **Pagination:** Not specified in the PRD.
- **Idempotency:** Messaging retries must not create duplicate task execution for the same inbound message ID.

## 6. UI / UX Constraints

- **Existing interfaces:** CLI, HTTP API, Web UI and Telegram integration.
- **Planned interfaces:** Enhanced TUI and a unified messaging gateway.
- **Component library/design system:** Not specified in the PRD.
- **Color palette and typography:** Not specified in the PRD.
- **Brand voice and visual direction:** Not specified in the PRD.
- **Responsive breakpoints/layout rules:** Not specified in the PRD.
- **Accessibility requirements:** Not specified in the PRD.
- **TUI behavior requirements:** Multiline input, command history, streaming assistant output, visible task/tool progress, cancellation/interrupt, approval prompts and session search/selection; basic readline fallback when TTY features are unavailable.
- **Long-running task UX:** Expose task status and cancellation where supported.
- **Approval UX:** Explain the operation, target and risk before requesting approval.
- **Capability UX:** Clearly report unsupported or unavailable capabilities instead of implying a scaffold/configuration flag is operational.
- **External visual assets:** None specified; `asset-manifest.md` is not required by the extraction rules.

## 7. Business Logic & Domain Rules

### Domain Rules & Behavior

- **Provider independence:** Agent behavior must not depend on a single LLM vendor's proprietary tool-call schema.
- **Provider capabilities:** Expose capability detection, including streaming, native tool calling, vision, audio input and audio output; do not assume all providers support all modalities.
- **Tool execution:**
  - Normalize provider-native tool calls into one internal representation.
  - Validate tool name and arguments against the registered schema.
  - Reject unknown, malformed or unauthorized tool calls.
  - Support multiple tool calls in one assistant response when supported by the provider.
  - Keep structured-JSON response mode as a compatibility fallback.
  - Record call ID, tool name, safe input summary, execution time, status and error classification.
- **Streaming:**
  - Normalize stream events and preserve event order.
  - Emit exactly one terminal completion or error event per request.
  - Do not duplicate or reorder text deltas.
  - Support cancellation through `AbortSignal` where supported.
  - Avoid unbounded buffering.
- **Sessions and search:**
  - JSON session records remain authoritative initially.
  - SQLite FTS5 stores a rebuildable index of session ID, message ID, timestamp, role, provider/model and searchable text.
  - Search supports query, date range, role and optional session/project filters.
  - Search results provide session references and excerpts; do not silently inject an entire historical session.
  - Session deletion must be reflected in or reconciled with the search index.
  - Index rebuild must be supported and produce equivalent searchable records.
- **Memory categories:** user preference, user profile, project fact, decision, procedure, environment note and temporary fact.
- **Memory provenance:** Store source session/message, timestamp, extractor, confidence and importance for memory items.
- **Memory lifecycle:** Detect duplicates and conflicts; consolidate candidates into reviewed durable memory; support inspect, update, forget and export; apply separate retention policies to raw chunks, session index and durable memory.
- **Memory safety:** Conflicting profile facts must be surfaced instead of silently overwritten; user-requested deletion must remove durable memory and index entries; source sessions must not be deleted by consolidation; memory writes may be reviewed or disabled.
- **User profile:** Keep durable preferences/project facts separate from inferred or temporary observations; allow inspection/editing; support opt-out by memory category; do not persist secrets or authentication factors.
- **MCP subprocess:**
  - Pass only explicitly configured environment variables and approved runtime allowlist values.
  - Do not inherit the entire parent `process.env` by default.
  - Support named secret references and per-server permissions/lifecycle controls.
  - Validate command, arguments, working directory and package source before launch.
  - Redact credentials from logs and tool results.
- **Project context discovery:**
  - Discover supported files including `AGENTS.md`, `CLAUDE.md`, `.claude/` project rules and Native OpenClaw-specific context files.
  - Apply deterministic precedence across global, workspace, repository-root and nested-directory instructions.
  - Enforce file-size and context-token budgets.
  - Do not follow symlinks outside permitted roots without policy approval.
  - Treat repository instructions and fetched content as untrusted; they cannot change runtime security policy.
  - Invalidate cached context when source files change.
- **Task lifecycle:** `queued` → `running` → `waiting-for-approval` as needed → terminal state (`completed`, `failed`, `cancelled` or `timed-out`). Persist safe task metadata and trace; do not store private model reasoning in user-visible traces.
- **Subagents:**
  - Each child task has a distinct ID, session/context boundary and execution budget.
  - Configure explicit capabilities, provider/model and tool allowlists.
  - Limit delegation depth; support wait, poll, cancel and result retrieval.
  - Do not inherit parent privileged tools or credentials automatically.
  - Return concise results, artifacts, changed files, status and validation metadata.
- **Parallel execution:** Enforce global/per-user concurrency, per-task timeout and resource budgets; honor dependencies; preserve partial results; detect conflicting writes to the same file.
- **Browser:** Support navigation, wait, click, type, select, scroll, screenshot, page inspection and policy-controlled upload/download; use named sessions; enforce timeout/cancellation; treat page content/downloads as untrusted; do not expose cookies/passwords/tokens to model context/logs/screenshots by default.
- **Terminal execution:** Use replaceable local, Docker and SSH backends; retain existing risk classifier/approval semantics; enforce per-task working directory, environment allowlist, timeout, output bounds, workspace restrictions and secret-file restrictions; fail closed when backend unavailable.
- **Background processes:** Return stable handles; support status, output tail, wait, interrupt and terminate; bound logs; record owner/task/workdir/time; apply timeout and orphan cleanup policy.
- **File operations:** Read with size/encoding limits; list/search within allowed roots; write atomically where possible; apply unified diffs only when context matches; preview diffs when policy requires; preserve backup/rollback metadata; do not permanently delete without authorization.
- **Messaging gateway:** Normalize inbound/outbound envelopes; isolate sessions by configured identity; enforce sender allowlists and rate limits; retry safely with idempotency; migrate Telegram without losing existing user/session mappings; a second channel must not require orchestrator changes.
- **Skills:** Load metadata first and full skill body on demand; support user/session activation; store provenance/version/compatibility/trust metadata; never automatically execute scripts from untrusted imported skills; imported skill updates must not silently overwrite local modifications.
- **Credentials:** Distinguish API keys, OAuth access tokens, refresh tokens and user secrets; scope credentials to tools; do not put raw secrets in prompts, session history, memory or ordinary logs; support refresh/revocation for integrations that require OAuth.
- **Research/spreadsheet workers:** A worker is available only when a real backend is configured and health-checked. Research output must include source URL, retrieval timestamp and evidence excerpt. Spreadsheet access must use defined read/write scopes. Placeholder 501 responses must not be reported as available capability.
- **Self-maintenance:** Preserve self-improvement, self-healing and self-upgrade as first-class features; self-healing changes require snapshot, patch review, isolated QA, explicit promotion and rollback.
- **Scheduled jobs:** Preserve existing scheduler/workflow functionality; scheduler misfires and retries must follow explicit policy; background operation on Android must not be described as guaranteed without physical-device validation.
- **Application versioning:** Not specified in the PRD.

### Data Storage Rules

- **Conversation/session source:** Existing JSON store initially; preserve backward compatibility.
- **Session search index:** SQLite FTS5, incremental and rebuildable; not the source of truth.
- **Durable memory:** Versioned local store with provenance/confidence metadata; exact entity schema and physical format are not specified.
- **Workspace documents:** Filesystem.
- **Skills:** Markdown files plus package metadata.
- **Scheduler jobs:** Existing store with schema version.
- **Task/subagent state:** Persistent local task store with parent-child references and lifecycle state.
- **Execution logs/artifacts:** Configured workspace/data directory with bounded retention and redaction.
- **Credentials:** Secret-provider abstraction; never place secrets in ordinary session JSON.
- **Schema/migration policy:** Back up user data before migration; add schema versions; make migrations repeatable or safely resumable; rebuild search indexes from authoritative source data.
- **Entity-level relational schema:** Not provided in the PRD; do not invent database tables, columns, foreign keys or indexes beyond the conceptual requirements above.

## 8. Environment & Configuration

- **Required environment variable names:** Not enumerated in the PRD.
- **Feature flags:** Optional capabilities must be independently configurable and capability-detected; exact flag names/defaults are not specified.
- **Logging/observability:** Structured logs with task/session/provider/tool correlation IDs; redact secrets from logs, traces and support bundles.
- **Metrics:** Provider/tool latency, token usage, error category, tool success/failure and execution status.
- **Health/readiness:** Health checks must distinguish process health from capability readiness; exact endpoint shape is not specified.
- **Build/deployment:** Core must build and run without Docker; Docker remains optional. Avoid native Node dependencies in core unless proven on all declared platforms.
- **Local development/staging/production strategy:** Not specified in the PRD.
- **Backup:** Back up user data before storage migrations; the PRD does not specify recurring backup frequency, retention, RTO or RPO.
- **Update/rollback:** Preserve compatibility; migration procedures must include backup and rollback. Self-healing/self-upgrade must use snapshot, QA and rollback before promotion.
- **Termux distribution:** Provide install/configure/update/start/stop/status/backup scripts; store state under configurable Termux home/data paths; avoid Docker, systemd, PRoot and QEMU.
- **Termux runtime verification:** Prove Node.js ARM32/Bionic, npm install, TypeScript build, application startup, process signals and all runtime dependencies on the physical X98 Mini.
- **Termux resource profile:** Measure idle/active memory, startup time, disk footprint and optional-feature overhead on the device. Low-memory profile should disable optional services by default.
- **Code graph tool:** `none` — no code graph package is required or specified by the PRD.

## 9. Constraints & Anti-patterns

- Do not rewrite working modules without a documented requirement or measurable reliability reason.
- Do not pursue complete Hermes feature parity for its own sake.
- Do not build a hosted SaaS control plane or multi-tenant cloud service as part of the first three phases.
- Do not require Kubernetes, a vector database or a cloud database for core operation.
- Do not build a custom browser engine.
- Do not bundle Chromium, large models or heavy media runtimes into the core Termux installation.
- Do not require Docker for core runtime operation or Termux deployment.
- Do not require native Node dependencies in core unless verified on the declared platform matrix, including Termux ARM32 when claimed supported.
- Do not assume ARMv8 CPU capability means Android exposes a 64-bit ABI; validate the actual ABI on the target device.
- Do not treat a worker scaffold, connector, configuration flag or HTTP process as proof that a capability is operational.
- Do not report browser/research/spreadsheet workers as available until the runtime/backend passes its readiness checks.
- Do not let web pages, search results, downloaded files, repository instructions, imported skills, MCP descriptions, tool outputs or subagent outputs override security policy, approval policy, credential scope or data-access restrictions.
- Do not execute dangerous shell commands or high-impact external actions without the required policy approval.
- Do not let child agents inherit parent privileged tools, secrets or forbidden paths by default.
- Do not pass the full parent process environment to MCP subprocesses by default.
- Do not expose credentials in prompts, session history, memory, logs, screenshots, tool results or diagnostic bundles.
- Do not follow symlinks outside permitted workspace/project roots without policy approval.
- Do not allow unbounded streaming buffers, task concurrency, process counts or tool output sizes.
- Do not silently overwrite conflicting file changes or skill modifications.
- Do not claim guaranteed 24/7 Android background operation without device-level validation.
- **API stability:** Use versioned API routes and preserve existing CLI/settings/session/workspace compatibility through planned aliases/readers/migrations.
- **CORS/API exposure:** Use secure defaults for API exposure, CORS and authentication; detailed allow-origin policy is not specified in the PRD.
- **Idempotency:** Retried inbound messaging events must not trigger duplicate task execution for the same message ID.
- **Migration safety:** Back up before migration; migrations must be repeatable or safely resumable; search indexes must be rebuildable.
- **Performance:** Do not initialize heavy optional services at core startup; respect skill/context budgets; bound concurrency/output/processes; avoid unbounded streaming buffers.
- **Known platform limitation:** Android background execution can be interrupted by the operating system; persistence/recovery and user-controlled foreground/keep-awake behavior must be documented.
- **Compliance:** No regulated compliance regime or formal compliance requirement is specified by the PRD.
- **Additional security policies not specified:** Constant-time comparison for secrets, regex complexity policy, HTTP redirect policy, inbound webhook signature verification and specific API error-body fields are not defined in the PRD; do not invent project-specific values here.

### Sensitive / High-Blast-Radius Code

- The PRD does not enumerate specific functions/classes as high-blast-radius code. Start this list empty and populate it only after repository-level code review identifies concrete targets.
