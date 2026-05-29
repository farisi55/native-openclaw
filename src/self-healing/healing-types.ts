export type HealingRunType = 'self-healing' | 'self-upgrade';
export type HealingRunStatus = 'running' | 'passed' | 'failed' | 'rolled_back' | 'aborted';
export type HealingLoopStatus = 'passed' | 'failed' | 'dependency_installed' | 'patched';

export interface HealingRun {
  id: string;
  type: HealingRunType;
  status: HealingRunStatus;
  userInput: string;
  startedAt: string;
  finishedAt?: string;
  maxLoops: number;
  currentLoop: number;
  workdir: string;
  snapshotId?: string;
  loops: HealingLoopResult[];
  finalSummary?: string;
  error?: string;
  createdBy?: 'cli' | 'api' | 'telegram' | 'system';
}

export interface HealingLoopResult {
  loop: number;
  startedAt: string;
  finishedAt?: string;
  status: HealingLoopStatus;
  analysis?: BugAnalysis | UpgradeAnalysis;
  patchPlan?: PatchPlan;
  changedFiles?: string[];
  commandsRun?: CommandRunResult[];
  qaReport?: QAReport;
  missingPackages?: string[];
  error?: string;
}

export interface BugAnalysis {
  summary: string;
  likelyCause: string;
  affectedFiles: string[];
  fixStrategy: string;
  confidence: number;
}

export interface UpgradeAnalysis {
  summary: string;
  missingCapability: string;
  feasible: boolean;
  targetFiles: string[];
  implementationStrategy: string;
  confidence: number;
}

export interface PatchPlan {
  files: Array<{
    path: string;
    action: 'create' | 'update' | 'delete';
    reason: string;
  }>;
  testStrategy: string;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface QAReport {
  passed: boolean;
  summary: string;
  failedCommand?: string;
  missingPackages: string[];
  errors: string[];
  nextAction: 'done' | 'install_dependency' | 'retry_fix' | 'abort';
  rawLogExcerpt: string;
}

export interface CommandRunResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface HealingEngineConfig {
  enabled: boolean;
  maxLoops: number;
  autoApply: boolean;
  autoInstall: boolean;
  autoRollback: boolean;
  testCommands: string[];
  timeoutMs: number;
  workdir: string;
  runsDir: string;
  dataDir: string;
  redactSecrets: boolean;
  temperature: number;
}

export interface UpgradeEngineConfig extends HealingEngineConfig {
  autoRegister: boolean;
  allowedTargets: string[];
}

export interface HealingRunInput {
  userInput: string;
  source: 'cli' | 'api' | 'telegram' | 'system';
  workdir?: string;
  errorLog?: string;
  targetFiles?: string[];
}

export interface UpgradeRunInput {
  userInput: string;
  source: 'cli' | 'api' | 'telegram' | 'system';
  missingCapability?: string;
}

export interface GeneratedFilePatch {
  path: string;
  action: 'create' | 'update' | 'delete';
  content?: string;
}
