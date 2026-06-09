export interface CommandMcpServerDefinition {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  url?: never;
}

export interface UrlMcpServerDefinition {
  url: string;
  command?: never;
  args?: never;
  env?: never;
}

export type McpAgentServerDefinition =
  | CommandMcpServerDefinition
  | UrlMcpServerDefinition;

export interface McpAgentConfigFile {
  mcpServers: Record<string, McpAgentServerDefinition>;
}

export interface ConfigureMcpServerInput {
  serverName: string;
  command?: string;
  args?: string[];
  url?: string;
  configPath?: string;
  overwrite?: boolean;
}

export interface ConfigureMcpServerResult {
  ok: boolean;
  configPath: string;
  serverName: string;
  action: 'created' | 'updated' | 'unchanged';
  before?: McpAgentServerDefinition;
  after?: McpAgentServerDefinition;
  yamlPreview: string;
  message: string;
}

export type McpConfigIntentAction = 'configure' | 'remove' | 'list';

export interface ParsedMcpConfigIntent {
  action: McpConfigIntentAction;
  serverName?: string;
  command?: string;
  args?: string[];
  url?: string;
  configPath?: string;
}

export interface McpAgentActionResult {
  ok: boolean;
  configPath: string;
  action: 'created' | 'updated' | 'unchanged' | 'removed' | 'listed';
  serverName?: string;
  before?: McpAgentServerDefinition;
  after?: McpAgentServerDefinition;
  servers?: Record<string, McpAgentServerDefinition>;
  yamlPreview: string;
  message: string;
}

export interface McpAgentConfig {
  enabled: boolean;
  allowConfigWrite: boolean;
  projectRoot: string;
  configPath: string;
}
