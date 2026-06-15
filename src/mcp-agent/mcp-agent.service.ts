import { isDeepStrictEqual } from 'util';
import { createLogger } from '../utils/logger';
import {
  assertMcpCommandAllowed,
  extractNpxPackage,
  normalizeMcpStartError,
  resolveKnownMcpServerAliasRuntime,
  validateNpmPackageExists,
  type NpmPackageValidator,
  type ResolvedMcpServerAlias,
} from '../mcp';
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
const INVALID_MCP_PACKAGES = new Set([
  '@modelcontextprotocol/server-google-sheets',
]);

export interface McpAgentServiceDependencies {
  npmPackageValidator?: NpmPackageValidator;
  aliasResolver?: (serverName: string) => Promise<ResolvedMcpServerAlias | undefined>;
}

export class McpAgentService {
  readonly configService: McpConfigService;
  private readonly npmPackageValidator: NpmPackageValidator;
  private readonly aliasResolver: (
    serverName: string
  ) => Promise<ResolvedMcpServerAlias | undefined>;

  constructor(
    private readonly config: McpAgentConfig,
    dependencies: McpAgentServiceDependencies = {}
  ) {
    this.configService = new McpConfigService(config.projectRoot, config.configPath);
    this.npmPackageValidator =
      dependencies.npmPackageValidator ?? validateNpmPackageExists;
    this.aliasResolver = dependencies.aliasResolver ?? (
      (serverName) => resolveKnownMcpServerAliasRuntime(serverName, {
        workspacePath:
          process.env['WORKSPACE_DIR'] ??
          `${this.config.projectRoot}/workspace`,
      })
    );
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  async configureServer(input: ConfigureMcpServerInput): Promise<ConfigureMcpServerResult> {
    this.assertEnabled();
    this.assertWritable();
    const serverName = normalizeMcpServerName(input.serverName);
    const { definition, warnings } = await this.toDefinition(serverName, input);
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
        ...(warnings.length > 0 ? { warnings } : {}),
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
      message: [
        `MCP server "${serverName}" was ${action} in the configuration.`,
        ...warnings.map((warning) => `Warning: ${warning}`),
      ].join(' '),
      ...(warnings.length > 0 ? { warnings } : {}),
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

  private async toDefinition(
    serverName: string,
    input: ConfigureMcpServerInput
  ): Promise<{ definition: McpAgentServerDefinition; warnings: string[] }> {
    const alias = !input.command && !input.url
      ? await this.aliasResolver(serverName)
      : undefined;
    const definition = validateMcpAgentServerDefinition(alias?.config ?? {
      ...(input.command !== undefined ? { command: input.command } : {}),
      ...(input.args !== undefined ? { args: input.args } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
    });
    const warnings: string[] = [];

    if ('command' in definition) {
      assertMcpCommandAllowed(definition.command);
      const packageName = extractNpxPackage(definition.command, definition.args);
      if (packageName) {
        if (INVALID_MCP_PACKAGES.has(packageName)) {
          throw new Error(
            `Package not found in npm registry: ${packageName}. ` +
            'For Google Sheets, use the auth-required third-party alias "google-sheets" ' +
            'or package @node2flow/google-sheets-mcp.'
          );
        }

        const validatePackage = this.config.validateNpmPackage ?? true;
        if (validatePackage) {
          const validation = await this.npmPackageValidator(
            packageName,
            this.config.npmValidateTimeoutMs ?? 15_000
          );
          if (!validation.ok) {
            const detail = validation.error ?? 'npm registry validation failed';
            if (/\bE404\b|\b404\b|not\s+found|not in this registry/i.test(detail)) {
              throw new Error(`Package not found in npm registry: ${packageName}`);
            }
            throw normalizeMcpStartError(
              new Error(`Could not verify npm package ${packageName}: ${detail}`)
            );
          }
        } else {
          warnings.push(
            `npm package ${packageName} was not verified. /mcp start may fail if it does not exist.`
          );
        }
      }
    }

    if (alias?.alias.requiresAuth) {
      warnings.push(
        `${serverName} uses third-party package ${alias.alias.packageName} and requires authentication.`
      );
    }
    warnings.push(...(alias?.warnings ?? []));
    return { definition, warnings };
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
