import type { IProvider } from '../../types/provider';
import { CodingAgent } from '../../self-healing/coding-agent';
import { redactSecrets } from '../../self-healing/log-redactor';
import { createMessage, extractText } from '../../types/message';
import { createLogger } from '../../utils/logger';
import type {
  AgentConnector,
  AgentExecutionResult,
  AgentTask,
} from '../agent-gateway.types';
import { codingContext } from './coding-context';

const logger = createLogger('agent:internal-coding');

function envBool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export class InternalCodingConnector implements AgentConnector {
  readonly id = 'internal-coding';
  readonly displayName = 'Internal CodingAgent';
  readonly capabilities = [
    'coding.patch',
    'coding.review',
    'coding.refactor',
    'coding.test',
  ] as const;
  readonly riskLevel = 'warning' as const;
  readonly priority = 20;
  private readonly codingAgent: CodingAgent;

  constructor(
    private readonly provider?: IProvider,
    private readonly model = 'default',
    private readonly temperature = 0.1,
    private readonly redact = true
  ) {
    this.codingAgent = new CodingAgent(provider, model, temperature, redact);
  }

  isEnabled(): boolean {
    return Boolean(this.provider) && envBool('AGENT_INTERNAL_CODING_ENABLED', true);
  }

  canHandle(task: AgentTask): boolean {
    if (!this.isEnabled()) return false;
    if (
      task.capability === 'coding.review' ||
      task.capability === 'coding.test'
    ) {
      return true;
    }
    if (
      task.capability !== 'coding.patch' &&
      task.capability !== 'coding.refactor'
    ) {
      return false;
    }
    try {
      codingContext(task);
      return true;
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
      executionMode: 'internal-only' as const,
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
      return {
        ok: false,
        agentId: this.id,
        capability: task.capability,
        summary: 'Internal CodingAgent did not produce a valid patch.',
        error: {
          code: 'NO_DETECTABLE_CHANGES',
          message: 'Internal CodingAgent did not produce detectable file changes.',
        },
        metadata: {
          providerId: context.executionState.providerId ?? this.provider?.id,
          model: context.executionState.model,
          providerFallbackUsed: context.executionState.providerFallbackUsed ?? false,
        },
      };
    }

    logger.info('internal patch produced', {
      taskId: task.id,
      changedFiles,
      providerId: context.executionState.providerId ?? this.provider?.id,
      model: context.executionState.model,
      providerFallbackUsed: context.executionState.providerFallbackUsed ?? false,
    });
    return {
      ok: true,
      agentId: this.id,
      capability: task.capability,
      summary: `Internal CodingAgent changed ${changedFiles.length} file(s).`,
      changedFiles,
      metadata: {
        providerId: context.executionState.providerId ?? this.provider?.id,
        model: context.executionState.model,
        providerFallbackUsed: context.executionState.providerFallbackUsed ?? false,
      },
    };
  }

  private async executeReadOnly(
    task: AgentTask,
    signal?: AbortSignal
  ): Promise<AgentExecutionResult> {
    if (!this.provider) {
      return {
        ok: false,
        agentId: this.id,
        capability: task.capability,
        summary: 'Internal CodingAgent provider is unavailable.',
        error: {
          code: 'INTERNAL_PROVIDER_UNAVAILABLE',
          message: 'Internal CodingAgent provider is unavailable.',
        },
      };
    }

    const action = task.capability === 'coding.review'
      ? 'Review the requested code or change. Report concrete findings, risks, and recommended fixes.'
      : 'Analyze the requested test task. Report the test result when evidence is available, otherwise provide a precise test plan and state that execution was not performed.';
    const prompt = [
      action,
      'Keep the response concise and do not claim files or commands changed unless they actually changed.',
      `Task: ${task.userInput}`,
    ].join('\n\n');

    try {
      const response = await this.provider.chat({
        model: this.model,
        messages: [
          createMessage({
            role: 'user',
            content: redactSecrets(prompt, this.redact),
          }),
        ],
        temperature: this.temperature,
        ...(signal ? { signal } : {}),
      });
      if (signal?.aborted) return this.aborted(task);
      const output = extractText(response.message.content).trim();
      if (!output) {
        return {
          ok: false,
          agentId: this.id,
          capability: task.capability,
          summary: 'Internal CodingAgent returned an empty result.',
          error: {
            code: 'EMPTY_AGENT_RESULT',
            message: 'Internal CodingAgent returned an empty result.',
          },
        };
      }
      return {
        ok: true,
        agentId: this.id,
        capability: task.capability,
        summary: task.capability === 'coding.review'
          ? 'Internal code review completed.'
          : 'Internal test analysis completed.',
        output,
        ...(task.capability === 'coding.test'
          ? {
              qa: [{
                command: 'internal test analysis',
                exitCode: 0,
                skipped: true,
                reason: 'Fallback provider produced test analysis; it did not execute a local command.',
              }],
            }
          : {}),
        metadata: {
          providerId: this.provider.id,
          model: response.model,
          latencyMs: response.latencyMs,
        },
      };
    } catch (error) {
      if (signal?.aborted) return this.aborted(task);
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('internal read-only task failed', {
        taskId: task.id,
        capability: task.capability,
        error: message,
      });
      return {
        ok: false,
        agentId: this.id,
        capability: task.capability,
        summary: 'Internal CodingAgent failed.',
        error: {
          code: 'INTERNAL_CODING_FAILED',
          message,
        },
      };
    }
  }

  private aborted(task: AgentTask): AgentExecutionResult {
    return {
      ok: false,
      agentId: this.id,
      capability: task.capability,
      summary: 'Internal CodingAgent execution was aborted.',
      error: {
        code: 'AGENT_ABORTED',
        message: 'Internal CodingAgent execution was aborted.',
      },
    };
  }
}
