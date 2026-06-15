import { existsSync } from 'fs';
import { posix, win32 } from 'path';
import type { McpCommandServerConfig } from './mcp-config';
import {
  getGlobalNpmRoot,
  getNpxCommand,
  type McpPlatform,
} from './mcp-platform';

export interface KnownMcpServerAlias {
  packageName: string;
  binaryName?: string;
  distPath?: string;
  defaultArgs?: string[];
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
  warnings?: string[];
}

export const KNOWN_MCP_SERVER_ALIASES: Readonly<Record<string, KnownMcpServerAlias>> = {
  everything: {
    packageName: '@modelcontextprotocol/server-everything',
    binaryName: 'mcp-server-everything',
    distPath: 'dist/index.js',
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
    binaryName: 'mcp-server-filesystem',
    distPath: 'dist/index.js',
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

export async function resolveKnownMcpServerAliasRuntime(
  name: string,
  options: {
    platform?: McpPlatform;
    workspacePath?: string;
    fileExists?: (path: string) => boolean;
    globalNpmRootResolver?: () => Promise<string | undefined>;
  } = {}
): Promise<ResolvedMcpServerAlias | undefined> {
  const normalized = name.trim().toLowerCase();
  const alias = getKnownMcpServerAlias(normalized);
  if (!alias) return undefined;

  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? win32 : posix;
  const fileExists = options.fileExists ?? existsSync;
  const workspacePath = pathApi.resolve(
    options.workspacePath ??
    process.env['WORKSPACE_DIR'] ??
    pathApi.join(process.cwd(), 'workspace')
  );
  const globalRoot = options.globalNpmRootResolver
    ? await options.globalNpmRootResolver()
    : await getGlobalNpmRoot({ platform });
  const packageEntry = globalRoot && alias.distPath
    ? pathApi.join(globalRoot, alias.packageName, alias.distPath)
    : undefined;

  if (packageEntry && fileExists(packageEntry)) {
    return {
      name: normalized,
      alias,
      config: {
        command: 'node',
        args: [
          packageEntry,
          ...(normalized === 'filesystem' ? [workspacePath] : []),
        ],
      },
      usingFallback: false,
    };
  }

  const fallbackArgs = normalized === 'filesystem'
    ? [...alias.fallbackArgs.slice(0, -1), workspacePath]
    : [...alias.fallbackArgs];
  return {
    name: normalized,
    alias,
    config: {
      command: getNpxCommand(platform),
      args: fallbackArgs,
    },
    usingFallback: true,
    warnings: [
      `Global package ${alias.packageName} was not found; using ${getNpxCommand(platform)} fallback. First start may be slower.`,
    ],
  };
}
