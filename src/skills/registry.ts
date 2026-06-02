/**
 * skills/registry.ts
 * In-memory registry — stores all available skills and tracks
 * which ones are currently active for a conversation turn.
 */

import { loadSkills } from './loader';
import type { Skill, LoadSkillsOptions } from './loader';
import { createLogger } from '../utils/logger';
import { isSimpleChatIntent } from '../agents/simple-chat-intent';

const logger = createLogger('skills:registry');

export interface SkillRelevanceOptions {
  enabled?: boolean;
  maxSkills?: number;
}

const STOPWORDS = new Set([
  'aku',
  'anda',
  'dan',
  'dari',
  'for',
  'ini',
  'itu',
  'kamu',
  'ke',
  'me',
  'my',
  'saya',
  'send',
  'the',
  'to',
  'yang',
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function skillSearchText(skill: Skill): string {
  return [
    skill.id,
    skill.name,
    skill.description,
    skill.frontmatter.tags.join(' '),
  ].join(' ').toLowerCase();
}

export function selectRelevantSkills(
  input: string,
  skills: Skill[],
  options: SkillRelevanceOptions = {}
): Skill[] {
  const enabled = options.enabled ?? true;
  if (!enabled) return skills;
  if (isSimpleChatIntent(input)) return [];

  const maxSkills = Math.max(0, options.maxSkills ?? 3);
  if (maxSkills === 0) return [];

  const inputTokens = tokens(input);
  if (inputTokens.length === 0) return [];

  const scored = skills
    .map((skill) => {
      const text = skillSearchText(skill);
      let score = 0;
      for (const token of inputTokens) {
        if (text.includes(token)) score += 1;
      }
      for (const tag of skill.frontmatter.tags) {
        const normalizedTag = tag.toLowerCase();
        if (normalizedTag && input.toLowerCase().includes(normalizedTag)) score += 3;
      }
      if (skill.name && input.toLowerCase().includes(skill.name.toLowerCase())) score += 5;
      return { skill, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.skill.frontmatter.priority - a.skill.frontmatter.priority);

  return scored.slice(0, maxSkills).map((item) => item.skill);
}

export class SkillRegistry {
  private readonly _skills: Map<string, Skill> = new Map();
  private _activeIds: string[] = [];

  // ── Population ─────────────────────────────────────────────────────────────

  /**
   * Load skills from disk and populate the registry.
   * Safe to call multiple times — clears previous state.
   * All loaded (and enabled) skills are auto-activated.
   */
  async load(options: LoadSkillsOptions = {}): Promise<void> {
    this._skills.clear();
    this._activeIds = [];

    const result = await loadSkills(options);
    if (!result.ok) {
      logger.warn('skill loading failed', { error: result.error.message });
      return;
    }

    for (const skill of result.value) {
      this._skills.set(skill.id, skill);
    }

    this._activeIds = result.value.map((s) => s.id);

    logger.info('registry populated', {
      total: this._skills.size,
      active: this._activeIds.length,
    });
  }

  /** Register a skill programmatically (useful for tests). */
  register(skill: Skill): void {
    this._skills.set(skill.id, skill);
    logger.debug('skill registered', { id: skill.id });
  }

  /**
   * Register a skill dynamically and activate it immediately.
   * Existing skills with the same id are overwritten.
   */
  registerAndActivate(skill: Skill): void {
    this._skills.set(skill.id, skill);
    if (!this._activeIds.includes(skill.id)) {
      this._activeIds.push(skill.id);
    }
    logger.info('skill hot-registered', { id: skill.id, name: skill.name });
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  all(): Skill[] {
    return [...this._skills.values()];
  }

  get(id: string): Skill | undefined {
    return this._skills.get(id);
  }

  has(id: string): boolean {
    return this._skills.has(id);
  }

  get size(): number {
    return this._skills.size;
  }

  // ── Activation ─────────────────────────────────────────────────────────────

  /** Active Skill objects in the current order. */
  activeSkills(): Skill[] {
    return this._activeIds
      .map((id) => this._skills.get(id))
      .filter((s): s is Skill => s !== undefined);
  }

  relevantActiveSkills(input: string, options: SkillRelevanceOptions = {}): Skill[] {
    return selectRelevantSkills(input, this.activeSkills(), options);
  }

  get activeIds(): string[] {
    return [...this._activeIds];
  }

  /** Activate additional skills by ID. Already-active skills are ignored. */
  activate(...ids: string[]): void {
    for (const id of ids) {
      if (!this._skills.has(id)) {
        logger.warn('activate: skill not found', { id });
        continue;
      }
      if (!this._activeIds.includes(id)) {
        this._activeIds.push(id);
        logger.debug('skill activated', { id });
      }
    }
  }

  /** Deactivate specific skills by ID. */
  deactivate(...ids: string[]): void {
    const set = new Set(ids);
    const before = this._activeIds.length;
    this._activeIds = this._activeIds.filter((id) => !set.has(id));
    logger.debug('skills deactivated', { count: before - this._activeIds.length });
  }

  /** Replace the active set with exactly these IDs. Unknown IDs are ignored. */
  setActive(ids: string[]): void {
    this._activeIds = ids.filter((id) => {
      if (!this._skills.has(id)) {
        logger.warn('setActive: skill not found — ignored', { id });
        return false;
      }
      return true;
    });
    logger.debug('active skills set', { active: this._activeIds });
  }

  activateAll(): void {
    this._activeIds = [...this._skills.keys()];
  }

  deactivateAll(): void {
    this._activeIds = [];
  }
}
