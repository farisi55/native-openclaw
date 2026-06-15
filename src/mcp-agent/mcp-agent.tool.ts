import type { RegisteredTool } from '../tools/tool-registry';
import type { ConfigureMcpServerInput } from './mcp-agent.types';
import type { McpAgentService } from './mcp-agent.service';

export function createMcpAgentConfigureTool(service: McpAgentService): RegisteredTool {
  return {
    manifest: {
      name: 'mcp-agent.configure-server',
      displayName: 'MCP Agent Configure Server',
      description: 'Safely create or update an MCP server entry in mcp_agent.config.yaml.',
      version: '1.0.0',
      entry: 'internal',
      enabled: true,
      examples: [
        'Add the built-in MCP smoke server alias everything',
        'Add MCP server google-sheets using npx -y @node2flow/google-sheets-mcp',
        'Register a URL-based MCP server',
      ],
      inputSchema: {
        type: 'object',
        properties: {
          serverName: { type: 'string', description: 'MCP server name, normalized to kebab-case.' },
          command: { type: 'string', description: 'Command launcher for a command-based MCP server.' },
          args: { type: 'array', description: 'Command arguments.' },
          url: { type: 'string', description: 'HTTP(S) URL for a URL-based MCP server.' },
          configPath: { type: 'string', description: 'Optional YAML path inside the project root.' },
          overwrite: { type: 'boolean', description: 'Allow updating an existing server.' },
        },
        required: ['serverName'],
      },
    },
    async run(input: unknown): Promise<string> {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('mcp-agent.configure-server input must be an object.');
      }
      const result = await service.configureServer(input as ConfigureMcpServerInput);
      return JSON.stringify(result, null, 2);
    },
  };
}
