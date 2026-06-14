import { createLogger } from '../utils/logger';
import { AgentGatewayExecutor } from './agent-gateway.executor';
import { capabilityForIntent } from './agent-gateway.router';
import {
  createAgentTaskId,
  type AgentCapability,
  type AgentExecutionResult,
  type AgentStatus,
  type AgentTask,
  type AgentTaskConstraints,
  type AgentTaskSource,
} from './agent-gateway.types';
import { externalAgentEnablementMessage } from './external-agents';

const logger = createLogger('agent-gateway');

export interface AgentGatewayRequest {
  intent: string;
  userInput: string;
  capability?: AgentCapability;
  cwd?: string;
  source?: AgentTaskSource;
  context?: Record<string, unknown>;
  constraints?: AgentTaskConstraints;
}

export function formatAgentStatuses(statuses: AgentStatus[]): string {
  const lines = [
    'Agent Gateway',
    '------------------------------------------------------------',
  ];
  for (const status of statuses) {
    const state = status.enabled
      ? status.health
        ? status.health.ok
          ? 'healthy'
          : 'unavailable'
        : 'enabled'
      : 'disabled';
    const health = status.health ? ` (${status.health.message})` : '';
    lines.push(
      `${status.id.padEnd(20)} ${state.padEnd(11)} ${status.capabilities.join(',')}${health}`
    );
  }
  return lines.join('\n');
}

export class AgentGatewayService {
  constructor(
    readonly executor: AgentGatewayExecutor,
    private readonly knownAgents: AgentStatus[] = []
  ) {}

  resolveCapability(intent: string, userInput: string): AgentCapability | null {
    return capabilityForIntent(intent, userInput);
  }

  async execute(task: AgentTask): Promise<AgentExecutionResult> {
    return this.executor.execute(task);
  }

  listAgents(): AgentStatus[] {
    const statuses = new Map<string, AgentStatus>();
    for (const known of this.knownAgents) statuses.set(known.id, { ...known });
    for (const connector of this.executor.registry.list()) {
      const existing = statuses.get(connector.id);
      statuses.set(connector.id, {
        id: connector.id,
        displayName: connector.displayName,
        enabled: connector.isEnabled(),
        registered: true,
        capabilities: connector.capabilities,
        riskLevel: connector.riskLevel,
        priority: connector.priority,
        ...(existing?.profile ? { profile: existing.profile } : {}),
      });
    }
    return [...statuses.values()].sort(
      (left, right) =>
        left.priority - right.priority || left.id.localeCompare(right.id)
    );
  }

  async healthAgents(): Promise<AgentStatus[]> {
    const statuses = this.listAgents();
    return Promise.all(
      statuses.map(async (status) => {
        if (!status.enabled || !status.registered) return status;
        const connector = this.executor.registry.get(status.id);
        if (!connector?.healthCheck) {
          return {
            ...status,
            health: {
              ok: true,
              message: 'ready (no external health check required)',
            },
          };
        }
        return {
          ...status,
          health: await connector.healthCheck(),
        };
      })
    );
  }

  async tryExecute(
    request: AgentGatewayRequest
  ): Promise<AgentExecutionResult | null> {
    const capability =
      request.capability ??
      this.resolveCapability(request.intent, request.userInput);
    if (!capability) return null;

    const knownExternal = this.knownAgents.find((agent) =>
      agent.capabilities.includes(capability)
    );
    if (knownExternal && !knownExternal.enabled) {
      const message =
        externalAgentEnablementMessage(capability) ??
        `External agent ${knownExternal.id} is disabled.`;
      return {
        ok: false,
        agentId: knownExternal.id,
        selectedAgent: knownExternal.id,
        capability,
        summary: message,
        fallbackUsed: false,
        fallbackChain: [],
        failedAgents: [],
        error: {
          code: 'EXTERNAL_AGENT_DISABLED',
          message,
        },
      };
    }

    logger.debug('capability selected', {
      intent: request.intent,
      capability,
      source: request.source,
    });
    return this.execute({
      id: createAgentTaskId('agent'),
      intent: request.intent,
      capability,
      userInput: request.userInput,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      ...(request.source ? { source: request.source } : {}),
      ...(request.context ? { context: request.context } : {}),
      ...(request.constraints ? { constraints: request.constraints } : {}),
    });
  }
}
