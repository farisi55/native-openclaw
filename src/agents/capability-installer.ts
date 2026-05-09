/**
 * agents/capability-installer.ts
 * Natural-language tool/skill installation.
 *
 * Understands intents like:
 *   "install a weather tool"
 *   "I need a skill for API testing"
 *   "add the web-fetch tool"
 *   "enable code reviewer skill"
 *
 * Searches tools/available/ and skills/ for matches,
 * installs them, and returns a confirmation message.
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import type { ToolRegistry } from '../tools/tool-registry';
import type { SkillRegistry } from '../skills/registry';
import { installTool, listAvailable } from '../tools/tool-installer';
import { loadSkillFromFile } from '../skills/loader';
import { createLogger } from '../utils/logger';

const logger = createLogger('agents:capability-installer');

// ─── Detection patterns ───────────────────────────────────────────────────────

const INSTALL_TOOL_RE  = /(?:install|add|setup|get|enable)\s+(?:a\s+|the\s+)?(?:tool\s+)?([a-z0-9_\-\s]+?)(?:\s+tool)?(?:\s*$|\.)/i;
const INSTALL_SKILL_RE = /(?:install|add|setup|get|enable)\s+(?:a\s+|the\s+)?(?:skill\s+)?([a-z0-9_\-\s]+?)(?:\s+skill)?(?:\s*$|\.)/i;
const NEED_SKILL_RE    = /(?:need|want|require)\s+(?:a\s+skill|skill)\s+(?:for\s+)?([a-z0-9_\-\s]+)/i;
const NEED_TOOL_RE     = /(?:need|want|require)\s+(?:a\s+tool|tool)\s+(?:for\s+)?([a-z0-9_\-\s]+)/i;

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9\-_]/g, '');
}

// ─── Installer ────────────────────────────────────────────────────────────────

export interface InstallIntent {
  type: 'tool' | 'skill';
  name: string;
}

export interface CapabilityInstallResult {
  handled: boolean;
  response: string;
}

export class CapabilityInstaller {
  private readonly toolRegistry: ToolRegistry;
  private readonly skillRegistry: SkillRegistry;
  private readonly projectRoot: string;

  constructor(toolRegistry: ToolRegistry, skillRegistry: SkillRegistry, projectRoot?: string) {
    this.toolRegistry  = toolRegistry;
    this.skillRegistry = skillRegistry;
    this.projectRoot   = projectRoot ?? process.cwd();
  }

  // ── Intent detection ───────────────────────────────────────────────────────

  detectIntent(input: string): InstallIntent | null {
    const t = input.trim();

    // Tool patterns
    for (const re of [INSTALL_TOOL_RE, NEED_TOOL_RE]) {
      const m = re.exec(t);
      if (m?.[1]) return { type: 'tool', name: slugify(m[1]) };
    }

    // Skill patterns
    for (const re of [INSTALL_SKILL_RE, NEED_SKILL_RE]) {
      const m = re.exec(t);
      if (m?.[1]) return { type: 'skill', name: slugify(m[1]) };
    }

    return null;
  }

  // ── Main handler ──────────────────────────────────────────────────────────

  async handle(input: string): Promise<CapabilityInstallResult> {
    const intent = this.detectIntent(input);
    if (!intent) return { handled: false, response: '' };

    if (intent.type === 'tool') {
      return this.handleToolInstall(intent.name);
    }
    return this.handleSkillInstall(intent.name);
  }

  // ── Tool install ──────────────────────────────────────────────────────────

  private async handleToolInstall(name: string): Promise<CapabilityInstallResult> {
    // Already installed?
    if (this.toolRegistry.has(name)) {
      return {
        handled: true,
        response: `✅ Tool **${name}** is already installed and active.`,
      };
    }

    // Find best match in available tools
    const available = listAvailable(this.projectRoot);
    const match = this.fuzzyMatch(name, available);

    if (!match) {
      return {
        handled: true,
        response: [
          `❌ No tool matching "${name}" found in tools/available/.`,
          available.length > 0
            ? `\nAvailable tools: ${available.join(', ')}`
            : '\nNo tools available for installation.',
        ].join(''),
      };
    }

    logger.info('capability-installer: installing tool', { name: match });
    const result = await installTool(match, this.projectRoot);

    if (!result.ok) {
      return { handled: true, response: `❌ Install failed: ${result.message}` };
    }

    // Reload registry
    await this.toolRegistry.loadTools();

    return {
      handled: true,
      response: [
        `✅ Tool **${match}** installed and activated!`,
        `\nIt is now available for use in this session.`,
      ].join(''),
    };
  }

  // ── Skill install ─────────────────────────────────────────────────────────

  private async handleSkillInstall(name: string): Promise<CapabilityInstallResult> {
    // Already registered?
    if (this.skillRegistry.has(name)) {
      this.skillRegistry.activate(name);
      return {
        handled: true,
        response: `✅ Skill **${name}** activated!`,
      };
    }

    // Search skills/ folder
    const skillsDir = process.env['SKILLS_DIR'] ?? join(this.projectRoot, 'skills');
    const availableSkills = await this.listAvailableSkills(skillsDir);
    const match = this.fuzzyMatch(name, availableSkills);

    if (!match) {
      return {
        handled: true,
        response: [
          `❌ No skill matching "${name}" found in skills/.`,
          availableSkills.length > 0
            ? `\nAvailable skills: ${availableSkills.join(', ')}`
            : `\nAdd .md files to the skills/ directory to create skills.`,
        ].join(''),
      };
    }

    const skillPath = join(skillsDir, `${match}.md`);
    const loadResult = await loadSkillFromFile(skillPath);
    if (!loadResult.ok) {
      return { handled: true, response: `❌ Could not load skill: ${loadResult.error.message}` };
    }

    this.skillRegistry.register(loadResult.value);
    this.skillRegistry.activate(loadResult.value.id);

    logger.info('capability-installer: skill installed', { id: loadResult.value.id });

    return {
      handled: true,
      response: [
        `✅ Skill **${loadResult.value.name}** loaded and activated!`,
        loadResult.value.description ? `\n_${loadResult.value.description}_` : '',
      ].join(''),
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private fuzzyMatch(query: string, candidates: string[]): string | null {
    const q = query.toLowerCase().replace(/-/g, '');
    // Exact match first
    if (candidates.includes(query)) return query;
    // Partial match
    return (
      candidates.find((c) => c.replace(/-/g, '').includes(q)) ??
      candidates.find((c) => q.includes(c.replace(/-/g, ''))) ??
      null
    );
  }

  private async listAvailableSkills(skillsDir: string): Promise<string[]> {
    if (!existsSync(skillsDir)) return [];
    try {
      const entries = await readdir(skillsDir);
      return entries
        .filter((e) => e.endsWith('.md'))
        .map((e) => e.replace(/\.md$/, ''));
    } catch {
      return [];
    }
  }
}
