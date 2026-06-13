import type { IProvider } from '../../types/provider';
import { CodingAgent } from '../../self-healing/coding-agent';
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
  readonly capabilities = ['coding.patch'] as const;
  readonly riskLevel = 'warning' as const;
  private readonly codingAgent: CodingAgent;

  constructor(
    private readonly provider?: IProvider,
    model = 'default',
    temperature = 0.1,
    redact = true
  ) {
    this.codingAgent = new CodingAgent(provider, model, temperature, redact);
  }

  isEnabled(): boolean {
    return Boolean(this.provider) && envBool('AGENT_INTERNAL_CODING_ENABLED', true);
  }

  canHandle(task: AgentTask): boolean {
    return task.capability === 'coding.patch' && this.isEnabled();
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
      executionMode: 'internal-only' as const,
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
}
