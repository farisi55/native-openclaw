import { createLogger } from '../utils/logger';
import type { AgentCapability, AgentConnector, AgentTask } from './agent-gateway.types';

const logger = createLogger('agent-gateway:registry');

export class AgentGatewayRegistry {
  private readonly connectors = new Map<string, AgentConnector>();

  constructor(connectors: AgentConnector[] = []) {
    for (const connector of connectors) this.register(connector);
  }

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
    return [...this.connectors.values()].sort((left, right) =>
      left.priority - right.priority || left.id.localeCompare(right.id)
    );
  }

  enabledFor(capability: AgentCapability, task: AgentTask): AgentConnector[] {
    const selected: AgentConnector[] = [];
    for (const connector of this.list()) {
      if (!connector.capabilities.includes(capability)) continue;
      if (!connector.isEnabled()) {
        logger.debug('connector skipped', {
          taskId: task.id,
          agentId: connector.id,
          capability,
          reason: 'disabled',
        });
        continue;
      }
      if (!connector.canHandle(task)) {
        logger.debug('connector skipped', {
          taskId: task.id,
          agentId: connector.id,
          capability,
          reason: 'cannot-handle',
        });
        continue;
      }
      selected.push(connector);
    }
    return selected;
  }
}
