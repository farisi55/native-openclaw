/**
 * workspace/workspace-manager.ts
 * Local-first, human-readable workspace management with safe path resolution.
 */

import { mkdir, readdir, readFile, stat, writeFile, appendFile } from 'fs/promises';
import { existsSync } from 'fs';
import { isAbsolute, relative, resolve, sep } from 'path';
import { getOptionalEnv } from '../config/env';

export interface WorkspaceEntry {
  path: string;
  type: 'file' | 'directory';
}

export interface WorkspaceManagerOptions {
  rootDir?: string;
}

const DEFAULT_FILES: Record<string, string> = {
  'AGENTS.md': [
    '# Agents',
    '',
    'Native OpenClaw can coordinate chat, sessions, tools, skills, memory, and workspace files.',
    'Use this file to describe local agent roles, capabilities, and handoff notes.',
    '',
  ].join('\n'),
  'BOOTSTRAP.md': [
    '# Bootstrap',
    '',
    'Startup notes for the workspace.',
    'Record setup steps, assumptions, and project-specific boot instructions here.',
    '',
  ].join('\n'),
  'HEARTBEAT.md': [
    '# Heartbeat',
    '',
    'Status: ready',
    'Update this file with current operating status or recent checkpoints.',
    '',
  ].join('\n'),
  'IDENTITY.md': [
    '# Identity',
    '',
    'Workspace identity notes for this OpenClaw instance.',
    'Keep durable identity and naming details here.',
    '',
  ].join('\n'),
  'SOUL.md': [
    '# Soul',
    '',
    'Principles: be useful, careful, local-first, transparent, and respectful of user intent.',
    'Keep behavior notes concise and human-readable.',
    '',
  ].join('\n'),
  'TOOLS.md': [
    '# Tools',
    '',
    'Workspace-aware tools can list, read, write, append, and create folders inside this directory.',
    'Use reports/, artifacts/, backup/, MEMORY.md, and NOTES.md for task outputs when needed.',
    '',
  ].join('\n'),
  'USER.md': [
    '# User',
    '',
    'User profile notes placeholder.',
    'Add stable preferences and project context only when useful.',
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

export class WorkspaceManager {
  readonly rootDir: string;

  constructor(options: WorkspaceManagerOptions = {}) {
    const configured = options.rootDir ?? getOptionalEnv('WORKSPACE_DIR', './workspace') ?? './workspace';
    this.rootDir = resolve(process.cwd(), configured);
  }

  async ensureWorkspace(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await mkdir(resolve(this.rootDir, 'state'), { recursive: true });

    for (const [file, content] of Object.entries(DEFAULT_FILES)) {
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

  resolvePath(path: string): string {
    const trimmed = path.trim();
    if (!trimmed || trimmed === '.') return this.rootDir;
    if (trimmed.includes('\0')) throw new Error('Workspace path contains an invalid character.');
    if (isAbsolute(trimmed) || /^[a-zA-Z]:/.test(trimmed)) {
      throw new Error('Workspace paths must be relative.');
    }
    if (trimmed.split(/[\\/]+/).includes('..')) {
      throw new Error('Workspace path traversal is not allowed.');
    }

    const target = resolve(this.rootDir, trimmed);
    const rel = relative(this.rootDir, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error('Workspace path traversal is not allowed.');
    }

    return target;
  }

  private toWorkspacePath(path: string): string {
    const rel = relative(this.rootDir, path);
    return rel === '' ? '.' : rel.split(sep).join('/');
  }
}
