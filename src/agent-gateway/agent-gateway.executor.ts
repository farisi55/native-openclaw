import { createLogger } from '../utils/logger';
import type {
  AgentAttempt,
  AgentExecutionResult,
  AgentGatewayConfig,
  AgentTask,
} from './agent-gateway.types';
import { AgentGatewayPolicy } from './agent-gateway.policy';
import { AgentGatewayRegistry } from './agent-gateway.registry';
import { AgentGatewayRouter } from './agent-gateway.router';

const logger = createLogger('agent-gateway');

const DEFAULT_CONFIG: AgentGatewayConfig = {
  enabled: true,
  maxDelegationDepth: 1,
  defaultTimeoutMs: 900_000,
};

function withTimeout(
  promise: Promise<AgentExecutionResult>,
  timeoutMs: number,
  task: AgentTask,
  agentId: string
): Promise<AgentExecutionResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        ok: false,
        agentId,
        capability: task.capability,
        summary: `${agentId} timed out.`,
        error: {
          code: 'AGENT_TIMEOUT',
          message: `${agentId} exceeded ${timeoutMs} ms.`,
        },
      });
    }, timeoutMs);
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          agentId,
          capability: task.capability,
          summary: `${agentId} failed.`,
          error: {
            code: 'AGENT_EXECUTION_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
  });
}

export class AgentGatewayExecutor {
  readonly registry: AgentGatewayRegistry;
  private readonly router: AgentGatewayRouter;
  private readonly policy: AgentGatewayPolicy;
  private readonly config: AgentGatewayConfig;

  constructor(input: {
    registry?: AgentGatewayRegistry;
    router?: AgentGatewayRouter;
    policy?: AgentGatewayPolicy;
    config?: Partial<AgentGatewayConfig>;
  } = {}) {
    this.registry = input.registry ?? new AgentGatewayRegistry();
    this.router = input.router ?? new AgentGatewayRouter();
    this.policy = input.policy ?? new AgentGatewayPolicy();
    this.config = { ...DEFAULT_CONFIG, ...input.config };
  }

  async execute(task: AgentTask): Promise<AgentExecutionResult> {
    if (!this.config.enabled) {
      return {
        ok: false,
        agentId: 'agent-gateway',
        capability: task.capability,
        summary: 'Agent Gateway is disabled.',
        error: { code: 'AGENT_GATEWAY_DISABLED', message: 'Set AGENT_GATEWAY_ENABLED=true.' },
      };
    }

    this.policy.assertTask(task);
    const connectors = this.router.route(task, this.registry);
    if (connectors.length === 0) {
      return {
        ok: false,
        agentId: 'agent-gateway',
        capability: task.capability,
        summary: `No enabled connector can handle ${task.capability}.`,
        error: { code: 'NO_AGENT_CONNECTOR', message: `No connector available for ${task.capability}.` },
      };
    }

    const attempts: AgentAttempt[] = [];
    for (const connector of connectors) {
      logger.info('selected connector', {
        taskId: task.id,
        capability: task.capability,
        agentId: connector.id,
        fallback: attempts.length > 0,
      });
      const timeoutMs = task.constraints?.maxRuntimeMs ?? this.config.defaultTimeoutMs;
      const result = await withTimeout(connector.execute(task), timeoutMs, task, connector.id);
      const violations = result.ok ? this.policy.validateResult(task, result) : [];
      if (violations.length > 0) {
        const rollbackFiles = task.context?.['rollbackFiles'];
        if (typeof rollbackFiles === 'function' && result.changedFiles?.length) {
          await Promise.resolve(rollbackFiles(result.changedFiles));
        }
        attempts.push({
          agentId: connector.id,
          ok: false,
          errorCode: 'POLICY_VIOLATION',
          errorMessage: violations.join('; '),
        });
        logger.warn('connector result rejected by policy', {
          taskId: task.id,
          agentId: connector.id,
          violations,
        });
        continue;
      }

      attempts.push({
        agentId: connector.id,
        ok: result.ok,
        ...(result.error?.code ? { errorCode: result.error.code } : {}),
        ...(result.error?.message ? { errorMessage: result.error.message } : {}),
      });
      if (result.ok) {
        return {
          ...result,
          metadata: {
            ...(result.metadata ?? {}),
            fallbackUsed: attempts.length > 1,
            fallbackPath: attempts.map((attempt) => attempt.agentId),
            attempts,
            warnings: attempts
              .filter((attempt) => attempt.errorCode === 'POLICY_VIOLATION')
              .map((attempt) => attempt.errorMessage ?? 'Connector result violated policy.'),
          },
        };
      }

      logger.warn('connector failed; trying fallback', {
        taskId: task.id,
        agentId: connector.id,
        errorCode: result.error?.code,
        nextConnector: connectors[attempts.length]?.id,
      });
    }

    const last = attempts[attempts.length - 1];
    return {
      ok: false,
      agentId: last?.agentId ?? 'agent-gateway',
      capability: task.capability,
      summary: `All connectors failed for ${task.capability}.`,
      error: {
        code: last?.errorCode ?? 'ALL_CONNECTORS_FAILED',
        message: last?.errorMessage ?? `All connectors failed for ${task.capability}.`,
      },
      metadata: {
        fallbackUsed: attempts.length > 1,
        fallbackPath: attempts.map((attempt) => attempt.agentId),
        attempts,
      },
    };
  }
}
