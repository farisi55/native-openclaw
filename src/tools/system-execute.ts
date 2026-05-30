/**
 * tools/system-execute.ts
 * Execute local commands with risk-based policy and approval for dangerous operations.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { basename, dirname, join, resolve, sep } from 'path';
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { createLogger } from '../utils/logger';
import { WorkspaceManager } from '../workspace';
import { redactSecrets } from '../self-healing';

const logger = createLogger('tool:system-execute');
const execAsync = promisify(exec);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000;
const REGISTRY_PATH = join(process.cwd(), 'data', 'custom-commands.json');
const APPROVALS_PATH = join(process.env['APP_DATA_DIR'] ?? join(process.cwd(), 'data'), 'system-execute-approvals.json');

export type CommandRiskLevel = 'safe' | 'warning' | 'dangerous';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface CommandRiskAssessment {
  risk: CommandRiskLevel;
  reason: string;
  requiresApproval: boolean;
  warnings: string[];
  matchedRules: string[];
}

export interface PendingCommandApproval {
  id: string;
  command: string;
  shell?: string;
  cwd?: string;
  createdAt: string;
  expiresAt: string;
  risk: 'dangerous';
  reason: string;
  requestedBy?: string;
  status: ApprovalStatus;
}

export interface ExecuteInput {
  command?: string;
  alias?: string;
  shell?: string;
  timeout?: number;
  cwd?: string;
  saveAs?: string;
  description?: string;
  approvalId?: string;
  approved?: boolean;
  requestedBy?: string;
  confirm?: boolean;
  confirmId?: string;
}

export interface ExecuteResult {
  ok: boolean;
  content: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  risk?: CommandRiskAssessment;
  approvalId?: string;
}

export interface CustomCommand {
  alias: string;
  command: string;
  description?: string;
  createdAt: string;
}

const SAFE_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'USERNAME',
  'USERPROFILE',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TZ',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'PWD',
  'LOGNAME',
  'COLORTERM',
  'TERM_PROGRAM',
  'ComSpec',
  'COMSPEC',
  'SystemRoot',
] as const;

const SAFE_BASE_COMMANDS = new Set([
  'pwd',
  'ls',
  'dir',
  'cat',
  'type',
  'echo',
  'date',
  'whoami',
  'hostname',
  'uname',
  'ps',
  'tasklist',
  'netstat',
  'ss',
  'ipconfig',
  'ifconfig',
  'find',
  'grep',
  'select-string',
  'get-childitem',
  'get-content',
  'head',
  'tail',
  'wc',
  'sort',
  'which',
  'where',
]);

const WARNING_BASE_COMMANDS = new Set([
  'npm',
  'mkdir',
  'touch',
  'cp',
  'copy',
  'mv',
  'move',
  'set-content',
  'new-item',
  'docker',
  'docker-compose',
  'git',
  'sed',
  'service',
]);

export const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:\/|~|\*|\.{1,2}(?:\s|$)|["']?[a-zA-Z]:[\\/])/i,
  /\brm\s+-[a-z]*r[a-z]*\s+(?:\/|~|\*|\.{1,2}(?:\s|$)|["']?[a-zA-Z]:[\\/])/i,
  /\bsudo\s+rm\b/i,
  /\bchmod\s+-R\s+777\s+(?:\/|~|[a-zA-Z]:[\\/])/i,
  /\bchown\s+-R\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bshutdown\b/i,
  /\bshutdown(?:\.exe)?\b[\s\S]*(?:\/s|\/r|\/p|\/h)\b/i,
  /\bRestart-Computer\b/i,
  /\bStop-Computer\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bpoweroff\b/i,
  /\bsystemctl\s+(?:stop|disable)\b/i,
  /\biptables\b/i,
  /\bufw\b/i,
  /\bfirewalld\b/i,
  /\buserdel\b/i,
  /\bpasswd\b/i,
  /\bcrontab\s+-r\b/i,
  /\bkill\s+-9\b/i,
  /\bpkill\b/i,
  /\bcurl\b[\s\S]*\|\s*(?:sh|bash|zsh)\b/i,
  /\bwget\b[\s\S]*\|\s*(?:sh|bash|zsh)\b/i,
  /(?:^|[;&|]\s*)eval\b/i,
  /:\(\)\s*\{\s*:\|\:\s*&\s*\}\s*;/,
  /\bdel\s+\/s\s+\/q\s+[a-zA-Z]:\\/i,
  /\bformat\b/i,
  /\bdiskpart\b/i,
  /\bbcdedit\b/i,
  /\breg\s+delete\b/i,
  /\bnet\s+user\b[\s\S]*\s+\/delete\b/i,
  /\bStop-Service\b/i,
  /\bSet-ExecutionPolicy\s+Unrestricted\b/i,
  /\b(?:Invoke-Expression|iex)\b/i,
  /\biwr\b[\s\S]*\|\s*iex\b/i,
  /\birm\b[\s\S]*\|\s*iex\b/i,
  /\b(?:Invoke-WebRequest|Invoke-RestMethod)\b[\s\S]*\|\s*(?:Invoke-Expression|iex)\b/i,
  /\b(?:powershell|pwsh)(?:\.exe)?\b[\s\S]*(?:^|\s)-(?:EncodedCommand|enc)\b/i,
  /\bpowershell(?:\.exe)?\b[\s\S]*\b(?:Invoke-Expression|iex)\b/i,
  /\bcurl\b[\s\S]*\|\s*powershell(?:\.exe)?\b/i,
  /\bdocker\s+system\s+prune\s+-a\b/i,
  /\bdocker\s+volume\s+rm\b/i,
  /\bdocker\s+rm\s+-f\b/i,
  /\bdocker\s+compose\s+down\s+-v\b/i,
  /\bdocker-compose\s+down\s+-v\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-fdx\b/i,
  /\bgit\s+push\s+--force\b/i,
];

export const SUBSHELL_PATTERNS: RegExp[] = [
  /\$\(/m,
  /`/m,
  /\$\{[\s\S]*/m,
];

let _workspace: WorkspaceManager | undefined;

async function getWorkspace(): Promise<WorkspaceManager> {
  if (!_workspace) {
    _workspace = new WorkspaceManager();
    await _workspace.ensureWorkspace();
  }
  return _workspace;
}

function isSystemExecuteEnabled(): boolean {
  return process.env['SYSTEM_EXECUTE_ENABLED'] !== 'false';
}

function getEnvBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() === 'true';
}

function getEnvInt(key: string, fallback: number): number {
  const parsed = Number(process.env[key]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function isRiskBasedPolicy(): boolean {
  return (process.env['SYSTEM_EXECUTE_POLICY'] ?? 'risk-based').trim().toLowerCase() === 'risk-based';
}

function allowArbitraryCommands(): boolean {
  return getEnvBool('SYSTEM_EXECUTE_ALLOW_ARBITRARY', true);
}

function warningAutoExecute(): boolean {
  return getEnvBool('SYSTEM_EXECUTE_WARNING_AUTO_EXECUTE', true);
}

function requireApprovalForDangerous(): boolean {
  return getEnvBool('SYSTEM_EXECUTE_REQUIRE_APPROVAL_FOR_DANGEROUS', true);
}

function redactOutput(input: string): string {
  return redactSecrets(input, getEnvBool('SYSTEM_EXECUTE_REDACT_SECRETS', true));
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
    .split(/&&|\|\||(?<!\\);|\r?\n/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function baseCommand(segment: string): string {
  const token = stripCommandQuotes(segment.split(/\s+/)[0] ?? '');
  return basename(token.replace(/\\/g, '/')).toLowerCase();
}

function allSegmentsReadOnly(command: string): boolean {
  const segments = commandSegments(command);
  if (segments.length === 0) return false;

  return segments.every((segment) => {
    const base = baseCommand(segment);
    const lower = segment.toLowerCase();
    if (!SAFE_BASE_COMMANDS.has(base)) return false;
    if (base === 'find' && /\b(?:-delete|-exec\s+(?:rm|mv|cp|sh|bash)\b)/i.test(lower)) return false;
    if ((base === 'grep' || base === 'select-string') && /\s>\s?/.test(segment)) return false;
    return true;
  });
}

function isSafeKnownCommand(command: string): boolean {
  const lower = command.toLowerCase().trim();
  if (/^docker\s+(?:ps|logs\b)/i.test(lower)) return true;
  if (/^git\s+(?:status|diff|log|show|branch\b)/i.test(lower)) return true;
  if (/^npm\s+(?:run\s+build|test|run\s+test)\b/i.test(lower)) return true;
  if (/^node\s+--version\b/i.test(lower)) return true;
  return allSegmentsReadOnly(command);
}

function warningRules(command: string): string[] {
  const lower = command.toLowerCase();
  const matched: string[] = [];
  const segments = commandSegments(command);
  if (segments.some((segment) => WARNING_BASE_COMMANDS.has(baseCommand(segment)))) matched.push('known-modifying-command');
  if (/\bnpm\s+(?:install|uninstall|update|cache\s+clean)\b/i.test(lower)) matched.push('npm-may-modify-dependencies');
  if (/\bgit\s+(?:checkout|restore)\b/i.test(lower)) matched.push('git-working-tree-change');
  if (/\b(?:mkdir|touch|cp|copy|mv|move|set-content|new-item|sed\s+-i)\b/i.test(lower)) matched.push('file-system-change');
  if (/\bdocker(?:\s+compose|-compose)?\s+restart\b/i.test(lower)) matched.push('container-restart');
  if (/\b(?:sudo|runas)\b/i.test(lower)) matched.push('privilege-request');
  if (/\b(?:curl|wget|iwr|invoke-webrequest)\b/i.test(lower)) matched.push('network-command');
  if (/\bexport\s+[A-Z_][A-Z0-9_]*=/i.test(command)) matched.push('environment-change');
  if (/[>&]\s*\S/.test(command)) matched.push('redirection-or-background');
  if (/\|/.test(command)) matched.push('pipeline');
  return matched;
}

function isDangerousPowerShellRemoveItem(command: string): boolean {
  const normalized = command.toLowerCase();
  if (!/\bremove-item\b/.test(normalized)) return false;

  const hasRecurse = /(?:^|\s)-recurse\b/.test(normalized);
  const hasForce = /(?:^|\s)-force\b/.test(normalized);
  if (!hasRecurse || !hasForce) return false;

  const dangerousTargetPatterns = [
    /[a-z]:[\\/]/i,
    /\$env:systemroot/i,
    /\$env:userprofile/i,
    /\bc:\\windows\b/i,
    /\bc:\\users\b/i,
    /\bc:\\program files\b/i,
    /(?:^|\s)\*(?:\s|$)/,
    /(?:^|\s)\\(?:\s|$)/,
    /(?:^|\s)\/(?:\s|$)/,
    /(?:^|\s)~(?:\s|$)/,
  ];

  return dangerousTargetPatterns.some((pattern) => pattern.test(command));
}

export function classifyCommandRisk(command: string): CommandRiskAssessment {
  const matchedSubshell = SUBSHELL_PATTERNS
    .map((pattern) => pattern.source)
    .filter((_, index) => SUBSHELL_PATTERNS[index]?.test(command));

  if (matchedSubshell.length > 0) {
    return {
      risk: 'dangerous',
      reason: 'Command uses command substitution or shell expansion that can hide a second command.',
      requiresApproval: requireApprovalForDangerous(),
      warnings: ['This command can execute hidden or untrusted code.'],
      matchedRules: matchedSubshell,
    };
  }

  if (isSafeKnownCommand(command)) {
    return {
      risk: 'safe',
      reason: 'Command appears read-only or is an approved low-risk build/test/status command.',
      requiresApproval: false,
      warnings: [],
      matchedRules: ['read-only-or-build-test'],
    };
  }

  if (isDangerousPowerShellRemoveItem(command)) {
    return {
      risk: 'dangerous',
      reason: 'PowerShell Remove-Item targets a root, system, profile, or wildcard path with -Recurse and -Force.',
      requiresApproval: requireApprovalForDangerous(),
      warnings: ['This command can recursively delete critical files or user data.'],
      matchedRules: ['powershell-remove-item-recursive-force-dangerous-target'],
    };
  }

  const matchedDangerous = DANGEROUS_PATTERNS
    .map((pattern) => pattern.source)
    .filter((_, index) => DANGEROUS_PATTERNS[index]?.test(command));

  if (matchedDangerous.length > 0) {
    return {
      risk: 'dangerous',
      reason: 'Command matches destructive, privilege-sensitive, or hard-to-reverse patterns.',
      requiresApproval: requireApprovalForDangerous(),
      warnings: ['This command can damage data, change system state, or execute untrusted code.'],
      matchedRules: matchedDangerous,
    };
  }

  const matchedWarnings = warningRules(command);
  return {
    risk: 'warning',
    reason: matchedWarnings.length > 0
      ? 'Command may modify files, environment, network state, or project dependencies.'
      : 'Unknown command; defaulting to warning instead of blocking by allowlist.',
    requiresApproval: false,
    warnings: ['Warning: this command may modify files or environment.'],
    matchedRules: matchedWarnings.length > 0 ? matchedWarnings : ['unknown-command-warning'],
  };
}

export function isDangerousCommand(cmd: string): boolean {
  return classifyCommandRisk(cmd).risk === 'dangerous';
}

export function isCommandAllowed(command: string): boolean {
  if (!isRiskBasedPolicy() || !allowArbitraryCommands()) {
    return isSafeKnownCommand(command);
  }
  return true;
}

function buildSafeEnv(cwd: string): NodeJS.ProcessEnv {
  const safeEnv: NodeJS.ProcessEnv = {};
  const envEntries = Object.entries(process.env);
  for (const key of SAFE_ENV_KEYS) {
    const found = envEntries.find(([envKey]) => envKey.toLowerCase() === key.toLowerCase());
    if (found?.[1] !== undefined) safeEnv[key] = found[1];
  }
  safeEnv['PWD'] = cwd;
  return safeEnv;
}

async function loadRegistry(): Promise<CustomCommand[]> {
  if (!existsSync(REGISTRY_PATH)) return [];
  try {
    const raw = await readFile(REGISTRY_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as CustomCommand[] : [];
  } catch {
    return [];
  }
}

async function saveRegistry(commands: CustomCommand[]): Promise<void> {
  await mkdir(dirname(REGISTRY_PATH), { recursive: true });
  const tmp = `${REGISTRY_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(commands, null, 2), 'utf-8');
  await rename(tmp, REGISTRY_PATH);
}

export async function saveCustomCommand(
  alias: string,
  command: string,
  description?: string
): Promise<string> {
  const risk = classifyCommandRisk(command);
  if (risk.risk === 'dangerous') {
    throw new Error(`Command "${command}" is dangerous and cannot be saved as a reusable alias.`);
  }

  const registry = await loadRegistry();
  const existing = registry.findIndex((c) => c.alias === alias);
  const entry: CustomCommand = {
    alias,
    command,
    createdAt: new Date().toISOString(),
    ...(description !== undefined ? { description } : {}),
  };

  if (existing >= 0) registry[existing] = entry;
  else registry.push(entry);
  await saveRegistry(registry);
  logger.info('custom command saved', { alias, risk: risk.risk });
  return `Command saved as alias "${alias}":\n\`${command}\`\nRisk: ${risk.risk}`;
}

export async function listCustomCommands(): Promise<string> {
  const registry = await loadRegistry();
  if (registry.length === 0) return 'No custom commands saved yet.';
  const lines = registry.map((c) =>
    `- **${c.alias}**: \`${c.command}\`${c.description ? ` - ${c.description}` : ''}`
  );
  return `Custom Commands:\n\n${lines.join('\n')}`;
}

export function detectShell(): string {
  if (process.platform === 'win32') {
    return process.env['ComSpec'] ?? process.env['COMSPEC'] ?? 'C:\\Windows\\System32\\cmd.exe';
  }
  return process.env['SHELL'] ?? '/bin/sh';
}

export function normalizeShell(shell?: string): string {
  if (!shell || !shell.trim()) return detectShell();
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
  const workspace = await getWorkspace();
  const workspaceRoot = resolve(workspace.rootDir);

  if (explicitCwd?.trim()) {
    const rawCwd = explicitCwd.trim();
    const target = /^[a-zA-Z]:[\\/]/.test(rawCwd) || rawCwd.startsWith('/') || rawCwd.startsWith('\\')
      ? resolve(rawCwd)
      : resolve(workspaceRoot, rawCwd);
    const relative = target === workspaceRoot ? '' : target.slice(workspaceRoot.length);

    if (
      target !== workspaceRoot &&
      (!target.startsWith(`${workspaceRoot}${sep}`) || relative.startsWith(`..${sep}`))
    ) {
      return { ok: false, content: 'cwd di luar workspace boundary.' };
    }
    return { ok: true, cwd: target };
  }

  const mode = (process.env['SYSTEM_EXECUTE_DEFAULT_CWD'] ?? 'workspace').trim().toLowerCase();
  return { ok: true, cwd: mode === 'workspace' ? workspaceRoot : process.cwd() };
}

async function readApprovals(): Promise<PendingCommandApproval[]> {
  try {
    const raw = await readFile(APPROVALS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isPendingCommandApproval) : [];
  } catch {
    return [];
  }
}

function isPendingCommandApproval(value: unknown): value is PendingCommandApproval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item['id'] === 'string' &&
    typeof item['command'] === 'string' &&
    typeof item['createdAt'] === 'string' &&
    typeof item['expiresAt'] === 'string' &&
    item['risk'] === 'dangerous' &&
    typeof item['reason'] === 'string' &&
    typeof item['status'] === 'string';
}

async function writeApprovals(records: PendingCommandApproval[]): Promise<void> {
  await mkdir(dirname(APPROVALS_PATH), { recursive: true });
  const tmp = `${APPROVALS_PATH}.tmp`;
  const data = JSON.stringify(records.slice(-200), null, 2);
  await writeFile(tmp, data, 'utf-8');
  try {
    await rename(tmp, APPROVALS_PATH);
  } catch (error) {
    logger.debug('approval store atomic rename failed, falling back to direct write', {
      error: error instanceof Error ? error.message : String(error),
    });
    await writeFile(APPROVALS_PATH, data, 'utf-8');
    await unlink(tmp).catch(() => undefined);
  }
}

function expireRecord(record: PendingCommandApproval, now = new Date()): PendingCommandApproval {
  if (record.status === 'pending' && new Date(record.expiresAt).getTime() <= now.getTime()) {
    return { ...record, status: 'expired' };
  }
  return record;
}

async function savePendingApproval(input: {
  command: string;
  shell?: string;
  cwd?: string;
  risk: CommandRiskAssessment;
  requestedBy?: string;
}): Promise<PendingCommandApproval> {
  const now = new Date();
  const record: PendingCommandApproval = {
    id: `cmd_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    command: input.command,
    ...(input.shell ? { shell: input.shell } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + getEnvInt('SYSTEM_EXECUTE_APPROVAL_TTL_MS', DEFAULT_APPROVAL_TTL_MS)).toISOString(),
    risk: 'dangerous',
    reason: input.risk.reason,
    ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
    status: 'pending',
  };
  const records = (await readApprovals()).map((item) => expireRecord(item, now));
  records.push(record);
  await writeApprovals(records);
  return record;
}

async function findApproval(id: string): Promise<PendingCommandApproval | null> {
  const now = new Date();
  const records = (await readApprovals()).map((item) => expireRecord(item, now));
  await writeApprovals(records);
  return records.find((record) => record.id === id) ?? null;
}

async function updateApprovalStatus(id: string, status: ApprovalStatus): Promise<PendingCommandApproval | null> {
  const now = new Date();
  let found: PendingCommandApproval | null = null;
  const records = (await readApprovals()).map((item) => {
    const current = expireRecord(item, now);
    if (current.id !== id) return current;
    found = { ...current, status };
    return found;
  });
  if (found) await writeApprovals(records);
  return found;
}

export async function listPendingCommandApprovals(): Promise<PendingCommandApproval[]> {
  const now = new Date();
  const records = (await readApprovals()).map((item) => expireRecord(item, now));
  await writeApprovals(records);
  return records.filter((record) => record.status === 'pending');
}

export async function approveCommand(id: string): Promise<ExecuteResult> {
  const record = await findApproval(id);
  if (!record) {
    return { ok: false, content: `Approval ${id} not found.` };
  }
  if (record.status !== 'pending') {
    return { ok: false, content: `Approval ${id} is ${record.status}.` };
  }
  await updateApprovalStatus(id, 'approved');
  return runSystemExecute({
    command: record.command,
    ...(record.shell ? { shell: record.shell } : {}),
    ...(record.cwd ? { cwd: record.cwd } : {}),
    approvalId: id,
    approved: true,
  });
}

export async function rejectCommand(id: string): Promise<ExecuteResult> {
  const record = await updateApprovalStatus(id, 'rejected');
  if (!record) return { ok: false, content: `Approval ${id} not found.` };
  return {
    ok: true,
    content: `Command approval ${id} rejected. Command was not executed.`,
  };
}

function approvalRequestContent(command: string, risk: CommandRiskAssessment, id: string): string {
  return [
    'Command classified as dangerous and requires approval.',
    '',
    `Risk: ${risk.risk}`,
    `Reason: ${risk.reason}`,
    '',
    'Command:',
    command,
    '',
    `To approve, reply: approve command ${id}`,
    `To reject: reject command ${id}`,
  ].join('\n');
}

function approvalStatusText(risk: CommandRiskAssessment, approved: boolean): string {
  if (risk.risk !== 'dangerous') return 'not required';
  return approved ? 'approved' : 'required';
}

function truncateOutput(value: string, maxChars: number): string {
  const redacted = redactOutput(value);
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}\n...[output truncated]`;
}

function formatExecutionResult(input: {
  command: string;
  risk: CommandRiskAssessment;
  approved: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}): string {
  const maxOutputChars = getEnvInt('SYSTEM_EXECUTE_MAX_OUTPUT_CHARS', DEFAULT_MAX_OUTPUT_CHARS);
  const stdout = truncateOutput(input.stdout, maxOutputChars);
  const stderr = truncateOutput(input.stderr, Math.max(2000, Math.floor(maxOutputChars / 2)));
  const lines = [
    'Command:',
    input.command,
    '',
    `Risk: ${input.risk.risk}`,
    `Approval: ${approvalStatusText(input.risk, input.approved)}`,
    `Exit code: ${input.exitCode}`,
  ];

  if (input.risk.risk === 'warning') {
    lines.push('', 'Warning:', input.risk.warnings.join('\n') || input.risk.reason);
  }

  lines.push('', 'STDOUT:', stdout || '(empty)', '', 'STDERR:', stderr || '(empty)');
  return lines.join('\n');
}

async function executeCommand(input: {
  command: string;
  shell?: string;
  timeout?: number;
  cwd?: string;
  risk: CommandRiskAssessment;
  approved: boolean;
}): Promise<ExecuteResult> {
  const shell = normalizeShell(input.shell);
  const timeout = input.timeout ?? getEnvInt('SYSTEM_EXECUTE_TIMEOUT', DEFAULT_TIMEOUT_MS);
  const cwdResult = await resolveExecutionCwd(input.cwd);
  if (!cwdResult.ok) return { ok: false, content: cwdResult.content, risk: input.risk };

  const cwd = cwdResult.cwd;
  const safeEnv = buildSafeEnv(cwd);

  const logMeta = {
    command: redactOutput(input.command).slice(0, 160),
    shell,
    cwd,
    risk: input.risk.risk,
    matchedRules: input.risk.matchedRules,
  };
  if (getEnvBool('SYSTEM_EXECUTE_LOG_COMMANDS', true)) {
    if (input.risk.risk === 'safe') logger.info('system-execute: executing command', logMeta);
    else logger.warn('system-execute: executing command with risk', logMeta);
  }

  try {
    const { stdout, stderr } = await execAsync(input.command, {
      shell,
      cwd,
      timeout,
      env: safeEnv,
      encoding: 'utf-8',
    });

    const out = typeof stdout === 'string' ? stdout.trim() : String(stdout ?? '').trim();
    const err = typeof stderr === 'string' ? stderr.trim() : String(stderr ?? '').trim();
    return {
      ok: true,
      content: formatExecutionResult({
        command: redactOutput(input.command),
        risk: input.risk,
        approved: input.approved,
        exitCode: 0,
        stdout: out,
        stderr: err,
      }),
      stdout: redactOutput(out),
      stderr: redactOutput(err),
      exitCode: 0,
      risk: input.risk,
    };
  } catch (e: unknown) {
    const err = e as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number;
      message?: string;
    };
    const out = typeof err.stdout === 'string' ? err.stdout.trim() : String(err.stdout ?? '').trim();
    const serr = typeof err.stderr === 'string' ? err.stderr.trim() : String(err.stderr ?? '').trim();
    const code = typeof err.code === 'number' ? err.code : 1;
    const message = err.message ?? String(e);
    const stderr = serr || message;
    return {
      ok: code === 0,
      content: formatExecutionResult({
        command: redactOutput(input.command),
        risk: input.risk,
        approved: input.approved,
        exitCode: code,
        stdout: out,
        stderr,
      }),
      stdout: redactOutput(out),
      stderr: redactOutput(stderr),
      exitCode: code,
      risk: input.risk,
    };
  }
}

export async function runSystemExecute(
  input: ExecuteInput | string | Record<string, unknown>
): Promise<ExecuteResult> {
  if (!isSystemExecuteEnabled()) {
    return { ok: false, content: 'System execution is disabled. Set SYSTEM_EXECUTE_ENABLED=true.' };
  }

  const opts: ExecuteInput = typeof input === 'string' ? { command: input } : input as ExecuteInput;

  if (opts.saveAs && opts.command) {
    const msg = await saveCustomCommand(opts.saveAs, opts.command, opts.description);
    return { ok: true, content: msg };
  }

  if (opts.alias === 'list' || opts.command === 'list') {
    return { ok: true, content: await listCustomCommands() };
  }

  let command = opts.command ?? '';
  if (opts.alias) {
    const registry = await loadRegistry();
    const found = registry.find((c) => c.alias === opts.alias);
    if (!found) {
      return { ok: false, content: `Alias "${opts.alias}" not found. Use /tools or ask me to save it first.` };
    }
    command = found.command;
    logger.info('custom command resolved', { alias: opts.alias, risk: classifyCommandRisk(command).risk });
  }

  if (!command.trim()) return { ok: false, content: 'No command provided.' };

  const risk = classifyCommandRisk(command);
  if (!allowArbitraryCommands() && !isSafeKnownCommand(command)) {
    return {
      ok: false,
      content: 'Arbitrary command execution is disabled. Set SYSTEM_EXECUTE_ALLOW_ARBITRARY=true to allow risk-based execution.',
      risk,
    };
  }

  if (risk.risk === 'warning' && !warningAutoExecute()) {
    return {
      ok: false,
      content: [
        'Command classified as warning and warning auto-execute is disabled.',
        `Risk: ${risk.risk}`,
        `Reason: ${risk.reason}`,
        '',
        'Command:',
        command,
      ].join('\n'),
      risk,
    };
  }

  const approvalId = opts.approvalId?.trim() || opts.confirmId?.trim();
  const legacyConfirmed = opts.confirm === true && !approvalId;
  const explicitlyApproved = opts.approved === true || legacyConfirmed;

  if (risk.risk === 'dangerous' && risk.requiresApproval && !explicitlyApproved) {
    if (approvalId) {
      const record = await findApproval(approvalId);
      if (!record || record.command !== command || record.status !== 'approved') {
        return {
          ok: false,
          content: 'Approval is invalid, expired, rejected, or does not match this command.',
          risk,
        };
      }
      return executeCommand({
        command,
        ...(opts.shell ?? record.shell ? { shell: opts.shell ?? record.shell } : {}),
        ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
        ...(opts.cwd ?? record.cwd ? { cwd: opts.cwd ?? record.cwd } : {}),
        risk,
        approved: true,
      });
    }

    const record = await savePendingApproval({
      command,
      ...(opts.shell ? { shell: opts.shell } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      risk,
      ...(opts.requestedBy ? { requestedBy: opts.requestedBy } : {}),
    });
    return {
      ok: false,
      content: approvalRequestContent(command, risk, record.id),
      risk,
      approvalId: record.id,
    };
  }

  return executeCommand({
    command,
    ...(opts.shell ? { shell: opts.shell } : {}),
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    risk,
    approved: risk.risk === 'dangerous',
  });
}
