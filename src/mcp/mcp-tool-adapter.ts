import type { RegisteredTool, ToolManifest } from '../tools/tool-registry';
import type { McpTool } from './mcp-client';

export interface McpToolCaller {
  callTool(serverName: string, toolName: string, input: unknown): Promise<unknown>;
}

const DANGEROUS_TOOL_KEYWORDS = [
  'execute',
  'exec',
  'shell',
  'command',
  'terminal',
  'run_code',
  'run-code',
  'eval',
  'invoke',
  'dispatch',
  'syscall',
  'process',
  'spawn',
  'subprocess',
] as const;

const DANGEROUS_TOOL_RE = new RegExp(
  `(?:^|[^a-z0-9])(?:${DANGEROUS_TOOL_KEYWORDS.join('|')})(?:[^a-z0-9]|$)`,
  'i'
);

export function makeMcpToolName(serverName: string, toolName: string): string {
  return `mcp:${serverName}:${toolName}`;
}

// FIX: use explicit inline type instead of ToolManifest['inputSchema'] (which is optional)
interface SchemaShape {
  type: string;
  properties?: Record<string, { type: string; description?: string }>;
  required?: string[];
}

function toToolInputSchema(inputSchema: Record<string, unknown> | undefined): SchemaShape | undefined {
  if (!inputSchema) return undefined;
  const type = typeof inputSchema['type'] === 'string' ? inputSchema['type'] : 'object';
  const rawProperties = inputSchema['properties'];
  const properties: Record<string, { type: string; description?: string }> = {};

  if (rawProperties && typeof rawProperties === 'object' && !Array.isArray(rawProperties)) {
    for (const [key, value] of Object.entries(rawProperties as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const raw = value as Record<string, unknown>;
      const prop: { type: string; description?: string } = {
        type: typeof raw['type'] === 'string' ? raw['type'] : 'string',
      };
      if (typeof raw['description'] === 'string') prop.description = raw['description'];
      properties[key] = prop;
    }
  }

  // FIX: build schema with explicit type, conditionally add optional fields
  const schema: SchemaShape = { type };
  if (Object.keys(properties).length > 0) schema.properties = properties;
  if (Array.isArray(inputSchema['required'])) {
    schema.required = inputSchema['required'].filter((item): item is string => typeof item === 'string');
  }
  return schema;
}

function cleanInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const copy = { ...(input as Record<string, unknown>) };
  delete copy['confirm'];
  delete copy['confirmed'];
  return copy;
}

function isConfirmed(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const obj = input as Record<string, unknown>;
  return obj['confirm'] === true || obj['confirmed'] === true;
}

function formatMcpResult(result: unknown): string {
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .map((item) => {
          if (!item || typeof item !== 'object') return '';
          const raw = item as Record<string, unknown>;
          if (typeof raw['text'] === 'string') return raw['text'];
          return JSON.stringify(raw);
        })
        .filter(Boolean)
        .join('\n');
      if (text) return text;
    }
  }
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

export function createMcpRegisteredTool(
  serverName: string,
  tool: McpTool,
  caller: McpToolCaller
): RegisteredTool {
  const runtimeName = makeMcpToolName(serverName, tool.name);
  const nameDangerous = DANGEROUS_TOOL_RE.test(tool.name);
  const descDangerous = typeof tool.description === 'string'
    && DANGEROUS_TOOL_RE.test(tool.description);
  const dangerous = nameDangerous || descDangerous;

  const manifest: ToolManifest = {
    name: runtimeName,
    displayName: `${serverName}:${tool.name}`,
    description: tool.description ?? `MCP tool "${tool.name}" from server "${serverName}".`,
    version: 'runtime',
    entry: 'runtime:mcp',
    enabled: true,
  };

  // FIX: assign only if defined — avoids exactOptionalPropertyTypes issue
  const inputSchema = toToolInputSchema(tool.inputSchema);
  if (inputSchema !== undefined) manifest.inputSchema = inputSchema;

  return {
    manifest,
    run: async (input: unknown) => {
      if (dangerous && !isConfirmed(input)) {
        return `MCP tool "${runtimeName}" may execute code or system commands. Re-run with {"confirm": true} after user confirmation.`;
      }
      const result = await caller.callTool(serverName, tool.name, cleanInput(input));
      return formatMcpResult(result);
    },
  };
}

export { DANGEROUS_TOOL_KEYWORDS };
