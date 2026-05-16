import type { IProvider } from '../types/provider';
import type { McpManager } from '../mcp';
import type { ToolRegistry } from '../tools/tool-registry';
import type { WorkspaceManager } from '../workspace';

export interface WorkflowEmailConfig {
  sendEmail: boolean;
  subject?: string;
  recipient?: string;
  sender?: string;
}

export interface WorkflowDefinition {
  title: string;
  role: string;
  objective: string;
  topic: string;
  dataRequirements: string[];
  toolsToUse: string[];
  analysisRequirements: string[];
  outputRequirements: string[];
  email: WorkflowEmailConfig;
  safetyRules: string[];
  rawMarkdown: string;
}

export type WorkflowStepType =
  | 'search'
  | 'scrape'
  | 'analyze'
  | 'chart'
  | 'report'
  | 'email'
  | 'workspace_write';

export interface WorkflowPlanStep {
  id: string;
  type: WorkflowStepType;
  tool: string | null;
  goal: string;
  input: Record<string, unknown>;
}

export interface WorkflowExecutionPlan {
  title: string;
  topic: string;
  steps: WorkflowPlanStep[];
  requiresEmail: boolean;
  requiresChart: boolean;
  missingTools: string[];
}

export interface WorkflowToolCapability {
  name: string;
  source: 'mcp' | 'native';
  server?: string;
  toolName?: string;
  runtimeName: string;
  description: string;
  capabilities: Array<'search' | 'scrape' | 'analyze' | 'chart' | 'email' | 'workspace_write'>;
}

export interface WorkflowToolResult {
  stepId: string;
  type: WorkflowStepType;
  tool: string | null;
  goal: string;
  ok: boolean;
  output: string;
  sources: string[];
  error?: string;
}

export interface WorkflowGeneratedFile {
  path: string;
  type: 'html' | 'json' | 'png';
}

export interface WorkflowEmailStatus {
  attempted: boolean;
  sent: boolean;
  method: 'mcp-brevo' | 'internal-brevo' | 'skipped';
  detail: string;
}

export interface WorkflowRunResult {
  content: string;
  title: string;
  topic: string;
  plan: WorkflowExecutionPlan;
  toolsUsed: string[];
  sources: string[];
  generatedFiles: WorkflowGeneratedFile[];
  emailStatus: WorkflowEmailStatus;
  errors: string[];
  missingCapabilities: string[];
  rawResults: WorkflowToolResult[];
}

export interface WorkflowRunnerDeps {
  toolRegistry: ToolRegistry;
  mcpManager?: McpManager;
  workspace?: WorkspaceManager;
  provider?: IProvider;
  model?: string;
  now?: Date;
}
