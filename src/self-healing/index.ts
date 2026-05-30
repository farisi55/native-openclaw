export type {
  BugAnalysis,
  CommandRunResult,
  GeneratedFilePatch,
  HealingEngineConfig,
  HealingLoopResult,
  HealingLoopStatus,
  HealingRun,
  HealingRunInput,
  HealingRunStatus,
  HealingRunType,
  PatchPlan,
  QAReport,
  UpgradeAnalysis,
  UpgradeEngineConfig,
  UpgradeRunInput,
} from './healing-types';

export { BugAnalyzerAgent } from './bug-analyzer-agent';
export { CodingAgent } from './coding-agent';
export { DependencyResolver } from './dependency-resolver';
export { DiffGenerator } from './diff-generator';
export type { DiffGeneratorOptions } from './diff-generator';
export { HealingStore } from './healing-store';
export { PatchApplier } from './patch-applier';
export { PatchPlanner } from './patch-planner';
export { QAAgent } from './qa-agent';
export { ReportWriter } from './report-writer';
export { SafetyPolicy } from './safety-policy';
export { SnapshotManager } from './snapshot-manager';
export { SelfHealingEngine } from './self-healing-engine';
export type { SelfHealingEngineDeps } from './self-healing-engine';
export { SelfUpgradeEngine } from './self-upgrade-engine';
export type { SelfUpgradeEngineDeps } from './self-upgrade-engine';
export { TestRunner } from './test-runner';
export { redactSecrets } from './log-redactor';
export { handleSelfHealingAction } from './actions';
export type { SelfHealingActionContext, SelfHealingActionResult } from './actions';
