---
project: Native OpenClaw
knowledge_version: 1.0.1
changelog_version: 1.0.1
created: 2026-11-14
status: in_progress
milestone: 1 of 2
project_shape: fullstack
simple_mode: false
existing_codebase: false
high_scale_target: false
---

## [IN PROGRESS]

### Task #002 — Validate README and Dependency Lockfile
- **Phase:** Phase 1 — Foundation
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Verify the committed npm lockfile and make the README installation, run, build and test instructions executable and consistent with the current package scripts.
- **Files to create / modify:** `README.md`, `package.json`, `package-lock.json`, `.env.example`
- **Acceptance criteria:**
  - [ ] `npm ci` completes from a clean checkout using the committed lockfile.
  - [ ] README install/run/build/test commands are executed and corrected where necessary; README links to `.env.example`.
- **Dependencies:** Task #001
- **Decisions made:** Keep npm and `package-lock.json` as the package-manager/lockfile strategy; do not replace the current lockfile with another package manager.

## [NEXT TASKS]


### Phase 1 — Foundation

### Task #003 — Configure CI and Security Scans
- **Phase:** Phase 1 — Foundation
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Create a GitHub Actions pipeline that runs lint, type-check, test, SAST and SCA on every push, with CI secrets held as masked/protected repository or organization secrets.
- **Files to create / modify:** `.github/workflows/ci.yml`, `package.json`, `README.md`
- **Acceptance criteria:**
  - [ ] The workflow runs in the order lint → type-check → test → SAST → SCA on every push and pull request.
  - [ ] Semgrep is configured as the TypeScript/JavaScript SAST scanner and `npm audit` as the separate npm dependency SCA/CVE scanner.
  - [ ] Any required CI credentials are referenced through GitHub Actions secrets; no secret value is committed or printed in workflow logs.
  - [ ] A deliberately failing lint/test/security fixture causes the corresponding CI job to fail.
  - [ ] `Dockerfile` does not place secret values in `ARG`/`ENV` or persistent image layers; proxy configuration cannot persist credentials in build metadata.
- **Dependencies:** Task #001, Task #002
- **Decisions made:** Use Semgrep for source scanning and `npm audit` for dependency scanning; use GitHub Actions masked secrets rather than repository variables for secret values.

### Task #004 — Automate Dependency Update Reviews
- **Phase:** Phase 1 — Foundation
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Configure recurring automated dependency update proposals for npm dependencies and GitHub Actions so the dependency baseline does not become stale between CI runs.
- **Files to create / modify:** `.github/dependabot.yml`
- **Acceptance criteria:**
  - [ ] Dependabot is enabled for npm and GitHub Actions with a weekly schedule.
  - [ ] A test or configuration validation confirms both package ecosystems are covered and update pull requests target the intended default branch.
- **Dependencies:** Task #003
- **Decisions made:** Use Dependabot with weekly updates; keep updates as pull requests so existing CI/security gates validate them before merge.

### Task #005 — Initialize Structured Logging Redaction
- **Phase:** Phase 1 — Foundation
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Ensure the existing logger emits structured records and scrubs secrets and sensitive values before logs are written or forwarded.
- **Files to create / modify:** `src/utils/logger.ts`, `src/utils/secret-redactor.ts`, `test/logger-redaction.test.ts`
- **Acceptance criteria:**
  - [ ] Logs include stable level, timestamp, component and correlation metadata where available.
  - [ ] API keys, access tokens, passwords, private-key material and configured secret values are redacted in nested objects and error messages.
  - [ ] A forced exception containing probe secrets produces no unredacted secret in captured logs.
- **Dependencies:** Task #001
- **Decisions made:** Extend the existing Winston-based logger rather than introducing a second logging framework; make redaction a shared pre-transport step.

### Task #006 — Validate Runtime Configuration at Startup
- **Phase:** Phase 1 — Foundation
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Validate required configuration at application startup, conditional on enabled providers/features, and fail fast with actionable errors when required values are absent or invalid.
- **Files to create / modify:** `src/config/env.ts`, `src/index.ts`, `.env.example`, `test/env-validation.test.ts`
- **Acceptance criteria:**
  - [ ] A valid minimal configuration starts successfully.
  - [ ] Enabling a provider/integration without its required credential or endpoint exits with a clear, redacted validation error.
  - [ ] Validation errors never print secret values and `.env.example` documents every required variable discovered by the validator.
- **Dependencies:** Task #002, Task #005
- **Decisions made:** Use the existing Zod dependency for typed configuration validation; keep optional integrations disabled unless their required configuration is present.

### Task #007 — Add API Liveness and Readiness Checks
- **Phase:** Phase 1 — Foundation
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Expose separate process-liveness and capability-readiness health checks for the HTTP server without coupling readiness to optional features that are disabled.
- **Files to create / modify:** `src/api/routes.ts`, `src/api/server.ts`, `src/api/types.ts`, `test/api-server.test.js`
- **Acceptance criteria:**
  - [ ] The liveness route returns success while the process can serve requests.
  - [ ] The readiness route reports configured core dependencies and identifies unavailable required capabilities without reporting optional disabled adapters as failures.
  - [ ] Health responses contain no credentials, internal filesystem paths or raw exception traces.
- **Dependencies:** Task #006
- **Decisions made:** Keep health semantics lightweight and local-first; do not make a third-party LLM call on every readiness probe.


### Special Track — X98 Mini / Termux ARM32

### Task #008 — Verify Native Node ARM32 Runtime
- **Phase:** Special Track — X98 Mini / Termux ARM32
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Run a compatibility spike on the physical X98 Mini to prove that Node.js/npm and the project runtime execute on the exposed Android `armeabi-v7a`/Bionic ABI without PRoot, QEMU, root or firmware changes.
- **Files to create / modify:** `scripts/termux/node-runtime-compat.sh`, `docs/platform/termux-arm32-compatibility.md`
- **Acceptance criteria:**
  - [ ] The report records Android API, ABI, `uname`, Node.js/npm versions, Node architecture, install/build result and process-signal behavior from the physical device.
  - [ ] A minimal Node script and the project TypeScript build run directly in Termux with no PRoot/QEMU/other Linux userspace.
  - [ ] If no supported Node runtime is available, the report records an explicit NO-GO and blocks Termux packaging rather than substituting emulation.
- **Dependencies:** Task #001, Task #002
- **Decisions made:** Treat actual Android ABI and runtime execution as authoritative; CPU ARMv8 capability alone is not acceptance evidence.


### Phase 2 — Domain & Data

### Task #009 — Select SQLite FTS5 Runtime Driver
- **Phase:** Phase 2 — Domain & Data
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Select the SQLite driver and verify FTS5 capability on supported desktop/server Node runtimes and the X98 Mini ARM32 target before adopting it for session search.
- **Files to create / modify:** `docs/adr/ADR-001-sqlite-driver.md`, `scripts/termux/sqlite-fts5-probe.mjs`, `test/sqlite-driver-compat.test.ts`
- **Acceptance criteria:**
  - [ ] The ADR compares `node:sqlite`, pure-JS/WASM and native-addon alternatives against runtime support, FTS5 availability, async behavior and ARM32/Bionic compatibility.
  - [ ] The selected driver passes create/insert/query/delete/reopen probes on the physical target; otherwise the ADR records a compatible alternative or a blocked Termux capability.
  - [ ] No production session data is migrated as part of this spike.
- **Migration safety:**
  - [ ] Schema changes: none in this driver-selection spike.
  - [ ] Down migration: N/A because no persistent schema is created.
  - [ ] Idempotency: probe can be rerun from a clean temporary database.
  - [ ] Delete strategy: temporary test database is removed after the probe.
  - [ ] Live-traffic tables: N/A.
- **Dependencies:** Task #008
- **Decisions made:** Do not select a native SQLite addon or `node:sqlite` solely from desktop support; require a physical ARM32/Bionic result.

### Task #010 — Create FTS5 Session Search Schema
- **Phase:** Phase 2 — Domain & Data
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Implement the rebuildable FTS5 search-index schema and storage adapter using only the session/message fields required by `knowledge.md` §7.
- **Files to create / modify:** `src/storage/session-search-store.ts`, `src/storage/sqlite/session-search-schema.ts`, `src/storage/migrations/`, `test/session-search-schema.test.ts`
- **Acceptance criteria:**
  - [ ] The created index represents session ID, message ID, timestamp, role, provider/model and searchable message text.
  - [ ] Schema and concrete column types are documented in the approved ADR and are not treated as authoritative conversation storage.
  - [ ] Index creation and teardown pass on each declared supported SQLite runtime.
- **Migration safety:**
  - [ ] Schema must contain exactly the required search metadata; document any FTS5 technical columns/metadata mappings in ADR-001.
  - [ ] Down migration/index-drop operation is written and tested.
  - [ ] Migration is idempotent and safely handles an already-created index.
  - [ ] Delete strategy: hard-remove derived index rows when source session/message is deleted; soft-delete is not added to the FTS index.
  - [ ] Live-traffic table treatment: N/A; JSON session files remain the source of truth.
- **Dependencies:** Task #009
- **Decisions made:** Keep JSON session files authoritative; FTS5 is a derivative index that can be deleted and rebuilt.

### Task #011 — Synchronize and Rebuild Session Index
- **Phase:** Phase 2 — Domain & Data
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Implement incremental indexing, index rebuild and deletion reconciliation from the authoritative JSON session store.
- **Files to create / modify:** `src/storage/session-search-indexer.ts`, `src/storage/session-manager.ts`, `src/storage/session-search-store.ts`, `test/session-search-indexer.test.ts`
- **Acceptance criteria:**
  - [ ] Appending or updating a session message updates the index without duplicate rows.
  - [ ] A full rebuild produces the same searchable records as incremental indexing.
  - [ ] Deleting a session/message removes or reconciles its search-index entries; index loss does not corrupt source sessions.
- **Migration safety:**
  - [ ] Schema remains identical to Task #010 and `knowledge.md` §7.
  - [ ] No additional schema migration is introduced; Task #010 down migration remains the rollback path.
  - [ ] Indexer/rebuild operations are idempotent.
  - [ ] Delete strategy follows source session/message deletion; no soft-delete field is added to the derived index.
  - [ ] Live-traffic tables: N/A.
- **Dependencies:** Task #010
- **Decisions made:** Run index synchronization as an idempotent projection from the JSON source; rebuild must be available as a recovery path.


### Phase 3 — Core Features

### Task #012 — Normalize Provider-Native Tool Calls
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Introduce one provider-independent tool-call/result contract and map native provider function calls into it while retaining the current structured-JSON fallback.
- **Files to create / modify:** `src/types/provider.ts`, `src/types/message.ts`, `src/agents/tool-parser.ts`, `src/agents/tool-loop.ts`, `src/providers/`
- **Acceptance criteria:**
  - [ ] At least one native-tool provider completes a multi-tool turn with matching call/result IDs.
  - [ ] A provider without native tool calling continues to run through the structured-JSON compatibility path.
  - [ ] Malformed arguments, unknown tool names and duplicate call IDs are rejected before execution.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #006
- **Decisions made:** Keep `IProvider.chat()` compatibility; add normalized capability-aware tool mapping rather than replacing all adapters at once.

### Task #013 — Stream Provider Responses and Events
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Add normalized streaming events and cancellation to the provider contract and agent loop, with non-streaming fallback for providers that do not support streaming.
- **Files to create / modify:** `src/types/provider.ts`, `src/providers/base.ts`, `src/agents/orchestrator.ts`, `src/agents/tool-loop.ts`, `src/cli/`
- **Acceptance criteria:**
  - [ ] A streaming provider emits ordered start/text/tool/result/usage/terminal events with exactly one terminal completion or error.
  - [ ] AbortSignal cancellation stops upstream work where supported and prevents unbounded buffering.
  - [ ] A non-streaming provider still returns the existing final ChatResponse behavior.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #012
- **Decisions made:** Use additive stream capability detection; preserve the existing `chat()` path as compatibility fallback.

### Task #014 — Expose Historical Session Search
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Expose the FTS5 session search and matching-message retrieval through CLI, HTTP API and an agent tool using one shared service contract.
- **Files to create / modify:** `src/storage/session-search-store.ts`, `src/cli/index.ts`, `src/api/routes.ts`, `src/tools/tool-registry.ts`, `src/tools/tool-executor.ts`
- **Acceptance criteria:**
  - [ ] Search accepts query and supported filters (date range, role and optional session/project filter) and returns session ID, timestamp, role and excerpt.
  - [ ] A result can be opened/retrieved by message reference without injecting an entire historical session automatically.
  - [ ] The CLI, API and tool return equivalent normalized search results.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #010, Task #011, Task #012
- **Decisions made:** Keep the index as a query projection and share the same search service between user interfaces.

### Task #015 — Persist Provenance-Aware Memory Items
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Introduce a versioned durable-memory item model with the required categories, provenance, confidence, importance and retention metadata.
- **Files to create / modify:** `src/memory/memory-store.ts`, `src/memory/semantic-memory.ts`, `src/storage/memory-manager.ts`, `test/memory-store.test.ts`
- **Acceptance criteria:**
  - [ ] Memory items support user preference, user profile, project fact, decision, procedure, environment note and temporary fact categories.
  - [ ] Every persisted item records source session/message, timestamp, extractor, confidence and importance.
  - [ ] Memory persistence can be loaded after restart without deleting source sessions.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #012
- **Decisions made:** Use a versioned local store and keep raw session history separate from durable memory; do not add an external vector database.

### Task #016 — Consolidate and Review Memory Candidates
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Implement duplicate/conflict detection and a reviewable consolidation flow that promotes memory candidates into durable memory without silently overwriting conflicting facts.
- **Files to create / modify:** `src/memory/memory-consolidator.ts`, `src/memory/memory-review.ts`, `src/memory/memory-store.ts`, `src/cli/index.ts`
- **Acceptance criteria:**
  - [ ] Duplicate candidates are identified and grouped without deleting source messages.
  - [ ] Conflicting values are surfaced for review rather than silently overwriting durable memory.
  - [ ] Inspect, update, forget and export operations work; forgetting removes the durable record and related search entries.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #015
- **Decisions made:** Treat consolidation as a separate lifecycle from session retention; keep memory writes reviewable and disableable.

### Task #017 — Add Editable User Profile Controls
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Create an editable profile model that separates durable preferences/project facts from temporary or inferred observations and supports category-level opt-out.
- **Files to create / modify:** `src/memory/user-profile.ts`, `src/memory/memory-store.ts`, `src/cli/index.ts`, `src/api/routes.ts`
- **Acceptance criteria:**
  - [ ] Profile facts can be inspected, edited and exported through the supported interface.
  - [ ] Category opt-out prevents new profile extraction for the disabled category.
  - [ ] Profile updates are auditable and do not persist secrets or authentication factors.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #015, Task #016
- **Decisions made:** Keep user-profile data separate from raw transcripts and temporary memory observations.

### Task #018 — Isolate MCP Subprocess Environments
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Replace blanket parent environment inheritance with a per-server environment builder that passes only configured values and approved runtime allowlist entries.
- **Files to create / modify:** `src/mcp/mcp-client.ts`, `src/mcp/mcp-config.ts`, `src/mcp/mcp-server-manager.ts`, `test/mcp.test.js`, `test/mcp-environment-isolation.test.ts`
- **Acceptance criteria:**
  - [ ] A child-process fixture cannot read an unrelated parent API key or secret.
  - [ ] Explicitly configured MCP environment values are available to that server and secrets are redacted from logs/results.
  - [ ] Existing MCP initialize, tool-call and shutdown tests remain green.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #005, Task #006
- **Decisions made:** Use explicit allowlists and named secret references; do not forward `process.env` wholesale.

### Task #019 — Discover Scoped Project Context Files
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Implement project-root and nested-directory instruction discovery with deterministic precedence, size/token budgets and symlink boundary enforcement.
- **Files to create / modify:** `src/context/context-discovery.ts`, `src/agents/orchestrator.ts`, `src/workspace/workspace-manager.ts`, `test/context-discovery.test.ts`
- **Acceptance criteria:**
  - [ ] The discovery service loads supported `AGENTS.md`, `CLAUDE.md`, `.claude/` project rules and Native OpenClaw context files in the documented precedence order.
  - [ ] Nested instructions apply only to their permitted subtree and symlinks outside allowed roots are rejected unless policy allows them.
  - [ ] Untrusted project files cannot change runtime approval, credential or security policy.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #006, Task #012
- **Decisions made:** Treat discovered repository text as untrusted contextual data; runtime security policy always takes precedence.

### Task #020 — Persist Task Lifecycle and Execution Traces
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Add stable task IDs, persisted task states and safe execution traces covering tool outcomes, failures, approvals and cancellation.
- **Files to create / modify:** `src/tasks/task-manager.ts`, `src/tasks/task-store.ts`, `src/agents/orchestrator.ts`, `src/agents/tool-loop.ts`, `src/api/routes.ts`
- **Acceptance criteria:**
  - [ ] Tasks support queued, running, waiting-for-approval, completed, failed, cancelled and timed-out states across restart.
  - [ ] Trace records correlate task/session/provider/tool IDs and distinguish provider failure, tool failure and timeout.
  - [ ] Trace output contains no private model reasoning or raw secrets.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #012, Task #013, Task #018
- **Decisions made:** Persist only operational metadata, outcomes and safe tool summaries; never expose private reasoning in task traces.

### Task #021 — Select Replaceable Browser Backend
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Compare local Playwright, CDP and remote-browser options, then record the selected backend contract and constrained-device fallback before implementing browser operations.
- **Files to create / modify:** `docs/adr/ADR-002-browser-backend.md`, `src/browser/browser-backend.ts`, `test/browser-backend-contract.test.ts`
- **Acceptance criteria:**
  - [ ] The ADR records the selected desktop/server backend, Termux strategy, install footprint and fallback when no browser capability is configured.
  - [ ] The `BrowserBackend` contract covers navigation, inspection, interaction, screenshots, named sessions, timeout and cancellation without exposing implementation-specific types to the orchestrator.
  - [ ] Unavailable backends report not-ready rather than a successful placeholder response.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #020
- **Decisions made:** Keep browser runtime optional; choose remote execution for constrained targets if local browser binaries are not verified.

### Task #022 — Implement Browser Navigation and Inspection
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Implement the first operational browser backend for navigation, waiting and page inspection, replacing the existing 501 browser scaffold for supported configurations.
- **Files to create / modify:** `src/browser/local-browser-backend.ts`, `src/browser/browser-session-manager.ts`, `agents/browser-agent/src/index.js`, `test/browser-navigation.test.ts`
- **Acceptance criteria:**
  - [ ] The backend navigates to a deterministic local test page and returns URL, title and requested page content.
  - [ ] Navigation, wait and inspection operations honor timeout and cancellation.
  - [ ] Browser readiness checks verify the actual browser runtime rather than only worker HTTP availability.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #021
- **Decisions made:** Use the backend selected in ADR-002; preserve a clear not-configured state when browser binaries are absent.

### Task #023 — Implement Browser Interaction and Sessions
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Add click, type, select, scroll, screenshot and policy-controlled upload/download operations with named browser-session isolation.
- **Files to create / modify:** `src/browser/local-browser-backend.ts`, `src/browser/browser-session-manager.ts`, `src/security/credential-provider.ts`, `test/browser-interaction.test.ts`
- **Acceptance criteria:**
  - [ ] A deterministic test flow completes click/type/select/scroll and saves a screenshot artifact.
  - [ ] Uploads/downloads are constrained to allowed workspace paths and session state does not leak across named sessions.
  - [ ] Cookies, passwords and access tokens are excluded from model context and ordinary logs by default.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #022, Task #018
- **Decisions made:** Keep browser credentials outside page text and agent logs; apply workspace policy to every file transfer.

### Task #024 — Create Generic Subagent Manager
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Build a generic child-agent lifecycle independent of specific connectors, with isolated child context, explicit capabilities and bounded execution budgets.
- **Files to create / modify:** `src/agents/subagent-manager.ts`, `src/agents/subagent-contract.ts`, `src/tasks/task-manager.ts`, `test/subagent-manager.test.ts`
- **Acceptance criteria:**
  - [ ] A parent creates a child task with its own task/session IDs, tool allowlist, provider/model selection and execution budget.
  - [ ] Parent can wait, poll, cancel and retrieve a structured child result including status and artifacts.
  - [ ] Child output does not mutate the parent transcript and child credentials/tools are not inherited automatically.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #020, Task #018
- **Decisions made:** Keep `AgentGateway` as connector plumbing and place generic child lifecycle in a dedicated `SubagentManager`; cap delegation depth.

### Task #025 — Execute Bounded Parallel Task Graphs
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Add dependency-aware parallel execution for independent child tasks with concurrency limits, cancellation propagation and write-conflict detection.
- **Files to create / modify:** `src/agents/task-graph.ts`, `src/agents/parallel-executor.ts`, `src/agents/subagent-manager.ts`, `test/parallel-executor.test.ts`
- **Acceptance criteria:**
  - [ ] Two independent fixture tasks run concurrently within configured global/per-user limits; dependent tasks wait for predecessors.
  - [ ] A failed prerequisite cancels or blocks only policy-dependent tasks while completed partial results remain available.
  - [ ] Concurrent writes to the same file are rejected or resolved by an explicit conflict strategy.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #024, Task #020
- **Decisions made:** Use bounded concurrency and preserve partial child results; never silently merge conflicting file writes.

### Task #026 — Define Terminal Backend and Local Adapter
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Define a replaceable terminal execution contract and adapt the existing local `system-execute` path to consume it without weakening risk classification or approval.
- **Files to create / modify:** `src/execution/execution-backend.ts`, `src/execution/local-backend.ts`, `src/tools/plugins/system-execute.plugin.ts`, `test/execution-backend.test.ts`
- **Acceptance criteria:**
  - [ ] The local backend accepts task ID, working directory, environment allowlist, timeout and output bounds.
  - [ ] Existing dangerous-command approval and workspace restrictions remain enforced through the shared policy layer.
  - [ ] Unavailable or invalid backend selection fails closed.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #020, Task #018
- **Decisions made:** Keep policy independent from backend selection; backend choice must not bypass command risk classification.

### Task #027 — Implement Isolated Docker Execution Adapter
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Add the Docker execution adapter for supported desktop/server hosts using non-root execution, bounded resources and restricted mounts/network policy.
- **Files to create / modify:** `src/execution/docker-backend.ts`, `src/execution/execution-backend.ts`, `test/docker-execution-backend.test.ts`
- **Acceptance criteria:**
  - [ ] An approved fixture command executes in a non-root container with configured CPU/memory/output limits.
  - [ ] A forbidden host path is not mounted or accessible and missing Docker capability returns a clear unavailable status.
  - [ ] The adapter preserves approval and timeout semantics from the shared execution policy.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #026
- **Decisions made:** Treat Docker as an optional execution backend, never as a core runtime or Termux prerequisite.

### Task #028 — Implement Restricted SSH Execution Adapter
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Add an SSH execution backend using configured host allowlists and scoped credentials for remote terminal work.
- **Files to create / modify:** `src/execution/ssh-backend.ts`, `src/execution/execution-backend.ts`, `src/security/credential-provider.ts`, `test/ssh-execution-backend.test.ts`
- **Acceptance criteria:**
  - [ ] A configured test host executes an approved command with the requested working directory and timeout.
  - [ ] Unlisted hosts and missing credentials are rejected before connection; credentials are absent from logs and task traces.
  - [ ] The remote result is normalized to the shared execution result contract.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #026
- **Decisions made:** Use explicit host configuration/SSH-agent credentials behind the backend contract for this task; integrate the central credential provider in the later credential-management task. Never accept arbitrary SSH destinations from model output.

### Task #029 — Manage Background Process Lifecycle
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Provide stable process handles and lifecycle operations for long-running terminal commands, including bounded output retention and orphan cleanup.
- **Files to create / modify:** `src/execution/process-manager.ts`, `src/execution/local-backend.ts`, `src/cli/index.ts`, `test/process-manager.test.ts`
- **Acceptance criteria:**
  - [ ] A background fixture process can be started, inspected, tailed, awaited, interrupted and terminated by handle.
  - [ ] Process metadata includes owner/task/workdir/time and output storage remains bounded after completion.
  - [ ] Restart recovery detects owned orphan processes and follows the documented cleanup policy.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #020, Task #026
- **Decisions made:** Avoid `node-pty` or other native dependencies in the core unless separately proven on the platform matrix.

### Task #030 — Add Safe File Read and Search Tools
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Implement bounded file read, directory listing and search operations that enforce workspace/project roots, ignore rules and symlink boundaries.
- **Files to create / modify:** `src/files/file-service.ts`, `src/tools/tool-registry.ts`, `src/tools/tool-executor.ts`, `test/file-service-read-search.test.ts`
- **Acceptance criteria:**
  - [ ] Read/list/search returns results only within permitted roots and respects file size/encoding limits and configured ignore rules.
  - [ ] Path traversal and symlink escape fixtures are rejected.
  - [ ] Tool results identify truncation and limits without returning raw secrets from denied paths.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #018, Task #020
- **Decisions made:** Share the same path policy across browser downloads, terminal execution and file tools.

### Task #031 — Add Atomic File Patch and Rollback
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Implement context-checked unified-diff application, atomic writes, preview/diff output and rollback metadata for agent-generated changes.
- **Files to create / modify:** `src/files/file-patch-service.ts`, `src/files/file-service.ts`, `src/workspace/workspace-manager.ts`, `test/file-patch-service.test.ts`
- **Acceptance criteria:**
  - [ ] A valid patch applies atomically and emits a diff summary plus changed-file list.
  - [ ] A stale or invalid patch is rejected without partially modifying the target file.
  - [ ] Rollback restores the original bytes from recorded metadata; permanent deletion remains policy-gated.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #030, Task #020
- **Decisions made:** Require expected-context validation and preserve a recoverable original before applying agent-generated changes.

### Task #032 — Define Unified Messaging Gateway Contract
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Create the channel-independent inbound/outbound message envelope and adapter lifecycle so channel integrations do not call the orchestrator directly.
- **Files to create / modify:** `src/messaging/messaging-adapter.ts`, `src/messaging/messaging-gateway.ts`, `src/messaging/message-envelope.ts`, `test/messaging-gateway.test.ts`
- **Acceptance criteria:**
  - [ ] The envelope includes channel, account, chat, sender, message ID, attachments and reply/thread metadata.
  - [ ] Adapters expose start, stop, health, receive, send and delivery-status behavior through one interface.
  - [ ] Session routing is identity-isolated and rejects unauthorized sender identities before task creation.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #020, Task #012
- **Decisions made:** Keep channel-specific SDKs behind adapters and make inbound message ID the idempotency key for task creation.

### Task #033 — Load Skills Progressively on Demand
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Change skill selection to load metadata first and retrieve full instructions only when a skill is relevant and enabled.
- **Files to create / modify:** `src/skills/skill-registry.ts`, `src/skills/skill-loader.ts`, `src/agents/orchestrator.ts`, `src/cli/index.ts`, `test/progressive-skills.test.ts`
- **Acceptance criteria:**
  - [ ] The prompt contains skill metadata but does not inject unrelated full skill bodies.
  - [ ] A selected skill can be viewed/loaded on demand and disabled skills are not loaded.
  - [ ] Skill scripts from untrusted sources are never auto-executed.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #019, Task #012
- **Decisions made:** Preserve existing skill activation and self-improvement behavior while introducing progressive loading.

### Task #034 — Add Agent Skills Compatibility Catalog
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Implement import/export validation and a local catalog for the selected portable Agent Skills format, including provenance and trust metadata.
- **Files to create / modify:** `src/skills/agent-skills/`, `src/skills/skill-registry.ts`, `src/cli/index.ts`, `test/agent-skills-compat.test.ts`
- **Acceptance criteria:**
  - [ ] A valid external-format skill imports with equivalent name/description/instructions and a recorded source/version/checksum.
  - [ ] Invalid or unsafe packages are rejected with a diagnostic and untrusted scripts are not executed.
  - [ ] Updating an imported skill does not silently overwrite local modifications.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #033
- **Decisions made:** Implement a local catalog first; remote marketplace/billing is outside this milestone.

### Task #035 — Define Multimodal Attachment Contracts
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Add provider capability negotiation and secure attachment metadata/storage contracts for image and audio inputs/outputs, keeping video generation/analysis optional.
- **Files to create / modify:** `src/types/message.ts`, `src/providers/`, `src/attachments/attachment-store.ts`, `src/attachments/modality-capabilities.ts`, `test/multimodal-contract.test.ts`
- **Acceptance criteria:**
  - [ ] Messages can represent image/audio attachments without flattening binary data into ordinary text logs.
  - [ ] Provider capabilities explicitly report image/audio support and unsupported modalities return a clear error.
  - [ ] Attachment size/MIME validation and redaction prevent image/audio payloads from appearing in public logs.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #012, Task #005
- **Decisions made:** Define replaceable modality contracts using currently configured provider credentials; integrate the central credential provider in the later credential-management task. Do not bundle heavy media runtimes into the core Termux package.


## [COMPLETED]

> Changelog v1.0.0 initialized from `knowledge.md` v1.0.0 on 2026-11-14. Shape: `fullstack`. No execution task is marked complete by initialization.

### Task #001 — Project Scaffolding, CI/CD & Observability Baseline ✅
- **Completed:** 2026-11-15
- **Phase:** Phase 1 — Foundation
- **Status:** OK
- **Branch:** feat/task-001-project-scaffolding-ci-cd-observability-baseline
- **Files created / modified:**
  - `.gitignore` — grouped baseline: secrets/keys/certs, Node/TS generated output, logs/OS noise, AI-agent local state, `.scratch/`; local runtime data paths anchored to the repo root
  - `.husky/pre-commit` — committed hook that runs the staged-path checker
  - `scripts/check-staged-files.mjs` — staged-path denylist checker (`.env*` except `.env.example`, key/cert files, `CLAUDE.local.md`, `.claude/settings.local.json`, `.claude/worktrees/`, `.aider*`, `.scratch/`, `secrets/`)
  - `package.json` — added `husky` devDependency and the `prepare` hook-install script
  - `package-lock.json` — lockfile updated for husky 9.1.7
  - `src/web-ui/web-ui-types.ts` — replaced an empty extending interface with an equivalent type alias (pre-existing lint error that blocked the Phase 1 lint gate)
  - `README.md` — Quick Start: hook installation note and manual check command
  - `knowledge.md` — §2 Git hooks entry; version bumped to 1.0.1
  - `changelog.md` — task tracker, version 1.0.1
  - Pre-existing untracked flow source docs committed unchanged: `PRD.md`, `TDD.md`, `AGENTS.md`, `CLAUDE.md`, `changelog-milestone-2.md`, `hermes-termux/*`
- **Acceptance criteria met:**
  - [x] `.gitignore` contains all five required groups: secrets; Node/TypeScript-generated output; logs/OS noise; AI-agent local state; and `.scratch/`.
  - [x] `git ls-files -ci --exclude-standard` prints no paths after remediation.
  - [x] The pre-commit hook blocks `.env*` except `.env.example`, key/cert files, `CLAUDE.local.md`, `.claude/settings.local.json`, `.claude/worktrees/`, `.aider*`, and `.scratch/`; it does not ignore all of `.claude/`, `CLAUDE.md`, or `AGENTS.md`.
  - [x] A temporary probe file in each denylist category is rejected by the hook.
- **Security gate:** BASIC — all applicable checks passed — OPEN ITEM: main/production branch protection requires GitHub admin API access that this run does not have; assign to Task #003 when CI exists (see Notes)
- **Scalability gate:** BASIC — all checks passed (most items N/A: no request path, DB, pool or external I/O added)
- **Regression:** Phase 1 build OK — `npm run build` exit 0; `npx eslint "src/**/*.ts"` exit 0 (0 errors, 2 pre-existing warnings); `node test/web-ui.test.js` 19/19 passed
- **Decisions made:**
  - [ARCH] Use Husky 9 with a single Node denylist script shared by the hook; no per-pattern grep chains.
  - [INFRA] Anchor gitignored local data paths (`/workspace/`, `/data/`, `/.data/`, `/.data-test*/`, `/tmp/`) to the repository root so tracked `src/workspace/*.ts` files stop matching `workspace/`; that anchor is the remediation for `git ls-files -ci`.
  - [ARCH] Commit the pre-existing untracked flow source docs unchanged in this scaffold task so the repository baseline is self-describing and the working tree is clean for later tasks.
  - [TEST] Verify the hook twice: probe files in a throwaway repo (10 deny categories rejected, 5 allowed paths accepted) and a real `git commit` with a forced-staged `.scratch/` probe that Husky rejected end-to-end.
- **Notes:** Main/production branch protection could not be configured: `gh` is not installed and no GitHub admin API client/token is available to this run; repository settings are not file changes. Follow up in Task #003, which creates CI. Also out of the task's original file list: `src/web-ui/web-ui-types.ts` was edited to clear a pre-existing ESLint error that blocked the Phase 1 lint gate (type-only, no runtime change). Pre-existing untracked docs were committed unchanged, not edited.
- **Knowledge drift:** UPDATE REQUIRED: @knowledge §2 — added the Git hooks entry (Husky dev dependency + `scripts/check-staged-files.mjs`), version bumped to 1.0.1
- **Docs sync:** updated README.md — Quick Start: documented hook installation via `npm install` and the manual `node scripts/check-staged-files.mjs` command


## Milestone Rules and Source Constraints

- `existing_codebase: false` is copied from `knowledge.md` according to the exact Prompt 05 provenance rule; it does not assert that the Git repository is empty. Preserve existing source and extend modules rather than rewriting them.
- Phase applicability: Phase 1, Phase 2, Phase 3, Phase 4, Phase 5, Phase 6 and Phase 7 apply. The project is `fullstack`, has an SQLite FTS5 index, consumes third-party services and has a Web UI.
- Phase 7 uses the Server variant. The project is not high-scale by the source definition; no edge/WAF, API-gateway scaling or autoscaling tasks are added.
- `simple_mode: false`; capacity Stage 2 is required. Initial and six-month user targets are not specified, so use the required 50-VU minimum as a baseline and do not describe it as a declared capacity target.
- No inbound webhook provider is specified. Webhook signature-verification tasks are N/A until an inbound webhook is added; retryable messaging/email operations still require idempotency.
- The source provides no relational entity schema. Phase 2 changes are limited to the documented rebuildable FTS5 session index; no unapproved domain tables, soft-delete fields or live-traffic table migrations may be invented.
- Phase 6 endpoint audit is read-only. Its findings must become new tasks at the front of `[NEXT TASKS]`, continuing numbering above Task #063; do not fix findings inside the audit task or renumber existing tasks.
- Phase 3 and later tasks each include a unit-test criterion and a test-isolation criterion. Phase 2 tasks include migration-safety checks.
- All paths are repository-relative. A task must update `knowledge.md`/TDD or add an ADR when an implementation decision changes the agreed source of truth.
