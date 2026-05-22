/**
 * tools/system-execute.ts
 * Execute arbitrary local commands with stdout/stderr capture.
 * Supports shell mode, custom command registry, and OS-aware defaults.
 *
 * Env:
 *   SYSTEM_EXECUTE_ENABLED=true   (default: true)
 *   SYSTEM_EXECUTE_TIMEOUT=30000  (ms)
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { basename, join, resolve, sep } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { createLogger } from '../utils/logger';
import { KVStore } from '../storage/json-store';
import type { JsonObject, JsonValue } from '../types/global';
import { WorkspaceManager } from '../workspace';

const logger = createLogger('tool:system-execute');
const execAsync = promisify(exec);

const TIMEOUT_MS = parseInt(process.env['SYSTEM_EXECUTE_TIMEOUT'] ?? '30000', 10);
const ENABLED = process.env['SYSTEM_EXECUTE_ENABLED'] !== 'false';
const REGISTRY_PATH = join(process.cwd(), 'data', 'custom-commands.json');
const CONFIRM_TTL_MS = 5 * 60 * 1000;
const CONFIRM_STORE_KEY_PREFIX = 'confirm:';
const CONFIRM_STORE_FILE = 'system-execute-confirmations';

// SECURITY FIX [C1]: allowlist is the primary command gate; dangerous regex remains secondary.
const DEFAULT_ALLOWED_COMMANDS = [
  'ls',
  'pwd',
  'cat',
  'echo',
  'git',
  'node',
  'npm',
  'python',
  'python3',
  'pip',
  'find',
  'grep',
  'head',
  'tail',
  'wc',
  'sort',
  'mkdir',
  'cp',
  'mv',
  'touch',
  'date',
  'whoami',
  'which',
  'dir',
  'env --help',
] as const;

// SECURITY FIX [C3]: only explicitly safe environment keys are inherited by child processes.
const SAFE_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'TMPDIR',
  'PWD',
  'LOGNAME',
  'COLORTERM',
  'TERM_PROGRAM',
] as const;

export const DANGEROUS_PATTERNS: RegExp[] = [
  /\b(shutdown|reboot|restart)\b/i,
  /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\b/i,
  /\bdel\s+\/s\b/i,
  /\brmdir\s+\/s\b/i,
  /\b(format|mkfs|diskpart)\b/i,
  /\bdd\s+if=/i,
  /\bchmod\s+-R\s+777\b/i,
  /\bchown\s+-R\b/i,
];

export interface PendingCommand {
  id: string;
  command: string;
  createdAt: number;
  expiresAt: number;
}

const fallbackPendingCommands = new Map<string, PendingCommand>();

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ExecuteInput {
  /** Raw command to execute. */
  command?: string;
  /** Name/alias of a saved custom command. */
  alias?: string;
  /** Shell to use: 'bash' | 'sh' | 'cmd' | 'powershell'. Default: auto-detect. */
  shell?: string;
  /** Timeout in ms. */
  timeout?: number;
  /** Working directory. */
  cwd?: string;
  /** Save this command as a custom alias. */
  saveAs?: string;
  /** Description for saved command. */
  description?: string;
  /** Explicit confirmation for dangerous commands. */
  confirm?: boolean;
  /** Pending confirmation ID returned for a dangerous command. */
  confirmId?: string;
}

export interface ExecuteResult {
  ok: boolean;
  content: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export interface CustomCommand {
  alias: string;
  command: string;
  description?: string;
  createdAt: string;
}

export function isDangerousCommand(cmd: string): boolean {
  // SECURITY FIX [C1]: secondary guard is intentionally narrower for restart/reboot tokens.
  if (/\b(rm\s+-[a-z]*r[a-z]*f?[a-z]*|del\s+\/s|rmdir\s+\/s|format|mkfs|diskpart|dd\s+if=|chmod\s+-R\s+777|chown\s+-R)\b/i.test(cmd)) {
    return true;
  }

  if (/\bshutdown(?:\b|[-_])/i.test(cmd) || /(^|[;&|]\s*)(reboot|restart)(\s|$)/i.test(cmd)) {
    return true;
  }

  return DANGEROUS_PATTERNS.some((pattern) => {
    if (pattern.source.includes('shutdown|reboot|restart')) return false;
    return pattern.test(cmd);
  });
}

function getAllowedCommands(): string[] {
  const extra = (process.env['SYSTEM_EXECUTE_ALLOWED_COMMANDS'] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...DEFAULT_ALLOWED_COMMANDS, ...extra].map((entry) => entry.toLowerCase());
}

function stripCommandQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function commandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||\||(?<!\\);|\r?\n/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function baseCommand(segment: string): string {
  const token = stripCommandQuotes(segment.split(/\s+/)[0] ?? '');
  return basename(token.replace(/\\/g, '/')).toLowerCase();
}

function isAllowedCommand(cmd: string): boolean {
  const allowed = getAllowedCommands();
  const segments = commandSegments(cmd);
  if (segments.length === 0) return false;

  return segments.every((segment) => {
    const normalized = segment.trim().toLowerCase();
    const base = baseCommand(segment);

    if (!base) return false;

    if (
      (base === 'python' || base === 'python3') &&
      /(^|\s)-c(\s|$)/i.test(segment)
    ) {
      return false;
    }

    if (
      base === 'node' &&
      /(^|\s)(-e|--eval)(\s|=|$)/i.test(segment)
    ) {
      return false;
    }

    return allowed.some((entry) => {
      if (entry.includes(' ')) {
        return normalized === entry || normalized.startsWith(`${entry} `);
      }
      return base === entry;
    });
  });
}

function buildSafeEnv(cwd: string): NodeJS.ProcessEnv {
  const safeEnv: NodeJS.ProcessEnv = {};
  const envEntries = Object.entries(process.env);

  for (const key of SAFE_ENV_KEYS) {
    const found = envEntries.find(([envKey]) => envKey.toLowerCase() === key.toLowerCase());
    if (found?.[1] !== undefined) {
      safeEnv[key] = found[1];
    }
  }

  safeEnv['PWD'] = cwd;
  return safeEnv;
}

function pendingStore(): KVStore {
  return new KVStore({
    dataDir: process.env['APP_DATA_DIR'] ?? join(process.cwd(), 'data'),
    fileName: CONFIRM_STORE_FILE,
  });
}

function pendingToJson(command: PendingCommand): JsonObject {
  return {
    id: command.id,
    command: command.command,
    createdAt: command.createdAt,
    expiresAt: command.expiresAt,
  };
}

function parsePending(value: JsonValue | null): PendingCommand | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as JsonObject;
  if (
    typeof entry['id'] !== 'string' ||
    typeof entry['command'] !== 'string' ||
    typeof entry['createdAt'] !== 'number' ||
    typeof entry['expiresAt'] !== 'number'
  ) {
    return null;
  }

  return {
    id: entry['id'],
    command: entry['command'],
    createdAt: entry['createdAt'],
    expiresAt: entry['expiresAt'],
  };
}

async function savePendingCommand(command: PendingCommand): Promise<void> {
  const key = `${CONFIRM_STORE_KEY_PREFIX}${command.id}`;
  const store = pendingStore();
  const result = await store.set(key, pendingToJson(command));
  if (!result.ok) {
    // SECURITY FIX [H8]: fallback is best-effort only if persistent confirmation storage fails.
    logger.warn('system-execute: persistent confirm store unavailable, using memory fallback', {
      error: result.error.message,
    });
    fallbackPendingCommands.set(command.id, command);
  }
}

async function getPendingCommand(id: string): Promise<PendingCommand | null> {
  const key = `${CONFIRM_STORE_KEY_PREFIX}${id}`;
  const store = pendingStore();
  const result = await store.get<JsonObject>(key);
  if (result.ok) {
    return parsePending(result.value);
  }

  logger.warn('system-execute: confirm store read failed, checking memory fallback', {
    error: result.error.message,
  });
  return fallbackPendingCommands.get(id) ?? null;
}

async function deletePendingCommand(id: string): Promise<void> {
  const key = `${CONFIRM_STORE_KEY_PREFIX}${id}`;
  const store = pendingStore();
  const result = await store.delete(key);
  if (!result.ok) {
    logger.warn('system-execute: confirm store delete failed', {
      error: result.error.message,
    });
  }
  fallbackPendingCommands.delete(id);
}

// ─── Custom command registry ──────────────────────────────────────────────────

async function loadRegistry(): Promise<CustomCommand[]> {
  if (!existsSync(REGISTRY_PATH)) {
    return [];
  }

  try {
    const raw = await readFile(REGISTRY_PATH, 'utf-8');
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed as CustomCommand[];
  } catch {
    return [];
  }
}

async function saveRegistry(commands: CustomCommand[]): Promise<void> {
  await mkdir(join(REGISTRY_PATH, '..'), { recursive: true });
  await writeFile(REGISTRY_PATH, JSON.stringify(commands, null, 2), 'utf-8');
}

export async function saveCustomCommand(
  alias: string,
  command: string,
  description?: string
): Promise<string> {
  const registry = await loadRegistry();
  const existing = registry.findIndex((c) => c.alias === alias);

  const entry: CustomCommand = {
    alias,
    command,
    createdAt: new Date().toISOString(),
  };

  if (description !== undefined) {
    entry.description = description;
  }

  if (existing >= 0) {
    registry[existing] = entry;
  } else {
    registry.push(entry);
  }

  await saveRegistry(registry);

  logger.info('custom command saved', { alias, command });

  return `✅ Command saved as alias "${alias}":\n\`${command}\``;
}

export async function listCustomCommands(): Promise<string> {
  const registry = await loadRegistry();

  if (registry.length === 0) {
    return '📋 No custom commands saved yet.';
  }

  const lines = registry.map((c) =>
    `- **${c.alias}**: \`${c.command}\`${c.description ? `  — ${c.description}` : ''}`
  );

  return `📋 **Custom Commands:**\n\n${lines.join('\n')}`;
}

// ─── OS-aware shell selection ─────────────────────────────────────────────────

export function detectShell(): string {
  if (process.platform === 'win32') {
    return process.env['ComSpec'] ?? process.env['COMSPEC'] ?? 'C:\\Windows\\System32\\cmd.exe';
  }

  return process.env['SHELL'] ?? '/bin/sh';
}

export function normalizeShell(shell?: string): string {
  if (!shell || !shell.trim()) {
    return detectShell();
  }

  const normalized = shell.trim().toLowerCase();

  if (process.platform === 'win32') {
    if (normalized === 'cmd' || normalized === 'cmd.exe') {
      return process.env['ComSpec'] ?? process.env['COMSPEC'] ?? 'C:\\Windows\\System32\\cmd.exe';
    }
    if (normalized === 'powershell' || normalized === 'powershell.exe') {
      return process.env['SystemRoot']
        ? `${process.env['SystemRoot']}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
        : 'powershell.exe';
    }
    if (normalized === 'pwsh' || normalized === 'pwsh.exe') return 'pwsh.exe';
    return shell;
  }

  if (normalized === 'bash') return '/bin/bash';
  if (normalized === 'sh') return '/bin/sh';
  if (normalized === 'zsh') return '/bin/zsh';

  return shell;
}

type CwdResolution =
  | { ok: true; cwd: string }
  | { ok: false; content: string };

async function resolveExecutionCwd(explicitCwd?: string): Promise<CwdResolution> {
  const workspace = new WorkspaceManager();
  await workspace.ensureWorkspace();
  const workspaceRoot = resolve(workspace.rootDir);

  if (explicitCwd?.trim()) {
    const rawCwd = explicitCwd.trim();
    const target = /^[a-zA-Z]:[\\/]/.test(rawCwd) || rawCwd.startsWith('/') || rawCwd.startsWith('\\')
      ? resolve(rawCwd)
      : resolve(workspaceRoot, rawCwd);
    const relative = target === workspaceRoot ? '' : target.slice(workspaceRoot.length);

    // SECURITY FIX [H7]: explicit cwd must remain inside the workspace boundary.
    if (
      target !== workspaceRoot &&
      (!target.startsWith(`${workspaceRoot}${sep}`) || relative.startsWith(`..${sep}`))
    ) {
      return {
        ok: false,
        content: 'cwd di luar workspace boundary.',
      };
    }

    return { ok: true, cwd: target };
  }

  const mode = (process.env['SYSTEM_EXECUTE_DEFAULT_CWD'] ?? 'workspace').trim().toLowerCase();
  if (mode === 'workspace') {
    return { ok: true, cwd: workspaceRoot };
  }

  return { ok: true, cwd: process.cwd() };
}

// ─── Execution ────────────────────────────────────────────────────────────────

export async function runSystemExecute(
  input: ExecuteInput | string | Record<string, unknown>
): Promise<ExecuteResult> {
  if (!ENABLED) {
    return {
      ok: false,
      content: '❌ System execution is disabled. Set SYSTEM_EXECUTE_ENABLED=true.',
    };
  }

  let opts: ExecuteInput;

  if (typeof input === 'string') {
    opts = { command: input };
  } else {
    opts = input as ExecuteInput;
  }

  // Save custom command
  if (opts.saveAs && opts.command) {
    const msg = await saveCustomCommand(
      opts.saveAs,
      opts.command,
      opts.description
    );

    return {
      ok: true,
      content: msg,
    };
  }

  // List custom commands
  if (opts.alias === 'list' || opts.command === 'list') {
    return {
      ok: true,
      content: await listCustomCommands(),
    };
  }

  // Resolve command: alias → registry lookup → raw command
  let cmd = opts.command ?? '';

  if (opts.alias) {
    const registry = await loadRegistry();
    const found = registry.find((c) => c.alias === opts.alias);

    if (found) {
      cmd = found.command;

      logger.info('custom command resolved', {
        alias: opts.alias,
        command: cmd,
      });
    } else {
      return {
        ok: false,
        content: `❌ Alias "${opts.alias}" not found. Use /tools or ask me to save it first.`,
      };
    }
  }

  if (!cmd.trim()) {
    return {
      ok: false,
      content: '❌ No command provided.',
    };
  }

  if (!isAllowedCommand(cmd)) {
    return {
      ok: false,
      content: isDangerousCommand(cmd)
        ? 'Command ini berpotensi berbahaya dan tidak diizinkan oleh allowlist system-execute.'
        : 'Perintah tidak diizinkan oleh allowlist system-execute. Tambahkan command aman melalui SYSTEM_EXECUTE_ALLOWED_COMMANDS jika memang diperlukan.',
    };
  }

  const requestedConfirmId = opts.confirmId?.trim();
  if (requestedConfirmId) {
    const pending = await getPendingCommand(requestedConfirmId);
    const now = Date.now();

    if (!pending || pending.expiresAt <= now || pending.command !== cmd) {
      await deletePendingCommand(requestedConfirmId);
      return {
        ok: false,
        content: 'Konfirmasi tidak valid atau sudah kedaluwarsa.',
      };
    }

    await deletePendingCommand(requestedConfirmId);
  } else if (isDangerousCommand(cmd) && opts.confirm !== true) {
    const id = `cmd_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const now = Date.now();
    await savePendingCommand({
      id,
      command: cmd,
      createdAt: now,
      expiresAt: now + CONFIRM_TTL_MS,
    });

    return {
      ok: false,
      content:
        `⚠️ Command ini berpotensi berbahaya dan membutuhkan konfirmasi eksplisit.\n\n` +
        `Command: \`${cmd}\`\n\n` +
        `Untuk mengeksekusi, kirim ulang dengan:\n` +
        `{ "confirmId": "${id}" }\n\n` +
        'Konfirmasi berlaku selama 5 menit.',
    };
  }

  const shell = normalizeShell(opts.shell);
  const timeout = opts.timeout ?? TIMEOUT_MS;
  const cwdResult = await resolveExecutionCwd(opts.cwd);
  if (!cwdResult.ok) {
    return {
      ok: false,
      content: cwdResult.content,
    };
  }

  const cwd = cwdResult.cwd;
  const safeEnv = buildSafeEnv(cwd);

  logger.warn('system-execute: executing allowlisted command', {
    command: cmd.slice(0, 80),
    shell,
    cwd,
  });

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      shell,
      cwd,
      timeout,
      env: safeEnv,
      encoding: 'utf-8',
    });

    const out = typeof stdout === 'string' ? stdout.trim() : String(stdout ?? '').trim();
    const err = typeof stderr === 'string' ? stderr.trim() : String(stderr ?? '').trim();

    const content = [
      `✅ **Command executed:** \`${cmd.slice(0, 100)}\``,
      '',
      out ? `**stdout:**\n\`\`\`\n${out.slice(0, 3000)}\n\`\`\`` : '',
      err ? `**stderr:**\n\`\`\`\n${err.slice(0, 1000)}\n\`\`\`` : '',
    ].filter(Boolean).join('\n');

    const result: ExecuteResult = {
      ok: true,
      content,
      stdout: out,
      stderr: err,
      exitCode: 0,
    };

    return result;
  } catch (e: unknown) {
    const err = e as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number;
      message?: string;
    };

    const out = typeof err.stdout === 'string'
      ? err.stdout.trim()
      : String(err.stdout ?? '').trim();

    const serr = typeof err.stderr === 'string'
      ? err.stderr.trim()
      : String(err.stderr ?? '').trim();

    const code = err.code ?? 1;
    const msg = err.message ?? String(e);

    const content = [
      `⚠️ **Command exited with code ${code}:** \`${cmd.slice(0, 100)}\``,
      '',
      out ? `**stdout:**\n\`\`\`\n${out.slice(0, 2000)}\n\`\`\`` : '',
      serr ? `**stderr:**\n\`\`\`\n${serr.slice(0, 1000)}\n\`\`\`` : '',
      !out && !serr ? `Error: ${msg.slice(0, 300)}` : '',
    ].filter(Boolean).join('\n');

    return {
      ok: code === 0,
      content,
      stdout: out,
      stderr: serr,
      exitCode: code,
    };
  }
}
