import { relative, resolve, sep } from 'path';
import type { McpManager } from '../../mcp';
import type { McpAgentActionResult, McpAgentService } from '../../mcp-agent';
import { createLogger } from '../../utils/logger';
import type {
  AgentConnector,
  AgentExecutionResult,
  AgentTask,
} from '../agent-gateway.types';

const logger = createLogger('agent:mcp');

function envBool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function serverNameFromInput(input: string): string | null {
  const patterns = [
    /\bmcp\s+server\s+([a-z0-9][a-z0-9_.-]*)\b/i,
    /\bserver\s+mcp\s+([a-z0-9][a-z0-9_.-]*)\b/i,
    /\b(?:start|stop|jalankan|mulai|hentikan|matikan)\s+mcp\s+([a-z0-9][a-z0-9_.-]*)\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(input);
    if (match?.[1]) return match[1].toLowerCase();
  }
  return null;
}

function formatConfigResult(result: McpAgentActionResult): string {
  const heading = result.action === 'listed'
    ? 'Konfigurasi MCP berhasil dibaca.'
    : result.action === 'removed'
    ? `Server MCP \`${result.serverName ?? ''}\` berhasil dihapus.`
    : result.action === 'unchanged'
    ? result.message
    : `Server MCP \`${result.serverName ?? ''}\` berhasil ${result.action === 'created' ? 'ditambahkan' : 'diperbarui'}.`;
  return [
    heading,
    ...(result.warnings?.length
      ? ['', ...result.warnings.map((warning) => `Warning: ${warning}`)]
      : []),
    '',
    `File: \`${result.configPath}\``,
    '',
    '```yaml',
    result.yamlPreview.trimEnd(),
    '```',
  ].join('\n');
}

export class McpAgentConnector implements AgentConnector {
  readonly id = 'mcp-agent';
  readonly displayName = 'Internal MCP Agent';
  readonly capabilities = [
    'mcp.config',
    'mcp.server.list',
    'mcp.server.start',
    'mcp.server.stop',
  ] as const;
  readonly riskLevel = 'safe' as const;
  readonly priority = 10;

  constructor(
    private readonly service?: McpAgentService,
    private readonly manager?: McpManager
  ) {}

  isEnabled(): boolean {
    return envBool('AGENT_MCP_ENABLED', true) && Boolean(this.service?.enabled || this.manager);
  }

  canHandle(task: AgentTask): boolean {
    return this.capabilities.includes(task.capability as typeof this.capabilities[number]);
  }

  async execute(task: AgentTask, signal?: AbortSignal): Promise<AgentExecutionResult> {
    if (signal?.aborted) return this.failure(task, 'AGENT_ABORTED', 'MCP Agent execution was aborted.');
    if (task.capability === 'mcp.config' || task.capability === 'mcp.server.list') {
      if (!this.service?.enabled) {
        return this.failure(task, 'MCP_AGENT_DISABLED', 'MCP Agent self-configuration is disabled.');
      }
      const result = task.capability === 'mcp.server.list'
        ? await this.service.listServers()
        : await this.service.handleInstruction(task.userInput);
      if (signal?.aborted) return this.failure(task, 'AGENT_ABORTED', 'MCP Agent execution was aborted.');
      if (this.manager) await this.manager.loadConfig();
      const changed = result.action === 'created' || result.action === 'updated' || result.action === 'removed';
      const relPath = relative(resolve(task.cwd ?? process.cwd()), result.configPath).split(sep).join('/');
      logger.info('MCP config processed', {
        taskId: task.id,
        action: result.action,
        serverName: result.serverName,
      });
      return {
        ok: true,
        agentId: this.id,
        capability: task.capability,
        summary: result.message,
        output: formatConfigResult(result),
        ...(changed ? { changedFiles: [relPath] } : {}),
        metadata: {
          action: result.action,
          operation: result.action === 'listed'
            ? 'list'
            : result.action === 'removed' || (
                result.action === 'unchanged' &&
                result.serverName &&
                !result.after
              )
            ? 'remove'
            : 'configure',
          configPath: result.configPath,
          serverName: result.serverName,
          serverNames: Object.keys(result.servers ?? {}),
        },
      };
    }

    if (!this.manager) {
      return this.failure(task, 'MCP_MANAGER_UNAVAILABLE', 'MCP manager is disabled or not initialized.');
    }
    const serverName = String(task.context?.['serverName'] ?? serverNameFromInput(task.userInput) ?? '').trim();
    if (!serverName) {
      return this.failure(task, 'MCP_SERVER_NAME_REQUIRED', 'MCP server name could not be determined.');
    }
    if (task.capability === 'mcp.server.start') {
      const configured = (await this.manager.listServers()).find((server) => server.name === serverName);
      if (!configured) {
        return this.failure(task, 'MCP_SERVER_NOT_CONFIGURED', `MCP server "${serverName}" is not configured.`);
      }
      if (configured.transport === 'url') {
        return this.failure(
          task,
          'MCP_URL_TRANSPORT_UNSUPPORTED',
          `MCP server "${serverName}" uses URL transport and cannot be started by the stdio client.`
        );
      }
      try {
        const tools = await this.manager.startServer(serverName);
        return {
          ok: true,
          agentId: this.id,
          capability: task.capability,
          summary: `MCP server "${serverName}" started with ${tools.length} tool(s).`,
          output: `MCP server \`${serverName}\` started with ${tools.length} tool(s).`,
          metadata: {
            serverName,
            transport: configured.transport,
            command: configured.command,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = /\b(?:auth|credential|token|api\s*key|unauthorized|forbidden)\b/i.test(message)
          ? 'MCP_AUTH_REQUIRED'
          : 'MCP_SERVER_START_FAILED';
        return this.failure(task, code, message);
      }
    }
    const stopped = await this.manager.stopServer(serverName);
    return {
      ok: true,
      agentId: this.id,
      capability: task.capability,
      summary: stopped
        ? `MCP server "${serverName}" stopped.`
        : `MCP server "${serverName}" was not running.`,
      output: stopped
        ? `MCP server \`${serverName}\` stopped.`
        : `MCP server \`${serverName}\` was not running.`,
      metadata: { serverName, stopped },
    };
  }

  private failure(task: AgentTask, code: string, message: string): AgentExecutionResult {
    return {
      ok: false,
      agentId: this.id,
      capability: task.capability,
      summary: message,
      error: { code, message },
    };
  }
}
