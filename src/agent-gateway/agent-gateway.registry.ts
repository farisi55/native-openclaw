import { createLogger } from '../utils/logger';
import type { AgentCapability, AgentConnector, AgentTask } from './agent-gateway.types';

const logger = createLogger('agent-gateway:registry');

export class AgentGatewayRegistry {
  private readonly connectors = new Map<string, AgentConnector>();

  register(connector: AgentConnector): void {
    this.connectors.set(connector.id, connector);
    logger.debug('connector registered', {
      agentId: connector.id,
      capabilities: connector.capabilities,
      enabled: connector.isEnabled(),
    });
  }

  get(id: string): AgentConnector | undefined {
    return this.connectors.get(id);
  }

  list(): AgentConnector[] {
    return [...this.connectors.values()];
  }

  enabledFor(capability: AgentCapability, task: AgentTask): AgentConnector[] {
    return this.list().filter((connector) =>
      connector.isEnabled() &&
      connector.capabilities.includes(capability) &&
      connector.canHandle(task)
    );
  }
}
