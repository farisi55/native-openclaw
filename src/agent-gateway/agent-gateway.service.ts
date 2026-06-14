import { createLogger } from '../utils/logger';
import { AgentGatewayExecutor } from './agent-gateway.executor';
import { capabilityForIntent } from './agent-gateway.router';
import {
  createAgentTaskId,
  type AgentCapability,
  type AgentExecutionResult,
  type AgentTask,
  type AgentTaskConstraints,
  type AgentTaskSource,
} from './agent-gateway.types';

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

export class AgentGatewayService {
  constructor(readonly executor: AgentGatewayExecutor) {}

  resolveCapability(intent: string, userInput: string): AgentCapability | null {
    return capabilityForIntent(intent, userInput);
  }

  async execute(task: AgentTask): Promise<AgentExecutionResult> {
    return this.executor.execute(task);
  }

  async tryExecute(
    request: AgentGatewayRequest
  ): Promise<AgentExecutionResult | null> {
    const capability =
      request.capability ??
      this.resolveCapability(request.intent, request.userInput);
    if (!capability) return null;

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
