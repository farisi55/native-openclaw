import { createLogger } from '../utils/logger';
import type {
  AgentCapability,
  AgentStatus,
} from './agent-gateway.types';
import {
  ExternalHttpAgentConnector,
  type ExternalAgentFetch,
  type ExternalHttpAgentConfig,
} from './connectors/external-http-agent.connector';

const logger = createLogger('agent-gateway:registry');

function envBool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function envInt(key: string, fallback: number): number {
  const value = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function externalAgentConfigsFromEnv(): ExternalHttpAgentConfig[] {
  return [
    {
      id: 'browser-agent',
      displayName: 'Browser Agent',
      enabled: envBool('AGENT_BROWSER_ENABLED', false),
      baseUrl:
        process.env['AGENT_BROWSER_BASE_URL']?.trim() ||
        'http://browser-agent:3101',
      capabilities: ['browser.automation', 'browser.ui-test'],
      timeoutMs: envInt('AGENT_BROWSER_TIMEOUT_MS', 300_000),
      apiKeyEnv: 'AGENT_BROWSER_API_KEY',
      riskLevel: 'warning',
      priority: 100,
      profile: 'browser',
    },
    {
      id: 'research-agent',
      displayName: 'Research Agent',
      enabled: envBool('AGENT_RESEARCH_ENABLED', false),
      baseUrl:
        process.env['AGENT_RESEARCH_BASE_URL']?.trim() ||
        'http://research-agent:3102',
      capabilities: ['research.web', 'research.market'],
      timeoutMs: envInt('AGENT_RESEARCH_TIMEOUT_MS', 600_000),
      apiKeyEnv: 'AGENT_RESEARCH_API_KEY',
      riskLevel: 'safe',
      priority: 100,
      profile: 'research',
    },
    {
      id: 'spreadsheet-agent',
      displayName: 'Spreadsheet Agent',
      enabled: envBool('AGENT_SPREADSHEET_ENABLED', false),
      baseUrl:
        process.env['AGENT_SPREADSHEET_BASE_URL']?.trim() ||
        'http://spreadsheet-agent:3103',
      capabilities: [
        'spreadsheet.read',
        'spreadsheet.write',
        'spreadsheet.report',
      ],
      timeoutMs: envInt('AGENT_SPREADSHEET_TIMEOUT_MS', 300_000),
      apiKeyEnv: 'AGENT_SPREADSHEET_API_KEY',
      riskLevel: 'warning',
      priority: 100,
      profile: 'spreadsheet',
    },
  ];
}

export function createExternalAgentConnectorsFromEnv(
  fetchFn?: ExternalAgentFetch
): ExternalHttpAgentConnector[] {
  const connectors: ExternalHttpAgentConnector[] = [];
  for (const config of externalAgentConfigsFromEnv()) {
    if (!config.enabled) {
      logger.debug(`${config.id} skipped because disabled`, {
        agentId: config.id,
        profile: config.profile,
      });
      continue;
    }
    connectors.push(new ExternalHttpAgentConnector(config, fetchFn));
  }
  return connectors;
}

export function externalAgentStatusesFromEnv(): AgentStatus[] {
  return externalAgentConfigsFromEnv().map((config) => ({
    id: config.id,
    displayName: config.displayName,
    enabled: config.enabled,
    registered: false,
    capabilities: config.capabilities,
    riskLevel: config.riskLevel ?? 'warning',
    priority: config.priority ?? 100,
    ...(config.profile ? { profile: config.profile } : {}),
  }));
}

export function externalAgentEnablementMessage(
  capability: AgentCapability
): string | null {
  if (capability.startsWith('browser.')) {
    return [
      'Fitur browser-agent belum aktif.',
      'Aktifkan dengan:',
      'docker compose --profile browser up -d',
      'dan set AGENT_BROWSER_ENABLED=true.',
    ].join('\n');
  }
  if (capability.startsWith('research.')) {
    return [
      'Fitur research-agent belum aktif.',
      'Aktifkan dengan:',
      'docker compose --profile research up -d',
      'dan set AGENT_RESEARCH_ENABLED=true.',
    ].join('\n');
  }
  if (capability.startsWith('spreadsheet.')) {
    return [
      'Fitur spreadsheet-agent belum aktif.',
      'Aktifkan dengan:',
      'docker compose --profile spreadsheet up -d',
      'dan set AGENT_SPREADSHEET_ENABLED=true.',
    ].join('\n');
  }
  return null;
}

