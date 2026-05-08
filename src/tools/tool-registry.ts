/**
 * tools/tool-registry.ts
 * Auto-discovers and manages the plugin tool system.
 * v7: enriched manifest with examples, richer buildToolsBlock() for LLM reasoning.
 */

import { readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
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
  private readonly installedDir: string;
  private readonly registry = new Map<string, RegisteredTool>();
  private loaded = false;

  constructor(projectRoot?: string) {
    const root = projectRoot ?? process.cwd();
    this.installedDir = join(root, 'tools', 'installed');
  }

  async loadTools(): Promise<void> {
    this.registry.clear();

    if (!existsSync(this.installedDir)) {
      logger.debug('tools/installed directory not found — no plugins loaded');
      this.loaded = true;
      return;
    }

    let entries: string[];
    try {
      entries = await readdir(this.installedDir);
    } catch (e) {
      logger.warn('could not read tools/installed', { error: String(e) });
      this.loaded = true;
      return;
    }

    const errors: string[] = [];

    for (const toolDir of entries) {
      const manifestPath = join(this.installedDir, toolDir, 'manifest.json');
      if (!existsSync(manifestPath)) continue;

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

    logger.info('tool registry loaded', {
      count: this.registry.size,
      tools: [...this.registry.keys()],
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
        const mod = await import(distPlugin) as { run?: (input: unknown) => Promise<string> };
        if (typeof mod.run === 'function') return mod.run;
      } catch (e) {
        logger.debug('dist plugin import failed', { path: distPlugin, error: String(e) });
      }
    }

    const entryPath = presolve(this.installedDir, toolDir, manifest.entry);
    if (existsSync(entryPath)) {
      try {
        const mod = await import(entryPath) as { run?: (input: unknown) => Promise<string> };
        if (typeof mod.run === 'function') return mod.run;
      } catch (e) {
        logger.debug('entry import failed', { path: entryPath, error: String(e) });
      }
    }

    const srcPlugin = pjoin(cwd, 'src', 'tools', 'plugins', `${pluginName}.plugin.ts`);
    if (existsSync(srcPlugin)) {
      try {
        const mod = await import(srcPlugin) as { run?: (input: unknown) => Promise<string> };
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
      '---',
    ];

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
