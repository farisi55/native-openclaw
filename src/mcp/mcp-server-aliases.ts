import { existsSync } from 'fs';
import type { McpCommandServerConfig } from './mcp-config';

export interface KnownMcpServerAlias {
  packageName: string;
  preferredCommand?: string;
  preferredArgs?: string[];
  fallbackCommand: string;
  fallbackArgs: string[];
  description: string;
  requiresAuth: boolean;
}

export interface ResolvedMcpServerAlias {
  name: string;
  alias: KnownMcpServerAlias;
  config: McpCommandServerConfig;
  usingFallback: boolean;
}

export const KNOWN_MCP_SERVER_ALIASES: Readonly<Record<string, KnownMcpServerAlias>> = {
  everything: {
    packageName: '@modelcontextprotocol/server-everything',
    preferredCommand: 'node',
    preferredArgs: [
      '/usr/local/lib/node_modules/@modelcontextprotocol/server-everything/dist/index.js',
    ],
    fallbackCommand: 'npx',
    fallbackArgs: ['-y', '@modelcontextprotocol/server-everything'],
    description: 'MCP test server for smoke testing.',
    requiresAuth: false,
  },
  filesystem: {
    packageName: '@modelcontextprotocol/server-filesystem',
    preferredCommand: 'node',
    preferredArgs: [
      '/usr/local/lib/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js',
      '/workspace',
    ],
    fallbackCommand: 'npx',
    fallbackArgs: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
    description: 'Filesystem MCP server restricted to /workspace.',
    requiresAuth: false,
  },
  'google-sheets': {
    packageName: '@node2flow/google-sheets-mcp',
    fallbackCommand: 'npx',
    fallbackArgs: ['-y', '@node2flow/google-sheets-mcp'],
    description: 'Third-party Google Sheets MCP server.',
    requiresAuth: true,
  },
};

export function getKnownMcpServerAlias(name: string): KnownMcpServerAlias | undefined {
  return KNOWN_MCP_SERVER_ALIASES[name.trim().toLowerCase()];
}

export function resolveKnownMcpServerAlias(
  name: string,
  fileExists: (path: string) => boolean = existsSync
): ResolvedMcpServerAlias | undefined {
  const normalized = name.trim().toLowerCase();
  const alias = getKnownMcpServerAlias(normalized);
  if (!alias) return undefined;

  const preferredEntry = alias.preferredArgs?.[0];
  if (
    alias.preferredCommand &&
    alias.preferredArgs &&
    preferredEntry &&
    fileExists(preferredEntry)
  ) {
    return {
      name: normalized,
      alias,
      config: {
        command: alias.preferredCommand,
        args: [...alias.preferredArgs],
      },
      usingFallback: false,
    };
  }

  return {
    name: normalized,
    alias,
    config: {
      command: alias.fallbackCommand,
      args: [...alias.fallbackArgs],
    },
    usingFallback: true,
  };
}
