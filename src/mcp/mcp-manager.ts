import type { ToolRegistry } from '../tools/tool-registry';
import { createLogger } from '../utils/logger';
import { McpClient, type McpTool } from './mcp-client';
import {
  loadMcpConfig,
  parseMcpServerInput,
  saveMcpConfig,
  validateMcpServerConfig,
  type McpConfigFile,
  type McpServerConfig,
} from './mcp-config';
import { createMcpRegisteredTool, makeMcpToolName } from './mcp-tool-adapter';

const logger = createLogger('mcp:manager');

export interface McpManagerOptions {
  configPath?: string;
  toolRegistry?: ToolRegistry;
}

export interface McpServerInfo {
  name: string;
  command?: string;
  url?: string;
  args: string[];
  transport: 'stdio' | 'url';
  status: 'running' | 'stopped';
}

export class McpManager {
  private readonly configPath: string;
  private readonly toolRegistry: ToolRegistry | undefined;
  private config: McpConfigFile = { mcpServers: {} };
  private readonly clients = new Map<string, McpClient>();
  private readonly cachedTools = new Map<string, McpTool[]>();

  constructor(options: McpManagerOptions = {}) {
    this.configPath = options.configPath ?? './mcp_agent.config.yaml';
    this.toolRegistry = options.toolRegistry;
  }

  get path(): string {
    return this.configPath;
  }

  async init(): Promise<void> {
    await this.loadConfig();
  }

  async loadConfig(): Promise<McpConfigFile> {
    this.config = await loadMcpConfig(this.configPath);
    return this.config;
  }

  async saveConfig(): Promise<void> {
    await saveMcpConfig(this.configPath, this.config);
  }

  async listServers(): Promise<McpServerInfo[]> {
    await this.loadConfig();
    return Object.entries(this.config.mcpServers).map(([name, config]) => ({
      name,
      ...('url' in config ? { url: config.url } : { command: config.command }),
      args: 'args' in config ? (config.args ?? []) : [],
      transport: 'url' in config ? 'url' : 'stdio',
      status: this.clients.get(name)?.isRunning ? 'running' : 'stopped',
    }));
  }

  async addServer(name: string, config: McpServerConfig): Promise<void> {
    await this.loadConfig();
    this.config.mcpServers[name] = validateMcpServerConfig(config);
    await this.saveConfig();
  }

  async addServerFromInput(name: string, rawJson?: string): Promise<void> {
    await this.addServer(name, parseMcpServerInput(name, rawJson));
  }

  async removeServer(name: string): Promise<boolean> {
    await this.loadConfig();
    if (!this.config.mcpServers[name]) return false;
    await this.stopServer(name);
    delete this.config.mcpServers[name];
    await this.saveConfig();
    return true;
  }

  async startServer(name: string): Promise<McpTool[]> {
    await this.loadConfig();
    const config = this.config.mcpServers[name];
    if (!config) throw new Error(`MCP server "${name}" is not configured.`);
    if ('url' in config) {
      throw new Error(`MCP server "${name}" uses URL transport, which is listed but cannot be started by the stdio MCP client yet.`);
    }

    let client = this.clients.get(name);
    if (!client || !client.isRunning) {
      client = new McpClient(name, config);
      this.clients.set(name, client);
      await client.start();
    }

    const tools = await client.listTools();
    this.cachedTools.set(name, tools);
    this.registerToolsForServer(name, tools);
    logger.info('MCP server started', { name, tools: tools.length });
    return tools;
  }

  async stopServer(name: string): Promise<boolean> {
    const client = this.clients.get(name);
    this.unregisterToolsForServer(name);
    this.cachedTools.delete(name);
    this.clients.delete(name);
    if (!client) return false;
    await client.stop();
    logger.info('MCP server stopped', { name });
    return true;
  }

  async restartServer(name: string): Promise<McpTool[]> {
    await this.stopServer(name);
    return this.startServer(name);
  }

  async startAllConfigured(): Promise<Array<{ name: string; ok: boolean; error?: string }>> {
    await this.loadConfig();
    const results: Array<{ name: string; ok: boolean; error?: string }> = [];
    for (const name of Object.keys(this.config.mcpServers)) {
      try {
        await this.startServer(name);
        results.push({ name, ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('MCP server failed to start', { name, error: message });
        results.push({ name, ok: false, error: message });
      }
    }
    return results;
  }

  listTools(serverName?: string): Array<{ server: string; name: string; runtimeName: string; description?: string }> {
    const entries = serverName
      ? [[serverName, this.cachedTools.get(serverName) ?? []] as const]
      : [...this.cachedTools.entries()];

    return entries.flatMap(([server, tools]) =>
      tools.map((tool) => {
        const item: { server: string; name: string; runtimeName: string; description?: string } = {
          server,
          name: tool.name,
          runtimeName: makeMcpToolName(server, tool.name),
        };
        if (tool.description) item.description = tool.description;
        return item;
      })
    );
  }

  registerRunningTools(): void {
    for (const [server, tools] of this.cachedTools) {
      this.registerToolsForServer(server, tools);
    }
  }

  async callTool(serverName: string, toolName: string, input: unknown): Promise<unknown> {
    const client = this.clients.get(serverName);
    if (!client?.isRunning) {
      throw new Error(`MCP server "${serverName}" is not running.`);
    }
    return client.callTool(toolName, input);
  }

  private registerToolsForServer(serverName: string, tools: McpTool[]): void {
    if (!this.toolRegistry) return;
    this.unregisterToolsForServer(serverName);
    for (const tool of tools) {
      this.toolRegistry.registerRuntimeTool(createMcpRegisteredTool(serverName, tool, this));
    }
  }

  private unregisterToolsForServer(serverName: string): void {
    this.toolRegistry?.unregisterByPrefix(`mcp:${serverName}:`);
  }
}
