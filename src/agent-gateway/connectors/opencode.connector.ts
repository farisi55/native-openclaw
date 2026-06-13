import {
  CodingAgent,
  isOpenCodeEnabledForMode,
} from '../../self-healing/coding-agent';
import { createLogger } from '../../utils/logger';
import type {
  AgentConnector,
  AgentExecutionResult,
  AgentTask,
} from '../agent-gateway.types';
import { codingContext } from './coding-context';

const logger = createLogger('agent:opencode');

function envBool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export class OpenCodeConnector implements AgentConnector {
  readonly id = 'opencode';
  readonly displayName = 'OpenCode Connector';
  readonly capabilities = [
    'coding.patch',
    'coding.review',
    'coding.refactor',
    'coding.test',
  ] as const;
  readonly riskLevel = 'warning' as const;

  constructor(private readonly codingAgent = new CodingAgent()) {}

  isEnabled(): boolean {
    return envBool(
      'AGENT_OPENCODE_ENABLED',
      envBool('OPENCODE_AGENT_ENABLED', false)
    );
  }

  canHandle(task: AgentTask): boolean {
    if (task.capability !== 'coding.patch') return false;
    try {
      return isOpenCodeEnabledForMode(codingContext(task).mode);
    } catch {
      return false;
    }
  }

  async execute(task: AgentTask): Promise<AgentExecutionResult> {
    const context = codingContext(task);
    const common = {
      userInput: task.userInput,
      analysis: context.analysis,
      patchPlan: context.patchPlan,
      ...(context.previousQa ? { previousQa: context.previousQa } : {}),
      patchApplier: context.patchApplier,
      ...(context.runId ? { runId: context.runId } : {}),
      ...(context.loop ? { loop: context.loop } : {}),
      openCodeState: context.openCodeState,
      executionState: context.executionState,
      executionMode: 'opencode-only' as const,
    };
    const changedFiles = context.mode === 'self-healing'
      ? await this.codingAgent.applyBugFix({
          ...common,
          analysis: context.analysis as Extract<typeof context.analysis, { likelyCause: string }>,
          ...(context.errorLog ? { errorLog: context.errorLog } : {}),
        })
      : await this.codingAgent.applyUpgrade({
          ...common,
          analysis: context.analysis as Extract<typeof context.analysis, { missingCapability: string }>,
        });

    if (changedFiles.length === 0) {
      const state = context.openCodeState;
      const code = state.unavailable
        ? 'OPENCODE_UNAVAILABLE'
        : state.lastErrorType
        ? state.lastErrorType.toUpperCase().replace(/-/g, '_')
        : state.lastError
        ? 'OPENCODE_FAILED'
        : 'NO_DETECTABLE_CHANGES';
      const message = state.lastError ??
        'OpenCode completed but did not produce detectable file changes.';
      logger.warn('no detectable changes', {
        taskId: task.id,
        errorCode: code,
      });
      return {
        ok: false,
        agentId: this.id,
        capability: task.capability,
        summary: message,
        error: { code, message },
        metadata: { openCodeState: { ...state } },
      };
    }

    return {
      ok: true,
      agentId: this.id,
      capability: task.capability,
      summary: `OpenCode changed ${changedFiles.length} file(s).`,
      changedFiles,
      metadata: { openCodeState: { ...context.openCodeState } },
    };
  }
}
