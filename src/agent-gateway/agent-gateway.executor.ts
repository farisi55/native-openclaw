import { createLogger } from '../utils/logger';
import type {
  AgentAttempt,
  AgentConnector,
  AgentExecutionResult,
  AgentFailedAgent,
  AgentGatewayConfig,
  AgentResultValidation,
  AgentTask,
} from './agent-gateway.types';
import { AgentGatewayPolicy } from './agent-gateway.policy';
import { AgentGatewayRegistry } from './agent-gateway.registry';
import { AgentGatewayRouter } from './agent-gateway.router';
import { AgentGatewayValidator } from './agent-gateway.validator';

const logger = createLogger('agent-gateway:executor');

const DEFAULT_CONFIG: AgentGatewayConfig = {
  enabled: true,
  maxDelegationDepth: 1,
  defaultTimeoutMs: 900_000,
  maxFallbacks: 2,
  validateResults: true,
};

async function executeWithTimeout(
  connector: AgentConnector,
  task: AgentTask,
  timeoutMs: number
): Promise<AgentExecutionResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;

  return new Promise((resolve) => {
    const finish = (result: AgentExecutionResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    timer = setTimeout(() => {
      controller.abort();
      logger.warn('connector timeout occurred', {
        taskId: task.id,
        capability: task.capability,
        agentId: connector.id,
        timeoutMs,
      });
      finish({
        ok: false,
        agentId: connector.id,
        capability: task.capability,
        summary: `Agent execution timed out after ${timeoutMs}ms.`,
        error: {
          code: 'AGENT_TIMEOUT',
          message: `Agent execution timed out after ${timeoutMs}ms.`,
        },
      });
    }, timeoutMs);

    Promise.resolve()
      .then(() => connector.execute(task, controller.signal))
      .then(finish)
      .catch((error: unknown) => {
        finish({
          ok: false,
          agentId: connector.id,
          capability: task.capability,
          summary: `${connector.id} failed.`,
          error: {
            code: 'AGENT_EXECUTION_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
  });
}

function validationErrorCode(
  task: AgentTask,
  validation: AgentResultValidation
): string {
  if (validation.errors.some((error) => error.startsWith('NO_DETECTABLE_CHANGES'))) {
    return 'NO_DETECTABLE_CHANGES';
  }
  if (
    validation.errors.some((error) =>
      /forbidden path|outside allowed paths|dependency manifest|path escapes/i.test(error)
    )
  ) {
    return 'POLICY_VIOLATION';
  }
  if (task.capability.startsWith('mcp.')) return 'MCP_RESULT_INVALID';
  return 'AGENT_RESULT_INVALID';
}

function failedAgents(attempts: AgentAttempt[]): AgentFailedAgent[] {
  return attempts
    .filter((attempt) => !attempt.ok)
    .map((attempt) => ({
      agentId: attempt.agentId,
      ...(attempt.errorCode ? { code: attempt.errorCode } : {}),
      ...(attempt.errorMessage ? { message: attempt.errorMessage } : {}),
    }));
}

export class AgentGatewayExecutor {
  readonly registry: AgentGatewayRegistry;
  private readonly router: AgentGatewayRouter;
  private readonly policy: AgentGatewayPolicy;
  private readonly validator: AgentGatewayValidator;
  private readonly config: AgentGatewayConfig;

  constructor(input: {
    registry?: AgentGatewayRegistry;
    router?: AgentGatewayRouter;
    policy?: AgentGatewayPolicy;
    validator?: AgentGatewayValidator;
    config?: Partial<AgentGatewayConfig>;
  } = {}) {
    this.registry = input.registry ?? new AgentGatewayRegistry();
    this.router = input.router ?? new AgentGatewayRouter();
    this.policy = input.policy ?? new AgentGatewayPolicy();
    this.validator = input.validator ?? new AgentGatewayValidator(this.policy);
    this.config = { ...DEFAULT_CONFIG, ...input.config };
  }

  async execute(task: AgentTask): Promise<AgentExecutionResult> {
    if (!this.config.enabled) {
      return this.failure(
        task,
        'AGENT_GATEWAY_DISABLED',
        'Agent Gateway is disabled. Set AGENT_GATEWAY_ENABLED=true.'
      );
    }

    const delegationDepth = Number(task.context?.['delegationDepth'] ?? 0);
    if (
      Number.isFinite(delegationDepth) &&
      delegationDepth >= this.config.maxDelegationDepth
    ) {
      return this.failure(
        task,
        'AGENT_DELEGATION_LIMIT',
        `Agent delegation depth reached the configured maximum of ${this.config.maxDelegationDepth}.`
      );
    }

    try {
      this.policy.assertTask(task);
    } catch (error) {
      return this.failure(
        task,
        'AGENT_POLICY_REJECTED',
        error instanceof Error ? error.message : String(error)
      );
    }

    const connectors = this.router
      .route(task, this.registry)
      .slice(0, Math.max(1, this.config.maxFallbacks + 1));
    if (connectors.length === 0) {
      return this.failure(
        task,
        'NO_AGENT_CONNECTOR',
        `No enabled connector can handle ${task.capability}.`
      );
    }

    const attempts: AgentAttempt[] = [];
    let lastValidation: AgentResultValidation | undefined;

    for (let index = 0; index < connectors.length; index += 1) {
      const connector = connectors[index]!;
      logger.info('selected connector', {
        taskId: task.id,
        capability: task.capability,
        agentId: connector.id,
        fallback: index > 0,
      });

      const timeoutMs = Math.max(
        1,
        task.constraints?.maxRuntimeMs ?? this.config.defaultTimeoutMs
      );
      const rawResult = await executeWithTimeout(connector, task, timeoutMs);
      const validation = this.config.validateResults
        ? await this.validator.validate(task, rawResult)
        : {
            ok: rawResult.ok,
            warnings: ['Agent result validation is disabled.'],
            errors: rawResult.ok ? [] : [rawResult.error?.message ?? rawResult.summary],
          };
      lastValidation = validation;

      let result = { ...rawResult, validation };
      if (rawResult.ok && !validation.ok) {
        const code = validationErrorCode(task, validation);
        const message = validation.errors.join('; ');
        const rollbackFiles = task.context?.['rollbackFiles'];
        if (typeof rollbackFiles === 'function' && rawResult.changedFiles?.length) {
          await Promise.resolve(rollbackFiles(rawResult.changedFiles));
        }
        result = {
          ...rawResult,
          ok: false,
          summary: message,
          validation,
          error: { code, message },
        };
      }

      attempts.push({
        agentId: connector.id,
        ok: result.ok,
        ...(result.error?.code === 'AGENT_TIMEOUT' ? { timedOut: true } : {}),
        ...(result.error?.code ? { errorCode: result.error.code } : {}),
        ...(result.error?.message ? { errorMessage: result.error.message } : {}),
      });

      if (result.ok) {
        return this.withExecutionMetadata(result, attempts);
      }

      const nextConnector = connectors[index + 1];
      if (nextConnector) {
        logger.warn('fallback triggered', {
          taskId: task.id,
          capability: task.capability,
          failedAgent: connector.id,
          errorCode: result.error?.code,
          nextConnector: nextConnector.id,
        });
      }
    }

    const last = attempts[attempts.length - 1];
    const chain = attempts.map((attempt) => attempt.agentId);
    return {
      ok: false,
      agentId: last?.agentId ?? 'agent-gateway',
      selectedAgent: last?.agentId ?? 'agent-gateway',
      capability: task.capability,
      summary: `All connectors failed for ${task.capability}.`,
      fallbackUsed: attempts.length > 1,
      fallbackChain: chain,
      failedAgents: failedAgents(attempts),
      ...(lastValidation ? { validation: lastValidation } : {}),
      error: {
        code: last?.errorCode ?? 'ALL_CONNECTORS_FAILED',
        message: last?.errorMessage ?? `All connectors failed for ${task.capability}.`,
      },
      metadata: {
        fallbackUsed: attempts.length > 1,
        fallbackPath: chain,
        fallbackChain: chain,
        selectedAgent: last?.agentId ?? 'agent-gateway',
        failedAgents: failedAgents(attempts),
        attempts,
      },
    };
  }

  private withExecutionMetadata(
    result: AgentExecutionResult,
    attempts: AgentAttempt[]
  ): AgentExecutionResult {
    const chain = attempts.map((attempt) => attempt.agentId);
    const failed = failedAgents(attempts);
    logger.info('final selected result', {
      capability: result.capability,
      selectedAgent: result.agentId,
      fallbackChain: chain,
      validationOk: result.validation?.ok,
    });
    return {
      ...result,
      selectedAgent: result.agentId,
      fallbackUsed: attempts.length > 1,
      fallbackChain: chain,
      failedAgents: failed,
      metadata: {
        ...(result.metadata ?? {}),
        fallbackUsed: attempts.length > 1,
        fallbackPath: chain,
        fallbackChain: chain,
        selectedAgent: result.agentId,
        failedAgents: failed,
        attempts,
        warnings: [
          ...attempts
            .filter((attempt) => attempt.errorCode === 'POLICY_VIOLATION')
            .map((attempt) => attempt.errorMessage ?? 'Connector result violated policy.'),
          ...(result.validation?.warnings ?? []),
        ],
      },
    };
  }

  private failure(
    task: AgentTask,
    code: string,
    message: string
  ): AgentExecutionResult {
    return {
      ok: false,
      agentId: 'agent-gateway',
      selectedAgent: 'agent-gateway',
      capability: task.capability,
      summary: message,
      fallbackUsed: false,
      fallbackChain: [],
      failedAgents: [],
      error: { code, message },
    };
  }
}
