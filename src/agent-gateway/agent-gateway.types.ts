export type AgentCapability =
  | 'coding.patch'
  | 'coding.review'
  | 'coding.refactor'
  | 'coding.test'
  | 'mcp.config'
  | 'mcp.server.list'
  | 'mcp.server.start'
  | 'mcp.server.stop';

export type AgentRiskLevel = 'safe' | 'warning' | 'dangerous';

export type AgentTaskSource =
  | 'cli'
  | 'web'
  | 'scheduler'
  | 'self-healing'
  | 'self-upgrade'
  | 'system';

export interface AgentTaskConstraints {
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  maxRuntimeMs?: number;
  requireApproval?: boolean;
  allowPackageJsonChanges?: boolean;
  dryRun?: boolean;
}

export interface AgentTask {
  id: string;
  intent: string;
  capability: AgentCapability;
  userInput: string;
  cwd?: string;
  source?: AgentTaskSource;
  context?: Record<string, unknown>;
  constraints?: AgentTaskConstraints;
}

export interface AgentQaResult {
  command: string;
  exitCode: number;
  skipped?: boolean;
  reason?: string;
  stdoutPreview?: string;
  stderrPreview?: string;
}

export interface AgentResultValidation {
  ok: boolean;
  warnings: string[];
  errors: string[];
}

export interface AgentExecutionError {
  code?: string;
  message: string;
  details?: unknown;
}

export interface AgentFailedAgent {
  agentId: string;
  code?: string;
  message?: string;
}

export interface AgentExecutionResult {
  ok: boolean;
  agentId: string;
  capability: AgentCapability;
  summary: string;
  output?: string;
  changedFiles?: string[];
  artifacts?: string[];
  fallbackUsed?: boolean;
  fallbackChain?: string[];
  selectedAgent?: string;
  failedAgents?: AgentFailedAgent[];
  validation?: AgentResultValidation;
  qa?: AgentQaResult[];
  error?: AgentExecutionError;
  metadata?: Record<string, unknown>;
}

export interface AgentConnector {
  id: string;
  displayName: string;
  capabilities: readonly AgentCapability[];
  riskLevel: AgentRiskLevel;
  priority: number;
  isEnabled(): boolean;
  canHandle(task: AgentTask): boolean;
  execute(task: AgentTask, signal?: AbortSignal): Promise<AgentExecutionResult>;
}

export interface AgentGatewayConfig {
  enabled: boolean;
  maxDelegationDepth: number;
  defaultTimeoutMs: number;
  maxFallbacks: number;
  validateResults: boolean;
}

export interface AgentAttempt {
  agentId: string;
  ok: boolean;
  timedOut?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export function createAgentTaskId(prefix = 'agent-task'): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(16).slice(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}
