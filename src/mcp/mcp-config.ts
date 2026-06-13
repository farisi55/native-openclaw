import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, extname, resolve } from 'path';
import { parseDocument } from 'yaml';

export interface McpCommandServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  url?: never;
}

export interface McpUrlServerConfig {
  url: string;
  command?: never;
  args?: never;
  env?: never;
}

export type McpServerConfig = McpCommandServerConfig | McpUrlServerConfig;

function isMcpUrlServerConfig(config: McpServerConfig): config is McpUrlServerConfig {
  return typeof config.url === 'string';
}

export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

export const DEFAULT_MCP_CONFIG: McpConfigFile = {
  mcpServers: {},
};

function createDefaultMcpConfig(): McpConfigFile {
  return { mcpServers: {} };
}

export const MCP_SERVER_PRESETS: Record<string, McpServerConfig> = {
  console: {
    command: 'npx',
    args: ['-y', '@ooples/mcp-console-automation'],
  },
  tavily: {
    command: 'npx',
    args: ['-y', '@tavily/mcp-server'],
  },
  firecrawl: {
    command: 'npx',
    args: ['-y', '@mendable/firecrawl-mcp-server'],
  },
  e2b: {
    command: 'npx',
    args: ['-y', '@e2b/mcp-server'],
  },
  brevo: {
    command: 'npx',
    args: ['-y', 'mcp-server-brevo'],
  },
};

export const MCP_ALLOWED_LAUNCHERS: ReadonlySet<string> = new Set([
  'npx',
  'uvx',
  'node',
  'nodejs',
  'python',
  'python3',
  'deno',
]);

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\\/.test(value);
}

export function assertMcpCommandAllowed(command: string): void {
  if (!command || command.trim() === '') return;
  const trimmed = command.trim();
  if (isAbsolutePath(trimmed)) return;

  const launcher = trimmed.split(/[\\/]/).at(-1)?.split(' ')[0] ?? trimmed;
  if (!MCP_ALLOWED_LAUNCHERS.has(launcher)) {
    throw new Error(
      `MCP server command "${launcher}" is not in the allowed launcher list. ` +
      `Use an absolute binary path, or one of: ${[...MCP_ALLOWED_LAUNCHERS].join(', ')}.`
    );
  }
}

export function resolveMcpConfigPath(configPath = './mcp_agent.config.yaml'): string {
  return resolve(process.cwd(), configPath);
}

export function validateMcpServerConfig(value: unknown): McpServerConfig {
  if (!value || typeof value !== 'object') {
    throw new Error('MCP server config must be an object.');
  }

  const candidate = value as Record<string, unknown>;
  const command = typeof candidate['command'] === 'string' ? candidate['command'].trim() : '';
  const url = typeof candidate['url'] === 'string' ? candidate['url'].trim() : '';

  if ((command && url) || (!command && !url)) {
    throw new Error('MCP server config requires either a non-empty command or a non-empty url.');
  }

  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('MCP server url is invalid.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('MCP server url must use http or https.');
    }
    return { url };
  }

  assertMcpCommandAllowed(command);

  if (candidate['args'] !== undefined) {
    if (!Array.isArray(candidate['args']) || !candidate['args'].every((arg) => typeof arg === 'string')) {
      throw new Error('MCP server args must be an array of strings.');
    }
  }

  if (candidate['env'] !== undefined) {
    if (!candidate['env'] || typeof candidate['env'] !== 'object' || Array.isArray(candidate['env'])) {
      throw new Error('MCP server env must be an object.');
    }
    for (const [key, val] of Object.entries(candidate['env'] as Record<string, unknown>)) {
      if (typeof key !== 'string' || typeof val !== 'string') {
        throw new Error('MCP server env values must be strings.');
      }
    }
  }

  const config: McpServerConfig = {
    command,
  };

  if (candidate['args'] !== undefined) config.args = candidate['args'] as string[];
  if (candidate['env'] !== undefined) config.env = candidate['env'] as Record<string, string>;

  return config;
}

export function validateMcpConfigFile(value: unknown): McpConfigFile {
  if (!value || typeof value !== 'object') return createDefaultMcpConfig();

  const candidate = value as Record<string, unknown>;
  const rawServers = candidate['mcpServers'];
  if (!rawServers || typeof rawServers !== 'object' || Array.isArray(rawServers)) {
    return createDefaultMcpConfig();
  }

  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(rawServers as Record<string, unknown>)) {
    mcpServers[name] = validateMcpServerConfig(config);
  }

  return { mcpServers };
}

function parseMcpConfig(raw: string, configPath: string): unknown {
  if (!raw.trim()) return DEFAULT_MCP_CONFIG;
  if (/\.ya?ml$/i.test(extname(configPath))) {
    const document = parseDocument(raw, { uniqueKeys: true });
    if (document.errors.length > 0) {
      throw new Error(`Invalid MCP YAML: ${document.errors[0]?.message ?? 'parse failed'}`);
    }
    return document.toJS({ maxAliasCount: 0 });
  }
  return JSON.parse(raw);
}

function stringifyMcpConfig(config: McpConfigFile, configPath: string): string {
  const validated = validateMcpConfigFile(config);
  if (!/\.ya?ml$/i.test(extname(configPath))) {
    return JSON.stringify(validated, null, 2);
  }
  const lines = ['mcpServers:'];
  const entries = Object.entries(validated.mcpServers);
  if (entries.length === 0) return 'mcpServers: {}\n';
  for (const [name, server] of entries) {
    lines.push(`  ${name}:`);
    if ('url' in server) {
      lines.push(`    url: ${JSON.stringify(server.url)}`);
      continue;
    }
    lines.push(`    command: ${JSON.stringify(server.command)}`);
    if (server.args) lines.push(`    args: [${server.args.map((arg) => JSON.stringify(arg)).join(', ')}]`);
    if (server.env) {
      lines.push('    env:');
      for (const [key, value] of Object.entries(server.env)) {
        lines.push(`      ${key}: ${JSON.stringify(value)}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function loadMcpConfig(configPath = './mcp_agent.config.yaml'): Promise<McpConfigFile> {
  const absolutePath = resolveMcpConfigPath(configPath);

  if (!existsSync(absolutePath)) {
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, JSON.stringify(DEFAULT_MCP_CONFIG, null, 2), 'utf-8');
    return createDefaultMcpConfig();
  }

  const raw = await readFile(absolutePath, 'utf-8');
  const parsed = parseMcpConfig(raw, absolutePath);
  return validateMcpConfigFile(parsed);
}

export async function saveMcpConfig(
  configPath: string,
  config: McpConfigFile
): Promise<void> {
  const absolutePath = resolveMcpConfigPath(configPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, stringifyMcpConfig(config, absolutePath), 'utf-8');
}

export function parseMcpServerInput(name: string, rawJson?: string): McpServerConfig {
  const normalized = name.toLowerCase();

  if (!rawJson || rawJson.trim() === '') {
    const preset = MCP_SERVER_PRESETS[normalized];
    if (!preset) {
      throw new Error(`No MCP preset found for "${name}". Provide a JSON server config.`);
    }

    if (isMcpUrlServerConfig(preset)) {
      return { url: preset.url };
    }

    const config: McpCommandServerConfig = { command: preset.command };
    if (preset.args) config.args = [...preset.args];
    if (preset.env) config.env = { ...preset.env };
    return config;
  }

  const parsed = JSON.parse(rawJson);
  const fullConfig = validateMcpConfigFile(parsed);
  const fromFull = fullConfig.mcpServers[name] ?? fullConfig.mcpServers[normalized];
  if (fromFull) return fromFull;

  return validateMcpServerConfig(parsed);
}
