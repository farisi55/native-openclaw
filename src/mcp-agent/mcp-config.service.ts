import { existsSync } from 'fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { parseDocument } from 'yaml';
import type {
  McpAgentConfigFile,
  McpAgentServerDefinition,
} from './mcp-agent.types';

const DEFAULT_CONFIG: McpAgentConfigFile = { mcpServers: {} };
const PROTECTED_PATH_RE =
  /(?:^|[\\/])(?:\.env(?:\..*)?|\.git|node_modules|dist|secrets?(?:\..*)?|id_rsa)(?:[\\/]|$)|\.(?:pem|key)$/i;

function cloneDefinition(value: McpAgentServerDefinition): McpAgentServerDefinition {
  if ('url' in value) return { url: value.url };
  return {
    command: value.command,
    ...(value.args ? { args: [...value.args] } : {}),
    ...(value.env ? { env: { ...value.env } } : {}),
  };
}

function quote(value: string): string {
  return JSON.stringify(value);
}

export function normalizeMcpServerName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\\/]/.test(trimmed) || trimmed.includes('..')) {
    throw new Error('MCP server name is invalid.');
  }
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(normalized)) {
    throw new Error('MCP server name is invalid.');
  }
  return normalized;
}

export function validateMcpAgentServerDefinition(
  value: unknown
): McpAgentServerDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MCP server definition must be an object.');
  }
  const record = value as Record<string, unknown>;
  const command = typeof record['command'] === 'string' ? record['command'].trim() : '';
  const url = typeof record['url'] === 'string' ? record['url'].trim() : '';

  if ((command && url) || (!command && !url)) {
    throw new Error('MCP server must define either command or url.');
  }

  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('MCP server URL is invalid.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('MCP server URL must use http or https.');
    }
    return { url };
  }

  const args = record['args'];
  if (args !== undefined && (!Array.isArray(args) || !args.every((item) => typeof item === 'string'))) {
    throw new Error('MCP server args must be an array of strings.');
  }

  const env = record['env'];
  if (
    env !== undefined &&
    (!env || typeof env !== 'object' || Array.isArray(env) ||
      !Object.values(env as Record<string, unknown>).every((item) => typeof item === 'string'))
  ) {
    throw new Error('MCP server env must contain string values.');
  }

  return {
    command,
    ...(args !== undefined ? { args: [...args as string[]] } : {}),
    ...(env !== undefined ? { env: { ...env as Record<string, string> } } : {}),
  };
}

export function validateMcpAgentConfig(value: unknown): McpAgentConfigFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MCP config must be an object.');
  }
  const rawServers = (value as Record<string, unknown>)['mcpServers'];
  if (!rawServers || typeof rawServers !== 'object' || Array.isArray(rawServers)) {
    throw new Error('MCP config requires an mcpServers object.');
  }

  const mcpServers: Record<string, McpAgentServerDefinition> = {};
  for (const [rawName, definition] of Object.entries(rawServers as Record<string, unknown>)) {
    const name = normalizeMcpServerName(rawName);
    mcpServers[name] = validateMcpAgentServerDefinition(definition);
  }
  return { mcpServers };
}

export function stringifyMcpAgentConfig(config: McpAgentConfigFile): string {
  const lines = ['mcpServers:'];
  const entries = Object.entries(config.mcpServers);
  if (entries.length === 0) return 'mcpServers: {}\n';

  for (const [name, definition] of entries) {
    lines.push(`  ${name}:`);
    if ('url' in definition) {
      lines.push(`    url: ${quote(definition.url)}`);
      continue;
    }
    lines.push(`    command: ${quote(definition.command)}`);
    if (definition.args) {
      lines.push(`    args: [${definition.args.map(quote).join(', ')}]`);
    }
    if (definition.env) {
      lines.push('    env:');
      for (const [key, value] of Object.entries(definition.env)) {
        lines.push(`      ${key}: ${quote(value)}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

export class McpConfigService {
  readonly projectRoot: string;
  readonly defaultConfigPath: string;

  constructor(projectRoot = process.cwd(), configPath = './mcp_agent.config.yaml') {
    this.projectRoot = resolve(projectRoot);
    this.defaultConfigPath = this.resolveConfigPath(configPath);
  }

  resolveConfigPath(configPath?: string): string {
    const requested = configPath?.trim() || './mcp_agent.config.yaml';
    const absolute = isAbsolute(requested)
      ? resolve(requested)
      : resolve(this.projectRoot, requested);
    const rel = relative(this.projectRoot, absolute);
    if (rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../') || isAbsolute(rel)) {
      throw new Error('MCP config path must stay inside the project root.');
    }
    if (PROTECTED_PATH_RE.test(absolute)) {
      throw new Error('MCP config path points to a protected file or directory.');
    }
    if (!/\.ya?ml$/i.test(absolute)) {
      throw new Error('MCP config path must be a .yaml or .yml file.');
    }
    return absolute;
  }

  async read(configPath?: string): Promise<{
    configPath: string;
    config: McpAgentConfigFile;
    yaml: string;
  }> {
    const absolute = configPath
      ? this.resolveConfigPath(configPath)
      : this.defaultConfigPath;
    if (!existsSync(absolute)) {
      return {
        configPath: absolute,
        config: { mcpServers: {} },
        yaml: stringifyMcpAgentConfig(DEFAULT_CONFIG),
      };
    }

    const yaml = await readFile(absolute, 'utf-8');
    if (!yaml.trim()) {
      return {
        configPath: absolute,
        config: { mcpServers: {} },
        yaml: stringifyMcpAgentConfig(DEFAULT_CONFIG),
      };
    }

    const document = parseDocument(yaml, { uniqueKeys: true });
    if (document.errors.length > 0) {
      throw new Error(`Invalid MCP YAML: ${document.errors[0]?.message ?? 'parse failed'}`);
    }
    const parsed = document.toJS({ maxAliasCount: 0 }) as unknown;
    return {
      configPath: absolute,
      config: validateMcpAgentConfig(parsed),
      yaml,
    };
  }

  async write(
    config: McpAgentConfigFile,
    configPath?: string
  ): Promise<{ configPath: string; yaml: string }> {
    const absolute = configPath
      ? this.resolveConfigPath(configPath)
      : this.defaultConfigPath;
    const validated = validateMcpAgentConfig(config);
    const yaml = stringifyMcpAgentConfig(validated);
    const reparsed = parseDocument(yaml, { uniqueKeys: true });
    if (reparsed.errors.length > 0) {
      throw new Error(`Generated MCP YAML is invalid: ${reparsed.errors[0]?.message ?? 'parse failed'}`);
    }
    validateMcpAgentConfig(reparsed.toJS({ maxAliasCount: 0 }));

    await mkdir(dirname(absolute), { recursive: true });
    const temporaryPath = `${absolute}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporaryPath, yaml, 'utf-8');
      await rename(temporaryPath, absolute);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return { configPath: absolute, yaml };
  }

  cloneConfig(config: McpAgentConfigFile): McpAgentConfigFile {
    return {
      mcpServers: Object.fromEntries(
        Object.entries(config.mcpServers).map(([name, definition]) => [
          name,
          cloneDefinition(definition),
        ])
      ),
    };
  }
}
