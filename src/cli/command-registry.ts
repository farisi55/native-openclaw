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
  { command: '/cron', description: 'Show cronjob help', aliases: ['/jobs', '/schedule'] },
  { command: '/cron list', description: 'List cronjobs' },
  { command: '/cron get', description: 'Show cronjob details', usage: '/cron get <id-or-name>', requiresArgument: true },
  { command: '/cron create', description: 'Create cronjob from natural language', usage: '/cron create <text>', requiresArgument: true },
  { command: '/cron update', description: 'Update cronjob schedule', usage: '/cron update <id-or-name> jam <HH:mm>', requiresArgument: true },
  { command: '/cron delete', description: 'Delete cronjob', usage: '/cron delete <id-or-name>', requiresArgument: true },
  { command: '/cron enable', description: 'Enable cronjob', usage: '/cron enable <id-or-name>', requiresArgument: true },
  { command: '/cron disable', description: 'Disable cronjob', usage: '/cron disable <id-or-name>', requiresArgument: true },
  { command: '/cron run', description: 'Run cronjob now', usage: '/cron run <id-or-name>', requiresArgument: true },
  { command: '/cron runs', description: 'Show cronjob run history' },
  { command: '/self-improve', description: 'Show self-improvement help', aliases: ['/self', '/improve'] },
  { command: '/self-improve status', description: 'Show self-improvement status' },
  { command: '/self-improve skills', description: 'List auto-generated skills' },
  { command: '/self-improve stats', description: 'Show self-improvement stats' },
  { command: '/self-improve evaluate', description: 'Run self-improvement evaluation now' },
  { command: '/self-improve enable', description: 'Show how to enable self-improvement' },
  { command: '/self-improve disable', description: 'Show how to disable self-improvement' },
  { command: '/heal', description: 'Show self-healing help', aliases: ['/self-heal'] },
  { command: '/heal status', description: 'Show self-healing status' },
  { command: '/heal runs', description: 'List self-healing runs' },
  { command: '/heal report', description: 'Show self-healing report', usage: '/heal report <runId>', requiresArgument: true },
  { command: '/heal diff', description: 'Show self-healing diff report', usage: '/heal diff <runId>', requiresArgument: true },
  { command: '/heal run', description: 'Run autonomous self-healing', usage: '/heal run <instruction>', aliases: ['/fix'], requiresArgument: true },
  { command: '/upgrade', description: 'Show self-upgrade help', aliases: ['/self-upgrade'] },
  { command: '/upgrade status', description: 'Show self-upgrade status' },
  { command: '/upgrade runs', description: 'List self-upgrade runs' },
  { command: '/upgrade report', description: 'Show self-upgrade report', usage: '/upgrade report <runId>', requiresArgument: true },
  { command: '/upgrade diff', description: 'Show self-upgrade diff report', usage: '/upgrade diff <runId>', requiresArgument: true },
  { command: '/upgrade run', description: 'Run autonomous self-upgrade', usage: '/upgrade run <instruction>', requiresArgument: true },
  { command: '/prompt-optimize', description: 'Show prompt optimizer status', aliases: ['/po'] },
  { command: '/prompt-optimize status', description: 'Show prompt optimizer status' },
  { command: '/prompt-optimize test', description: 'Preview prompt optimization', usage: '/prompt-optimize test <text>', aliases: ['/po test'], requiresArgument: true },
  { command: '/prompt-optimize last', description: 'Show last prompt optimization summary' },
  { command: '/system-execute', description: 'Show system-execute policy', aliases: ['/exec'] },
  { command: '/system-execute policy', description: 'Show system-execute risk policy' },
  { command: '/system-execute approvals', description: 'List pending dangerous command approvals', aliases: ['/exec approvals'] },
  { command: '/system-execute approve', description: 'Approve a pending dangerous command', usage: '/system-execute approve <id>', aliases: ['/exec approve'], requiresArgument: true },
  { command: '/system-execute reject', description: 'Reject a pending dangerous command', usage: '/system-execute reject <id>', aliases: ['/exec reject'], requiresArgument: true },
  { command: '/restart', description: 'Schedule graceful restart when manual restart is enabled' },
  { command: '/restart status', description: 'Show restart lifecycle status' },
  { command: '/agents', description: 'List AgentGateway connectors' },
  { command: '/agents list', description: 'List AgentGateway connectors' },
  { command: '/agents health', description: 'Check enabled external agent health' },
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
