/**
 * skills/index.ts
 * Barrel — re-exports the skills layer.
 */

export { parseSkillFile } from './parser';
export type { SkillFrontmatter, ParsedSkillFile } from './parser';

export { loadSkills, loadSkillFromFile } from './loader';
export type { Skill, LoadSkillsOptions } from './loader';

export { SkillRegistry } from './registry';
export { SkillExtractor } from './skill-extractor';
export type { SkillExtractionInput, ExtractedSkill } from './skill-extractor';
export { SkillWriter } from './skill-writer';
export { SkillQualityTracker } from './skill-quality-tracker';
export type { SkillQualityEntry } from './skill-quality-tracker';
export { SkillEvaluator } from './skill-evaluator';
export type { EvaluationReport } from './skill-evaluator';
export { SelfImprovingEngine } from './self-improving-engine';
export type { SelfImprovingStatus, SelfImprovingSkillStatus } from './self-improving-engine';
export { handleSelfImprovingAction } from './self-improving-actions';
export type { SelfImprovingActionContext, SelfImprovingActionResult } from './self-improving-actions';
