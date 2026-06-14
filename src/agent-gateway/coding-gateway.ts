import type { IProvider } from '../types/provider';
import type {
  ApplyBugFixInput,
  ApplyUpgradeInput,
  CodingPatchAgent,
} from '../self-healing/coding-agent';
import { AgentGatewayExecutor } from './agent-gateway.executor';
import { AgentGatewayRegistry } from './agent-gateway.registry';
import { createAgentTaskId, type AgentExecutionResult } from './agent-gateway.types';
import { InternalCodingConnector } from './connectors/internal-coding.connector';
import { OpenCodeConnector } from './connectors/opencode.connector';

function envBool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function envInt(key: string, fallback: number): number {
  const value = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export class GatewayCodingAgent implements CodingPatchAgent {
  private readonly gateway: AgentGatewayExecutor;

  constructor(input: {
    provider?: IProvider;
    model?: string;
    temperature?: number;
    redact?: boolean;
    gateway?: AgentGatewayExecutor;
  } = {}) {
    if (input.gateway) {
      this.gateway = input.gateway;
      return;
    }
    const registry = new AgentGatewayRegistry();
    registry.register(new OpenCodeConnector());
    registry.register(new InternalCodingConnector(
      input.provider,
      input.model ?? 'default',
      input.temperature ?? 0.1,
      input.redact ?? true
    ));
    this.gateway = new AgentGatewayExecutor({
      registry,
      config: {
        enabled: envBool('AGENT_GATEWAY_ENABLED', true),
        maxDelegationDepth: envInt('AGENT_GATEWAY_MAX_DELEGATION_DEPTH', 1),
        defaultTimeoutMs: envInt('AGENT_GATEWAY_DEFAULT_TIMEOUT_MS', 900_000),
        maxFallbacks: envInt('AGENT_GATEWAY_MAX_FALLBACKS', 2),
        validateResults: envBool('AGENT_GATEWAY_VALIDATE_RESULTS', true),
      },
    });
  }

  async applyBugFix(input: ApplyBugFixInput): Promise<string[]> {
    return this.execute('self-healing', input);
  }

  async applyUpgrade(input: ApplyUpgradeInput): Promise<string[]> {
    return this.execute('self-upgrade', input);
  }

  private async execute(
    mode: 'self-healing' | 'self-upgrade',
    input: ApplyBugFixInput | ApplyUpgradeInput
  ): Promise<string[]> {
    const openCodeState = input.openCodeState ?? {};
    const executionState = input.executionState ?? {};
    const allowPackageJsonChanges = Boolean(
      input.previousQa?.nextAction === 'install_dependency' &&
      input.previousQa.missingPackages.length > 0
    );
    const result = await this.gateway.execute({
      id: createAgentTaskId(mode === 'self-healing' ? 'heal' : 'upgrade'),
      intent: mode,
      capability: 'coding.patch',
      userInput: input.userInput,
      cwd: input.patchApplier.root,
      context: {
        mode,
        analysis: input.analysis,
        patchPlan: input.patchPlan,
        patchApplier: input.patchApplier,
        ...(input.previousQa ? { previousQa: input.previousQa } : {}),
        ...('errorLog' in input && input.errorLog ? { errorLog: input.errorLog } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.loop ? { loop: input.loop } : {}),
        openCodeState,
        executionState,
        rollbackFiles: (files: string[]) => input.patchApplier.rollbackFiles(files),
      },
      constraints: {
        allowedPaths: [
          'src/',
          'test/',
          'tests/',
          'docs/',
          'README.md',
          ...input.patchPlan.files.map((file) => file.path),
        ],
        forbiddenPaths: ['.env', '.env.*', 'node_modules/', 'dist/', '.git/'],
        maxRuntimeMs: envInt('AGENT_GATEWAY_DEFAULT_TIMEOUT_MS', 900_000),
        allowPackageJsonChanges,
      },
    });
    this.captureGatewayResult(openCodeState, result);
    return result.ok ? (result.changedFiles ?? []) : [];
  }

  private captureGatewayResult(
    state: NonNullable<ApplyBugFixInput['openCodeState']>,
    result: AgentExecutionResult
  ): void {
    state.gatewayAgentId = result.agentId;
    const fallbackPath = result.metadata?.['fallbackPath'];
    if (Array.isArray(fallbackPath) && fallbackPath.every((item) => typeof item === 'string')) {
      state.gatewayFallbackPath = [...fallbackPath];
    }
    const warnings = result.metadata?.['warnings'];
    if (Array.isArray(warnings) && warnings.every((item) => typeof item === 'string')) {
      state.gatewayWarnings = [...warnings];
    }
    if (result.agentId === 'internal-coding') {
      state.fallbackUsed = Boolean(result.metadata?.['fallbackUsed']);
      if (typeof result.metadata?.['providerId'] === 'string') {
        state.providerId = result.metadata['providerId'];
      }
      if (typeof result.metadata?.['model'] === 'string') {
        state.providerModel = result.metadata['model'];
      }
      if (typeof result.metadata?.['providerFallbackUsed'] === 'boolean') {
        state.providerFallbackUsed = result.metadata['providerFallbackUsed'];
      }
    }
  }
}
