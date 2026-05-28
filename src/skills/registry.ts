/**
 * skills/registry.ts
 * In-memory registry — stores all available skills and tracks
 * which ones are currently active for a conversation turn.
 */

import { loadSkills } from './loader';
import type { Skill, LoadSkillsOptions } from './loader';
import { createLogger } from '../utils/logger';

const logger = createLogger('skills:registry');

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
