import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { redactSecrets } from '../self-healing/log-redactor';
import { createLogger } from '../utils/logger';
import { resolveOpenCodeCwd } from './opencode-cwd-resolver';
import {
  bootstrapOpenCodeAuthFromEnv,
  getOpenCodeAuthStatus,
  type OpenCodeAuthBootstrapResult,
} from './opencode-auth';
import {
  detectOpenCode,
  installOpenCode,
  type OpenCodeDetectionResult,
  type OpenCodeInstallerDeps,
  type OpenCodeInstallResult,
} from './opencode-installer';
import { killProcessTree, type KillProcessTreeResult } from '../utils/process-tree';

export type OpenCodeAgentMode = 'analyze' | 'patch' | 'test' | 'review';
export type OpenCodeErrorType =
  | 'timeout'
  | 'idle-timeout'
  | 'model-not-found'
  | 'invalid-provider-prefix'
  | 'auth-required'
  | 'server-error'
  | 'invalid-cli-template'
  | 'permission-rejected'
  | 'permission-warning'
  | 'unknown';

export interface OpenCodeAgentInput {
  task?: string;
  cwd?: string;
  timeoutMs?: number;
  mode?: OpenCodeAgentMode;
  context?: string;
  signal?: AbortSignal;
  deps?: OpenCodeAgentDeps;
}

export interface OpenCodeAgentDeps extends OpenCodeInstallerDeps {
  killProcessTreeFn?: typeof killProcessTree;
}

export interface OpenCodeAgentResult {
  ok: boolean;
  mode: OpenCodeAgentMode;
  task: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  summary: string;
  error?: string;
  detection?: OpenCodeDetectionResult;
  install?: OpenCodeInstallResult;
  installApprovalId?: string;
  errorType?: OpenCodeErrorType;
  suggestion?: string;
  authBootstrap?: OpenCodeAuthBootstrapResult;
  killed?: boolean;
  killedBy?: 'timeout' | 'idle-timeout';
  killResult?: KillProcessTreeResult;
  lastOutputAt?: string;
  idleMs?: number;
}

export interface OpenCodeErrorDiagnostic {
  type: OpenCodeErrorType;
  message: string;
  suggestion: string;
}

export interface OpenCodeErrorInput {
  stdout?: string;
  stderr?: string;
  errorMessage?: string;
}

export interface OpenCodeConfigCheck {
  path: string;
  exists: boolean;
  invalidProviderPrefix: boolean;
  warnings: string[];
}

export interface OpenCodeDoctorInput {
  cwd?: string;
  smokeTest?: boolean;
  deps?: OpenCodeAgentDeps;
  includeUserConfig?: boolean;
}

export interface OpenCodeDoctorResult {
  ok: boolean;
  command: string;
  installed: boolean;
  version?: string;
  cwd: string;
  cwdValid: boolean;
  cwdReason: string;
  argsTemplate: string;
  argsPreview: string[];
  directMode: boolean;
  injectSafetyPreamble: boolean;
  idleTimeoutMs: number;
  hardTimeoutMs: number;
  templateValid: boolean;
  templateWarnings: string[];
  dangerousSkipPermissions: boolean;
  promptMode: 'positional' | 'prompt-flag' | 'unknown';
  authBootstrapEnabled: boolean;
  zenApiKeyPresent: boolean;
  authProvider: string;
  authFile: string;
  authFileExists: boolean;
  authProviderExists: boolean;
  runHelpOk: boolean;
  runHelpStdout: string;
  runHelpStderr: string;
  configFiles: OpenCodeConfigCheck[];
  warnings: string[];
  suggestions: string[];
  smokeTest?: OpenCodeAgentResult;
}

export interface OpenCodeArgsTemplateValidation {
  template: string;
  valid: boolean;
  includesTask: boolean;
  dangerousSkipPermissions: boolean;
  promptMode: 'positional' | 'prompt-flag' | 'unknown';
  warnings: string[];
  error?: string;
  suggestion?: string;
}

const DEFAULT_ARGS_TEMPLATE = 'run --dangerously-skip-permissions "{{task}}"';
const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_KILL_GRACE_MS = 10_000;
const DEFAULT_MAX_OUTPUT_CHARS = 30_000;
const logger = createLogger('tool:opencode-agent');

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envNonNegativeInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envOptionalNonNegativeInt(key: string): number | undefined {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function previewOutput(value: string, maxChars = 1000): string {
  const redacted = redactSecrets(value);
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}...[truncated ${redacted.length - maxChars} chars]`;
}

function errorResult(input: {
  mode: OpenCodeAgentMode;
  task: string;
  summary: string;
  error: string;
  durationMs?: number;
  detection?: OpenCodeDetectionResult;
  install?: OpenCodeInstallResult;
  installApprovalId?: string;
  errorType?: OpenCodeErrorType;
  suggestion?: string;
  authBootstrap?: OpenCodeAuthBootstrapResult;
}): OpenCodeAgentResult {
  return {
    ok: false,
    mode: input.mode,
    task: input.task,
    stdout: '',
    stderr: '',
    exitCode: null,
    durationMs: input.durationMs ?? 0,
    timedOut: false,
    truncated: false,
    summary: input.summary,
    error: input.error,
    ...(input.detection ? { detection: input.detection } : {}),
    ...(input.install ? { install: input.install } : {}),
    ...(input.installApprovalId ? { installApprovalId: input.installApprovalId } : {}),
    ...(input.errorType ? { errorType: input.errorType } : {}),
    ...(input.suggestion ? { suggestion: input.suggestion } : {}),
    ...(input.authBootstrap ? { authBootstrap: input.authBootstrap } : {}),
  };
}

function isSafeCommandBinary(command: string): boolean {
  if (!command.trim()) return false;
  return !/[\0\r\n;&|<>`]/.test(command);
}

function splitArgsTemplate(template: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < template.length; i += 1) {
    const char = template[i]!;
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (char === '\\' && i + 1 < template.length) {
        current += template[i + 1]!;
        i += 1;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) args.push(current);
  return args;
}

export function isOpenCodeDirectModeEnabled(): boolean {
  return envBool('OPENCODE_AGENT_DIRECT_MODE', true);
}

function shouldInjectSafetyPreamble(directMode: boolean): boolean {
  return envBool('OPENCODE_AGENT_INJECT_SAFETY_PREAMBLE', !directMode);
}

function buildTask(input: OpenCodeAgentInput, mode: OpenCodeAgentMode, options: {
  cwd?: string;
  directMode?: boolean;
  injectSafetyPreamble?: boolean;
} = {}): string {
  const task = String(input.task ?? '').trim();
  const context = String(input.context ?? '').trim();
  const directMode = options.directMode ?? isOpenCodeDirectModeEnabled();
  const injectSafetyPreamble = options.injectSafetyPreamble ?? shouldInjectSafetyPreamble(directMode);

  if (directMode) {
    const hasProjectReference = options.cwd && task.toLowerCase().includes(options.cwd.toLowerCase());
    const directTask = options.cwd && !hasProjectReference
      ? `${task} pada project berikut ${options.cwd}`
      : task;
    if (!injectSafetyPreamble) return directTask;
    return [
      'Do not read .env, .env.*, private keys, secrets.*, node_modules, dist, or .git.',
      directTask,
    ].join('\n\n');
  }

  const parts = [
    injectSafetyPreamble
      ? 'Do not read .env, .env.*, private keys, secrets.*, node_modules, dist, or .git.'
      : '',
    `Mode: ${mode}`,
    `Task: ${task}`,
    context ? `Context:\n${context}` : '',
  ].filter(Boolean);
  return parts.join('\n\n');
}

function buildArgs(template: string, task: string, mode: OpenCodeAgentMode): string[] {
  return splitArgsTemplate(template).map((arg) =>
    arg.replace(/\{\{task\}\}/g, task).replace(/\{\{mode\}\}/g, mode)
  );
}

export function previewOpenCodeArgs(args: string[], task: string): string[] {
  const replacement = `[task:${task.length} chars]`;
  return args.map((arg) => redactSecrets(arg === task ? replacement : arg.replace(task, replacement)));
}

export function buildOpenCodeArgsPreview(
  template: string,
  task = 'doctor preview task',
  mode: OpenCodeAgentMode = 'analyze',
  options: { cwd?: string; directMode?: boolean; injectSafetyPreamble?: boolean } = {}
): string[] {
  const fullTask = buildTask({ task }, mode, options);
  return previewOpenCodeArgs(buildArgs(template, fullTask, mode), fullTask);
}

function templatePromptMode(template: string): 'positional' | 'prompt-flag' | 'unknown' {
  if (/--prompt\b/.test(template)) return 'prompt-flag';
  if (/\{\{task\}\}/.test(template)) return 'positional';
  return 'unknown';
}

export function validateOpenCodeArgsTemplate(template: string): OpenCodeArgsTemplateValidation {
  const normalized = template.trim();
  const includesTask = /\{\{task\}\}/.test(normalized);
  const dangerousSkipPermissions = /--dangerously-skip-permissions\b/.test(normalized);
  const promptMode = templatePromptMode(normalized);
  const warnings: string[] = [];

  if (/--prompt\b/.test(normalized)) {
    return {
      template: normalized,
      valid: false,
      includesTask,
      dangerousSkipPermissions,
      promptMode,
      warnings,
      error: 'Invalid OpenCode args template: opencode run does not support --prompt.',
      suggestion: 'Use OPENCODE_AGENT_ARGS_TEMPLATE=run "{{task}}" or run --dangerously-skip-permissions "{{task}}".',
    };
  }

  if (!includesTask) {
    return {
      template: normalized,
      valid: false,
      includesTask,
      dangerousSkipPermissions,
      promptMode,
      warnings,
      error: 'OPENCODE_AGENT_ARGS_TEMPLATE should include {{task}} so the task can be passed to OpenCode.',
      suggestion: 'Use OPENCODE_AGENT_ARGS_TEMPLATE=run "{{task}}" or run --dangerously-skip-permissions "{{task}}".',
    };
  }

  if (dangerousSkipPermissions) {
    warnings.push('Dangerous skip permissions is enabled. Use only in trusted dev/isolated environments.');
  }

  return {
    template: normalized,
    valid: true,
    includesTask,
    dangerousSkipPermissions,
    promptMode,
    warnings,
  };
}

export function quoteWindowsArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"&|<>^%]/.test(arg)) return arg;
  return `"${arg
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%')}"`;
}

function buildExecutionCommand(input: {
  detection: OpenCodeDetectionResult;
  fallbackCommand: string;
  args: string[];
}): { command: string; args: string[]; shell: boolean } {
  const executionCommand = input.detection.resolvedCommand || input.fallbackCommand;
  const executionShell = input.detection.shell ?? false;
  if (executionShell && input.detection.executionStrategy === 'windows-shell') {
    // Keep command and args separate. Passing one fully concatenated command
    // string to cmd.exe breaks nested quotes around the long task argument and
    // can leave OpenCode waiting forever with no stdout/stderr. Let Node's
    // shell execution handle argument quoting instead.
    return {
      command: executionCommand,
      args: input.args,
      shell: true,
    };
  }
  return {
    command: executionCommand,
    args: input.args,
    shell: executionShell,
  };
}

function runDetectedOpenCodeCommand(input: {
  detection: OpenCodeDetectionResult;
  fallbackCommand: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  deps?: OpenCodeAgentDeps;
}): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
  errorType?: Extract<OpenCodeErrorType, 'timeout' | 'idle-timeout'>;
  killed?: boolean;
  killedBy?: 'timeout' | 'idle-timeout';
  killResult?: KillProcessTreeResult;
}> {
  const spawnFn = input.deps?.spawnFn ?? spawn;
  const platform = input.deps?.platform ?? process.platform;
  const idleTimeoutMs = envNonNegativeInt('OPENCODE_AGENT_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS);
  const killGraceMs = envInt('OPENCODE_AGENT_KILL_GRACE_MS', DEFAULT_KILL_GRACE_MS);
  const killTree = envBool('OPENCODE_AGENT_KILL_TREE', true);
  const execution = buildExecutionCommand({
    detection: input.detection,
    fallbackCommand: input.fallbackCommand,
    args: input.args,
  });

  return new Promise((resolveResult) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timeoutType: 'timeout' | 'idle-timeout' | undefined;
    let killed = false;
    let killedBy: 'timeout' | 'idle-timeout' | undefined;
    let killResult: KillProcessTreeResult | undefined;
    let lastOutputAt = Date.now();
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(execution.command, execution.args, {
        cwd: input.cwd,
        shell: execution.shell,
        windowsHide: true,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: killTree && platform !== 'win32',
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      resolveResult({
        ok: false,
        stdout: '',
        stderr: redactSecrets(err.message),
        exitCode: null,
        timedOut: false,
        error: err.message,
      });
      return;
    }

    const clearTimers = (): void => {
      if (hardTimer) clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (graceTimer) clearTimeout(graceTimer);
    };

    const finish = (exitCode: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      const rawStderr = error ? `${stderr}\n${error.message}` : stderr;
      const errorMessage = timeoutType === 'idle-timeout'
        ? `OpenCode produced no output for ${idleTimeoutMs} ms and was terminated.`
        : timeoutType === 'timeout'
          ? `OpenCode exceeded timeout of ${input.timeoutMs} ms and was terminated.`
          : error?.message;
      resolveResult({
        ok: !timedOut && !error && exitCode === 0,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(rawStderr),
        exitCode: timedOut ? null : exitCode,
        timedOut,
        ...(errorMessage ? { error: errorMessage } : {}),
        ...(timeoutType ? { errorType: timeoutType } : {}),
        killed,
        ...(killedBy ? { killedBy } : {}),
        ...(killResult ? { killResult } : {}),
      });
    };

    const terminate = (kind: 'timeout' | 'idle-timeout'): void => {
      if (settled || timedOut) return;
      timedOut = true;
      timeoutType = kind;
      killed = true;
      killedBy = kind;
      clearTimers();
      const pid = child.pid;
      logger.warn('OpenCode helper timeout reached; terminating process tree', {
        pid,
        kind,
        timeoutMs: input.timeoutMs,
        idleTimeoutMs,
        idleMs: Date.now() - lastOutputAt,
      });
      graceTimer = setTimeout(() => finish(null), killGraceMs);
      const killPromise = pid && killTree
        ? (input.deps?.killProcessTreeFn ?? killProcessTree)(pid, {
            platform,
            force: true,
            graceMs: killGraceMs,
          })
        : Promise.resolve({
            pid: pid ?? -1,
            platform,
            method: 'process' as const,
            ok: child.kill(),
          });
      killPromise
        .then((result) => {
          killResult = result;
          finish(null);
        })
        .catch((error) => {
          killResult = {
            pid: pid ?? -1,
            platform,
            method: 'process',
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
          finish(null);
        });
    };

    const resetIdleTimer = (): void => {
      lastOutputAt = Date.now();
      if (idleTimer) clearTimeout(idleTimer);
      if (idleTimeoutMs > 0) {
        idleTimer = setTimeout(() => terminate('idle-timeout'), idleTimeoutMs);
      }
    };

    hardTimer = setTimeout(() => {
      terminate('timeout');
    }, input.timeoutMs);
    resetIdleTimer();

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      resetIdleTimer();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
      resetIdleTimer();
    });
    child.once('error', (error) => finish(null, error));
    child.once('close', (code) => {
      if (timedOut) {
        killResult = killResult ?? {
          pid: child.pid ?? -1,
          platform,
          method: 'process',
          ok: true,
        };
      }
      finish(code);
    });
  });
}

function normalizeMode(mode: unknown): OpenCodeAgentMode {
  return mode === 'patch' || mode === 'test' || mode === 'review' ? mode : 'analyze';
}

function truncateOutput(stdout: string, stderr: string, maxChars: number): {
  stdout: string;
  stderr: string;
  truncated: boolean;
} {
  let truncated = false;
  const truncateOne = (value: string): string => {
    if (value.length <= maxChars) return value;
    truncated = true;
    return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
  };
  return {
    stdout: truncateOne(stdout),
    stderr: truncateOne(stderr),
    truncated,
  };
}

function correctedOpenCodeModel(text: string): string {
  const match = /opencode-zen\/([A-Za-z0-9_.-]+)/i.exec(text);
  return match?.[1] ? `opencode/${match[1]}` : 'opencode/deepseek-v4-flash-free';
}

function normalizeOpenCodeErrorInput(
  input: string | OpenCodeErrorInput,
  stderr = ''
): Required<OpenCodeErrorInput> {
  if (typeof input === 'string') {
    return {
      stdout: input,
      stderr,
      errorMessage: '',
    };
  }
  return {
    stdout: input.stdout ?? '',
    stderr: input.stderr ?? '',
    errorMessage: input.errorMessage ?? '',
  };
}

export function classifyOpenCodeError(input: string | OpenCodeErrorInput, stderr = ''): OpenCodeErrorDiagnostic {
  const normalized = normalizeOpenCodeErrorInput(input, stderr);
  const text = redactSecrets([
    normalized.stdout,
    normalized.stderr,
    normalized.errorMessage,
  ].filter(Boolean).join('\n'));
  const lower = text.toLowerCase();

  if (/opencode-zen\//i.test(text)) {
    const corrected = correctedOpenCodeModel(text);
    return {
      type: 'invalid-provider-prefix',
      message: 'OpenCode model config error: provider prefix opencode-zen/ is invalid.',
      suggestion: `Use ${corrected}, not ${corrected.replace(/^opencode\//, 'opencode-zen/')}.`,
    };
  }

  if (/model\s+not\s+found/i.test(text)) {
    return {
      type: 'model-not-found',
      message: 'OpenCode model was not found.',
      suggestion: 'Check the model name in opencode.jsonc. For OpenCode Zen free models, use examples like "opencode/deepseek-v4-flash-free" and "opencode/mimo-v2.5-free".',
    };
  }

  if (/unknown\s+argument.*prompt|unknown\s+option.*prompt|unexpected\s+argument.*prompt|unrecognized\s+(?:argument|option).*prompt/i.test(text)) {
    return {
      type: 'invalid-cli-template',
      message: 'OpenCode run rejected the configured CLI argument template.',
      suggestion: 'Use OPENCODE_AGENT_ARGS_TEMPLATE=run "{{task}}" or run --dangerously-skip-permissions "{{task}}".',
    };
  }

  if (/unexpected\s+server\s+error/i.test(text)) {
    return {
      type: 'server-error',
      message: 'OpenCode returned an unexpected server error.',
      suggestion: 'Check OpenCode Zen auth/API key. Run opencode run /connect or configure OPENCODE_AUTH_BOOTSTRAP=true with OPENCODE_ZEN_API_KEY.',
    };
  }

  if (
    /(?:user\s+)?rejected\s+permission|permission\s+(?:rejected|denied)|access\s+denied\s+.*(?:\.env|protected|file)|access\s+to\s+.*(?:\.env|protected)\s+(?:was\s+)?(?:denied|rejected|blocked)|not\s+allowed.*(?:\.env|file|protected)/i
      .test(text)
  ) {
    return {
      type: 'permission-rejected',
      message: 'OpenCode permission request was rejected.',
      suggestion: 'OpenCode requested protected file access. Use safety preamble, avoid .env, or use --dangerously-skip-permissions only in trusted dev.',
    };
  }

  if (/\b(auth|authentication|authorize|authorization|login|sign\s*in|api\s*key|apikey|token)\b/i.test(lower)) {
    return {
      type: 'auth-required',
      message: 'OpenCode authentication appears to be required.',
      suggestion: 'Run opencode run /connect or configure OPENCODE_AUTH_BOOTSTRAP=true with OPENCODE_ZEN_API_KEY.',
    };
  }

  return {
    type: 'unknown',
    message: 'OpenCode failed with an unknown error.',
    suggestion: 'Run /opencode doctor to validate OpenCode CLI, config, and auth.',
  };
}

function summarize(result: {
  ok: boolean;
  timedOut: boolean;
  exitCode: number | null;
  error?: string;
  truncated: boolean;
}): string {
  if (result.timedOut) return 'OpenCode agent timed out before completing the task.';
  if (result.error) return `OpenCode agent failed: ${result.error}`;
  if (result.ok) {
    return result.truncated
      ? 'OpenCode agent completed successfully; output was truncated.'
      : 'OpenCode agent completed successfully.';
  }
  return `OpenCode agent exited with code ${result.exitCode ?? 'null'}.`;
}

export function isOpenCodeEnvironmentFailure(result: OpenCodeAgentResult): boolean {
  const text = [
    result.errorType,
    result.error,
    result.summary,
    result.stderr,
    result.detection?.error,
  ].filter(Boolean).join('\n');

  return /ENOENT|EACCES|EPERM|timeout|idle-timeout|permission-rejected|permission(?:\s+\w+){0,4}\s+(?:denied|rejected)|not installed|not recognized|not found|command is invalid|cwd could not be resolved|cwd must stay|filesystem root|node_modules/i
    .test(text);
}

export async function runOpenCodeAgent(input: OpenCodeAgentInput | string): Promise<OpenCodeAgentResult> {
  const startedAt = Date.now();
  const normalizedInput: OpenCodeAgentInput = typeof input === 'string' ? { task: input } : input;
  const mode = normalizeMode(normalizedInput.mode);
  const task = String(normalizedInput.task ?? '').trim();

  if (normalizedInput.signal?.aborted) {
    return errorResult({
      mode,
      task,
      summary: 'OpenCode agent execution was aborted.',
      error: 'OpenCode agent execution was aborted.',
    });
  }

  if (!envBool('OPENCODE_AGENT_ENABLED', false)) {
    return errorResult({
      mode,
      task,
      summary: 'OpenCode agent tool is disabled.',
      error: 'OpenCode agent tool is disabled. Set OPENCODE_AGENT_ENABLED=true.',
    });
  }

  if (!task) {
    return errorResult({
      mode,
      task,
      summary: 'OpenCode agent task is required.',
      error: 'OpenCode agent task is required.',
    });
  }

  if (envBool('OPENCODE_AGENT_REQUIRE_CONFIRMATION', false)) {
    return errorResult({
      mode,
      task,
      summary: 'OpenCode agent requires confirmation before execution.',
      error: 'OpenCode agent confirmation is required by OPENCODE_AGENT_REQUIRE_CONFIRMATION=true.',
    });
  }

  const command = (process.env['OPENCODE_AGENT_COMMAND'] || 'opencode').trim();
  if (!isSafeCommandBinary(command)) {
    return errorResult({
      mode,
      task,
      summary: 'OpenCode agent command is invalid.',
      error: 'OPENCODE_AGENT_COMMAND must be a fixed command binary without shell control operators.',
    });
  }

  const argsTemplate = process.env['OPENCODE_AGENT_ARGS_TEMPLATE'] || DEFAULT_ARGS_TEMPLATE;
  const templateValidation = validateOpenCodeArgsTemplate(argsTemplate);
  if (!templateValidation.valid) {
    return errorResult({
      mode,
      task,
      summary: templateValidation.error ?? 'Invalid OpenCode args template.',
      error: templateValidation.error ?? 'Invalid OpenCode args template.',
      errorType: 'invalid-cli-template',
      ...(templateValidation.suggestion ? { suggestion: templateValidation.suggestion } : {}),
    });
  }
  for (const warning of templateValidation.warnings) {
    logger.warn('OpenCode args template warning', { warning });
  }

  const authBootstrap = await bootstrapOpenCodeAuthFromEnv();
  logger.info('OpenCode auth bootstrap checked', {
    authFile: authBootstrap.authFile,
    provider: authBootstrap.provider,
    created: authBootstrap.created,
    updated: authBootstrap.updated,
    skipped: authBootstrap.skipped,
    reason: authBootstrap.reason,
    ...(authBootstrap.warning ? { warning: authBootstrap.warning } : {}),
  });
  if (!authBootstrap.ok) {
    return errorResult({
      mode,
      task,
      summary: authBootstrap.reason,
      error: authBootstrap.reason,
      durationMs: Date.now() - startedAt,
      authBootstrap,
    });
  }

  let detection = await detectOpenCode(command, normalizedInput.deps);
  if (!detection.installed) {
    if (!envBool('OPENCODE_AUTO_INSTALL', false)) {
      return errorResult({
        mode,
        task,
        summary: 'OpenCode CLI is not installed.',
        error: 'OpenCode CLI is not installed. Install it manually or set OPENCODE_AUTO_INSTALL=true.',
        durationMs: Date.now() - startedAt,
        detection,
      });
    }

    const install = await installOpenCode({
      ...(normalizedInput.deps ? { deps: normalizedInput.deps } : {}),
    });
    if (install.approvalRequired) {
      return errorResult({
        mode,
        task,
        summary: 'OpenCode install approval is required.',
        error: install.error ?? 'OpenCode CLI is not installed. Install approval is required.',
        durationMs: Date.now() - startedAt,
        detection,
        install,
        ...(install.approvalId ? { installApprovalId: install.approvalId } : {}),
      });
    }

    if (!install.ok) {
      return errorResult({
        mode,
        task,
        summary: 'OpenCode auto-install failed.',
        error: install.error ?? 'OpenCode auto-install failed.',
        durationMs: Date.now() - startedAt,
        detection,
        install,
      });
    }

    if (!envBool('OPENCODE_INSTALL_RETRY_AFTER_INSTALL', true)) {
      return errorResult({
        mode,
        task,
        summary: 'OpenCode installed successfully. Retry the task to run OpenCode.',
        error: 'OpenCode installed successfully, but OPENCODE_INSTALL_RETRY_AFTER_INSTALL=false.',
        durationMs: Date.now() - startedAt,
        detection,
        install,
      });
    }

    if (install.detectedAfterInstall?.installed) {
      detection = install.detectedAfterInstall;
    } else {
      detection = await detectOpenCode(command, normalizedInput.deps);
    }
  }

  const cwdResult = resolveOpenCodeCwd({
    ...(normalizedInput.cwd ? { explicitCwd: normalizedInput.cwd } : {}),
    ...(process.env['OPENCODE_AGENT_CWD'] !== undefined ? { envCwd: process.env['OPENCODE_AGENT_CWD'] } : {}),
  });
  logger.info('resolved cwd', {
    cwd: cwdResult.cwd,
    source: cwdResult.source,
    valid: cwdResult.valid,
    reason: cwdResult.reason,
  });

  if (!cwdResult.valid) {
    return errorResult({
      mode,
      task,
      summary: 'OpenCode agent cwd could not be resolved safely.',
      error: cwdResult.reason,
    });
  }
  const cwd = cwdResult.cwd;

  const directMode = isOpenCodeDirectModeEnabled();
  const injectSafetyPreamble = shouldInjectSafetyPreamble(directMode);
  const timeoutMs = Math.max(1, normalizedInput.timeoutMs ?? envInt('OPENCODE_AGENT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS));
  const idleTimeoutOverride = envOptionalNonNegativeInt('OPENCODE_AGENT_IDLE_TIMEOUT_MS');
  const idleTimeoutMs = idleTimeoutOverride ?? (directMode ? 0 : DEFAULT_IDLE_TIMEOUT_MS);
  const killGraceMs = envInt('OPENCODE_AGENT_KILL_GRACE_MS', DEFAULT_KILL_GRACE_MS);
  const killTree = envBool('OPENCODE_AGENT_KILL_TREE', true);
  const maxOutputChars = envInt('OPENCODE_AGENT_MAX_OUTPUT_CHARS', DEFAULT_MAX_OUTPUT_CHARS);
  const fullTask = buildTask(normalizedInput, mode, { cwd, directMode, injectSafetyPreamble });
  const args = buildArgs(argsTemplate, fullTask, mode);
  const argsPreview = previewOpenCodeArgs(args, fullTask);
  const platform = normalizedInput.deps?.platform ?? process.platform;
  const execution = buildExecutionCommand({
    detection,
    fallbackCommand: command,
    args,
  });

  if (directMode) {
    logger.info('direct mode enabled', {
      mode,
      injectSafetyPreamble,
      taskChars: fullTask.length,
    });
  }
  if (directMode && idleTimeoutMs === 0) {
    logger.info('idle timeout disabled for direct mode', { mode });
  }

  logger.info('running OpenCode', {
    mode,
    cwd,
    command: detection.resolvedCommand || command,
    executionStrategy: detection.executionStrategy ?? 'direct',
    shell: execution.shell,
    argsPreview,
    argsCount: args.length,
    timeoutMs,
    idleTimeoutMs,
    killGraceMs,
    killTree,
    directMode,
    injectSafetyPreamble,
  });

  return new Promise<OpenCodeAgentResult>((resolveResult) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timeoutType: 'timeout' | 'idle-timeout' | undefined;
    let killed = false;
    let killedBy: 'timeout' | 'idle-timeout' | undefined;
    let killResult: KillProcessTreeResult | undefined;
    let lastOutputAt = Date.now();
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;

    let child: ReturnType<typeof spawn>;
    try {
      child = (normalizedInput.deps?.spawnFn ?? spawn)(execution.command, execution.args, {
        cwd,
        shell: execution.shell,
        windowsHide: true,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: killTree && platform !== 'win32',
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const durationMs = Date.now() - startedAt;
      const diagnostic = classifyOpenCodeError({ errorMessage: err.message });
      resolveResult({
        ok: false,
        mode,
        task,
        stdout: '',
        stderr: redactSecrets(err.message),
        exitCode: null,
        durationMs,
        timedOut: false,
        truncated: false,
        summary: diagnostic.type === 'unknown'
          ? `OpenCode agent failed: ${err.message}`
          : `OpenCode failed: ${diagnostic.message} Suggestion: ${diagnostic.suggestion}`,
        error: diagnostic.type === 'unknown' ? err.message : diagnostic.message,
        errorType: diagnostic.type,
        suggestion: diagnostic.suggestion,
        authBootstrap,
      });
      return;
    }

    const clearTimers = (): void => {
      if (hardTimer) clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (abortListener) normalizedInput.signal?.removeEventListener('abort', abortListener);
    };

    const finish = (exitCode: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimers();

      const redactedStdout = redactSecrets(stdout);
      const redactedStderr = redactSecrets(error ? `${stderr}\n${error.message}` : stderr);
      const truncated = truncateOutput(redactedStdout, redactedStderr, maxOutputChars);
      const ok = !timedOut && !error && exitCode === 0;
      const durationMs = Date.now() - startedAt;
      const diagnostic = ok
        ? null
        : timeoutType === 'timeout'
          ? {
              type: 'timeout' as const,
              message: `OpenCode exceeded timeout of ${timeoutMs} ms and was terminated.`,
              suggestion: 'Reduce task scope, increase OPENCODE_AGENT_TIMEOUT_MS, or inspect OpenCode for hangs.',
            }
          : timeoutType === 'idle-timeout'
            ? {
                type: 'idle-timeout' as const,
                message: `OpenCode produced no output for ${idleTimeoutMs} ms and was terminated.`,
                suggestion: 'Check OpenCode/auth/model state, or increase OPENCODE_AGENT_IDLE_TIMEOUT_MS if long silent work is expected.',
              }
            : classifyOpenCodeError({
                stdout: truncated.stdout,
                stderr: truncated.stderr,
                ...(error ? { errorMessage: error.message } : {}),
              });
      const baseSummary = summarize({
        ok,
        timedOut,
        exitCode: timedOut ? null : exitCode,
        truncated: truncated.truncated,
        ...(diagnostic && !ok ? { error: diagnostic.message } : error ? { error: error.message } : {}),
      });
      const summary = !ok && diagnostic && diagnostic.type !== 'unknown'
        ? `OpenCode failed: ${diagnostic.message} Suggestion: ${diagnostic.suggestion}`
        : baseSummary;
      const failureError = error?.message ?? (!ok ? diagnostic?.message ?? baseSummary : undefined);
      const lastOutputAtIso = new Date(lastOutputAt).toISOString();
      const idleMs = Date.now() - lastOutputAt;

      const logMeta = {
        mode,
        exitCode: timedOut ? null : exitCode,
        durationMs,
        timedOut,
        truncated: truncated.truncated,
        ...(timedOut ? {
          killed,
          killedBy,
          killResult,
          lastOutputAt: lastOutputAtIso,
          idleMs,
        } : {}),
      };
      if (ok) logger.info('OpenCode completed', logMeta);
      else logger.warn('OpenCode failed', {
        ...logMeta,
        error: failureError,
        errorType: diagnostic?.type,
        suggestion: diagnostic?.suggestion,
        stdoutPreview: previewOutput(truncated.stdout),
        stderrPreview: previewOutput(truncated.stderr),
      });

      resolveResult({
        ok,
        mode,
        task,
        stdout: truncated.stdout,
        stderr: truncated.stderr,
        exitCode: timedOut ? null : exitCode,
        durationMs,
        timedOut,
        truncated: truncated.truncated,
        summary,
        ...(!ok && failureError ? { error: failureError } : {}),
        ...(!ok && diagnostic ? { errorType: diagnostic.type, suggestion: diagnostic.suggestion } : {}),
        authBootstrap,
        ...(timedOut ? {
          killed,
          ...(killedBy ? { killedBy } : {}),
          ...(killResult ? { killResult } : {}),
          lastOutputAt: lastOutputAtIso,
          idleMs,
        } : {}),
      });
    };

    const terminate = (kind: 'timeout' | 'idle-timeout'): void => {
      if (settled || timedOut) return;
      timedOut = true;
      timeoutType = kind;
      killed = true;
      killedBy = kind;
      clearTimers();
      const pid = child.pid;
      logger.warn('OpenCode timeout reached; terminating process tree', {
        mode,
        pid,
        kind,
        timeoutMs,
        idleTimeoutMs,
        killGraceMs,
        executionStrategy: detection.executionStrategy ?? 'direct',
        shell: execution.shell,
        idleMs: Date.now() - lastOutputAt,
        stdoutPreview: previewOutput(stdout),
        stderrPreview: previewOutput(stderr),
      });
      graceTimer = setTimeout(() => finish(null), killGraceMs);
      const killPromise = pid && killTree
        ? (normalizedInput.deps?.killProcessTreeFn ?? killProcessTree)(pid, {
            platform,
            force: true,
            graceMs: killGraceMs,
          })
        : Promise.resolve({
            pid: pid ?? -1,
            platform,
            method: 'process' as const,
            ok: child.kill(),
          });
      killPromise
        .then((result) => {
          killResult = result;
          finish(null);
        })
        .catch((killError) => {
          killResult = {
            pid: pid ?? -1,
            platform,
            method: 'process',
            ok: false,
            error: killError instanceof Error ? killError.message : String(killError),
          };
          finish(null);
        });
    };

    const resetIdleTimer = (): void => {
      lastOutputAt = Date.now();
      if (idleTimer) clearTimeout(idleTimer);
      if (idleTimeoutMs > 0) {
        idleTimer = setTimeout(() => terminate('idle-timeout'), idleTimeoutMs);
      }
    };

    hardTimer = setTimeout(() => terminate('timeout'), timeoutMs);
    resetIdleTimer();
    if (normalizedInput.signal) {
      abortListener = () => terminate('timeout');
      normalizedInput.signal.addEventListener('abort', abortListener, { once: true });
      if (normalizedInput.signal.aborted) abortListener();
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      resetIdleTimer();
      logger.debug('OpenCode stdout received', { mode, bytes: Buffer.byteLength(chunk.toString()) });
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
      resetIdleTimer();
      logger.debug('OpenCode stderr received', { mode, bytes: Buffer.byteLength(chunk.toString()) });
    });
    child.once('error', (error) => finish(null, error));
    child.once('close', (code) => {
      if (timedOut) {
        killResult = killResult ?? {
          pid: child.pid ?? -1,
          platform,
          method: 'process',
          ok: true,
        };
      }
      finish(code);
    });
  });
}

function likelyOpenCodeConfigPaths(cwd: string, includeUserConfig: boolean): string[] {
  const home = homedir();
  const paths = [
    join(cwd, 'opencode.jsonc'),
    join(cwd, 'opencode.json'),
  ];

  if (!includeUserConfig) return [...new Set(paths)];

  paths.push(
    join(home, '.config', 'opencode', 'opencode.jsonc'),
    join(home, '.config', 'opencode', 'opencode.json')
  );

  if (process.platform === 'win32') {
    paths.push(
      join(home, 'AppData', 'Roaming', 'opencode', 'opencode.jsonc'),
      join(home, 'AppData', 'Roaming', 'opencode', 'opencode.json')
    );
  }

  return [...new Set(paths)];
}

async function checkOpenCodeConfig(path: string): Promise<OpenCodeConfigCheck> {
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      invalidProviderPrefix: false,
      warnings: [],
    };
  }

  const content = await readFile(path, 'utf-8').catch(() => '');
  const invalidProviderPrefix = /opencode-zen\//i.test(content);
  return {
    path,
    exists: true,
    invalidProviderPrefix,
    warnings: invalidProviderPrefix
      ? [
          'Invalid OpenCode provider prefix detected: opencode-zen/. Use opencode/ instead.',
          'Correct examples: "model": "opencode/deepseek-v4-flash-free" and "small_model": "opencode/mimo-v2.5-free".',
        ]
      : [],
  };
}

export async function runOpenCodeDoctor(input: OpenCodeDoctorInput = {}): Promise<OpenCodeDoctorResult> {
  const command = (process.env['OPENCODE_AGENT_COMMAND'] || 'opencode').trim() || 'opencode';
  const argsTemplate = process.env['OPENCODE_AGENT_ARGS_TEMPLATE'] || DEFAULT_ARGS_TEMPLATE;
  const templateValidation = validateOpenCodeArgsTemplate(argsTemplate);
  const authStatus = await getOpenCodeAuthStatus();
  const authBootstrapEnabled = envBool('OPENCODE_AUTH_BOOTSTRAP', false);
  const zenApiKeyPresent = Boolean((process.env['OPENCODE_ZEN_API_KEY'] || '').trim());
  const directMode = isOpenCodeDirectModeEnabled();
  const injectSafetyPreamble = shouldInjectSafetyPreamble(directMode);
  const hardTimeoutMs = envInt('OPENCODE_AGENT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  const idleTimeoutMs = envOptionalNonNegativeInt('OPENCODE_AGENT_IDLE_TIMEOUT_MS') ?? (directMode ? 0 : DEFAULT_IDLE_TIMEOUT_MS);
  const cwdResult = resolveOpenCodeCwd({
    ...(input.cwd ? { explicitCwd: input.cwd } : {}),
    ...(process.env['OPENCODE_AGENT_CWD'] !== undefined ? { envCwd: process.env['OPENCODE_AGENT_CWD'] } : {}),
  });
  const cwd = cwdResult.cwd;
  const argsPreview = buildOpenCodeArgsPreview(argsTemplate, 'doctor preview task', 'analyze', {
    cwd,
    directMode,
    injectSafetyPreamble,
  });
  const warnings: string[] = [];
  const suggestions: string[] = [];

  if (!cwdResult.valid) {
    warnings.push(`OpenCode cwd is invalid: ${cwdResult.reason}`);
  }

  if (!templateValidation.valid) {
    warnings.push(templateValidation.error ?? 'OpenCode args template is invalid.');
    if (templateValidation.suggestion) suggestions.push(templateValidation.suggestion);
  }
  warnings.push(...templateValidation.warnings);

  if (authStatus.providerWarning) {
    warnings.push(authStatus.providerWarning);
  }
  if (authBootstrapEnabled && !zenApiKeyPresent) {
    warnings.push('OPENCODE_AUTH_BOOTSTRAP=true but OPENCODE_ZEN_API_KEY is empty.');
  }

  suggestions.push('Correct model prefix: opencode/deepseek-v4-flash-free.');
  suggestions.push('Wrong model prefix: opencode-zen/deepseek-v4-flash-free.');
  suggestions.push('Manual-equivalent mode: OPENCODE_AGENT_DIRECT_MODE=true.');
  suggestions.push('Manual-equivalent mode: OPENCODE_AGENT_INJECT_SAFETY_PREAMBLE=false.');
  suggestions.push('Manual-equivalent mode: OPENCODE_AGENT_ARGS_TEMPLATE=run --dangerously-skip-permissions "{{task}}".');
  suggestions.push('Manual-equivalent mode: OPENCODE_AGENT_IDLE_TIMEOUT_MS=0.');

  const detection = await detectOpenCode(command, input.deps);
  if (!detection.installed) {
    warnings.push(detection.error ?? 'OpenCode CLI was not detected.');
    suggestions.push('Install OpenCode or set OPENCODE_AGENT_COMMAND to the correct binary.');
  }

  let runHelpOk = false;
  let runHelpStdout = '';
  let runHelpStderr = '';

  if (detection.installed && cwdResult.valid) {
    const help = await runDetectedOpenCodeCommand({
      detection,
      fallbackCommand: command,
      args: ['run', '--help'],
      cwd,
      timeoutMs: envInt('OPENCODE_AGENT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
      ...(input.deps ? { deps: input.deps } : {}),
    });
    runHelpOk = help.ok;
    const truncated = truncateOutput(help.stdout, help.stderr, DEFAULT_MAX_OUTPUT_CHARS);
    runHelpStdout = truncated.stdout;
    runHelpStderr = truncated.stderr;
    if (!help.ok) {
      const diagnostic = classifyOpenCodeError({
        stdout: help.stdout,
        stderr: help.stderr,
        ...(help.error ? { errorMessage: help.error } : {}),
      });
      warnings.push(`OpenCode run --help failed: ${diagnostic.message}`);
      suggestions.push(diagnostic.suggestion);
    }
  }

  const configFiles = await Promise.all(likelyOpenCodeConfigPaths(
    cwd,
    input.includeUserConfig ?? true
  ).map(checkOpenCodeConfig));
  const foundConfigs = configFiles.filter((item) => item.exists);
  if (foundConfigs.length === 0) {
    suggestions.push('No local opencode.jsonc/opencode.json was found. If model selection fails, create opencode.jsonc in the project root.');
  }

  for (const config of foundConfigs) {
    warnings.push(...config.warnings.map((warning) => `${warning} (${config.path})`));
  }

  if (foundConfigs.some((item) => item.invalidProviderPrefix)) {
    suggestions.push('Use "model": "opencode/deepseek-v4-flash-free", not "opencode-zen/deepseek-v4-flash-free".');
    suggestions.push('Use "small_model": "opencode/mimo-v2.5-free".');
  }

  let smokeTest: OpenCodeAgentResult | undefined;
  const shouldSmokeTest = Boolean(input.smokeTest || envBool('OPENCODE_DOCTOR_SMOKE_TEST', false));
  if (shouldSmokeTest && detection.installed && cwdResult.valid) {
    const smoke = await runDetectedOpenCodeCommand({
      detection,
      fallbackCommand: command,
      args: ['run', 'hello'],
      cwd,
      timeoutMs: envInt('OPENCODE_AGENT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
      ...(input.deps ? { deps: input.deps } : {}),
    });
    const truncated = truncateOutput(smoke.stdout, smoke.stderr, envInt('OPENCODE_AGENT_MAX_OUTPUT_CHARS', DEFAULT_MAX_OUTPUT_CHARS));
    const diagnostic = smoke.ok ? null : classifyOpenCodeError({
      stdout: truncated.stdout,
      stderr: truncated.stderr,
      ...(smoke.error ? { errorMessage: smoke.error } : {}),
    });
    smokeTest = {
      ok: smoke.ok,
      mode: 'analyze',
      task: 'hello',
      stdout: truncated.stdout,
      stderr: truncated.stderr,
      exitCode: smoke.exitCode,
      durationMs: 0,
      timedOut: smoke.timedOut,
      truncated: truncated.truncated,
      summary: smoke.ok
        ? 'OpenCode smoke test completed successfully.'
        : diagnostic && diagnostic.type !== 'unknown'
          ? `OpenCode failed: ${diagnostic.message} Suggestion: ${diagnostic.suggestion}`
          : 'OpenCode smoke test failed.',
      ...(!smoke.ok && diagnostic ? {
        error: diagnostic.message,
        errorType: diagnostic.type,
        suggestion: diagnostic.suggestion,
      } : {}),
      detection,
    };
    if (!smoke.ok && diagnostic) {
      warnings.push(`OpenCode smoke test failed: ${diagnostic.message}`);
      suggestions.push(diagnostic.suggestion);
    }
  }

  return {
    ok: detection.installed &&
      runHelpOk &&
      templateValidation.valid &&
      !foundConfigs.some((item) => item.invalidProviderPrefix) &&
      !authStatus.providerWarning,
    command,
    installed: detection.installed,
    ...(detection.version ? { version: detection.version } : {}),
    cwd,
    cwdValid: cwdResult.valid,
    cwdReason: cwdResult.reason,
    argsTemplate: redactSecrets(argsTemplate),
    argsPreview,
    directMode,
    injectSafetyPreamble,
    idleTimeoutMs,
    hardTimeoutMs,
    templateValid: templateValidation.valid,
    templateWarnings: templateValidation.warnings,
    dangerousSkipPermissions: templateValidation.dangerousSkipPermissions,
    promptMode: templateValidation.promptMode,
    authBootstrapEnabled,
    zenApiKeyPresent,
    authProvider: authStatus.provider,
    authFile: authStatus.authFile,
    authFileExists: authStatus.authFileExists,
    authProviderExists: authStatus.providerExists,
    runHelpOk,
    runHelpStdout,
    runHelpStderr,
    configFiles,
    warnings: [...new Set(warnings)],
    suggestions: [...new Set(suggestions)],
    ...(smokeTest ? { smokeTest } : {}),
  };
}
