/**
 * skills/index.ts
 * Barrel — re-exports the skills layer.
 */

export { parseSkillFile } from './parser';
export type { SkillFrontmatter, ParsedSkillFile } from './parser';

export { loadSkills, loadSkillFromFile } from './loader';
export type { Skill, LoadSkillsOptions } from './loader';

export { SkillRegistry } from './registry';
