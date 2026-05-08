/**
 * tools/tool-registry.ts
 * Auto-discovers and manages the plugin tool system.
 *
 * Scan order:
 *   tools/installed/<tool-name>/manifest.json
 *   → manifest.entry resolves to compiled JS in dist/tools/plugins/
 *
 * Each plugin module must export:
 *   export async function run(input: unknown): Promise<string>
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
  /** JS entry point (relative to dist/tools/plugins/ or absolute). */
  entry: string;
  enabled: boolean;
  /** Keywords that trigger this tool via rule-based matching. */
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

  // ── Load all installed tools ───────────────────────────────────────────────

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

      // Resolve plugin module: try dist/tools/plugins/<name>.plugin.js first,
      // then the manifest entry path.
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
    // Use the project root derived from installedDir (…/tools/installed → …/)
    const { join: pjoin, resolve: presolve } = await import('path');
    const cwd = pjoin(this.installedDir, '..', '..');

    // Strategy 1: compiled plugin file in dist/tools/plugins/
    const pluginName = manifest.name; // e.g. "web-fetch"
    const distPlugin = pjoin(cwd, 'dist', 'tools', 'plugins', `${pluginName}.plugin.js`);
    if (existsSync(distPlugin)) {
      try {
        const mod = await import(distPlugin) as { run?: (input: unknown) => Promise<string> };
        if (typeof mod.run === 'function') return mod.run;
      } catch (e) {
        logger.debug('dist plugin import failed', { path: distPlugin, error: String(e) });
      }
    }

    // Strategy 2: manifest.entry relative to tools/installed/<toolDir>/
    const entryPath = presolve(this.installedDir, toolDir, manifest.entry);
    if (existsSync(entryPath)) {
      try {
        const mod = await import(entryPath) as { run?: (input: unknown) => Promise<string> };
        if (typeof mod.run === 'function') return mod.run;
      } catch (e) {
        logger.debug('entry import failed', { path: entryPath, error: String(e) });
      }
    }

    // Strategy 3: src/tools/plugins/ (for ts-node dev mode)
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

  // ── Enable / disable (updates manifest.json on disk) ──────────────────────

  async enableTool(name: string): Promise<void> {
    const manifestPath = join(this.installedDir, name, 'manifest.json');
    if (!existsSync(manifestPath)) throw new Error(`Tool "${name}" not found in tools/installed/`);
    const raw = await readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as ToolManifest;
    manifest.enabled = true;
    const { writeFile } = await import('fs/promises');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    // Reload this tool
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

  // ── Trigger-based lookup ───────────────────────────────────────────────────

  /**
   * Find a tool whose triggers match the user input.
   * Returns the first match (registry insertion order = load order).
   */
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

  // ── Prompt injection string ────────────────────────────────────────────────

  buildToolsBlock(): string | null {
    if (this.registry.size === 0) return null;
    const lines = [...this.registry.values()].map((t) => {
      const schema = t.manifest.inputSchema?.properties
        ? Object.keys(t.manifest.inputSchema.properties).join(', ')
        : 'query';
      return `- ${t.manifest.name}(${schema}): ${t.manifest.description}`;
    });
    return [
      '## AVAILABLE TOOLS',
      '> You may suggest a tool call in your response using JSON:',
      '> `{"tool":"<name>","input":{"query":"..."}}`',
      '> The system will execute it and return the result.',
      '',
      ...lines,
      '',
    ].join('\n');
  }
}
