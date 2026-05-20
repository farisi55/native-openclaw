/**
 * workspace/workspace-manager.ts
 * Functional local-first agent workspace with safe path resolution.
 */

import {
  appendFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'fs/promises';
import { existsSync } from 'fs';
import { basename, isAbsolute, relative, resolve, sep } from 'path';
import { getEnvBool, getOptionalEnv } from '../config/env';

export interface WorkspaceEntry {
  path: string;
  type: 'file' | 'directory';
}

export interface WorkspaceInfo {
  rootDir: string;
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  coreFiles: Array<{ path: string; exists: boolean }>;
}

export interface WorkspaceMemoryEvent {
  type: 'user_preference' | 'project_decision' | 'tool_event' | 'workflow_event' | 'system_event';
  summary: string;
  source: 'chat' | 'api' | 'telegram' | 'workflow' | 'cli' | 'system';
  details?: string;
  date?: Date;
}

export interface WorkspaceContextOptions {
  includeWorkflow?: boolean;
}

export interface WorkspaceManagerOptions {
  rootDir?: string;
}

const DEFAULT_DIRS = ['state', 'memory', 'reports', 'artifacts', 'backup', 'trash'] as const;
const CORE_FILES = [
  'AGENTS.md',
  'BOOTSTRAP.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
  'SOUL.md',
  'TOOLS.md',
  'USER.md',
  'MEMORY.md',
  'WORKFLOW.md',
] as const;

const CONTEXT_LIMITS: Record<string, number> = {
  'AGENTS.md': 4000,
  'SOUL.md': 2000,
  'IDENTITY.md': 1000,
  'USER.md': 3000,
  'TOOLS.md': 3000,
  'MEMORY.md': 5000,
  'WORKFLOW.md': 3000,
};

function nowIso(): string {
  return new Date().toISOString();
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function hms(date: Date): string {
  return date.toTimeString().slice(0, 8);
}

function timestampForPath(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[workspace excerpt truncated]`;
}

function defaultFiles(): Record<string, string> {
  return {
    'AGENTS.md': [
      '# Agent Operating Rules',
      '',
      'Native OpenClaw uses this workspace as the local-first operational home.',
      '',
      '## Safety Red Lines',
      '- Never delete files permanently. Move unsafe deletions to workspace/trash.',
      '- Ask confirmation before commands that modify system state.',
      '- Ask confirmation before sending emails, unless a workflow explicitly sets sendEmail=true.',
      '- Do not expose secrets from USER.md, .env, config files, or command output.',
      '- Do not expose hidden reasoning, internal planning, or workspace context unless asked.',
      '',
      '## File Operations',
      '- Use workspace as the default working directory.',
      '- Resolve relative file paths under workspace.',
      '- Do not write outside workspace unless explicitly requested and allowed by configuration.',
      '- Use workspace/reports for reports and workspace/artifacts for generated artifacts.',
      '- Use workspace/backup for backups and workspace/trash for safe deletions.',
      '',
      '## Command Execution',
      '- Prefer workspace tools for workspace file operations.',
      '- Use system-execute only when a shell command is actually needed.',
      '- Dangerous commands require explicit confirmation.',
      '',
      '## Email and Tool Usage',
      '- Never invent email recipients or API keys.',
      '- Never claim a tool succeeded unless the tool result confirms success.',
      '- Use web-fetch for current data before sending reports about current events, prices, or market updates.',
      '',
    ].join('\n'),
    'BOOTSTRAP.md': [
      '# Bootstrap',
      '',
      `Created: ${nowIso()}`,
      '',
      'This workspace is the local-first home for Native OpenClaw.',
      '',
      'Core files:',
      '- AGENTS.md: operating policy and safety rules.',
      '- SOUL.md: tone, style, values, and behavior principles.',
      '- IDENTITY.md: agent name, role, and persona metadata.',
      '- USER.md: user preferences, projects, and environment notes.',
      '- TOOLS.md: local tool and API conventions.',
      '- HEARTBEAT.md: recurring checklist template.',
      '- MEMORY.md: curated long-term memory.',
      '- WORKFLOW.md: dynamic autonomous workflow instructions.',
      '',
    ].join('\n'),
    'HEARTBEAT.md': [
      '# Heartbeat',
      '',
      'Status: disabled by default.',
      '',
      '## Checklist Template',
      '- Review open tasks.',
      '- Check reports/ for generated reports.',
      '- Check artifacts/ for temporary output.',
      '- Review memory logs for durable updates.',
      '',
      'Heartbeat tasks are not executed automatically unless a separate heartbeat feature is enabled.',
      '',
    ].join('\n'),
    'IDENTITY.md': [
      '# Identity',
      '',
      'Name: Jarpis',
      'Role: Native OpenClaw local AI assistant',
      'Focus: backend engineering, automation, file operations, research, workflows, and local-first agent support.',
      '',
    ].join('\n'),
    'SOUL.md': [
      '# Soul',
      '',
      '- Communicate in a concise, professional Indonesian style when the user speaks Indonesian.',
      '- Be honest, practical, and technically grounded.',
      '- Avoid excessive small talk.',
      '- Prefer direct help, clear tradeoffs, and safe execution.',
      '- Stay local-first and respect user control over files, commands, and email.',
      '',
    ].join('\n'),
    'TOOLS.md': [
      '# Tools',
      '',
      '## Local Commands',
      '- system-execute runs shell commands and must respect dangerous-command confirmation.',
      '- Default shell cwd should be workspace unless a project/source task needs project root.',
      '',
      '## Workspace Tools',
      '- workspace-list, workspace-tree, workspace-read, workspace-write, workspace-append, workspace-mkdir, workspace-trash, workspace-backup, workspace-info.',
      '- Use workspace tools before shell commands for workspace file operations.',
      '',
      '## MCP',
      '- MCP tools are named mcp:<server>:<tool>.',
      '- Failed MCP servers should not crash the app.',
      '',
      '## Email',
      '- Brevo email uses configured sender/recipient when omitted.',
      '- Do not claim email success unless Brevo returns success.',
      '',
    ].join('\n'),
    'USER.md': [
      '# User',
      '',
      '## Profile',
      '- Add durable user profile notes here.',
      '',
      '## Preferences',
      '- Add response style, language, and workflow preferences here.',
      '',
      '## Projects',
      '- Add stable project context here.',
      '',
      '## Environment Notes',
      '- Add local OS, shell, paths, ports, and repo notes here.',
      '',
    ].join('\n'),
    'MEMORY.md': [
      '# Curated Long-Term Memory',
      '',
      'Use this file for durable, reviewed memory. Raw activity logs belong in memory/YYYY-MM-DD.md.',
      '',
      '## Important Facts',
      '',
      '## User Preferences',
      '',
      '## Project Decisions',
      '',
      '## Environment Notes',
      '',
      '## Open Questions',
      '',
    ].join('\n'),
    'WORKFLOW.md': [
      '# Workflow: Daily Market Intelligence Report',
      '',
      '## Role',
      'You are an autonomous market analyst.',
      '',
      '## Objective',
      'Generate a daily market intelligence report based on the topic defined below.',
      '',
      '## Topic',
      'Harga emas dan proyeksi pasar harian',
      '',
      '## Data Requirements',
      '- Search latest global price data',
      '- Search local Indonesian price data if relevant',
      '- Search 3 latest news or market sentiment factors',
      '- Collect historical data if available',
      '- Prefer reliable sources',
      '',
      '## Tools To Use',
      '- tavily: search latest information',
      '- firecrawl: scrape detailed web pages',
      '- e2b: run Python analysis and generate charts',
      '- brevo: send final HTML email',
      '',
      '## Analysis Requirements',
      '- Summarize current price or market condition',
      '- Analyze recent trend',
      '- Analyze sentiment from news',
      '- Generate short-term projection',
      '- If numeric historical data is available, generate a simple chart',
      '- If data is incomplete, clearly state limitations',
      '',
      '## Output Requirements',
      '- Generate professional HTML report',
      '- Save report to workspace/reports',
      '- Save raw data to workspace/reports',
      '- Save chart if generated',
      '- Send email if Brevo is configured and the workflow explicitly says to send email',
      '',
      '## Email',
      'sendEmail: true',
      'subject: "[LAPORAN HARIAN] Market Intelligence - {{date}}"',
      'recipient: "${BREVO_RECIPIENT_EMAIL}"',
      'sender: "${BREVO_SENDER_EMAIL}"',
      '',
      '## Safety Rules',
      '- Do not claim success if a tool fails',
      '- Do not fabricate prices or data',
      '- Always cite source URLs when available',
      '- If required MCP tools are missing, report missing tools',
      '- Do not send email unless sendEmail is true',
      '',
    ].join('\n'),
  };
}

export class WorkspaceManager {
  readonly rootDir: string;
  readonly allowOutsidePaths: boolean;

  constructor(options: WorkspaceManagerOptions = {}) {
    const configured = options.rootDir ?? getOptionalEnv('WORKSPACE_DIR', './workspace') ?? './workspace';
    this.rootDir = resolve(process.cwd(), configured);
    this.allowOutsidePaths = getEnvBool('WORKSPACE_ALLOW_OUTSIDE_PATHS', false);
  }

  async ensureWorkspace(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    for (const dir of DEFAULT_DIRS) {
      await mkdir(resolve(this.rootDir, dir), { recursive: true });
    }

    for (const [file, content] of Object.entries(defaultFiles())) {
      const target = this.resolvePath(file);
      if (!existsSync(target)) {
        await writeFile(target, content, 'utf-8');
      }
    }
  }

  async list(path = '.'): Promise<WorkspaceEntry[]> {
    await this.ensureWorkspace();
    const target = this.resolvePath(path);
    const targetStat = await stat(target);
    if (!targetStat.isDirectory()) {
      return [{ path: this.toWorkspacePath(target), type: 'file' }];
    }

    const entries = await readdir(target, { withFileTypes: true });
    return entries
      .map((entry): WorkspaceEntry => ({
        path: this.toWorkspacePath(resolve(target, entry.name)),
        type: entry.isDirectory() ? 'directory' : 'file',
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async tree(path = '.', maxDepth = 3): Promise<string> {
    await this.ensureWorkspace();
    const root = this.resolvePath(path);
    const lines: string[] = [];

    const walk = async (target: string, depth: number): Promise<void> => {
      if (depth > maxDepth) return;
      const entries = await readdir(target, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const full = resolve(target, entry.name);
        const rel = this.toWorkspacePath(full);
        lines.push(`${'  '.repeat(depth)}${entry.isDirectory() ? '[dir] ' : '[file]'} ${rel}`);
        if (entry.isDirectory()) await walk(full, depth + 1);
      }
    };

    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) return `[file] ${this.toWorkspacePath(root)}`;
    await walk(root, 0);
    return lines.length > 0 ? lines.join('\n') : '(empty)';
  }

  async read(path: string): Promise<string> {
    await this.ensureWorkspace();
    const target = this.resolvePath(path);
    const targetStat = await stat(target);
    if (!targetStat.isFile()) {
      throw new Error(`Workspace path is not a file: ${path}`);
    }
    return readFile(target, 'utf-8');
  }

  async write(path: string, content: string): Promise<void> {
    await this.ensureWorkspace();
    const target = this.resolvePath(path);
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf-8');
  }

  async append(path: string, content: string): Promise<void> {
    await this.ensureWorkspace();
    const target = this.resolvePath(path);
    await mkdir(resolve(target, '..'), { recursive: true });
    const prefix = existsSync(target) ? '\n' : '';
    await appendFile(target, `${prefix}${content}`, 'utf-8');
  }

  async mkdir(path: string): Promise<void> {
    await this.ensureWorkspace();
    const target = this.resolvePath(path);
    await mkdir(target, { recursive: true });
  }

  async trash(path: string): Promise<string> {
    await this.ensureWorkspace();
    const source = this.resolvePath(path);
    if (!existsSync(source)) throw new Error(`Workspace path not found: ${path}`);
    const rel = this.toWorkspacePath(source);
    const target = this.resolvePath(`trash/${timestampForPath()}-${basename(rel)}`);
    await mkdir(resolve(target, '..'), { recursive: true });
    await rename(source, target);
    return this.toWorkspacePath(target);
  }

  async backup(): Promise<string> {
    await this.ensureWorkspace();
    const backupPath = this.resolvePath(`backup/workspace-backup-${timestampForPath()}`);
    await mkdir(backupPath, { recursive: true });
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'backup') continue;
      const source = resolve(this.rootDir, entry.name);
      const target = resolve(backupPath, entry.name);
      await cp(source, target, { recursive: true });
    }
    return this.toWorkspacePath(backupPath);
  }

  async info(): Promise<WorkspaceInfo> {
    await this.ensureWorkspace();
    let fileCount = 0;
    let directoryCount = 0;
    let totalBytes = 0;

    const walk = async (target: string): Promise<void> => {
      const entries = await readdir(target, { withFileTypes: true });
      for (const entry of entries) {
        const full = resolve(target, entry.name);
        if (entry.isDirectory()) {
          directoryCount++;
          await walk(full);
        } else if (entry.isFile()) {
          fileCount++;
          totalBytes += (await stat(full)).size;
        }
      }
    };

    await walk(this.rootDir);
    return {
      rootDir: this.rootDir,
      fileCount,
      directoryCount,
      totalBytes,
      coreFiles: CORE_FILES.map((path) => ({ path, exists: existsSync(this.resolvePath(path)) })),
    };
  }

  async appendDailyMemory(event: WorkspaceMemoryEvent): Promise<string> {
    if (!getEnvBool('WORKSPACE_DAILY_MEMORY_ENABLED', true)) return '';
    await this.ensureWorkspace();
    const date = event.date ?? new Date();
    const file = `memory/${ymd(date)}.md`;
    const target = this.resolvePath(file);
    if (!existsSync(target)) {
      await writeFile(target, `# Daily Memory Log - ${ymd(date)}\n`, 'utf-8');
    }

    const block = [
      '',
      `## ${hms(date)}`,
      `- Type: ${event.type}`,
      `- Summary: ${event.summary}`,
      `- Source: ${event.source}`,
      event.details ? `- Details: ${event.details}` : '',
    ].filter(Boolean).join('\n');
    await appendFile(target, `${block}\n`, 'utf-8');
    return file;
  }

  async readDailyMemory(date = ymd(new Date())): Promise<string> {
    const path = `memory/${date}.md`;
    if (!existsSync(this.resolvePath(path))) {
      return `No daily memory log found for ${date}.`;
    }
    return this.read(path);
  }

  async appendLongTermMemory(summary: string): Promise<void> {
    if (!getEnvBool('WORKSPACE_MEMORY_ENABLED', true)) return;
    const line = summary.trim();
    if (!line) return;
    const prefix = line.startsWith('-') ? line : `- ${line}`;
    await this.append('MEMORY.md', `${prefix}`);
  }

  async updateLongTermMemory(summary: string): Promise<void> {
    await this.appendLongTermMemory(`## ${ymd(new Date())}\n${summary.trim()}`);
  }

  async buildContext(options: WorkspaceContextOptions = {}): Promise<string> {
    await this.ensureWorkspace();
    const sections: string[] = ['## WORKSPACE CONTEXT'];
    const files = ['IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'USER.md', 'TOOLS.md', 'MEMORY.md'];
    if (options.includeWorkflow) files.push('WORKFLOW.md');

    for (const file of files) {
      const path = this.resolvePath(file);
      if (!existsSync(path)) continue;
      const raw = await readFile(path, 'utf-8');
      sections.push('', `### ${file}`, truncate(raw.trim(), CONTEXT_LIMITS[file] ?? 2000));
    }

    sections.push(
      '',
      'Workspace rules:',
      '- Treat workspace as the default local working area.',
      '- Use workspace tools for workspace file operations.',
      '- Keep USER.md and MEMORY.md internal unless the user explicitly asks to read them.',
      '- Use workspace/trash instead of permanent deletion.',
      '- Save reports in reports/ and generated artifacts in artifacts/.'
    );

    return sections.join('\n');
  }

  async reloadContext(): Promise<void> {
    await this.ensureWorkspace();
  }

  resolvePath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed || trimmed === '.') return this.rootDir;
    if (trimmed.includes('\0')) throw new Error('Workspace path contains an invalid character.');
    if (isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) {
      if (!this.allowOutsidePaths) throw new Error('Workspace paths must be relative.');
    }
    const target = resolve(this.rootDir, trimmed);
    const rel = relative(this.rootDir, target);
    if (!this.allowOutsidePaths && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
      throw new Error('Workspace path traversal is not allowed.');
    }

    return target;
  }

  private toWorkspacePath(path: string): string {
    const rel = relative(this.rootDir, path);
    return rel === '' ? '.' : rel.split(sep).join('/');
  }
}
