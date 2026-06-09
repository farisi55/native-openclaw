import { isDeepStrictEqual } from 'util';
import { createLogger } from '../utils/logger';
import {
  McpConfigService,
  normalizeMcpServerName,
  validateMcpAgentServerDefinition,
} from './mcp-config.service';
import { parseMcpConfigurationInstruction } from './mcp-agent.intent';
import type {
  ConfigureMcpServerInput,
  ConfigureMcpServerResult,
  McpAgentActionResult,
  McpAgentConfig,
  McpAgentServerDefinition,
} from './mcp-agent.types';

const logger = createLogger('mcp-agent');

export class McpAgentService {
  readonly configService: McpConfigService;

  constructor(private readonly config: McpAgentConfig) {
    this.configService = new McpConfigService(config.projectRoot, config.configPath);
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  async configureServer(input: ConfigureMcpServerInput): Promise<ConfigureMcpServerResult> {
    this.assertEnabled();
    this.assertWritable();
    const serverName = normalizeMcpServerName(input.serverName);
    const definition = this.toDefinition(input);
    const current = await this.configService.read(input.configPath);
    const before = current.config.mcpServers[serverName];

    if (before && isDeepStrictEqual(before, definition)) {
      return {
        ok: true,
        configPath: current.configPath,
        serverName,
        action: 'unchanged',
        before,
        after: definition,
        yamlPreview: current.yaml,
        message: `MCP server "${serverName}" already has the requested configuration.`,
      };
    }
    if (before && input.overwrite === false) {
      throw new Error(`MCP server "${serverName}" already exists and overwrite is disabled.`);
    }

    const next = this.configService.cloneConfig(current.config);
    next.mcpServers[serverName] = definition;
    const written = await this.configService.write(next, input.configPath);
    const action = before ? 'updated' : 'created';
    logger.info('MCP self-configuration saved', {
      action,
      serverName,
      configPath: written.configPath,
    });
    return {
      ok: true,
      configPath: written.configPath,
      serverName,
      action,
      ...(before ? { before } : {}),
      after: definition,
      yamlPreview: written.yaml,
      message: `MCP server "${serverName}" was ${action} in the configuration.`,
    };
  }

  async removeServer(serverNameInput: string, configPath?: string): Promise<McpAgentActionResult> {
    this.assertEnabled();
    this.assertWritable();
    const serverName = normalizeMcpServerName(serverNameInput);
    const current = await this.configService.read(configPath);
    const before = current.config.mcpServers[serverName];
    if (!before) {
      return {
        ok: true,
        configPath: current.configPath,
        serverName,
        action: 'unchanged',
        yamlPreview: current.yaml,
        message: `MCP server "${serverName}" is not configured.`,
      };
    }

    const next = this.configService.cloneConfig(current.config);
    delete next.mcpServers[serverName];
    const written = await this.configService.write(next, configPath);
    logger.info('MCP self-configuration removed server', {
      serverName,
      configPath: written.configPath,
    });
    return {
      ok: true,
      configPath: written.configPath,
      serverName,
      action: 'removed',
      before,
      yamlPreview: written.yaml,
      message: `MCP server "${serverName}" was removed from the configuration.`,
    };
  }

  async listServers(configPath?: string): Promise<McpAgentActionResult> {
    this.assertEnabled();
    const current = await this.configService.read(configPath);
    return {
      ok: true,
      configPath: current.configPath,
      action: 'listed',
      servers: current.config.mcpServers,
      yamlPreview: current.yaml,
      message: `Found ${Object.keys(current.config.mcpServers).length} configured MCP server(s).`,
    };
  }

  async handleInstruction(input: string): Promise<McpAgentActionResult> {
    const parsed = parseMcpConfigurationInstruction(input);
    if (parsed.action === 'list') {
      return this.listServers(parsed.configPath);
    }
    if (parsed.action === 'remove') {
      return this.removeServer(parsed.serverName ?? '', parsed.configPath);
    }
    const result = await this.configureServer({
      serverName: parsed.serverName ?? '',
      ...(parsed.command ? { command: parsed.command } : {}),
      ...(parsed.args ? { args: parsed.args } : {}),
      ...(parsed.url ? { url: parsed.url } : {}),
      ...(parsed.configPath ? { configPath: parsed.configPath } : {}),
    });
    return result;
  }

  private toDefinition(input: ConfigureMcpServerInput): McpAgentServerDefinition {
    return validateMcpAgentServerDefinition({
      ...(input.command !== undefined ? { command: input.command } : {}),
      ...(input.args !== undefined ? { args: input.args } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
    });
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new Error('MCP Agent is disabled. Set MCP_AGENT_ENABLED=true.');
    }
  }

  private assertWritable(): void {
    if (!this.config.allowConfigWrite) {
      throw new Error('MCP Agent config writes are disabled. Set MCP_AGENT_ALLOW_CONFIG_WRITE=true.');
    }
  }
}
