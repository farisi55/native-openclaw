export interface SlashCommandDefinition {
  command: string;
  description: string;
  usage?: string;
  aliases?: string[];
  requiresArgument?: boolean;
}

export const SLASH_COMMANDS: SlashCommandDefinition[] = [
  { command: '/help', description: 'Show help', aliases: ['/h'] },
  { command: '/exit', description: 'Quit the application', aliases: ['/quit', '/q'] },
  { command: '/models', description: 'List models', aliases: ['/m'] },
  { command: '/model', description: 'Show current model' },
  { command: '/model', description: 'Switch active model', usage: '/model <model-id>', requiresArgument: true },
  { command: '/providers', description: 'Show providers', aliases: ['/p'] },
  { command: '/provider', description: 'Show current provider' },
  { command: '/provider', description: 'Switch active provider', usage: '/provider <id>', requiresArgument: true },
  { command: '/skills', description: 'List registered skills', aliases: ['/sk'] },
  { command: '/skills on', description: 'Activate a skill', usage: '/skills on <id>', requiresArgument: true },
  { command: '/skills off', description: 'Deactivate a skill', usage: '/skills off <id>', requiresArgument: true },
  { command: '/session', description: 'Show current session', aliases: ['/s'] },
  { command: '/session new', description: 'Create new session' },
  { command: '/session list', description: 'List all sessions' },
  { command: '/session switch', description: 'Switch active session', usage: '/session switch <id>', requiresArgument: true },
  { command: '/session delete', description: 'Delete a session', usage: '/session delete <id>', requiresArgument: true },
  { command: '/settings', description: 'Show persistent settings' },
  { command: '/settings default-model', description: 'Set default model', usage: '/settings default-model <model-id>', requiresArgument: true },
  { command: '/settings default-provider', description: 'Set default provider', usage: '/settings default-provider <provider-id>', requiresArgument: true },
  { command: '/tools', description: 'List installed tools', aliases: ['/t'] },
  { command: '/tools list', description: 'List installed tools' },
  { command: '/tools install', description: 'Install a tool', usage: '/tools install <name>', requiresArgument: true },
  { command: '/tools enable', description: 'Enable a tool', usage: '/tools enable <name>', requiresArgument: true },
  { command: '/tools disable', description: 'Disable a tool', usage: '/tools disable <name>', requiresArgument: true },
  { command: '/workspace', description: 'Show workspace info', aliases: ['/w'] },
  { command: '/workspace info', description: 'Show workspace status' },
  { command: '/workspace init', description: 'Create missing workspace files' },
  { command: '/workspace reload', description: 'Reload workspace context' },
  { command: '/workspace list', description: 'List workspace files' },
  { command: '/workspace tree', description: 'Show workspace tree' },
  { command: '/workspace read', description: 'Read workspace file', usage: '/workspace read <file>', requiresArgument: true },
  { command: '/workspace write', description: 'Write workspace file', usage: '/workspace write <file> <text>', requiresArgument: true },
  { command: '/workspace append', description: 'Append to workspace file', usage: '/workspace append <file> <text>', requiresArgument: true },
  { command: '/workspace mkdir', description: 'Create workspace folder', usage: '/workspace mkdir <folder>', requiresArgument: true },
  { command: '/workspace trash', description: 'Move workspace path to trash', usage: '/workspace trash <file>', requiresArgument: true },
  { command: '/workspace backup', description: 'Create workspace backup' },
  { command: '/memory', description: 'Show workspace memory help', aliases: ['/mem'] },
  { command: '/memory show', description: 'Read MEMORY.md' },
  { command: '/memory append', description: 'Append to MEMORY.md', usage: '/memory append <text>', requiresArgument: true },
  { command: '/memory daily', description: 'Read daily memory log' },
  { command: '/memory summarize', description: 'Append daily memory summary to MEMORY.md' },
  { command: '/heartbeat', description: 'Show HEARTBEAT.md checklist', aliases: ['/hb'] },
  { command: '/heartbeat show', description: 'Show HEARTBEAT.md checklist' },
  { command: '/heartbeat run', description: 'Show heartbeat checklist' },
  { command: '/mcp', description: 'Show MCP help' },
  { command: '/mcp list', description: 'List configured MCP servers' },
  { command: '/mcp add', description: 'Add MCP server', usage: '/mcp add <name> [json]', requiresArgument: true },
  { command: '/mcp remove', description: 'Remove MCP server', usage: '/mcp remove <name>', requiresArgument: true },
  { command: '/mcp start', description: 'Start MCP server', usage: '/mcp start <name>', requiresArgument: true },
  { command: '/mcp stop', description: 'Stop MCP server', usage: '/mcp stop <name>', requiresArgument: true },
  { command: '/mcp restart', description: 'Restart MCP server', usage: '/mcp restart <name>', requiresArgument: true },
  { command: '/mcp tools', description: 'List MCP tools' },
  { command: '/network', description: 'Show network diagnostics help', aliases: ['/net'] },
  { command: '/network dns', description: 'Show configured DNS servers' },
  { command: '/network check', description: 'Resolve a host', usage: '/network check <host>', requiresArgument: true },
  { command: '/network proxy', description: 'Show proxy configuration' },
  { command: '/workflow', description: 'Show workflow help', aliases: ['/wf'] },
  { command: '/workflow show', description: 'Show WORKFLOW.md summary' },
  { command: '/workflow run', description: 'Execute WORKFLOW.md' },
  { command: '/workflow edit', description: 'Open WORKFLOW.md in editor' },
  { command: '/workflow template', description: 'Create default WORKFLOW.md template' },
  { command: '/workflow validate', description: 'Validate WORKFLOW.md' },
];

function normalizeInput(input: string): string {
  return input.replace(/^\s+/, '').toLowerCase();
}

function allMatchableCommands(definition: SlashCommandDefinition): string[] {
  return [definition.command, ...(definition.aliases ?? [])];
}

function matchesCommand(candidate: string, query: string): boolean {
  const lowerCandidate = candidate.toLowerCase();
  if (lowerCandidate.startsWith(query)) return true;
  if (/\s$/.test(query)) return false;

  const queryParts = query.split(/\s+/).filter(Boolean);
  const candidateParts = lowerCandidate.split(/\s+/).filter(Boolean);

  return queryParts.every((part, index) => {
    const candidatePart = candidateParts[index];
    return candidatePart ? candidatePart.startsWith(part) : false;
  });
}

export function getSlashCommandSuggestions(
  input: string,
  max = 50,
  commands: readonly SlashCommandDefinition[] = SLASH_COMMANDS
): SlashCommandDefinition[] {
  const query = normalizeInput(input);
  if (!query.startsWith('/')) return [];

  const seen = new Set<string>();
  const matches: SlashCommandDefinition[] = [];

  for (const definition of commands) {
    const isMatch = allMatchableCommands(definition)
      .some((candidate) => matchesCommand(candidate, query));

    if (!isMatch || seen.has(definition.command)) continue;
    seen.add(definition.command);
    matches.push(definition);
    if (matches.length >= max) break;
  }

  return matches;
}

export function completionText(definition: SlashCommandDefinition): string {
  return definition.requiresArgument ? `${definition.command} ` : definition.command;
}

export function formatSlashCommandSuggestions(
  input: string,
  max = 10
): string {
  const suggestions = getSlashCommandSuggestions(input, max + 1);
  const visible = suggestions.slice(0, max);
  if (visible.length === 0) return '';

  const commandWidth = Math.max(...visible.map((item) => completionText(item).length));
  const lines = visible.map((item) => {
    const command = completionText(item).padEnd(commandWidth + 2);
    return `${command}${item.description}`;
  });

  if (suggestions.length > max) {
    lines.push(`... and ${suggestions.length - max} more`);
  }

  return lines.join('\n');
}
