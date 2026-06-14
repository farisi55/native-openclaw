import {
  CodingAgent,
  isOpenCodeEnabledForMode,
} from '../../self-healing/coding-agent';
import { runOpenCodeAgent } from '../../tools/opencode-agent';
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
  readonly priority = 10;

  constructor(
    private readonly codingAgent = new CodingAgent(),
    private readonly openCodeRunner: typeof runOpenCodeAgent = runOpenCodeAgent
  ) {}

  isEnabled(): boolean {
    return envBool(
      'AGENT_OPENCODE_ENABLED',
      envBool('OPENCODE_AGENT_ENABLED', false)
    );
  }

  canHandle(task: AgentTask): boolean {
    if (
      task.capability === 'coding.review' ||
      task.capability === 'coding.test'
    ) {
      return this.isEnabled();
    }
    if (
      task.capability !== 'coding.patch' &&
      task.capability !== 'coding.refactor'
    ) {
      return false;
    }
    try {
      return isOpenCodeEnabledForMode(codingContext(task).mode);
    } catch {
      return false;
    }
  }

  async execute(task: AgentTask, signal?: AbortSignal): Promise<AgentExecutionResult> {
    if (signal?.aborted) return this.aborted(task);
    if (
      task.capability === 'coding.review' ||
      task.capability === 'coding.test'
    ) {
      return this.executeReadOnly(task, signal);
    }

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
      ...(task.constraints?.maxRuntimeMs
        ? { timeoutMs: task.constraints.maxRuntimeMs }
        : {}),
      ...(signal ? { signal } : {}),
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

    if (signal?.aborted) return this.aborted(task);
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

  private async executeReadOnly(
    task: AgentTask,
    signal?: AbortSignal
  ): Promise<AgentExecutionResult> {
    const mode = task.capability === 'coding.review' ? 'review' : 'test';
    const result = await this.openCodeRunner({
      task: task.userInput,
      ...(task.cwd ? { cwd: task.cwd } : {}),
      ...(task.constraints?.maxRuntimeMs
        ? { timeoutMs: task.constraints.maxRuntimeMs }
        : {}),
      mode,
      ...(signal ? { signal } : {}),
    });

    if (signal?.aborted) return this.aborted(task);
    if (!result.ok) {
      const code = result.timedOut
        ? 'AGENT_TIMEOUT'
        : result.errorType
        ? result.errorType.toUpperCase().replace(/-/g, '_')
        : 'OPENCODE_FAILED';
      return {
        ok: false,
        agentId: this.id,
        capability: task.capability,
        summary: result.summary,
        error: {
          code,
          message: result.error ?? result.summary,
        },
        metadata: {
          durationMs: result.durationMs,
          exitCode: result.exitCode,
        },
      };
    }

    const output = result.stdout.trim() || result.summary;
    return {
      ok: true,
      agentId: this.id,
      capability: task.capability,
      summary: result.summary,
      output,
      ...(task.capability === 'coding.test'
        ? {
            qa: [{
              command: 'opencode test',
              exitCode: result.exitCode ?? 0,
              stdoutPreview: result.stdout.slice(0, 1000),
              stderrPreview: result.stderr.slice(0, 1000),
            }],
          }
        : {}),
      metadata: {
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        truncated: result.truncated,
      },
    };
  }

  private aborted(task: AgentTask): AgentExecutionResult {
    return {
      ok: false,
      agentId: this.id,
      capability: task.capability,
      summary: 'OpenCode execution was aborted.',
      error: {
        code: 'AGENT_ABORTED',
        message: 'OpenCode execution was aborted.',
      },
    };
  }
}
