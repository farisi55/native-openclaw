/**
 * tools/tool-registry.ts
 * Auto-discovers and manages the plugin tool system.
 * v7: enriched manifest with examples, richer buildToolsBlock() for LLM reasoning.
 */

import { readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { createLogger } from '../utils/logger';

const logger = createLogger('tools:registry');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolManifest {
  name: string;
  displayName?: string;
  description: string;
  version: string;
  entry: string;
  enabled: boolean;
  /** Usage examples injected into the LLM prompt for better tool selection. */
  examples?: string[];
  /** Legacy rule-based triggers (kept as fallback). */
  triggers?: string[];
  inputSchema?: {
    type: string;
    properties?: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

export interface RegisteredTool {
  manifest: ToolManifest;
  run: (input: unknown) => Promise<string>;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export class ToolRegistry {
  private readonly toolsDir: string;
  private readonly installedDir: string;
  private readonly registry = new Map<string, RegisteredTool>();
  private loaded = false;

  constructor(projectRoot?: string) {
    const root = projectRoot ?? process.cwd();
    this.toolsDir = this.resolveToolsDir(root);
    this.installedDir = join(this.toolsDir, 'installed');
  }

  get installedToolsDir(): string {
    return this.installedDir;
  }

  private resolveToolsDir(projectRoot: string): string {
    const configured = process.env['TOOLS_DIR'];
    const candidates: string[] = [];

    if (configured?.trim()) {
      const raw = configured.trim();
      candidates.push(isAbsolute(raw) ? raw : resolve(projectRoot, raw));
    }

    candidates.push(resolve(projectRoot, 'tools'));
    candidates.push(resolve(process.cwd(), 'tools'));
    candidates.push(resolve(__dirname, '..', '..', 'tools'));

    const unique = [...new Set(candidates.map((candidate) => resolve(candidate)))];
    const found = unique.find((candidate) => existsSync(join(candidate, 'installed')));
    return found ?? unique[0] ?? resolve(projectRoot, 'tools');
  }

  async loadTools(): Promise<void> {
    this.registry.clear();

    if (!existsSync(this.installedDir)) {
      logger.warn('No tools loaded', {
        cwd: process.cwd(),
        toolsDir: this.toolsDir,
        installedDir: this.installedDir,
        installedDirExists: false,
        manifestFilesFound: 0,
        hint: 'Run the app from the project root, set TOOLS_DIR=./tools, or ensure tools/installed contains enabled manifests.',
      });
      this.loaded = true;
      return;
    }

    let entries: string[];
    try {
      entries = await readdir(this.installedDir);
    } catch (e) {
      logger.warn('No tools loaded', {
        cwd: process.cwd(),
        toolsDir: this.toolsDir,
        installedDir: this.installedDir,
        installedDirExists: true,
        manifestFilesFound: 0,
        error: String(e),
        hint: 'Check filesystem permissions and that tools/installed is readable.',
      });
      this.loaded = true;
      return;
    }

    const errors: string[] = [];
    let manifestFilesFound = 0;

    for (const toolDir of entries) {
      const manifestPath = join(this.installedDir, toolDir, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      manifestFilesFound++;

      let manifest: ToolManifest;
      try {
        const raw = await readFile(manifestPath, 'utf-8');
        manifest = JSON.parse(raw) as ToolManifest;
      } catch (e) {
        errors.push(`${toolDir}: invalid manifest — ${String(e)}`);
        continue;
      }

      if (!manifest.enabled) {
        logger.debug('tool disabled — skipped', { name: manifest.name });
        continue;
      }

      const runFn = await this.resolveRunFunction(manifest, toolDir);
      if (!runFn) {
        errors.push(`${toolDir}: could not load run() — entry not found`);
        continue;
      }

      this.registry.set(manifest.name, { manifest, run: runFn });
      logger.debug('tool loaded', { name: manifest.name, version: manifest.version });
    }

    if (errors.length > 0) logger.warn('some tools failed to load', { errors });

    if (this.registry.size === 0) {
      logger.warn('No tools loaded', {
        cwd: process.cwd(),
        toolsDir: this.toolsDir,
        installedDir: this.installedDir,
        installedDirExists: true,
        manifestFilesFound,
        errors,
        hint: 'Check that manifests are enabled and each tool has a loadable dist/tools/plugins/<name>.plugin.js or installed entry file.',
      });
    }

    logger.info('tool registry loaded', {
      count: this.registry.size,
      tools: [...this.registry.keys()],
      installedDir: this.installedDir,
    });

    this.loaded = true;
  }

  private async resolveRunFunction(
    manifest: ToolManifest,
    toolDir: string
  ): Promise<((input: unknown) => Promise<string>) | null> {
    const { join: pjoin, resolve: presolve } = await import('path');
    const cwd = pjoin(this.installedDir, '..', '..');
    const pluginName = manifest.name;

    const distPlugin = pjoin(cwd, 'dist', 'tools', 'plugins', `${pluginName}.plugin.js`);
    if (existsSync(distPlugin)) {
      try {
        const mod = await import(pathToFileURL(distPlugin).href) as { run?: (input: unknown) => Promise<string> };
        if (typeof mod.run === 'function') return mod.run;
      } catch (e) {
        logger.debug('dist plugin import failed', { path: distPlugin, error: String(e) });
      }
    }

    const entryPath = presolve(this.installedDir, toolDir, manifest.entry);
    if (existsSync(entryPath)) {
      try {
        const mod = await import(pathToFileURL(entryPath).href) as { run?: (input: unknown) => Promise<string> };
        if (typeof mod.run === 'function') return mod.run;
      } catch (e) {
        logger.debug('entry import failed', { path: entryPath, error: String(e) });
      }
    }

    const srcPlugin = pjoin(cwd, 'src', 'tools', 'plugins', `${pluginName}.plugin.ts`);
    if (existsSync(srcPlugin)) {
      try {
        const mod = await import(pathToFileURL(srcPlugin).href) as { run?: (input: unknown) => Promise<string> };
        if (typeof mod.run === 'function') return mod.run;
      } catch (e) {
        logger.debug('src plugin import failed', { path: srcPlugin, error: String(e) });
      }
    }

    return null;
  }

  // ── Query API ──────────────────────────────────────────────────────────────

  listTools(): RegisteredTool[] {
    return [...this.registry.values()];
  }

  listAll(): Array<{ manifest: ToolManifest; enabled: boolean }> {
    return this.listTools().map((t) => ({ manifest: t.manifest, enabled: t.manifest.enabled }));
  }

  getTool(name: string): RegisteredTool | undefined {
    return this.registry.get(name);
  }

  has(name: string): boolean {
    return this.registry.has(name);
  }

  get size(): number {
    return this.registry.size;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  registerRuntimeTool(tool: RegisteredTool): void {
    this.registry.set(tool.manifest.name, tool);
    logger.info('runtime tool registered', { name: tool.manifest.name });
  }

  unregisterTool(name: string): boolean {
    const removed = this.registry.delete(name);
    if (removed) logger.info('runtime tool unregistered', { name });
    return removed;
  }

  unregisterByPrefix(prefix: string): number {
    let removed = 0;
    for (const name of [...this.registry.keys()]) {
      if (name.startsWith(prefix)) {
        this.registry.delete(name);
        removed++;
      }
    }
    if (removed > 0) logger.info('runtime tools unregistered', { prefix, removed });
    return removed;
  }

  // ── Enable / disable ───────────────────────────────────────────────────────

  async enableTool(name: string): Promise<void> {
    const manifestPath = join(this.installedDir, name, 'manifest.json');
    if (!existsSync(manifestPath)) throw new Error(`Tool "${name}" not found in tools/installed/`);
    const raw = await readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as ToolManifest;
    manifest.enabled = true;
    const { writeFile } = await import('fs/promises');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    await this.loadTools();
    logger.info('tool enabled', { name });
  }

  async disableTool(name: string): Promise<void> {
    const manifestPath = join(this.installedDir, name, 'manifest.json');
    if (!existsSync(manifestPath)) throw new Error(`Tool "${name}" not found in tools/installed/`);
    const raw = await readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as ToolManifest;
    manifest.enabled = false;
    const { writeFile } = await import('fs/promises');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    this.registry.delete(name);
    logger.info('tool disabled', { name });
  }

  // ── Legacy rule-based trigger lookup (kept as fast-path fallback) ─────────

  findByTrigger(input: string): RegisteredTool | null {
    const lower = input.toLowerCase();
    for (const tool of this.registry.values()) {
      const triggers = tool.manifest.triggers ?? [];
      if (triggers.some((t) => lower.includes(t.toLowerCase()))) {
        return tool;
      }
    }
    return null;
  }

  // ── Rich LLM tool prompt block ────────────────────────────────────────────

  /**
   * Generates a detailed, structured tool description block injected into
   * the system prompt. The LLM uses this to autonomously decide which tool
   * to call and with what parameters.
   *
   * Format follows the spec in v7 requirements.
   */
  buildToolsBlock(): string | null {
    if (this.registry.size === 0) return null;
    const hasWebFetch = this.registry.has('web-fetch');

    const sections: string[] = [
      '## AVAILABLE TOOLS',
      '',
      'You have access to the following tools. When a user request requires',
      'real-time data, system information, or an API call, respond ONLY with',
      'a JSON object in this EXACT format (no other text):',
      '',
      '```json',
      '{"type":"tool_call","tool":"<tool-name>","input":{"<param>":"<value>"}}',
      '```',
      '',
      'If NO tool is needed, respond ONLY with:',
      '',
      '```json',
      '{"type":"final_response","content":"<your answer here>"}',
      '```',
      '',
      'TOOL NAME RULES:',
      '- Use ONLY tools listed below in AVAILABLE TOOLS.',
      '- Do not invent tool names.',
      '- For news, latest information, current events, web search, current prices, or online lookup, use `web-fetch` if available.',
      '- Never use `news_api`, `news`, `search_api`, `web_search`, `browser`, or `browse` unless that exact tool name appears below.',
      '- If no suitable tool exists, answer that the capability is unavailable instead of inventing a tool.',
      '- Tool call output must use the exact registered tool name.',
      '',
      '---',
    ];

    if (hasWebFetch) {
      sections.push(
        'For real-time internet/news/current information, use:',
        '```json',
        '{"type":"tool_call","tool":"web-fetch","input":{"query":"latest news today"}}',
        '```',
        '',
        '---'
      );
    }

    let toolIndex = 1;
    for (const tool of this.registry.values()) {
      const m = tool.manifest;
      const props = m.inputSchema?.properties ?? {};
      const required = m.inputSchema?.required ?? [];

      const inputLines: string[] = ['{'];
      for (const [key, schema] of Object.entries(props)) {
        const req = required.includes(key) ? ' (required)' : ' (optional)';
        inputLines.push(`  "${key}": "${schema.type}"${req}${schema.description ? ' // ' + schema.description : ''}`);
      }
      if (Object.keys(props).length === 0) inputLines.push('  // no input required');
      inputLines.push('}');

      const exampleLines = (m.examples ?? []).slice(0, 3).map((ex) => `  - "${ex}"`);

      sections.push('');
      sections.push(`### ${toolIndex}. ${m.name}`);
      sections.push(`**Description:** ${m.description}`);
      sections.push('');
      sections.push('**Input schema:**');
      sections.push('```');
      sections.push(...inputLines);
      sections.push('```');
      if (exampleLines.length > 0) {
        sections.push('');
        sections.push('**When to use (examples):**');
        sections.push(...exampleLines);
      }
      sections.push('');
      sections.push('---');
      toolIndex++;
    }

    return sections.join('\n');
  }

  /**
   * Short one-line summary for system context injection (used in SYSTEM CONTEXT block).
   */
  buildShortToolsSummary(): string {
    if (this.registry.size === 0) return 'No tools available.';
    return this.listTools()
      .map((t) => `${t.manifest.name}: ${t.manifest.description}`)
      .join(' | ');
  }
}
