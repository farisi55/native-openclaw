import type { McpManager } from '../mcp';
import type { ToolRegistry } from '../tools/tool-registry';
import { WorkspaceManager } from '../workspace';
import { loadWorkflowMarkdown, DEFAULT_WORKFLOW_TEMPLATE } from './workflow-loader';
import { parseWorkflowMarkdown } from './workflow-parser';
import { runWorkflowFromDefinition } from './workflow-runner';
import type { WorkflowRunResult } from './workflow-types';

interface GoldWorkflowDeps {
  mcpManager?: McpManager;
  toolRegistry: ToolRegistry;
  workspace?: WorkspaceManager;
  now?: Date;
}

export type GoldReportWorkflowResult = WorkflowRunResult;

const GOLD_REPORT_TRIGGER_RE = /laporan\s+(?:komoditas\s+)?emas\s+harian|laporan\s+komoditas\s+emas|daily\s+gold\s+report|analisis\s+harga\s+emas.*(?:kirim|email)|autonomous\s+commodity\s+analyst|perintah\s+otonom.*emas/i;
const EMAIL_INTENT_RE = /\b(?:email|brevo|send|kirim)\b|perintah\s+otonom|autonomous\s+commodity\s+analyst/i;

export function isGoldReportWorkflowRequest(input: string): boolean {
  return GOLD_REPORT_TRIGGER_RE.test(input);
}

export function shouldEmailGoldReport(input: string): boolean {
  return EMAIL_INTENT_RE.test(input);
}

export async function runGoldReportWorkflow(
  _input: string,
  deps: GoldWorkflowDeps
): Promise<GoldReportWorkflowResult> {
  const workspace = deps.workspace ?? new WorkspaceManager();
  const loaded = await loadWorkflowMarkdown(workspace);
  const workflow = parseWorkflowMarkdown(loaded.markdown || DEFAULT_WORKFLOW_TEMPLATE);
  return runWorkflowFromDefinition(workflow, {
    ...(deps.mcpManager ? { mcpManager: deps.mcpManager } : {}),
    toolRegistry: deps.toolRegistry,
    workspace,
    ...(deps.now ? { now: deps.now } : {}),
  });
}
