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
import { join } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { createLogger } from '../utils/logger';

const logger = createLogger('tool:system-execute');
const execAsync = promisify(exec);

const TIMEOUT_MS = parseInt(process.env['SYSTEM_EXECUTE_TIMEOUT'] ?? '30000', 10);
const ENABLED = process.env['SYSTEM_EXECUTE_ENABLED'] !== 'false';
const REGISTRY_PATH = join(process.cwd(), 'data', 'custom-commands.json');
const CONFIRM_TTL_MS = 5 * 60 * 1000;

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

const pendingCommands = new Map<string, PendingCommand>();

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
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(cmd));
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

  const requestedConfirmId = opts.confirmId?.trim();
  if (requestedConfirmId) {
    const pending = pendingCommands.get(requestedConfirmId);
    const now = Date.now();

    if (!pending || pending.expiresAt <= now || pending.command !== cmd) {
      pendingCommands.delete(requestedConfirmId);
      return {
        ok: false,
        content: 'Konfirmasi tidak valid atau sudah kedaluwarsa.',
      };
    }

    pendingCommands.delete(requestedConfirmId);
  } else if (isDangerousCommand(cmd) && opts.confirm !== true) {
    const id = `cmd_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const now = Date.now();
    pendingCommands.set(id, {
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
  const cwd = opts.cwd ?? process.cwd();

  logger.info('system-execute', {
    command: cmd.slice(0, 80),
    shell,
    cwd,
  });

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      shell,
      cwd,
      timeout,
      env: { ...process.env },
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
