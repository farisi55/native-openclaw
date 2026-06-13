import type {
  BugAnalysis,
  PatchPlan,
  QAReport,
  UpgradeAnalysis,
} from '../../self-healing/healing-types';
import type {
  CodingExecutionState,
  OpenCodeFallbackState,
} from '../../self-healing/coding-agent';
import type { PatchApplier } from '../../self-healing/patch-applier';
import type { AgentTask } from '../agent-gateway.types';

export interface CodingConnectorContext {
  mode: 'self-healing' | 'self-upgrade';
  analysis: BugAnalysis | UpgradeAnalysis;
  patchPlan: PatchPlan;
  patchApplier: PatchApplier;
  previousQa?: QAReport;
  errorLog?: string;
  runId?: string;
  loop?: number;
  openCodeState: OpenCodeFallbackState;
  executionState: CodingExecutionState;
}

export function codingContext(task: AgentTask): CodingConnectorContext {
  const context = task.context as Partial<CodingConnectorContext> | undefined;
  if (
    !context ||
    (context.mode !== 'self-healing' && context.mode !== 'self-upgrade') ||
    !context.analysis ||
    !context.patchPlan ||
    !context.patchApplier ||
    !context.openCodeState ||
    !context.executionState
  ) {
    throw new Error('coding.patch task is missing its execution context.');
  }
  return context as CodingConnectorContext;
}
