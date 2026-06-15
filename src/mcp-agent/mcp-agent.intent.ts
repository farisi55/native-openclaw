import type { ParsedMcpConfigIntent } from './mcp-agent.types';
import { getKnownMcpServerAlias } from '../mcp/mcp-server-aliases';

const MCP_TERM_RE = /\b(?:mcp|model\s+context\s+protocol)\b/i;
const CONFIG_FILE_RE = /\bmcp_agent\.config\.ya?ml\b/i;
const CONFIG_ACTION_RE =
  /\b(?:tambahkan|tambah|daftarkan|register|add|update|ubah|hapus|remove|delete|list|daftar|tampilkan|show)\b/i;
const LIST_RE = /\b(?:list|daftar|tampilkan|show|lihat)\b/i;
const REMOVE_RE = /\b(?:hapus|remove|delete)\b/i;

function normalizeServerName(value: string): string {
  return value
    .trim()
    .replace(/^["'`]|["'`]$/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function tokenizeCommand(value: string): string[] {
  const tokens: string[] = [];
  const tokenRe = /"([^"]*)"|'([^']*)'|`([^`]*)`|([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(value)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (token) tokens.push(token);
  }
  return tokens;
}

function extractConfigPath(input: string): string | undefined {
  const explicit = /(?:file|path|config(?:uration)?|konfigurasi)\s+["'`]?([^\s"'`]+)["'`]?/i.exec(input);
  if (explicit?.[1]) return explicit[1].replace(/[),.;:]+$/, '');
  return CONFIG_FILE_RE.test(input) ? 'mcp_agent.config.yaml' : undefined;
}

function extractServerName(input: string): string | undefined {
  const patterns = [
    /\b(?:tambahkan|tambah|daftarkan|register|add|update|ubah|hapus|remove|delete)\s+mcp\s+server\s+([a-z0-9][a-z0-9 _.-]*?)(?=\s+(?:ke\s+(?:dalam\s+)?(?:file|config)|dari\s+(?:file|config)|to\b|from\b|gunakan|using|use|pakai|dengan|with)\b|[.,;:]|$)/i,
    /\b(?:tambahkan|tambah|daftarkan|register|add|update|ubah|hapus|remove|delete)\s+(?:server\s+)?mcp\s+([a-z0-9][a-z0-9 _.-]*?)(?=\s+(?:ke\s+(?:dalam\s+)?(?:file|config)|dari\s+(?:file|config)|to\b|from\b|gunakan|using|use|pakai|dengan|with)\b|[.,;:]|$)/i,
    /\b(?:server\s+mcp|mcp\s+server)\s+([a-z0-9][a-z0-9 _.-]*?)(?=\s+(?:ke\s+(?:dalam\s+)?(?:file|config)|dari\s+(?:file|config)|to\b|from\b|gunakan|using|use|pakai|dengan|with)\b|[.,;:]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(input);
    if (match?.[1]) return normalizeServerName(match[1]);
  }
  return undefined;
}

function extractCommand(input: string): { command: string; args: string[] } | null {
  const quoted = /\b(?:perintah(?:\s+eksekusi)?|command|exec(?:ution)?\s+command)\b\s*[:=]?\s*["'`]([^"'`]+)["'`]/i.exec(input);
  const unquoted = /\b(?:perintah(?:\s+eksekusi)?|command)\b\s*[:=]?\s*((?:npx|uvx|node|nodejs|python|python3|deno)\b[^.;\r\n]*)/i.exec(input);
  const raw = quoted?.[1] ?? unquoted?.[1];
  if (!raw) return null;

  const tokens = tokenizeCommand(raw.trim());
  const command = tokens.shift();
  return command ? { command, args: tokens } : null;
}

function extractUrl(input: string): string | undefined {
  return /\bhttps?:\/\/[^\s"'`]+/i.exec(input)?.[0]?.replace(/[),.;]+$/, '');
}

export function isMcpConfigurationIntent(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed || !MCP_TERM_RE.test(trimmed)) return false;
  if (CONFIG_FILE_RE.test(trimmed)) return true;
  if (!CONFIG_ACTION_RE.test(trimmed)) return false;
  if (/\b(?:server|config|konfigurasi)\b/i.test(trimmed)) return true;
  const serverName = extractServerName(trimmed);
  return Boolean(serverName && getKnownMcpServerAlias(serverName));
}

export function classifyMcpConfigurationIntent(
  input: string
): 'mcp-config-update' | 'mcp-config-read' | null {
  if (!isMcpConfigurationIntent(input)) return null;
  return LIST_RE.test(input) && !REMOVE_RE.test(input)
    ? 'mcp-config-read'
    : 'mcp-config-update';
}

export function parseMcpConfigurationInstruction(input: string): ParsedMcpConfigIntent {
  if (!isMcpConfigurationIntent(input)) {
    throw new Error('Instruction is not an MCP configuration request.');
  }

  const configPath = extractConfigPath(input);
  if (LIST_RE.test(input) && !REMOVE_RE.test(input)) {
    return {
      action: 'list',
      ...(configPath ? { configPath } : {}),
    };
  }

  const serverName = extractServerName(input);
  if (!serverName) {
    throw new Error('MCP server name could not be determined from the instruction.');
  }

  if (REMOVE_RE.test(input)) {
    return {
      action: 'remove',
      serverName,
      ...(configPath ? { configPath } : {}),
    };
  }

  const command = extractCommand(input);
  const url = extractUrl(input);
  if (!command && !url && !getKnownMcpServerAlias(serverName)) {
    throw new Error('Provide either an MCP command or URL.');
  }

  return {
    action: 'configure',
    serverName,
    ...(command ? { command: command.command, args: command.args } : {}),
    ...(!command && url ? { url } : {}),
    ...(configPath ? { configPath } : {}),
  };
}
