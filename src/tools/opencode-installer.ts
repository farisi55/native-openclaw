import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { createLogger } from '../utils/logger';
import { redactSecrets } from '../self-healing/log-redactor';
import { runSystemExecute, type ExecuteResult } from './system-execute';

const logger = createLogger('tool:opencode-installer');
const DEFAULT_DETECTION_TIMEOUT_MS = 10_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 300_000;
const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_INSTALL_OUTPUT_CHARS = 12_000;
const APPROVALS_PATH = join(
  process.env['APP_DATA_DIR'] ?? join(process.cwd(), 'data'),
  'opencode-install-approvals.json'
);

export type OpenCodeInstallStrategy =
  | 'npm-global'
  | 'npm-local'
  | 'official-script'
  | 'brew'
  | 'bun-global'
  | 'custom'
  | 'disabled';

export type OpenCodeExecutionStrategy =
  | 'direct'
  | 'windows-shell'
  | 'resolved-cmd'
  | 'custom';

export interface OpenCodeDetectionResult {
  installed: boolean;
  command: string;
  version?: string;
  path?: string;
  error?: string;
  executionStrategy?: OpenCodeExecutionStrategy;
  resolvedCommand?: string;
  shell?: boolean;
}

export interface OpenCodeInstallCommand {
  command: string;
  args: string[];
  shell?: boolean;
}

export interface OpenCodeInstallResult {
  ok: boolean;
  strategy: OpenCodeInstallStrategy;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  detectedAfterInstall?: OpenCodeDetectionResult;
  error?: string;
  approvalId?: string;
  approvalRequired?: boolean;
}

interface OpenCodeInstallApproval {
  id: string;
  strategy: OpenCodeInstallStrategy;
  command: string;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
}

export interface OpenCodeInstallerDeps {
  spawnFn?: typeof spawn;
  platform?: NodeJS.Platform;
  runSystemExecuteFn?: typeof runSystemExecute;
}

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

function normalizeStrategy(raw?: string): OpenCodeInstallStrategy {
  const value = (raw || 'npm-global').trim().toLowerCase();
  if (
    value === 'npm-global' ||
    value === 'npm-local' ||
    value === 'official-script' ||
    value === 'brew' ||
    value === 'bun-global' ||
    value === 'custom' ||
    value === 'disabled'
  ) {
    return value;
  }
  return 'npm-global';
}

function splitArgs(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (char === '\\' && i + 1 < command.length) {
        current += command[i + 1]!;
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
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) args.push(current);
  return args;
}

function quoteArg(arg: string): string {
  if (!arg) return '""';
  if (!/[\s"'&|<>^]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function commandToString(input: OpenCodeInstallCommand): string {
  if (input.shell && input.args.length >= 2 && input.args[0] === '-c') {
    return `${input.command} -c ${quoteArg(input.args.slice(1).join(' '))}`;
  }
  return [input.command, ...input.args].map(quoteArg).join(' ');
}

function supportsSudo(strategy: OpenCodeInstallStrategy): boolean {
  return strategy === 'npm-global' ||
    strategy === 'official-script' ||
    strategy === 'brew' ||
    strategy === 'bun-global';
}

function maybePrefixSudo(strategy: OpenCodeInstallStrategy, command: string, platform: NodeJS.Platform = process.platform): string {
  const sudoRequested = envBool('OPENCODE_INSTALL_USE_SUDO', false);
  if (platform === 'win32') {
    if (sudoRequested) {
      logger.warn('OPENCODE_INSTALL_USE_SUDO is ignored on Windows.');
    }
    return command;
  }
  if (!sudoRequested) return command;
  if (!supportsSudo(strategy)) return command;
  return command.startsWith('sudo ') ? command : `sudo ${command}`;
}

function truncate(value: string, maxChars = DEFAULT_MAX_INSTALL_OUTPUT_CHARS): string {
  const redacted = redactSecrets(value);
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}\n...[truncated ${redacted.length - maxChars} chars]`;
}

export function getOpenCodeInstallCommand(
  strategy: OpenCodeInstallStrategy = normalizeStrategy(process.env['OPENCODE_INSTALL_STRATEGY'])
): OpenCodeInstallCommand {
  switch (strategy) {
    case 'npm-global':
      return { command: 'npm', args: ['install', '-g', 'opencode-ai'] };
    case 'npm-local':
      return { command: 'npm', args: ['install', 'opencode-ai', '--save-dev'] };
    case 'official-script':
      return { command: 'sh', args: ['-c', 'curl -fsSL https://opencode.ai/install | bash'], shell: true };
    case 'brew':
      return { command: 'brew', args: ['install', 'anomalyco/tap/opencode'] };
    case 'bun-global':
      return { command: 'bun', args: ['add', '-g', 'opencode-ai'] };
    case 'custom': {
      const custom = (process.env['OPENCODE_INSTALL_COMMAND'] || '').trim();
      if (!custom) return { command: '', args: [] };
      const parts = splitArgs(custom);
      return { command: parts[0] ?? '', args: parts.slice(1) };
    }
    case 'disabled':
      return { command: '', args: [] };
  }
}

function runSpawn(input: {
  command: string;
  args: string[];
  timeoutMs: number;
  shell?: boolean;
  deps?: OpenCodeInstallerDeps;
}): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; error?: string }> {
  const spawnFn = input.deps?.spawnFn ?? spawn;
  return new Promise((resolveResult) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(input.command, input.args, {
        shell: input.shell ?? false,
        windowsHide: true,
        env: process.env,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      resolveResult({
        ok: false,
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: false,
        error: err.message,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, input.timeoutMs);

    const finish = (exitCode: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        ok: !timedOut && !error && exitCode === 0,
        stdout: redactSecrets(stdout.trim()),
        stderr: redactSecrets(error ? `${stderr}\n${error.message}`.trim() : stderr.trim()),
        exitCode,
        timedOut,
        ...(error ? { error: error.message } : {}),
      });
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => finish(null, error));
    child.once('close', (code) => finish(code));
  });
}

export async function detectOpenCode(
  command = process.env['OPENCODE_AGENT_COMMAND'] || 'opencode',
  deps: OpenCodeInstallerDeps = {}
): Promise<OpenCodeDetectionResult> {
  const binary = command.trim() || 'opencode';
  const platform = deps.platform ?? process.platform;
  logger.debug('OpenCode detection started', { command: binary });

  const direct = await runSpawn({
    command: binary,
    args: ['--version'],
    timeoutMs: DEFAULT_DETECTION_TIMEOUT_MS,
    deps,
  });

  if (direct.ok) {
    const version = direct.stdout || direct.stderr || 'unknown';
    logger.info('OpenCode detected', { command: binary, version });
    return {
      installed: true,
      command: binary,
      version,
      path: binary,
      executionStrategy: 'direct',
      resolvedCommand: binary,
      shell: false,
    };
  }

  if (platform === 'win32') {
    const commandLower = binary.toLowerCase();
    if (commandLower === 'opencode') {
      const cmdCommand = 'opencode.cmd';
      const cmdResult = await runSpawn({
        command: cmdCommand,
        args: ['--version'],
        timeoutMs: DEFAULT_DETECTION_TIMEOUT_MS,
        deps,
      });

      if (cmdResult.ok) {
        const version = cmdResult.stdout || cmdResult.stderr || 'unknown';
        logger.info('OpenCode detected through Windows .cmd resolution', { command: binary, resolvedCommand: cmdCommand, version });
        return {
          installed: true,
          command: binary,
          version,
          path: cmdCommand,
          executionStrategy: 'resolved-cmd',
          resolvedCommand: cmdCommand,
          shell: false,
        };
      }
    }

    const shellResult = await runSpawn({
      command: binary,
      args: ['--version'],
      timeoutMs: DEFAULT_DETECTION_TIMEOUT_MS,
      shell: true,
      deps,
    });

    if (shellResult.ok) {
      const version = shellResult.stdout || shellResult.stderr || 'unknown';
      logger.info('OpenCode detected through Windows shell fallback', { command: binary, version });
      return {
        installed: true,
        command: binary,
        version,
        path: binary,
        executionStrategy: 'windows-shell',
        resolvedCommand: binary,
        shell: true,
      };
    }
  }

  const error = direct.stderr || direct.error || `Unable to run ${binary} --version`;
  logger.info('OpenCode not detected', { command: binary, error: truncate(error, 600) });
  return {
    installed: false,
    command: binary,
    error,
  };
}

function isApproval(value: unknown): value is OpenCodeInstallApproval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item['id'] === 'string' &&
    typeof item['strategy'] === 'string' &&
    typeof item['command'] === 'string' &&
    typeof item['createdAt'] === 'string' &&
    typeof item['expiresAt'] === 'string' &&
    typeof item['status'] === 'string';
}

function expireApproval(record: OpenCodeInstallApproval, now = new Date()): OpenCodeInstallApproval {
  if (record.status === 'pending' && new Date(record.expiresAt).getTime() <= now.getTime()) {
    return { ...record, status: 'expired' };
  }
  return record;
}

async function readApprovals(): Promise<OpenCodeInstallApproval[]> {
  try {
    const raw = await readFile(APPROVALS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isApproval) : [];
  } catch {
    return [];
  }
}

async function writeApprovals(records: OpenCodeInstallApproval[]): Promise<void> {
  await mkdir(dirname(APPROVALS_PATH), { recursive: true });
  const tmp = `${APPROVALS_PATH}.tmp`;
  const data = JSON.stringify(records.slice(-100), null, 2);
  await writeFile(tmp, data, 'utf-8');
  try {
    await rename(tmp, APPROVALS_PATH);
  } catch {
    await writeFile(APPROVALS_PATH, data, 'utf-8');
    await unlink(tmp).catch(() => undefined);
  }
}

async function saveInstallApproval(strategy: OpenCodeInstallStrategy, command: string): Promise<OpenCodeInstallApproval> {
  const now = new Date();
  const record: OpenCodeInstallApproval = {
    id: `opencode_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    strategy,
    command,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DEFAULT_APPROVAL_TTL_MS).toISOString(),
    status: 'pending',
  };
  const records = (await readApprovals()).map((item) => expireApproval(item, now));
  records.push(record);
  await writeApprovals(records);
  return record;
}

export async function approveOpenCodeInstall(id: string): Promise<OpenCodeInstallResult> {
  const now = new Date();
  const records = (await readApprovals()).map((item) => expireApproval(item, now));
  const index = records.findIndex((record) => record.id === id);
  const found = index >= 0 ? records[index]! : null;
  if (!found) {
    return {
      ok: false,
      strategy: 'disabled',
      command: '',
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      error: `OpenCode install approval ${id} not found.`,
    };
  }
  records[index] = { ...found, status: 'approved' };
  await writeApprovals(records);
  return installOpenCode({
    strategy: found.strategy,
    command: found.command,
    requireApproval: false,
  });
}

export async function rejectOpenCodeInstall(id: string): Promise<OpenCodeInstallResult> {
  const now = new Date();
  const records = (await readApprovals()).map((item) => expireApproval(item, now));
  const index = records.findIndex((record) => record.id === id);
  const found = index >= 0 ? records[index]! : null;
  if (found) records[index] = { ...found, status: 'rejected' };
  await writeApprovals(records);
  return {
    ok: Boolean(found),
    strategy: found?.strategy ?? 'disabled',
    command: found?.command ?? '',
    stdout: '',
    stderr: '',
    exitCode: null,
    timedOut: false,
    ...(found ? {} : { error: `OpenCode install approval ${id} not found.` }),
  };
}

export async function installOpenCode(input: {
  strategy?: OpenCodeInstallStrategy;
  requireApproval?: boolean;
  command?: string;
  timeoutMs?: number;
  deps?: OpenCodeInstallerDeps;
} = {}): Promise<OpenCodeInstallResult> {
  const strategy = input.strategy ?? normalizeStrategy(process.env['OPENCODE_INSTALL_STRATEGY']);
  if (strategy === 'disabled') {
    return {
      ok: false,
      strategy,
      command: '',
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      error: 'OpenCode installation strategy is disabled.',
    };
  }

  const rawCustomCommand = strategy === 'custom' ? (process.env['OPENCODE_INSTALL_COMMAND'] || '').trim() : '';
  const installCommand = input.command
    ? { command: input.command, args: [] }
    : getOpenCodeInstallCommand(strategy);
  const baseCommand = input.command ?? (strategy === 'custom' ? rawCustomCommand : commandToString(installCommand));
  const command = maybePrefixSudo(strategy, baseCommand, input.deps?.platform);
  if (!installCommand.command && !input.command) {
    return {
      ok: false,
      strategy,
      command,
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      error: strategy === 'custom'
        ? 'OPENCODE_INSTALL_COMMAND is required when OPENCODE_INSTALL_STRATEGY=custom.'
        : 'OpenCode install command is empty.',
    };
  }

  const requireApproval = input.requireApproval ?? envBool('OPENCODE_INSTALL_REQUIRE_APPROVAL', true);
  if (requireApproval) {
    const approval = await saveInstallApproval(strategy, command);
    return {
      ok: false,
      strategy,
      command,
      stdout: '',
      stderr: '',
      exitCode: null,
      timedOut: false,
      approvalId: approval.id,
      approvalRequired: true,
      error: [
        'OpenCode CLI is not installed. Install now?',
        '',
        `Strategy: ${strategy}`,
        'Risk: warning',
        '',
        'Command:',
        command,
        '',
        `To approve, reply: approve opencode install ${approval.id}`,
        `To reject, reply: reject opencode install ${approval.id}`,
      ].join('\n'),
    };
  }

  const timeout = input.timeoutMs ?? envInt('OPENCODE_INSTALL_TIMEOUT_MS', DEFAULT_INSTALL_TIMEOUT_MS);
  logger.info('OpenCode install started', { strategy, command: redactSecrets(command) });
  const executionRunner = input.deps?.runSystemExecuteFn ?? runSystemExecute;
  const execution: ExecuteResult = await executionRunner({
    command,
    timeout,
    cwd: '.',
    requestedBy: 'opencode-agent',
  });

  const stdout = truncate(execution.stdout ?? '');
  const stderr = truncate(execution.stderr ?? execution.content);
  const timedOut = /timed out|timeout/i.test(stderr);
  const detectedAfterInstall = execution.ok
    ? await detectOpenCode(process.env['OPENCODE_AGENT_COMMAND'] || 'opencode', input.deps ?? {})
    : undefined;
  const ok = Boolean(execution.ok && detectedAfterInstall?.installed);

  if (ok) logger.info('OpenCode install completed', { strategy, command: process.env['OPENCODE_AGENT_COMMAND'] || 'opencode' });
  else logger.warn('OpenCode install failed or verification failed', { strategy, command: redactSecrets(command) });

  const missingNpm = /npm.*(?:not recognized|not found|enoent|cannot find)/i.test(stderr);
  return {
    ok,
    strategy,
    command,
    stdout: envBool('OPENCODE_INSTALL_LOG_OUTPUT', true) ? stdout : '',
    stderr: envBool('OPENCODE_INSTALL_LOG_OUTPUT', true) ? stderr : '',
    exitCode: execution.exitCode ?? null,
    timedOut,
    ...(detectedAfterInstall ? { detectedAfterInstall } : {}),
    ...(ok ? {} : {
      error: missingNpm
        ? 'npm is required to auto-install OpenCode. Please install Node.js/npm first.'
        : 'OpenCode install failed or could not be verified after installation.',
    }),
  };
}
