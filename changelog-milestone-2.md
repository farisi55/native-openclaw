---
project: Native OpenClaw
knowledge_version: 1.0.0
changelog_version: 1.0.0
created: 2026-11-14
status: in_progress
milestone: 2 of 2
project_shape: fullstack
simple_mode: false
existing_codebase: false
high_scale_target: false
---

## [IN PROGRESS]

Milestone 2 is gated by the Milestone 1 exit criteria. No task in this milestone is marked active until Milestone 1 is accepted.


## [NEXT TASKS]

### Phase 3 — Core Features

### Task #036 — Centralize Credentials and OAuth Lifecycle
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Introduce scoped credential-provider interfaces for environment secrets and encrypted local credentials, plus refresh/revocation handling for integrations that require OAuth.
- **Files to create / modify:** `src/security/credential-provider.ts`, `src/security/credential-vault.ts`, `src/security/oauth/`, `src/mcp/`, `src/integrations/`, `test/credential-provider.test.ts`
- **Acceptance criteria:**
  - [ ] A tool receives only credentials declared in its scope; raw secrets never enter prompts, sessions, memory, logs or diagnostic exports.
  - [ ] Expired OAuth credentials refresh successfully when configured or return a reauthorization-required status.
  - [ ] Termux configuration documents a secure fallback without assuming Android Keystore support.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #005, Task #006
- **Decisions made:** Keep secret storage behind a platform-neutral interface; decide the encryption/key-protection mechanism per platform before storing long-lived tokens.

### Task #037 — Add Operational Diagnostics and Support Bundles
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Expose component readiness and task-correlated diagnostics for providers, MCP servers, execution/browser backends and messaging adapters, with a redacted support bundle.
- **Files to create / modify:** `src/observability/diagnostics.ts`, `src/observability/support-bundle.ts`, `src/api/routes.ts`, `src/cli/index.ts`, `test/diagnostics.test.ts`
- **Acceptance criteria:**
  - [ ] Diagnostics distinguish process health from capability readiness and identify an unavailable optional backend accurately.
  - [ ] Exported support bundles include task/session/provider/tool correlation metadata but contain no configured secrets or private model reasoning.
  - [ ] Provider/tool latency, token usage, error category and success/failure counters are available through the diagnostics contract.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #005, Task #007, Task #020
- **Decisions made:** Keep observability local-first and vendor-neutral; use structured logs and bounded metrics before adding an external telemetry dependency.


### Task #038 — Create Versioned OpenAPI Contract
- **Phase:** Phase 3 — Core Features
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Create the machine-readable API contract for every registered HTTP route, using the existing versioned API surface and actual route/request/response behavior as the source.
- **Files to create / modify:** `docs/api.yaml`, `scripts/qa/verify-openapi.ts`, `src/api/routes.ts`, `src/api/types.ts`
- **Acceptance criteria:**
  - [ ] `docs/api.yaml` documents every implemented route, HTTP method, path, authentication requirement and available request/response schema without inventing unsupported fields.
  - [ ] An automated verifier detects both undocumented routes and stale paths in `docs/api.yaml`.
  - [ ] API contract changes are additive/backward-compatible unless a separately approved breaking-version decision exists.
  - [ ] Unit test for the route-to-OpenAPI verifier is written and passing.
  - [ ] Test is isolated: it creates its own route fixtures and cleans them up; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #007, Task #014
- **Decisions made:** Keep `docs/api.yaml` as the committed API contract and generate/verify it from the actual route registry; use the existing API versioning rather than inventing a new base path.

### Phase 4 — Integration

### Task #039 — Add Provider Timeout and Circuit Breaker
- **Phase:** Phase 4 — Integration
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Harden outbound LLM provider calls with consistent timeouts and per-provider circuit-breaker state while preserving provider fallback behavior.
- **Files to create / modify:** `src/providers/base.ts`, `src/router/fallback-manager.ts`, `src/router/provider-health.ts`, `test/provider-resilience.test.ts`
- **Acceptance criteria:**
  - [ ] A timed-out provider is classified and the router follows the configured fallback path.
  - [ ] Repeated failures open the provider circuit and a healthy provider can serve the request; recovery/half-open behavior is tested.
  - [ ] Circuit state and error logs contain no API key or raw secret.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #012, Task #013, Task #005
- **Decisions made:** Keep breaker state per provider/model endpoint and do not retry non-idempotent tool execution as if it were a pure model request.

### Task #040 — Harden Remote MCP Call Reliability
- **Phase:** Phase 4 — Integration
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Add outbound timeout and circuit-breaker behavior for remote MCP endpoints and bounded recovery for local MCP subprocess failures.
- **Files to create / modify:** `src/mcp/mcp-client.ts`, `src/mcp/mcp-server-manager.ts`, `src/mcp/mcp-config.ts`, `test/mcp-resilience.test.ts`
- **Acceptance criteria:**
  - [ ] A slow remote MCP call times out within its configured bound and marks the server capability unavailable.
  - [ ] Repeated remote endpoint failures open the server circuit and recover after the configured probe succeeds.
  - [ ] Non-idempotent `tools/call` requests are not automatically replayed unless explicitly declared safe.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #018, Task #036
- **Decisions made:** Apply timeout/circuit-breaker to remote server transport; avoid transparent retries of side-effecting MCP tool calls.

### Task #041 — Migrate Telegram Through Messaging Gateway
- **Phase:** Phase 4 — Integration
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Wrap the current Telegram bot in the unified messaging adapter without changing the orchestrator or losing existing allowlist/session behavior.
- **Files to create / modify:** `src/integrations/telegram.ts`, `src/messaging/adapters/telegram-adapter.ts`, `src/messaging/messaging-gateway.ts`, `test/telegram.test.js`
- **Acceptance criteria:**
  - [ ] Existing Telegram polling, queue, allowed-chat and reply behavior works through the messaging gateway.
  - [ ] A retry of the same Telegram message ID does not create a duplicate task.
  - [ ] Outbound Telegram sends have bounded timeouts and a per-channel circuit breaker; a failed send is surfaced without duplicating task execution.
  - [ ] An unauthorized sender cannot invoke tools or access an existing session.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #032, Task #020
- **Decisions made:** Preserve existing Telegram identity/session mapping and move channel-specific logic behind the adapter.

### Task #042 — Add a Second Messaging Channel
- **Phase:** Phase 4 — Integration
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Select and implement one additional adapter from the PRD candidates (WhatsApp, Discord or Slack) through the existing messaging contract.
- **Files to create / modify:** `docs/adr/ADR-004-secondary-channel.md`, `src/messaging/adapters/secondary-adapter.ts`, `src/messaging/messaging-gateway.ts`, `test/secondary-channel-adapter.test.ts`
- **Acceptance criteria:**
  - [ ] The ADR records the selected channel, authentication method, operational constraints and reason for selection.
  - [ ] The selected adapter can receive and send a controlled test message without changing the core orchestrator.
  - [ ] Allowlist, session isolation, delivery status and idempotency tests pass.
  - [ ] Outbound sends have bounded timeouts and a per-channel circuit breaker; side-effecting sends are not replayed without idempotency.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #032, Task #036, Task #041
- **Decisions made:** Choose exactly one candidate for this iteration; keep the other candidates deferred rather than adding multiple SDKs at once.

### Task #043 — Harden Brevo Email Delivery
- **Phase:** Phase 4 — Integration
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Add outbound timeout, retry policy and circuit-breaker handling to Brevo email delivery, with idempotency protection against duplicate scheduled notifications.
- **Files to create / modify:** `src/tools/plugins/brevo-email.plugin.ts`, `src/integrations/brevo-email.ts`, `src/scheduler/`, `test/brevo-email-resilience.test.ts`
- **Acceptance criteria:**
  - [ ] A Brevo timeout is bounded and classified; repeated service failures open the circuit and recover on a successful probe.
  - [ ] A retryable scheduled email uses a stable idempotency key or an outbox guard to prevent duplicate delivery.
  - [ ] Missing Brevo credentials disable the integration with a clear readiness status and no secret leakage.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #036, Task #037
- **Decisions made:** Use circuit breaker because `simple_mode` is false; do not automatically replay a send unless idempotency is enforced.

### Task #044 — Implement Verifiable Research Worker
- **Phase:** Phase 4 — Integration
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Replace the research-agent placeholder with a real search/crawler backend and return structured evidence records.
- **Files to create / modify:** `agents/research-agent/src/index.js`, `src/research/research-backend.ts`, `src/tools/browsing.ts`, `test/research-agent.test.ts`
- **Acceptance criteria:**
  - [ ] A configured research request returns source URLs, retrieval timestamps and evidence excerpts for a controlled test query.
  - [ ] Missing backend credentials/readiness produces an explicit unavailable status rather than a placeholder success.
  - [ ] Search/crawler calls enforce outbound timeouts and a circuit breaker; failed requests return a classified integration error.
  - [ ] Untrusted source text is returned as evidence and cannot authorize privileged tools.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #021, Task #022, Task #039
- **Decisions made:** Reuse configured Tavily/Firecrawl or a separately approved backend; preserve source attribution and retrieval timestamps.

### Task #045 — Implement Scoped Spreadsheet Worker
- **Phase:** Phase 4 — Integration
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Replace the spreadsheet-agent placeholder with a real Google Sheets or MCP adapter using explicit read/write scopes.
- **Files to create / modify:** `agents/spreadsheet-agent/src/index.js`, `src/integrations/google-sheets/`, `src/security/credential-provider.ts`, `test/spreadsheet-agent.test.ts`
- **Acceptance criteria:**
  - [ ] The configured adapter reads and writes a controlled test spreadsheet within its declared scopes.
  - [ ] Missing credentials or scopes return a clear unavailable/permission error and do not report the worker as ready.
  - [ ] Google Sheets calls enforce outbound timeouts and a circuit breaker; writes are not automatically replayed without an idempotency guard.
  - [ ] Spreadsheet inputs/outputs are validated and secrets are absent from logs and task traces.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #036, Task #037
- **Decisions made:** Use Google Sheets or an approved MCP implementation; record selected API/scopes in the integration ADR before enabling writes.

### Phase 5 — UI/UX

### Task #046 — Harden Web UI Output and CDN Policy
- **Phase:** Phase 5 — UI/UX
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Audit and harden the Web UI rendering boundary against XSS and ensure any externally loaded script/style uses Subresource Integrity.
- **Files to create / modify:** `src/web-ui/public/`, `src/web-ui/`, `test/html-sanitizer.test.js`, `docs/security/web-ui.md`
- **Acceptance criteria:**
  - [ ] Untrusted user, tool, browser and model text is rendered as text or safely sanitized; an XSS fixture cannot execute script.
  - [ ] If external CDN assets are present, each script/style uses integrity and crossorigin attributes; otherwise the build contains no unapproved external CDN dependency.
  - [ ] Production UI does not expose unsafe HTML insertion paths for untrusted content.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #005, Task #032
- **Decisions made:** Prefer locally packaged assets; use SRI wherever an external CDN script/style is retained.

### Task #047 — Stream Task Progress into Web UI
- **Phase:** Phase 5 — UI/UX
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Connect the normalized streaming/task event contract to the Web UI so users can see text, tool progress, approvals and completion in order.
- **Files to create / modify:** `src/api/stream.ts`, `src/api/routes.ts`, `src/web-ui/public/`, `docs/adr/ADR-003-web-stream-transport.md`, `test/web-ui-streaming.test.ts`
- **Acceptance criteria:**
  - [ ] The chosen SSE/WebSocket transport is documented and emits ordered message/tool/task events with one terminal state.
  - [ ] The UI can cancel an active task and displays waiting-for-approval, failed, cancelled and completed states accurately.
  - [ ] A reconnect or transport failure does not duplicate final text or create duplicate task execution.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #013, Task #020, Task #046
- **Decisions made:** Choose the lowest-complexity transport supported by the existing HTTP server; record the transport decision in ADR-003.

### Task #048 — Upgrade Interactive Terminal Experience
- **Phase:** Phase 5 — UI/UX
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Upgrade the current REPL into a task-oriented TUI with multiline input, command history, streaming output, tool progress, approvals and interrupt.
- **Files to create / modify:** `src/cli/index.ts`, `src/cli/tui/`, `src/agents/orchestrator.ts`, `test/tui.test.ts`
- **Acceptance criteria:**
  - [ ] A TTY session supports multiline input/history and shows streamed assistant/tool status in order.
  - [ ] The user can interrupt a running task and approve/deny a privileged action without terminating the whole application.
  - [ ] Non-TTY/pipe usage falls back to the existing basic readline behavior.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #013, Task #020
- **Decisions made:** Avoid native terminal dependencies in the core unless they pass the ARM32/Bionic compatibility test.

### Phase 6 — Testing & QA

### Task #049 — Establish Regression and Coverage Baseline
- **Phase:** Phase 6 — Testing & QA
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Run the complete regression suite, add missing unit/contract/E2E tests for delivered features and publish an actual coverage report without inventing a numeric target.
- **Files to create / modify:** `package.json`, `test/`, `scripts/qa/`, `docs/qa/coverage-baseline.md`
- **Acceptance criteria:**
  - [ ] All existing provider/router, CLI/session, MCP, system-execute/security, workspace, scheduler, Telegram, API, self-healing and self-improving regression tests pass.
  - [ ] The actual coverage report and measured baseline are recorded; no numeric coverage threshold is imposed until a maintainer sets one because the source specifies none.
  - [ ] A representative end-to-end flow covers repository task execution, browser/child-task behavior and interrupted-task recovery where enabled.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #012, Task #013, Task #014, Task #016, Task #018, Task #019, Task #020, Task #022, Task #024, Task #025, Task #026, Task #030, Task #031, Task #032, Task #033, Task #034, Task #035, Task #036, Task #039, Task #041
- **Decisions made:** Use the repository’s existing Node test tooling and record the measured baseline rather than inventing a coverage percentage.

### Task #050 — Audit Every HTTP API Endpoint
- **Phase:** Phase 6 — Testing & QA
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Perform a read-only STANDARD+FULL inventory of every HTTP route and cross-check it against `docs/api.yaml`; report authentication, authorization, rate limiting and schema-validation gaps without fixing them inline.
- **Files to create / modify:** `src/api/routes.ts`, `src/api/server.ts`, `src/api/types.ts`, `docs/api.yaml`, `docs/security/endpoint-audit.md`
- **Acceptance criteria:**
  - [ ] The report inventories every route with auth required, authorization layer/check, rate-limit status and request/response schema validation status.
  - [ ] The inventory is cross-checked against `docs/api.yaml`; missing documentation or mismatches are recorded as findings.
  - [ ] Every finding names the endpoint, defect and Security Gate tier (BASIC/STANDARD/FULL); no code remediation is performed in this task.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #038, Task #046, Task #049
- **Decisions made:** Context requirement: fresh session, no prior code-authoring history in this conversation, or dispatch to a subagent (Appendix J). Add each finding as a new remediation task at the front of [NEXT TASKS], with a task number greater than 64; do not renumber existing tasks.

### Task #051 — Add Security Acceptance Regression Tests
- **Phase:** Phase 6 — Testing & QA
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Create isolated security tests for prompt injection, MCP environment exposure, child-agent privilege boundaries, browser file transfer boundaries and approval bypass.
- **Files to create / modify:** `test/security/`, `test/mcp-environment-isolation.test.ts`, `test/subagent-manager.test.ts`, `test/browser-interaction.test.ts`, `test/system-execute-security.test.js`
- **Acceptance criteria:**
  - [ ] A malicious web/project/skill/tool fixture cannot authorize a privileged shell operation.
  - [ ] MCP and child-agent fixtures cannot access undeclared parent secrets or forbidden paths.
  - [ ] Dangerous shell commands and unauthorized messaging senders are rejected before execution.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #018, Task #023, Task #024, Task #026, Task #032, Task #041, Task #050
- **Decisions made:** Use deterministic fixtures and isolated temporary directories; do not use real production credentials in security tests.

### Phase 7 — Deployment (Server variant)

### Task #052 — Prepare Versioned Staging Release
- **Phase:** Phase 7 — Deployment (Server variant)
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Define the release version/tag convention, build a deployable staging artifact and deploy the application to a controlled staging environment with required configuration.
- **Files to create / modify:** `package.json`, `.github/workflows/release.yml`, `scripts/release/`, `docs/release.md`, `README.md`
- **Acceptance criteria:**
  - [ ] A version/tag convention is documented and the staging artifact is versioned; the previous version remains available for redeployment.
  - [ ] The application deploys to staging and a smoke test confirms startup plus required environment configuration.
  - [ ] The README build/run/deploy instructions match the release workflow and are followed successfully.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #003, Task #004, Task #007, Task #049, Task #050, Task #051
- **Decisions made:** Release version format is not specified in `knowledge.md`; propose `v<package.json version>` and obtain maintainer approval before tagging.

### Task #053 — Verify Graceful Shutdown During Deployment
- **Phase:** Phase 7 — Deployment (Server variant)
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Ensure SIGTERM drains in-flight HTTP requests, flushes persistence and stops owned scheduler/child processes before process exit.
- **Files to create / modify:** `src/index.ts`, `src/api/server.ts`, `src/scheduler/`, `src/execution/process-manager.ts`, `test/graceful-shutdown.test.ts`
- **Acceptance criteria:**
  - [ ] A controlled deployment sends SIGTERM and the process stops accepting new requests while completing or safely cancelling in-flight work.
  - [ ] Session/task writes are flushed and owned child processes are stopped or safely requeued before exit.
  - [ ] A sustained-load staging deploy produces zero 5xx responses during the verified drain window.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #020, Task #029, Task #052
- **Decisions made:** Make shutdown idempotent and bounded; persist task state before process exit.

### Task #054 — Test Staging Rollback Procedure
- **Phase:** Phase 7 — Deployment (Server variant)
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Document and execute a staging rollback to the previous version, including compatibility handling for local data/index changes.
- **Files to create / modify:** `docs/release.md`, `scripts/release/rollback.sh`, `.github/workflows/release.yml`, `test/release-rollback.test.ts`
- **Acceptance criteria:**
  - [ ] A previous tagged version can be redeployed in under 10 minutes using the documented procedure.
  - [ ] Rollback is tested in staging and preserves/restores user data and rebuildable search indexes safely.
  - [ ] The procedure identifies any migration that cannot be automatically reversed and its recovery path.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #052, Task #053, Task #010, Task #011
- **Decisions made:** Treat JSON sessions as authoritative and rebuild derived FTS indexes if rollback invalidates the index format.

### Task #055 — Run Two-Stage Staging Load Tests
- **Phase:** Phase 7 — Deployment (Server variant)
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Run the required smoke and capacity load stages on staging and record latency, error rate, memory and mid-test deployment behavior.
- **Files to create / modify:** `scripts/load/`, `docs/qa/staging-load-test.md`, `package.json`
- **Acceptance criteria:**
  - [ ] Stage 1 completes at 10 VU for 60 seconds and records P95, P99 and error rate.
  - [ ] Stage 2 completes for at least 2 minutes at a minimum 50 VU baseline; initial and six-month user targets are unspecified, so 50 VU is the minimum test floor, not a declared product capacity.
  - [ ] Memory at test end is no more than 120% of the starting level and a mid-test deployment causes zero 5xx responses.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #052, Task #053, Task #054
- **Decisions made:** Use k6 as the load-test runner; record actual staging capacity and limitations. `high_scale_target=false`, so no edge/WAF or horizontal autoscaling requirement is added.

### Task #056 — Configure Staging Alerts and Event Metrics
- **Phase:** Phase 7 — Deployment (Server variant)
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Validate production-configured log level, add an actionable error-rate alert and verify task/tool/provider operational events in staging.
- **Files to create / modify:** `src/observability/`, `config/alert-rules.yml`, `docs/operations/alerts.md`, `docs/qa/staging-observability.md`
- **Acceptance criteria:**
  - [ ] Log level is configuration-driven; the production level is explicitly selected and recorded with maintainer approval because `knowledge.md` does not specify a production log-level value.
  - [ ] At least one error-rate alert rule is configured and deliberately triggered in staging; the chosen threshold and destination are documented.
  - [ ] A smoke task records task-started/completed/failed, tool outcome and provider-fallback events with correlation IDs and no secrets.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #005, Task #037, Task #052
- **Decisions made:** Alert provider and threshold are not specified in the source; choose the staging operator’s supported alert destination and record the threshold before enabling it.

### Task #057 — Verify OpenAPI Against Staging
- **Phase:** Phase 7 — Deployment (Server variant)
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Verify the committed `docs/api.yaml` against the running staging server after the versioned API is deployed.
- **Files to create / modify:** `docs/api.yaml`, `src/api/routes.ts`, `src/api/server.ts`, `scripts/qa/verify-openapi.ts`
- **Acceptance criteria:**
  - [ ] Every implemented HTTP route and request/response schema is represented in `docs/api.yaml`.
  - [ ] The committed contract has no undocumented routes or stale paths when checked against staging; discrepancies block the release.
  - [ ] The README and API documentation identify the current API base/version and authentication requirements.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #007, Task #038, Task #052
- **Decisions made:** Use the existing normalized API contracts; do not invent endpoint fields or pagination behavior absent from implementation.

### Task #058 — Run Live Staging Security Verification
- **Phase:** Phase 7 — Deployment (Server variant)
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Verify security controls against the running staging origin using actual requests and scan output, not code-only assertions.
- **Files to create / modify:** `docs/security/staging-verification.md`, `scripts/security/staging-checks/`, `docs/api.yaml`
- **Acceptance criteria:**
  - [ ] Actual staging responses satisfy applicable HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy and CSP headers.
  - [ ] Foreign/untrusted Origin, missing/invalid auth and rate-limit crossing produce rejected/401-or-403/429 responses as applicable; cross-account access is denied for any ownership-scoped resource or documented N/A with evidence if no such resource exists.
  - [ ] Source maps are not downloadable; DB/internal ports are not externally reachable; OWASP ZAP baseline has zero unresolved high-severity findings.
  - [ ] The report includes actual commands and outputs for each check.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #046, Task #050, Task #051, Task #052, Task #057
- **Decisions made:** Do not claim a control is verified from configuration alone; test the running staging deployment. No external penetration-test compliance regime is specified.

### Task #059 — Test Backup Restore and Release Documentation
- **Phase:** Phase 7 — Deployment (Server variant)
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Back up the authoritative local data and restore it once in staging, then synchronize release/run/deploy documentation with the tested behavior.
- **Files to create / modify:** `scripts/backup/`, `scripts/restore/`, `docs/operations/backup-restore.md`, `README.md`, `docs/release.md`
- **Acceptance criteria:**
  - [ ] A staging backup restores JSON sessions, memory, scheduler/task state and workspace data without corrupting the source.
  - [ ] The FTS5 session search index can be rebuilt after restore and returns equivalent search results.
  - [ ] README build/run/deploy-or-release instructions are followed end-to-end and match the tested release.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #010, Task #011, Task #052, Task #054
- **Decisions made:** Keep backup frequency/retention/RTO/RPO as operator decisions until the product owner defines them; prove one successful restore.

### Special Track — X98 Mini / Termux ARM32

### Task #060 — Build Docker-Free Termux Install Scripts
- **Phase:** Special Track — X98 Mini / Termux ARM32
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Create native Termux install/configure/update/start/stop/status/backup scripts that install Node dependencies and build the project without Docker or a Linux userspace emulator.
- **Files to create / modify:** `scripts/termux/install.sh`, `scripts/termux/configure.sh`, `scripts/termux/start.sh`, `scripts/termux/stop.sh`, `scripts/termux/status.sh`, `scripts/termux/update.sh`, `scripts/termux/backup.sh`, `docs/platform/termux-install.md`
- **Acceptance criteria:**
  - [ ] A clean Termux environment installs and builds using the runtime proven in Task #008 without Docker, systemd, PRoot or QEMU.
  - [ ] All state paths resolve under configurable Termux home/data locations and install scripts are safe to rerun.
  - [ ] The scripts report missing optional capabilities instead of failing the core installation.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #008, Task #006, Task #002
- **Decisions made:** Do not bundle Chromium, heavy media runtimes or unverified native addons into the core Termux package.

### Task #061 — Handle Android Process Lifecycle Safely
- **Phase:** Special Track — X98 Mini / Termux ARM32
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Implement Termux-specific lifecycle handling for SIGINT/SIGTERM, persistence flush, child-process cleanup and documented Android background limitations.
- **Files to create / modify:** `src/platform/termux/lifecycle.ts`, `src/index.ts`, `src/scheduler/`, `src/execution/process-manager.ts`, `docs/platform/termux-install.md`
- **Acceptance criteria:**
  - [ ] SIGINT/SIGTERM triggers bounded shutdown, session/task flush and owned child-process cleanup.
  - [ ] Restart recovers safe persisted task state and does not claim uninterrupted 24/7 background execution.
  - [ ] Documented user-controlled foreground/keep-awake guidance is tested on the X98 Mini.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #020, Task #029, Task #053, Task #060
- **Decisions made:** Do not rely on systemd or Android root permissions; document OS-managed background termination as a platform limitation.

### Task #062 — Run X98 Mini Functional Acceptance
- **Phase:** Special Track — X98 Mini / Termux ARM32
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Run the Termux acceptance flow on the physical X98 Mini and capture evidence for core agent, tools, storage, scheduler, MCP and approved local execution.
- **Files to create / modify:** `scripts/termux/smoke-test.sh`, `docs/platform/termux-arm32-acceptance.md`, `test/platform/termux/`
- **Acceptance criteria:**
  - [ ] The device installs/starts the app, completes a provider chat and native or documented fallback tool call, and saves/resumes a session after restart.
  - [ ] An approved local command succeeds and a dangerous command is blocked until approval; scheduler and MCP are tested where a compatible server is configured, otherwise reported unavailable.
  - [ ] The Android TV remains usable and no PRoot/QEMU/root/firmware change is required.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #008, Task #012, Task #013, Task #018, Task #020, Task #026, Task #060, Task #061
- **Decisions made:** Only claim Termux support for capabilities exercised on the physical X98 Mini; record unsupported MCP/browser features explicitly.

### Task #063 — Measure Termux Resource Profile
- **Phase:** Special Track — X98 Mini / Termux ARM32
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Measure actual idle/active memory, startup time, disk footprint and optional-feature overhead on the X98 Mini and define a low-memory capability profile.
- **Files to create / modify:** `scripts/termux/measure-resources.sh`, `config/profiles/termux-low-memory.json`, `docs/platform/termux-arm32-acceptance.md`
- **Acceptance criteria:**
  - [ ] The report contains measured startup, memory and disk-footprint values for idle and representative active tasks.
  - [ ] The low-memory profile disables optional heavy services by default and reports remote/unsupported capabilities clearly.
  - [ ] No resource budget is stated as achieved unless the measurement output proves it.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #062
- **Decisions made:** Use measured device results; keep browser/media runtimes remote or independently installable unless physical tests prove local viability.

### Task #064 — Package Termux ARM32 Release
- **Phase:** Special Track — X98 Mini / Termux ARM32
- **Timebox:** 1–2 hours (split further if implementation exceeds this bound)
- **Scope:** Produce a versioned Termux distribution package and publish a compatibility note based on the physical-device acceptance evidence.
- **Files to create / modify:** `package.sh`, `scripts/termux/package.sh`, `docs/platform/termux-arm32-compatibility.md`, `docs/platform/termux-install.md`, `README.md`
- **Acceptance criteria:**
  - [ ] The package installs from a clean Termux environment and includes only verified ARM32/Bionic-compatible runtime dependencies.
  - [ ] Release notes state tested Android API/ABI/Node/npm versions and list unsupported optional capabilities.
  - [ ] The previous package remains installable and README release instructions match the tested package.
  - [ ] Unit test for the new logic is written and passing.
  - [ ] Test is isolated: it creates its own fixtures/temp state and cleans up after itself; it does not depend on shared mutable state or execution order.
- **Dependencies:** Task #060, Task #061, Task #062, Task #063, Task #052
- **Decisions made:** Do not describe ARM32 as supported until Tasks #008 and #061 pass on the physical device.

## [COMPLETED]

> No Milestone 2 implementation tasks are completed at initialization. Milestone 2 remains gated by Milestone 1 exit criteria.


## Milestone Rules and Source Constraints

- `existing_codebase: false` is copied from `knowledge.md` according to the exact Prompt 05 provenance rule; it does not assert that the Git repository is empty. Preserve existing source and extend modules rather than rewriting them.
- Phase applicability: Phase 1, Phase 2, Phase 3, Phase 4, Phase 5, Phase 6 and Phase 7 apply. The project is `fullstack`, has an SQLite FTS5 index, consumes third-party services and has a Web UI.
- Phase 7 uses the Server variant. The project is not high-scale by the source definition; no edge/WAF, API-gateway scaling or autoscaling tasks are added.
- `simple_mode: false`; capacity Stage 2 is required. Initial and six-month user targets are not specified, so use the required 50-VU minimum as a baseline and do not describe it as a declared capacity target.
- No inbound webhook provider is specified. Webhook signature-verification tasks are N/A until an inbound webhook is added; retryable messaging/email operations still require idempotency.
- The source provides no relational entity schema. Phase 2 changes are limited to the documented rebuildable FTS5 session index; no unapproved domain tables, soft-delete fields or live-traffic table migrations may be invented.
- Phase 6 endpoint audit is read-only. Its findings must become new tasks at the front of `[NEXT TASKS]`, continuing numbering above Task #064; do not fix findings inside the audit task or renumber existing tasks.
- Phase 3 and later tasks each include a unit-test criterion and a test-isolation criterion. Phase 2 tasks include migration-safety checks.
- All paths are repository-relative. A task must update `knowledge.md`/TDD or add an ADR when an implementation decision changes the agreed source of truth.
