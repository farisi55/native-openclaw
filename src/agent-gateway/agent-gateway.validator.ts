import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { parseDocument } from 'yaml';
import { validateMcpAgentConfig } from '../mcp-agent';
import { createLogger } from '../utils/logger';
import { AgentGatewayPolicy } from './agent-gateway.policy';
import type {
  AgentExecutionResult,
  AgentResultValidation,
  AgentTask,
} from './agent-gateway.types';

const logger = createLogger('agent-gateway:validator');

function stringMetadata(
  result: AgentExecutionResult,
  key: string
): string | undefined {
  const value = result.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArrayMetadata(
  result: AgentExecutionResult,
  key: string
): string[] {
  const value = result.metadata?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export class AgentGatewayValidator {
  constructor(private readonly policy = new AgentGatewayPolicy()) {}

  async validate(
    task: AgentTask,
    result: AgentExecutionResult
  ): Promise<AgentResultValidation> {
    const warnings: string[] = [];
    const errors: string[] = [];

    if (!result.ok) {
      errors.push(result.error?.message ?? result.summary);
      return { ok: false, warnings, errors };
    }

    if (
      task.capability.startsWith('browser.') ||
      task.capability.startsWith('research.') ||
      task.capability.startsWith('spreadsheet.')
    ) {
      this.validateExternalArtifacts(task, result, errors);
    }

    if (task.capability === 'coding.patch') {
      const changedFiles = result.changedFiles ?? [];
      const artifacts = result.artifacts?.filter((item) => item.trim()) ?? [];
      if (changedFiles.length === 0 && artifacts.length === 0) {
        errors.push('NO_DETECTABLE_CHANGES: coding.patch succeeded without changed files or a patch artifact.');
      }
      errors.push(...this.policy.validateResult(task, result));
    } else if (
      task.capability === 'coding.review' ||
      task.capability === 'coding.test'
    ) {
      if (!result.output?.trim() && (result.qa?.length ?? 0) === 0) {
        errors.push(`${task.capability} succeeded without output or QA results.`);
      }
    } else if (task.capability === 'coding.refactor') {
      if ((result.changedFiles?.length ?? 0) === 0) {
        errors.push('NO_DETECTABLE_CHANGES: coding.refactor succeeded without changed files.');
      }
      errors.push(...this.policy.validateResult(
        { ...task, capability: 'coding.patch' },
        result
      ));
    } else if (
      task.capability === 'mcp.config' ||
      task.capability === 'mcp.server.list'
    ) {
      await this.validateMcpConfigResult(task, result, warnings, errors);
    } else if (task.capability === 'mcp.server.start') {
      const transport = stringMetadata(result, 'transport');
      const command = stringMetadata(result, 'command');
      if (transport === 'url') {
        errors.push('URL-based MCP servers cannot be started by the stdio MCP client.');
      } else if (!command) {
        errors.push('Started MCP server result is missing its command metadata.');
      }
    } else if (task.capability.startsWith('browser.')) {
      this.validateBrowserResult(task, result, warnings, errors);
    } else if (task.capability.startsWith('research.')) {
      this.validateResearchResult(task, result, warnings, errors);
    } else if (task.capability.startsWith('spreadsheet.')) {
      this.validateSpreadsheetResult(task, result, warnings, errors);
    }

    const validation = {
      ok: errors.length === 0,
      warnings,
      errors,
    };
    if (validation.ok) {
      logger.debug('result validation passed', {
        taskId: task.id,
        capability: task.capability,
        agentId: result.agentId,
        warnings,
        errors,
      });
    } else {
      logger.warn('result validation failed', {
        taskId: task.id,
        capability: task.capability,
        agentId: result.agentId,
        warnings,
        errors,
      });
    }
    return validation;
  }

  private validateExternalArtifacts(
    task: AgentTask,
    result: AgentExecutionResult,
    errors: string[]
  ): void {
    const expectedPrefix =
      `workspace/artifacts/${result.agentId}/${task.id}/`;
    for (const artifact of result.artifacts ?? []) {
      const normalized = artifact.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!normalized.startsWith(expectedPrefix)) {
        errors.push(
          `External agent artifact must be under /${expectedPrefix}: ${artifact}`
        );
      }
    }
  }

  private validateBrowserResult(
    task: AgentTask,
    result: AgentExecutionResult,
    warnings: string[],
    errors: string[]
  ): void {
    if (!result.summary.trim()) errors.push('Browser agent result is missing a summary.');
    const screenshotRequested = /\b(?:screenshot|ambil\s+gambar|capture)\b/i.test(task.userInput);
    if (screenshotRequested && (result.artifacts?.length ?? 0) === 0) {
      errors.push('Browser task requested a screenshot but returned no artifact.');
    } else if ((result.artifacts?.length ?? 0) === 0) {
      warnings.push('Browser result did not include an artifact.');
    }
  }

  private validateResearchResult(
    task: AgentTask,
    result: AgentExecutionResult,
    warnings: string[],
    errors: string[]
  ): void {
    if (!result.summary.trim()) errors.push('Research result is missing a summary.');
    const sources = result.metadata?.['sources'];
    if (!Array.isArray(sources) || sources.length === 0) {
      warnings.push(
        task.capability === 'research.market'
          ? 'Market research result did not include source metadata.'
          : 'Web research result did not include source metadata.'
      );
    }
  }

  private validateSpreadsheetResult(
    task: AgentTask,
    result: AgentExecutionResult,
    warnings: string[],
    errors: string[]
  ): void {
    if (task.capability === 'spreadsheet.read') {
      const noData = result.metadata?.['noData'] === true;
      if (!result.output?.trim() && !noData) {
        errors.push('Spreadsheet read result must include a data preview or explicit no-data status.');
      }
      return;
    }
    if (task.capability === 'spreadsheet.write') {
      const target = result.metadata?.['targetSheet'] ?? result.metadata?.['range'];
      if (!target && !result.output?.trim()) {
        errors.push('Spreadsheet write result must identify the target sheet/range or operation summary.');
      }
      return;
    }
    if (!result.output?.trim() && (result.artifacts?.length ?? 0) === 0) {
      errors.push('Spreadsheet report result must include output or an artifact.');
    } else if ((result.artifacts?.length ?? 0) === 0) {
      warnings.push('Spreadsheet report did not include a generated artifact.');
    }
  }

  private async validateMcpConfigResult(
    task: AgentTask,
    result: AgentExecutionResult,
    warnings: string[],
    errors: string[]
  ): Promise<void> {
    const configPath = stringMetadata(result, 'configPath');
    if (!configPath) {
      errors.push('MCP result is missing configPath metadata.');
      return;
    }

    if (!existsSync(configPath)) {
      if (task.capability === 'mcp.server.list') {
        const listed = stringArrayMetadata(result, 'serverNames');
        if (listed.length === 0) {
          warnings.push('MCP config file does not exist; the empty server list is valid.');
          return;
        }
      }
      errors.push(`MCP config file does not exist: ${configPath}`);
      return;
    }

    let serverNames: string[];
    try {
      const yaml = await readFile(configPath, 'utf-8');
      const document = parseDocument(yaml, { uniqueKeys: true });
      if (document.errors.length > 0) {
        errors.push(`Invalid MCP YAML: ${document.errors[0]?.message ?? 'parse failed'}`);
        return;
      }
      const config = validateMcpAgentConfig(
        document.toJS({ maxAliasCount: 0 }) as unknown
      );
      serverNames = Object.keys(config.mcpServers).sort();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return;
    }

    if (task.capability === 'mcp.config') {
      const action = stringMetadata(result, 'action');
      const operation = stringMetadata(result, 'operation');
      const requestedServer = stringMetadata(result, 'serverName');
      if (!requestedServer) {
        errors.push('MCP config result is missing the requested server name.');
      } else if (action === 'removed' || operation === 'remove') {
        if (serverNames.includes(requestedServer)) {
          errors.push(`MCP server "${requestedServer}" still exists after removal.`);
        }
      } else if (!serverNames.includes(requestedServer)) {
        errors.push(`MCP server "${requestedServer}" is missing after configuration.`);
      }
      return;
    }

    const listedNames = stringArrayMetadata(result, 'serverNames').sort();
    if (serverNames.join('\n') !== listedNames.join('\n')) {
      errors.push(
        `MCP list/config mismatch: config has [${serverNames.join(', ')}], result has [${listedNames.join(', ')}].`
      );
    }
    if (!result.output?.trim()) {
      errors.push('MCP server list result must include a clear list or empty-list output.');
    }
  }
}
