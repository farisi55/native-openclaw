export type HealingRunType = 'self-healing' | 'self-upgrade';
export type HealingRunStatus = 'running' | 'passed' | 'failed' | 'rolled_back' | 'aborted';
export type HealingLoopStatus = 'passed' | 'failed' | 'dependency_installed' | 'patched';
export type FileChangeType = 'created' | 'updated' | 'deleted';

export interface FileDiffSummary {
  path: string;
  changeType: FileChangeType;
  additions: number;
  deletions: number;
  beforeSize: number;
  afterSize: number;
  diffText: string;
  truncated: boolean;
}

export interface HealingAgentFailure {
  agentId: string;
  code?: string;
  message?: string;
}

export interface HealingValidationResult {
  ok: boolean;
  warnings: string[];
  errors: string[];
}

export interface HealingProviderFailure {
  providerId: string;
  model: string;
  errorCode?: string;
  errorMessage?: string;
}

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
  restartRequired?: boolean;
  restartScheduled?: boolean;
  restartReason?: string;
  fileDiffs?: FileDiffSummary[];
  openCodeAttempted?: boolean;
  openCodeAttempts?: number;
  openCodeFallbackUsed?: boolean;
  opencodeUnavailable?: boolean;
  opencodeUnavailableReason?: string;
  opencodeError?: string;
  opencodeErrorType?: string;
  opencodeSuggestion?: string;
  agentUsed?: string;
  agentFallbackPath?: string[];
  providerUsed?: string;
  providerModel?: string;
  providerFallbackUsed?: boolean;
  providerFallbackPath?: string[];
  providerFailures?: HealingProviderFailure[];
  agentWarnings?: string[];
  agentFailedAgents?: HealingAgentFailure[];
  agentValidation?: HealingValidationResult;
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
  fileDiffs?: FileDiffSummary[];
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
  autoRestart: boolean;
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
