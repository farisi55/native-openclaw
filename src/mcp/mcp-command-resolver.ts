import { execFile } from 'child_process';
import { isAbsolute } from 'path';

export const MCP_ALLOWED_LAUNCHERS: ReadonlySet<string> = new Set([
  'npx',
  'uvx',
  'node',
  'nodejs',
  'python',
  'python3',
  'deno',
]);

export const KNOWN_MCP_BINARIES: Readonly<Record<string, {
  packageName: string;
  nodePath: string;
}>> = {
  'mcp-server-everything': {
    packageName: '@modelcontextprotocol/server-everything',
    nodePath: '/usr/local/lib/node_modules/@modelcontextprotocol/server-everything/dist/index.js',
  },
  'mcp-server-filesystem': {
    packageName: '@modelcontextprotocol/server-filesystem',
    nodePath: '/usr/local/lib/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js',
  },
};

export interface McpCommandAssessment {
  valid: boolean;
  needsResolution: boolean;
  reason?: string;
  suggestion?: string;
}

export interface McpCommandResolution extends McpCommandAssessment {
  command: string;
  originalCommand: string;
  resolved: boolean;
}

export type McpWhichResolver = (command: string) => Promise<string | undefined>;

function executableName(command: string): string {
  return command.trim().split(/[\\/]/).at(-1) ?? command.trim();
}

function knownBinarySuggestion(command: string): string {
  const known = KNOWN_MCP_BINARIES[command];
  if (!known) return '';
  return [
    `Install it globally: npm install -g ${known.packageName}`,
    `Or configure command "node" with args ["${known.nodePath}"].`,
  ].join(' ');
}

export function assessMcpCommand(command: string): McpCommandAssessment {
  const trimmed = command.trim();
  if (!trimmed) {
    return {
      valid: false,
      needsResolution: false,
      reason: 'MCP server command is empty.',
    };
  }
  if (isAbsolute(trimmed)) {
    return { valid: true, needsResolution: false };
  }

  const executable = executableName(trimmed);
  if (MCP_ALLOWED_LAUNCHERS.has(executable)) {
    return { valid: true, needsResolution: false };
  }
  if (KNOWN_MCP_BINARIES[executable]) {
    return {
      valid: true,
      needsResolution: true,
      suggestion: knownBinarySuggestion(executable),
    };
  }
  return {
    valid: false,
    needsResolution: false,
    reason: `MCP server command "${executable}" is not allowed as a bare command.`,
    suggestion: `Use an absolute binary path, or one of: ${[...MCP_ALLOWED_LAUNCHERS].join(', ')}.`,
  };
}

export function defaultMcpWhichResolver(command: string): Promise<string | undefined> {
  const executable = process.platform === 'win32' ? 'where.exe' : 'which';
  return new Promise((resolve) => {
    execFile(executable, [command], { windowsHide: true, timeout: 5_000 }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      const first = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      resolve(first && isAbsolute(first) ? first : undefined);
    });
  });
}

export async function resolveMcpCommand(
  command: string,
  whichResolver: McpWhichResolver = defaultMcpWhichResolver
): Promise<McpCommandResolution> {
  const originalCommand = command.trim();
  const assessment = assessMcpCommand(originalCommand);
  if (!assessment.valid || !assessment.needsResolution) {
    return {
      ...assessment,
      command: originalCommand,
      originalCommand,
      resolved: false,
    };
  }

  const executable = executableName(originalCommand);
  const resolvedCommand = await whichResolver(executable);
  if (resolvedCommand) {
    return {
      valid: true,
      needsResolution: false,
      command: resolvedCommand,
      originalCommand,
      resolved: true,
    };
  }

  return {
    valid: false,
    needsResolution: false,
    command: originalCommand,
    originalCommand,
    resolved: false,
    reason:
      `MCP server command "${executable}" is not allowed as a bare command and could not be resolved.`,
    suggestion: knownBinarySuggestion(executable),
  };
}

export function formatMcpCommandResolutionError(resolution: McpCommandResolution): string {
  return [
    resolution.reason ?? `MCP server command "${resolution.originalCommand}" is not allowed.`,
    resolution.suggestion ? `Suggestion: ${resolution.suggestion}` : '',
  ].filter(Boolean).join('\n');
}

export function assertMcpCommandAllowed(command: string): void {
  const assessment = assessMcpCommand(command);
  if (assessment.valid) return;
  throw new Error([
    assessment.reason,
    assessment.suggestion ? `Suggestion: ${assessment.suggestion}` : '',
  ].filter(Boolean).join('\n'));
}
