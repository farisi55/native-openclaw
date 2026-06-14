import { createLogger } from '../utils/logger';
import type { AgentCapability, AgentConnector, AgentTask } from './agent-gateway.types';
import type { AgentGatewayRegistry } from './agent-gateway.registry';

const logger = createLogger('agent-gateway:router');

const CONNECTOR_PRIORITY: Record<AgentCapability, string[]> = {
  'coding.patch': ['opencode', 'internal-coding'],
  'coding.review': ['opencode', 'internal-coding'],
  'coding.refactor': ['opencode', 'internal-coding'],
  'coding.test': ['opencode', 'internal-coding'],
  'mcp.config': ['mcp-agent'],
  'mcp.server.list': ['mcp-agent'],
  'mcp.server.start': ['mcp-agent'],
  'mcp.server.stop': ['mcp-agent'],
};

export function capabilityForIntent(intent: string, input = ''): AgentCapability | null {
  const normalizedIntent = intent.trim().toLowerCase();
  const normalizedInput = input.trim().toLowerCase();

  if (normalizedIntent === 'self-healing' || normalizedIntent === 'self-upgrade') {
    return 'coding.patch';
  }
  if (normalizedIntent === 'mcp-config-update') return 'mcp.config';
  if (normalizedIntent === 'mcp-config-read') return 'mcp.server.list';
  if (/\b(?:start|jalankan|mulai)\s+(?:server\s+)?mcp\b/.test(normalizedInput)) {
    return 'mcp.server.start';
  }
  if (/\b(?:stop|hentikan|matikan)\s+(?:server\s+)?mcp\b/.test(normalizedInput)) {
    return 'mcp.server.stop';
  }
  if (/\b(?:list|show|tampilkan|lihat|daftar)\b[\s\S]*\bmcp\b/.test(normalizedInput)) {
    return 'mcp.server.list';
  }
  if (/\bmcp\b/.test(normalizedInput) && /\b(?:add|tambahkan|tambah|update|ubah|remove|hapus|delete|config|konfigurasi)\b/.test(normalizedInput)) {
    return 'mcp.config';
  }
  if (
    /\b(?:fix|repair|perbaiki|benahi)\b[\s\S]*\b(?:bug|error|failure|gagal|kode|code|module|modul)\b/.test(normalizedInput)
  ) {
    return 'coding.patch';
  }
  if (
    /\b(?:review|tinjau|audit)\b[\s\S]*\b(?:code|kode|module|modul|file)\b/.test(normalizedInput)
  ) {
    return 'coding.review';
  }
  if (
    /\b(?:refactor|rapikan|restrukturisasi)\b[\s\S]*\b(?:code|kode|module|modul|file)\b/.test(normalizedInput)
  ) {
    return 'coding.refactor';
  }
  if (
    /\b(?:test|uji)\b[\s\S]*\b(?:code|kode|module|modul|build|suite)\b/.test(normalizedInput)
  ) {
    return 'coding.test';
  }
  return null;
}

export class AgentGatewayRouter {
  route(task: AgentTask, registry: AgentGatewayRegistry): AgentConnector[] {
    const available = registry.enabledFor(task.capability, task);
    const priority = CONNECTOR_PRIORITY[task.capability];
    const ranked = [...available].sort((left, right) => {
      const leftIndex = priority.indexOf(left.id);
      const rightIndex = priority.indexOf(right.id);
      const mappedOrder =
        (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) -
        (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
      return mappedOrder || left.priority - right.priority || left.id.localeCompare(right.id);
    });
    logger.debug('capability routed', {
      taskId: task.id,
      capability: task.capability,
      connectors: ranked.map((connector) => connector.id),
    });
    return ranked;
  }
}
