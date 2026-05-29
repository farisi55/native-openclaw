/**
 * cli/commands.ts
 * Handlers for all slash-commands available inside the chat REPL.
 */

import type { IProvider, ProviderRegistry } from '../types/provider';
import type { SkillRegistry } from '../skills/registry';
import type { SessionManager, Session } from '../storage/session-manager';
import type { SettingsManager } from '../storage/settings-manager';
import type { ToolRegistry } from '../tools/tool-registry';
import type { McpManager } from '../mcp';
import { installTool, listAvailable } from '../tools/tool-installer';
import { WorkspaceManager } from '../workspace';
import {
  getDnsServers,
  getProxyConfig,
  maskProxyUrl,
  networkCheck,
} from '../network';
import {
  ensureWorkflowTemplate,
  loadWorkflowMarkdown,
  parseWorkflowMarkdown,
  runWorkflowFromWorkspace,
  validateWorkflowDefinition,
  workflowSummary,
} from '../workflows';
import { handleCronCommand, type SchedulerActionContext } from '../scheduler';
import { handleSelfImprovingAction, type SelfImprovingActionContext } from '../skills';

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  red:     '\x1b[31m',
  white:   '\x1b[37m',
} as const;

function c(color: keyof typeof C, text: string): string {
  return `${C[color]}${text}${C.reset}`;
}

function hr(char = '─', width = 60): string {
  return char.repeat(width);
}

// ─── CLIContext ───────────────────────────────────────────────────────────────

export interface CLIContext {
  providers: ProviderRegistry;
  skillRegistry: SkillRegistry;
  sessions: SessionManager;
  settings: SettingsManager;
  toolRegistry: ToolRegistry;
  mcpManager?: McpManager;
  scheduler?: SchedulerActionContext;
  selfImproving?: SelfImprovingActionContext;
  activeProvider: IProvider;
  activeModel: string;
  activeSessionId: string | null;
  setProvider: (provider: IProvider, model: string) => void;
  setModel: (model: string) => void;
  setSession: (id: string | null) => Promise<void>;
}

// ─── /help ────────────────────────────────────────────────────────────────────

export function cmdHelp(): void {
  const lines = [
    '',
    c('bold', c('cyan', '  native-openclaw — Command Reference')),
    c('dim', `  ${hr()}`),
    '',
    `  ${c('yellow', '/help')}                         Show this help message`,
    `  ${c('yellow', '/models')}                       List models for all providers`,
    `  ${c('yellow', '/models <provider>')}            List models for one provider`,
    `  ${c('yellow', '/model')}                        Show current model`,
    `  ${c('yellow', '/model <model-id>')}             Switch to a different model`,
    `  ${c('yellow', '/provider')}                     Show current provider`,
    `  ${c('yellow', '/providers')}                    Show providers`,
    `  ${c('yellow', '/provider <id>')}                Switch to a different provider`,
    `  ${c('yellow', '/skills')}                       List registered skills`,
    `  ${c('yellow', '/skills on <id>')}               Activate a skill`,
    `  ${c('yellow', '/skills off <id>')}              Deactivate a skill`,
    `  ${c('yellow', '/session')}                      Show current session info`,
    `  ${c('yellow', '/session new')}                  Start a new session`,
    `  ${c('yellow', '/session list')}                 List all saved sessions`,
    `  ${c('yellow', '/session switch <id>')}           Resume a session by id`,
    `  ${c('yellow', '/session <id>')}                 Resume a session by id`,
    `  ${c('yellow', '/session delete <id>')}          Delete a session by id`,
    `  ${c('yellow', '/settings')}                     Show persistent settings`,
    `  ${c('yellow', '/settings default-model <id>')}   Set default model for current provider`,
    `  ${c('yellow', '/settings default-provider <id>')}  Set default provider`,
    `  ${c('yellow', '/workspace')}                    Show workspace info`,
    `  ${c('yellow', '/workspace info')}               Show workspace status`,
    `  ${c('yellow', '/workspace init')}               Create missing workspace files`,
    `  ${c('yellow', '/workspace reload')}             Reload workspace context`,
    `  ${c('yellow', '/workspace list')}               List workspace files`,
    `  ${c('yellow', '/workspace tree')}               Show workspace tree`,
    `  ${c('yellow', '/workspace read <file>')}        Read a workspace file`,
    `  ${c('yellow', '/workspace write <file> <text>')} Write a workspace file`,
    `  ${c('yellow', '/workspace append <file> <text>')} Append to a workspace file`,
    `  ${c('yellow', '/workspace mkdir <folder>')}     Create a workspace folder`,
    `  ${c('yellow', '/workspace trash <file>')}       Move a workspace path to trash`,
    `  ${c('yellow', '/workspace backup')}             Create a workspace backup`,
    `  ${c('yellow', '/memory')}                       Show workspace memory commands`,
    `  ${c('yellow', '/memory show')}                  Read MEMORY.md`,
    `  ${c('yellow', '/memory daily')}                 Read today's daily memory log`,
    `  ${c('yellow', '/heartbeat')}                    Show HEARTBEAT.md checklist`,
    `  ${c('yellow', '/network')}                      Show network diagnostics help`,
    `  ${c('yellow', '/network dns')}                  Show configured DNS servers`,
    `  ${c('yellow', '/network check <host>')}         Resolve a host`,
    `  ${c('yellow', '/network proxy')}                Show proxy config`,
    `  ${c('yellow', '/mcp')}                          Show MCP command help`,
    `  ${c('yellow', '/mcp list')}                     List configured MCP servers`,
    `  ${c('yellow', '/mcp add <name> [json]')}        Add MCP server preset or config`,
    `  ${c('yellow', '/mcp start <name>')}             Start an MCP server`,
    `  ${c('yellow', '/mcp stop <name>')}              Stop an MCP server`,
    `  ${c('yellow', '/mcp tools [name]')}             List MCP tools`,
    `  ${c('yellow', '/workflow')}                     Show workflow command help`,
    `  ${c('yellow', '/workflow show')}                Show WORKFLOW.md summary`,
    `  ${c('yellow', '/workflow run')}                 Execute WORKFLOW.md`,
    `  ${c('yellow', '/workflow validate')}            Validate WORKFLOW.md`,
    `  ${c('yellow', '/cron')}                         Show cronjob commands`,
    `  ${c('yellow', '/cron list')}                    List cronjobs`,
    `  ${c('yellow', '/cron create <text>')}           Create cronjob from natural language`,
    `  ${c('yellow', '/cron run <id-or-name>')}        Run a cronjob now`,
    `  ${c('yellow', '/self-improve status')}          Show self-improvement status`,
    `  ${c('yellow', '/self-improve skills')}          List auto-generated skills`,
    `  ${c('yellow', '/self-improve evaluate')}        Run skill self-evaluation`,
    `  ${c('yellow', '/tools')}                         List all installed tools`,
    `  ${c('yellow', '/tools install <name>')}          Install a tool from tools/available/`,
    `  ${c('yellow', '/tools enable <name>')}           Enable a disabled tool`,
    `  ${c('yellow', '/tools disable <name>')}          Disable a tool (keeps it installed)`,
    `  ${c('yellow', '/exit')}                          Quit the application`,
    '',
    c('dim', `  ${hr()}`),
    c('dim', '  Natural language actions (no slash needed):'),
    c('dim', '    list skills  |  use skill <id>  |  install skill <id>  |  disable skill <id>'),
    c('dim', '    delete session <id>'),
    '',
    c('dim', '  Tool actions (no slash, handled instantly):'),
    c('dim', '    what time is it?    |  what is the date?'),
    c('dim', '    what is the news?   |  fetch url <url>'),
    c('dim', '    get data from API /path'),
    '',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

// ─── /models ──────────────────────────────────────────────────────────────────

export async function cmdModels(ctx: CLIContext, args: string[]): Promise<void> {
  const targetId = args[0]?.toLowerCase();

  const providers = targetId
    ? (() => {
        const p = ctx.providers.get(targetId);
        if (!p) {
          process.stdout.write(c('red', `  Provider "${targetId}" not found.\n\n`));
          process.stdout.write(c('dim', `  Available: ${[...ctx.providers.keys()].join(', ')}\n\n`));
          return [];
        }
        return [p];
      })()
    : [...ctx.providers.values()];

  if (providers.length === 0) return;

  process.stdout.write('\n');

  for (const provider of providers) {
    process.stdout.write(
      `  ${c('bold', c('magenta', provider.displayName))} ${c('dim', `(${provider.id})`)}\n`
    );
    process.stdout.write(c('dim', `  ${hr('─', 50)}\n`));

    try {
      const models = await provider.listModels();
      if (models.length === 0) {
        process.stdout.write(c('dim', '  No models available.\n'));
      } else {
        for (const m of models.slice(0, 20)) {
          const active = provider.id === ctx.activeProvider.id && m.id === ctx.activeModel;
          const marker = active ? c('green', ' ✓') : '  ';
          const ctxWin = m.contextWindow >= 1000
            ? `${Math.round(m.contextWindow / 1000)}k`
            : String(m.contextWindow);
          const flags = [
            m.supportsTools ? c('cyan', 'tools') : '',
            m.supportsVision ? c('blue', 'vision') : '',
          ].filter(Boolean).join(' ');
          process.stdout.write(
            `${marker} ${c('white', m.id.padEnd(45))} ${c('dim', ctxWin.padStart(5))} ${flags}\n`
          );
        }
        if (models.length > 20) {
          process.stdout.write(c('dim', `  … and ${models.length - 20} more.\n`));
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(c('red', `  Error fetching models: ${msg}\n`));
    }
    process.stdout.write('\n');
  }
  process.stdout.write(c('dim', `  Tip: /model <id> to switch model\n\n`));
}

// ─── /model ───────────────────────────────────────────────────────────────────

export async function cmdModel(ctx: CLIContext, args: string[]): Promise<void> {
  const modelId = args.join(' ').trim();

  if (!modelId) {
    process.stdout.write('\n');
    process.stdout.write(`  ${c('bold', 'Active Model')}\n`);
    process.stdout.write(c('dim', `  ${hr('─', 50)}\n`));
    process.stdout.write(`  ${c('dim', 'Provider')}  ${c('magenta', ctx.activeProvider.displayName)}\n`);
    process.stdout.write(`  ${c('dim', 'Model   ')}  ${c('cyan', ctx.activeModel)}\n`);
    process.stdout.write(c('dim', '\n  /model <id> to switch.  /models to list available.\n\n'));
    return;
  }

  let modelExists = false;
  try {
    const models = await ctx.activeProvider.listModels();
    modelExists = models.some((m) => m.id === modelId);
  } catch {
    modelExists = true;
  }

  if (!modelExists) {
    process.stdout.write(c('red', `\n  Model "${modelId}" not found in ${ctx.activeProvider.displayName}.\n`));
    process.stdout.write(c('dim', '  Run /models to see available models.\n\n'));
    return;
  }

  const previous = ctx.activeModel;
  ctx.setModel(modelId);
  process.stdout.write(
    c('green', `\n  Model switched: ${c('dim', previous)} → ${c('cyan', modelId)}\n\n`)
  );
}

// ─── /skills ──────────────────────────────────────────────────────────────────

export function cmdSkills(ctx: CLIContext, args: string[]): void {
  const [action, id] = args;

  if (action === 'on' && id) {
    if (!ctx.skillRegistry.has(id)) {
      process.stdout.write(c('red', `  Skill "${id}" not found.\n\n`));
      return;
    }
    ctx.skillRegistry.activate(id);
    process.stdout.write(c('green', `  Skill "${id}" activated.\n\n`));
    return;
  }

  if (action === 'off' && id) {
    ctx.skillRegistry.deactivate(id);
    process.stdout.write(c('yellow', `  Skill "${id}" deactivated.\n\n`));
    return;
  }

  const all = ctx.skillRegistry.all();
  const activeIds = new Set(ctx.skillRegistry.activeIds);

  if (all.length === 0) {
    process.stdout.write(c('dim', '\n  No skills loaded. Add .md files to the skills/ directory.\n\n'));
    return;
  }

  process.stdout.write('\n');
  process.stdout.write(`  ${c('bold', 'Registered Skills')}\n`);
  process.stdout.write(c('dim', `  ${hr('─', 50)}\n`));

  for (const skill of all) {
    const status = activeIds.has(skill.id)
      ? c('green', ' ● active')
      : c('dim', ' ○ off   ');
    const tags = skill.frontmatter.tags.length
      ? c('dim', ` [${skill.frontmatter.tags.join(', ')}]`)
      : '';
    process.stdout.write(
      `  ${status}  ${c('bold', skill.name.padEnd(24))} ${c('dim', skill.id)}${tags}\n`
    );
    if (skill.description) {
      process.stdout.write(`           ${c('dim', skill.description)}\n`);
    }
  }
  process.stdout.write(c('dim', '\n  /skills on <id> | /skills off <id>\n'));
  process.stdout.write('\n');
}

// ─── /session ─────────────────────────────────────────────────────────────────

async function createAndActivateSession(ctx: CLIContext): Promise<Session> {
  const result = await ctx.sessions.create({
    providerId: ctx.activeProvider.id,
    model: ctx.activeModel,
    activeSkills: ctx.skillRegistry.activeIds,
  });

  if (!result.ok) throw result.error;

  await ctx.setSession(result.value.id);
  return result.value;
}

async function fallbackAfterActiveDelete(ctx: CLIContext): Promise<Session> {
  const recentResult = await ctx.sessions.getMostRecentSession();
  if (!recentResult.ok) throw recentResult.error;

  if (recentResult.value) {
    await ctx.setSession(recentResult.value.id);
    return recentResult.value;
  }

  return createAndActivateSession(ctx);
}

export async function cmdSession(ctx: CLIContext, args: string[]): Promise<void> {
  const [action, subArg] = args;

  // new
  if (action === 'new') {
    const session = await createAndActivateSession(ctx);
    process.stdout.write(c('green', `\n  New session ${session.id.slice(0, 8)}… started.\n\n`));
    return;
  }

  // list
  if (action === 'list') {
    const result = await ctx.sessions.list();
    if (!result.ok) { process.stdout.write(c('red', `  Error: ${result.error.message}\n\n`)); return; }
    const list = result.value;
    if (list.length === 0) { process.stdout.write(c('dim', '\n  No saved sessions.\n\n')); return; }

    process.stdout.write('\n');
    process.stdout.write(`  ${c('bold', 'Saved Sessions')}\n`);
    process.stdout.write(c('dim', `  ${hr('─', 60)}\n`));
    for (const s of list.slice(0, 15)) {
      const active = s.id === ctx.activeSessionId;
      const marker = active ? c('green', '▶') : ' ';
      const turns = s.messages.filter((m) => m.role === 'user').length;
      process.stdout.write(
        `  ${marker} ${c('cyan', s.id.slice(0, 8))}…  ` +
        `${c('white', s.model.padEnd(30))} ` +
        `${c('dim', `${turns} turn(s)  ${new Date(s.updatedAt).toLocaleString()}`)}\n`
      );
    }
    if (list.length > 15) process.stdout.write(c('dim', `  … and ${list.length - 15} more.\n`));
    process.stdout.write(c('dim', '\n  /session delete <id> to remove\n'));
    process.stdout.write('\n');
    return;
  }

  // delete <id>
  if (action === 'delete' && subArg) {
    const result = await ctx.sessions.deleteSession(subArg);
    if (!result.ok) {
      process.stdout.write(c('red', `\n  Error: ${result.error.message}\n\n`));
      return;
    }
    if (!result.value) {
      process.stdout.write(c('red', `\n  No session found matching "${subArg}".\n\n`));
      return;
    }
    const deletedId = result.value;
    // If deleted the active session, switch to the most recent remaining session.
    if (ctx.activeSessionId && deletedId === ctx.activeSessionId) {
      const fallback = await fallbackAfterActiveDelete(ctx);
      process.stdout.write(
        c('yellow', `\n  Session ${deletedId.slice(0, 8)}… deleted (was active). `) +
        c('green', `Now using ${fallback.id.slice(0, 8)}…\n\n`)
      );
    } else {
      if (ctx.activeSessionId) {
        await ctx.settings.setLastActiveSessionId(ctx.activeSessionId);
      }
      process.stdout.write(c('green', `\n  Session ${deletedId.slice(0, 8)}… deleted.\n\n`));
    }
    return;
  }

  // resume by partial id
  const switchId = action === 'switch' ? subArg : action;
  if (switchId && !['new', 'list', 'delete', 'switch'].includes(switchId)) {
    const result = await ctx.sessions.list();
    if (!result.ok) { process.stdout.write(c('red', `  Error: ${result.error.message}\n\n`)); return; }
    const match = result.value.find((s) => s.id.startsWith(switchId));
    if (!match) { process.stdout.write(c('red', `  Session "${switchId}" not found.\n\n`)); return; }
    await ctx.setSession(match.id);
    const turns = match.messages.filter((m) => m.role === 'user').length;
    process.stdout.write(c('green', `\n  Session ${match.id.slice(0, 8)}… resumed (${turns} turn(s)).\n\n`));
    return;
  }

  if (action === 'switch' && !subArg) {
    process.stdout.write(c('yellow', '\n  Usage: /session switch <id>\n\n'));
    return;
  }

  // show current
  if (!ctx.activeSessionId) {
    process.stdout.write(c('dim', '\n  No active session. Send a message to start one.\n\n'));
    return;
  }

  const result = await ctx.sessions.get(ctx.activeSessionId);
  if (!result.ok || !result.value) {
    process.stdout.write(c('red', '\n  Could not load current session.\n\n'));
    return;
  }
  const s: Session = result.value;
  const turns = s.messages.filter((m) => m.role === 'user').length;
  process.stdout.write('\n');
  process.stdout.write(`  ${c('bold', 'Current Session')}\n`);
  process.stdout.write(c('dim', `  ${hr('─', 50)}\n`));
  process.stdout.write(`  ${c('dim', 'ID       ')} ${c('cyan', s.id)}\n`);
  process.stdout.write(`  ${c('dim', 'Provider ')} ${s.providerId}\n`);
  process.stdout.write(`  ${c('dim', 'Model    ')} ${s.model}\n`);
  process.stdout.write(`  ${c('dim', 'Turns    ')} ${turns}\n`);
  process.stdout.write(`  ${c('dim', 'Messages ')} ${s.messages.length}\n`);
  process.stdout.write(`  ${c('dim', 'Started  ')} ${new Date(s.createdAt).toLocaleString()}\n`);
  process.stdout.write(`  ${c('dim', 'Updated  ')} ${new Date(s.updatedAt).toLocaleString()}\n`);
  if (s.activeSkills.length > 0) process.stdout.write(`  ${c('dim', 'Skills   ')} ${s.activeSkills.join(', ')}\n`);
  process.stdout.write('\n');
}

// ─── /provider ────────────────────────────────────────────────────────────────

export async function cmdProvider(ctx: CLIContext, args: string[]): Promise<void> {
  const [targetId] = args;

  if (!targetId) {
    process.stdout.write('\n');
    process.stdout.write(`  ${c('bold', 'Active Provider')}\n`);
    process.stdout.write(c('dim', `  ${hr('─', 50)}\n`));
    process.stdout.write(`  ${c('dim', 'Provider')}  ${c('magenta', ctx.activeProvider.displayName)} ${c('dim', `(${ctx.activeProvider.id})`)}\n`);
    process.stdout.write(`  ${c('dim', 'Model   ')}  ${c('cyan', ctx.activeModel)}\n`);
    process.stdout.write('\n');
    process.stdout.write(`  ${c('bold', 'All Providers')}\n`);
    for (const [id, p] of ctx.providers) {
      const active = id === ctx.activeProvider.id;
      const marker = active ? c('green', '▶') : ' ';
      process.stdout.write(`  ${marker} ${c('white', id.padEnd(15))} ${c('dim', p.displayName)}\n`);
    }
    process.stdout.write(c('dim', '\n  /provider <id>  |  /model <id>\n'));
    process.stdout.write('\n');
    return;
  }

  const provider = ctx.providers.get(targetId);
  if (!provider) {
    process.stdout.write(c('red', `\n  Provider "${targetId}" not found.\n`));
    process.stdout.write(c('dim', `  Available: ${[...ctx.providers.keys()].join(', ')}\n\n`));
    return;
  }

  // Resolution order:
  // 1. settings.json defaultModels[providerId]  (per-provider saved default)
  // 2. BUILTIN_DEFAULTS[providerId]              (from SettingsManager)
  // 3. listModels()[0]                           (first available)
  // 4. ENV var <PROVIDER>_DEFAULT_MODEL          (last resort)
  let model: string;

  // Step 1+2: check per-provider default (includes built-ins)
  const savedDefault = await ctx.settings.getDefaultModelForProvider(targetId);
  if (savedDefault) {
    model = savedDefault;
  } else {
    // Step 3: try listModels
    try {
      const models = await provider.listModels();
      const first = models[0];
      model = first ? first.id : (process.env[`${targetId.toUpperCase()}_DEFAULT_MODEL`] ?? 'unknown');
    } catch {
      // Step 4: env var fallback
      model = process.env[`${targetId.toUpperCase()}_DEFAULT_MODEL`] ?? 'unknown';
    }
  }

  ctx.setProvider(provider, model);
  process.stdout.write(c('green', `\n  Switched to ${provider.displayName} — model: ${model}\n`));
  process.stdout.write(c('dim', `  Use /model <id> to change model, /settings default-model <id> to save.\n\n`));
}

// ─── /settings ────────────────────────────────────────────────────────────────

export async function cmdSettings(ctx: CLIContext, args: string[]): Promise<void> {
  const [action, ...rest] = args;

  if (action === 'default-model' && rest.length > 0) {
    const model = rest.join(' ').trim();
    // Save per-provider AND legacy flat key
    await ctx.settings.setDefaultModelForProvider(ctx.activeProvider.id, model);
    process.stdout.write(c('green', `\n  Default model for ${ctx.activeProvider.id} set to: ${model}\n`));
    process.stdout.write(c('dim', '  This will be used next time you switch to this provider.\n\n'));
    return;
  }

  if (action === 'default-provider' && rest.length > 0) {
    const providerId = rest[0]!.trim();
    if (!ctx.providers.has(providerId)) {
      process.stdout.write(c('red', `\n  Provider "${providerId}" not found.\n\n`));
      return;
    }
    await ctx.settings.setDefaultProvider(providerId);
    process.stdout.write(c('green', `\n  Default provider set to: ${providerId}\n\n`));
    return;
  }

  // Show all settings
  const all = await ctx.settings.all();
  const perProviderMap = (all.defaultModels ?? {}) as Record<string, string>;
  process.stdout.write('\n');
  process.stdout.write(`  ${c('bold', 'Persistent Settings')}  ${c('dim', '(saved in settings.json)')}\n`);
  process.stdout.write(c('dim', `  ${'─'.repeat(56)}\n`));
  process.stdout.write(`  ${c('dim', 'defaultProvider       ')}  ${all.defaultProvider ?? c('dim', '(not set)')}\n`);
  process.stdout.write(`  ${c('dim', 'defaultModel (legacy) ')}  ${all.defaultModel ?? c('dim', '(not set)')}\n`);
  if (Object.keys(perProviderMap).length > 0) {
    process.stdout.write('\n');
    process.stdout.write(`  ${c('bold', 'Per-provider default models:')}\n`);
    for (const [pid, m] of Object.entries(perProviderMap)) {
      process.stdout.write(`    ${c('dim', pid.padEnd(14))}  ${c('cyan', m)}\n`);
    }
  }
  process.stdout.write('\n');
  process.stdout.write(c('dim', '  Commands:\n'));
  process.stdout.write(c('dim', '    /settings default-model <model-id>       ← saves for current provider\n'));
  process.stdout.write(c('dim', '    /settings default-provider <provider-id>\n'));
  process.stdout.write('\n');
}

// ─── /workspace ───────────────────────────────────────────────────────────────

export async function cmdWorkspace(_ctx: CLIContext, args: string[]): Promise<void> {
  const [action, target, ...rest] = args;
  const workspace = new WorkspaceManager();
  await workspace.ensureWorkspace();

  if (!action) {
    process.stdout.write('\n');
    process.stdout.write(`  ${c('bold', 'Workspace')}\n`);
    process.stdout.write(c('dim', `  ${hr('─', 56)}\n`));
    process.stdout.write(`  ${c('dim', 'Root')}  ${workspace.rootDir}\n\n`);
    process.stdout.write(c('dim', '  Commands:\n'));
    process.stdout.write(c('dim', '    /workspace info\n'));
    process.stdout.write(c('dim', '    /workspace init\n'));
    process.stdout.write(c('dim', '    /workspace reload\n'));
    process.stdout.write(c('dim', '    /workspace list\n'));
    process.stdout.write(c('dim', '    /workspace tree\n'));
    process.stdout.write(c('dim', '    /workspace read <file>\n'));
    process.stdout.write(c('dim', '    /workspace write <file> <text>\n'));
    process.stdout.write(c('dim', '    /workspace append <file> <text>\n'));
    process.stdout.write(c('dim', '    /workspace mkdir <folder>\n'));
    process.stdout.write(c('dim', '    /workspace trash <file>\n'));
    process.stdout.write(c('dim', '    /workspace backup\n\n'));
    return;
  }

  try {
    if (action === 'info') {
      const info = await workspace.info();
      process.stdout.write('\n');
      process.stdout.write(`  ${c('bold', 'Workspace Info')}\n`);
      process.stdout.write(c('dim', `  ${hr('─', 56)}\n`));
      process.stdout.write(`  ${c('dim', 'Root       ')} ${info.rootDir}\n`);
      process.stdout.write(`  ${c('dim', 'Files      ')} ${info.fileCount}\n`);
      process.stdout.write(`  ${c('dim', 'Directories')} ${info.directoryCount}\n`);
      process.stdout.write(`  ${c('dim', 'Size       ')} ${info.totalBytes} bytes\n\n`);
      process.stdout.write(`  ${c('bold', 'Core Files')}\n`);
      for (const file of info.coreFiles) {
        process.stdout.write(`  ${file.exists ? c('green', 'ok     ') : c('red', 'missing')} ${file.path}\n`);
      }
      process.stdout.write('\n');
      return;
    }

    if (action === 'init') {
      await workspace.ensureWorkspace();
      process.stdout.write(c('green', `\n  Workspace initialized: ${workspace.rootDir}\n\n`));
      return;
    }

    if (action === 'reload') {
      await workspace.reloadContext();
      process.stdout.write(c('green', '\n  Workspace context will be read from current Markdown files on the next turn.\n\n'));
      return;
    }

    if (action === 'list') {
      const entries = await workspace.list(target ?? '.');
      process.stdout.write('\n');
      process.stdout.write(`  ${c('bold', 'Workspace Files')}\n`);
      process.stdout.write(c('dim', `  ${hr('─', 56)}\n`));
      if (entries.length === 0) {
        process.stdout.write(c('dim', '  (empty)\n\n'));
        return;
      }
      for (const entry of entries) {
        const marker = entry.type === 'directory' ? c('cyan', 'dir ') : c('white', 'file');
        process.stdout.write(`  ${marker}  ${entry.path}\n`);
      }
      process.stdout.write('\n');
      return;
    }

    if (action === 'tree') {
      const tree = await workspace.tree(target ?? '.');
      process.stdout.write('\n');
      process.stdout.write(`  ${c('bold', 'Workspace Tree')}\n`);
      process.stdout.write(c('dim', `  ${hr('─', 56)}\n`));
      process.stdout.write(tree.split('\n').map((line) => `  ${line}`).join('\n'));
      process.stdout.write('\n\n');
      return;
    }

    if (action === 'read' && target) {
      const content = await workspace.read(target);
      process.stdout.write('\n');
      process.stdout.write(`  ${c('bold', target)}\n`);
      process.stdout.write(c('dim', `  ${hr('─', 56)}\n`));
      process.stdout.write(content.split('\n').map((line) => `  ${line}`).join('\n'));
      process.stdout.write('\n\n');
      return;
    }

    if (action === 'write' && target) {
      await workspace.write(target, rest.join(' '));
      process.stdout.write(c('green', `\n  Wrote workspace file: ${target}\n\n`));
      return;
    }

    if (action === 'append' && target) {
      await workspace.append(target, rest.join(' '));
      process.stdout.write(c('green', `\n  Appended to workspace file: ${target}\n\n`));
      return;
    }

    if (action === 'mkdir' && target) {
      await workspace.mkdir(target);
      process.stdout.write(c('green', `\n  Created workspace folder: ${target}\n\n`));
      return;
    }

    if (action === 'trash' && target) {
      const trashPath = await workspace.trash(target);
      process.stdout.write(c('yellow', `\n  Moved to workspace trash: ${trashPath}\n\n`));
      return;
    }

    if (action === 'backup') {
      const backupPath = await workspace.backup();
      process.stdout.write(c('green', `\n  Workspace backup created: ${backupPath}\n\n`));
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(c('red', `\n  Workspace error: ${msg}\n\n`));
    return;
  }

  process.stdout.write(c('yellow', '\n  Usage: /workspace [info|init|reload|list|tree|read|write|append|mkdir|trash|backup] ...\n\n'));
}

// ─── /memory ──────────────────────────────────────────────────────────────────

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function cmdMemory(_ctx: CLIContext, args: string[]): Promise<void> {
  const [action, ...rest] = args;
  const workspace = new WorkspaceManager();
  await workspace.ensureWorkspace();

  if (!action) {
    process.stdout.write('\n');
    process.stdout.write(`  ${c('bold', 'Workspace Memory')}\n`);
    process.stdout.write(c('dim', `  ${hr('─', 56)}\n`));
    process.stdout.write(c('dim', '  Commands:\n'));
    process.stdout.write(c('dim', '    /memory show\n'));
    process.stdout.write(c('dim', '    /memory append <text>\n'));
    process.stdout.write(c('dim', '    /memory daily\n'));
    process.stdout.write(c('dim', '    /memory daily <YYYY-MM-DD>\n'));
    process.stdout.write(c('dim', '    /memory summarize\n\n'));
    return;
  }

  try {
    if (action === 'show') {
      const content = await workspace.read('MEMORY.md');
      process.stdout.write('\n');
      process.stdout.write(`  ${c('bold', 'MEMORY.md')}\n`);
      process.stdout.write(c('dim', `  ${hr('─', 56)}\n`));
      process.stdout.write(content.split('\n').map((line) => `  ${line}`).join('\n'));
      process.stdout.write('\n\n');
      return;
    }

    if (action === 'append') {
      const text = rest.join(' ').trim();
      if (!text) {
        process.stdout.write(c('yellow', '\n  Usage: /memory append <text>\n\n'));
        return;
      }
      await workspace.appendLongTermMemory(text);
      await workspace.appendDailyMemory({
        type: 'project_decision',
        summary: text,
        source: 'cli',
        details: 'Appended to MEMORY.md from /memory append.',
      });
      process.stdout.write(c('green', '\n  Appended to workspace/MEMORY.md.\n\n'));
      return;
    }

    if (action === 'daily') {
      const date = rest[0] ?? todayYmd();
      const content = await workspace.readDailyMemory(date);
      process.stdout.write('\n');
      process.stdout.write(`  ${c('bold', `Daily Memory - ${date}`)}\n`);
      process.stdout.write(c('dim', `  ${hr('─', 56)}\n`));
      process.stdout.write(content.split('\n').map((line) => `  ${line}`).join('\n'));
      process.stdout.write('\n\n');
      return;
    }

    if (action === 'summarize') {
      const date = todayYmd();
      const content = await workspace.readDailyMemory(date);
      if (content.startsWith('No daily memory log')) {
        process.stdout.write(c('yellow', `\n  ${content}\n\n`));
        return;
      }
      await workspace.updateLongTermMemory([
        `Summary from daily log ${date}:`,
        content.slice(0, 3000),
      ].join('\n'));
      process.stdout.write(c('green', `\n  Appended a summary from memory/${date}.md to MEMORY.md.\n\n`));
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(c('red', `\n  Memory error: ${msg}\n\n`));
    return;
  }

  process.stdout.write(c('yellow', '\n  Usage: /memory [show|append|daily|summarize] ...\n\n'));
}

// ─── /heartbeat ───────────────────────────────────────────────────────────────

export async function cmdHeartbeat(_ctx: CLIContext, args: string[]): Promise<void> {
  const [action] = args;
  const workspace = new WorkspaceManager();
  await workspace.ensureWorkspace();

  if (!action || action === 'show') {
    const content = await workspace.read('HEARTBEAT.md');
    process.stdout.write('\n');
    process.stdout.write(`  ${c('bold', 'HEARTBEAT.md')}\n`);
    process.stdout.write(c('dim', `  ${hr('─', 56)}\n`));
    process.stdout.write(content.split('\n').map((line) => `  ${line}`).join('\n'));
    process.stdout.write('\n\n');
    return;
  }

  if (action === 'run') {
    process.stdout.write(c('yellow', '\n  Heartbeat execution is not automatic yet. Showing checklist instead.\n\n'));
    await cmdHeartbeat(_ctx, ['show']);
    return;
  }

  process.stdout.write(c('yellow', '\n  Usage: /heartbeat [show|run]\n\n'));
}

// ─── /network ─────────────────────────────────────────────────────────────────

// --- /cron -----------------------------------------------------------------

export async function cmdCron(ctx: CLIContext, args: string[]): Promise<void> {
  if (!ctx.scheduler) {
    process.stdout.write(c('yellow', '\n  Scheduler is not initialized.\n\n'));
    return;
  }

  const outputText = await handleCronCommand(args, ctx.scheduler, 'cli');
  process.stdout.write('\n');
  process.stdout.write(outputText.split('\n').map((line) => `  ${line}`).join('\n'));
  process.stdout.write('\n\n');
}

export async function cmdSelfImprove(ctx: CLIContext, args: string[]): Promise<void> {
  if (!ctx.selfImproving) {
    process.stdout.write(c('yellow', '\n  Self-improvement context is not initialized.\n\n'));
    return;
  }

  const input = `/self-improve${args.length > 0 ? ` ${args.join(' ')}` : ''}`;
  const result = await handleSelfImprovingAction(input, ctx.selfImproving);
  process.stdout.write('\n');
  process.stdout.write((result.response ?? '').split('\n').map((line) => `  ${line}`).join('\n'));
  process.stdout.write('\n\n');
}

export async function cmdNetwork(_ctx: CLIContext, args: string[]): Promise<void> {
  const [action, target] = args;

  if (!action) {
    process.stdout.write('\n');
    process.stdout.write(`  ${c('bold', 'Network')}\n`);
    process.stdout.write(c('dim', `  ${hr('─', 56)}\n`));
    process.stdout.write(c('dim', '  Commands:\n'));
    process.stdout.write(c('dim', '    /network dns\n'));
    process.stdout.write(c('dim', '    /network check <host>\n'));
    process.stdout.write(c('dim', '    /network proxy\n\n'));
    return;
  }

  if (action === 'dns') {
    const servers = getDnsServers();
    process.stdout.write('\n');
    process.stdout.write(`  ${c('bold', 'DNS')}\n`);
    process.stdout.write(c('dim', `  ${hr('─', 56)}\n`));
    process.stdout.write(`  ${c('dim', 'DNS_SERVERS')}  ${servers.length > 0 ? servers.join(', ') : c('dim', '(OS default)')}\n\n`);
    return;
  }

  if (action === 'proxy') {
    const proxy = getProxyConfig();
    process.stdout.write('\n');
    process.stdout.write(`  ${c('bold', 'Proxy')}\n`);
    process.stdout.write(c('dim', `  ${hr('─', 56)}\n`));
    process.stdout.write(`  ${c('dim', 'HTTP_PROXY ')}  ${maskProxyUrl(proxy.httpProxy) ?? c('dim', '(not set)')}\n`);
    process.stdout.write(`  ${c('dim', 'HTTPS_PROXY')}  ${maskProxyUrl(proxy.httpsProxy) ?? c('dim', '(not set)')}\n`);
    process.stdout.write(`  ${c('dim', 'NO_PROXY   ')}  ${proxy.noProxy.length > 0 ? proxy.noProxy.join(', ') : c('dim', '(not set)')}\n\n`);
    return;
  }

  if (action === 'check' && target) {
    const result = await networkCheck(target);
    process.stdout.write('\n');
    process.stdout.write(`  ${c('bold', 'Network Check')}\n`);
    process.stdout.write(c('dim', `  ${hr('─', 56)}\n`));
    process.stdout.write(`  ${c('dim', 'Host     ')}  ${result.host}\n`);
    process.stdout.write(`  ${c('dim', 'DNS      ')}  ${result.servers.length > 0 ? result.servers.join(', ') : '(OS default)'}\n`);
    process.stdout.write(`  ${c('dim', 'Status   ')}  ${result.ok ? c('green', 'resolved') : c('red', 'failed')}\n`);
    if (result.addresses.length > 0) {
      process.stdout.write(`  ${c('dim', 'Addresses')}  ${result.addresses.join(', ')}\n`);
    }
    if (result.error) {
      process.stdout.write(`  ${c('dim', 'Error    ')}  ${result.error}\n`);
    }
    process.stdout.write('\n');
    return;
  }

  process.stdout.write(c('yellow', '\n  Usage: /network [dns|proxy|check <host>]\n\n'));
}

// ─── /mcp ───────────────────────────────────────────────────────────────────

export async function cmdMcp(ctx: CLIContext, args: string[]): Promise<void> {
  const [action, name, ...rest] = args;
  const manager = ctx.mcpManager;

  if (!manager) {
    process.stdout.write(c('yellow', '\n  MCP is disabled or not initialized.\n\n'));
    return;
  }

  if (!action) {
    process.stdout.write('\n');
    process.stdout.write(`  ${c('bold', 'MCP')}\n`);
    process.stdout.write(c('dim', `  ${hr('─', 56)}\n`));
    process.stdout.write(`  ${c('dim', 'Config')}  ${manager.path}\n\n`);
    process.stdout.write(c('dim', '  Commands:\n'));
    process.stdout.write(c('dim', '    /mcp list\n'));
    process.stdout.write(c('dim', '    /mcp add <name> [json]\n'));
    process.stdout.write(c('dim', '    /mcp remove <name>\n'));
    process.stdout.write(c('dim', '    /mcp start <name>\n'));
    process.stdout.write(c('dim', '    /mcp stop <name>\n'));
    process.stdout.write(c('dim', '    /mcp restart <name>\n'));
    process.stdout.write(c('dim', '    /mcp tools [name]\n\n'));
    return;
  }

  try {
    if (action === 'list') {
      const servers = await manager.listServers();
      process.stdout.write('\n');
      process.stdout.write(`  ${c('bold', 'MCP Servers')}\n`);
      process.stdout.write(c('dim', `  ${hr('─', 56)}\n`));
      if (servers.length === 0) {
        process.stdout.write(c('dim', '  No MCP servers configured.\n\n'));
        return;
      }
      for (const server of servers) {
        const status = server.status === 'running' ? c('green', '● running') : c('dim', '○ stopped');
        const argsText = server.args.length > 0 ? ` ${server.args.join(' ')}` : '';
        process.stdout.write(`  ${status}  ${c('cyan', server.name.padEnd(16))} ${server.command}${argsText}\n`);
      }
      process.stdout.write('\n');
      return;
    }

    if (action === 'add' && name) {
      await manager.addServerFromInput(name, rest.join(' ').trim() || undefined);
      process.stdout.write(c('green', `\n  MCP server "${name}" added.\n\n`));
      return;
    }

    if (action === 'remove' && name) {
      const removed = await manager.removeServer(name);
      process.stdout.write(
        removed
          ? c('green', `\n  MCP server "${name}" removed.\n\n`)
          : c('yellow', `\n  MCP server "${name}" is not configured.\n\n`)
      );
      return;
    }

    if (action === 'start' && name) {
      const tools = await manager.startServer(name);
      process.stdout.write(c('green', `\n  MCP server "${name}" started with ${tools.length} tool(s).\n\n`));
      return;
    }

    if (action === 'stop' && name) {
      const stopped = await manager.stopServer(name);
      process.stdout.write(
        stopped
          ? c('yellow', `\n  MCP server "${name}" stopped.\n\n`)
          : c('yellow', `\n  MCP server "${name}" was not running.\n\n`)
      );
      return;
    }

    if (action === 'restart' && name) {
      const tools = await manager.restartServer(name);
      process.stdout.write(c('green', `\n  MCP server "${name}" restarted with ${tools.length} tool(s).\n\n`));
      return;
    }

    if (action === 'tools') {
      const tools = manager.listTools(name);
      process.stdout.write('\n');
      process.stdout.write(`  ${c('bold', 'MCP Tools')}\n`);
      process.stdout.write(c('dim', `  ${hr('─', 56)}\n`));
      if (tools.length === 0) {
        process.stdout.write(c('dim', '  No MCP tools loaded. Start a server first.\n\n'));
        return;
      }
      for (const tool of tools) {
        process.stdout.write(`  ${c('cyan', tool.runtimeName.padEnd(32))} ${c('dim', tool.description ?? '')}\n`);
      }
      process.stdout.write('\n');
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(c('red', `\n  MCP error: ${msg}\n\n`));
    return;
  }

  process.stdout.write(c('yellow', '\n  Usage: /mcp [list|add|remove|start|stop|restart|tools] ...\n\n'));
}

// ─── /workflow ──────────────────────────────────────────────────────────────

export async function cmdWorkflow(ctx: CLIContext, args: string[]): Promise<void> {
  const [action] = args;
  const workspace = new WorkspaceManager();

  if (!action) {
    process.stdout.write('\n');
    process.stdout.write(`  ${c('bold', 'Workflow')}\n`);
    process.stdout.write(c('dim', `  ${hr('─', 56)}\n`));
    process.stdout.write(c('dim', '  Commands:\n'));
    process.stdout.write(c('dim', '    /workflow show\n'));
    process.stdout.write(c('dim', '    /workflow run\n'));
    process.stdout.write(c('dim', '    /workflow edit\n'));
    process.stdout.write(c('dim', '    /workflow template\n'));
    process.stdout.write(c('dim', '    /workflow validate\n\n'));
    return;
  }

  try {
    if (action === 'template') {
      const path = await ensureWorkflowTemplate(workspace);
      process.stdout.write(c('green', `\n  WORKFLOW.md ready: ${path}\n\n`));
      return;
    }

    if (action === 'show') {
      const loaded = await loadWorkflowMarkdown(workspace);
      const workflow = parseWorkflowMarkdown(loaded.markdown);
      process.stdout.write('\n');
      process.stdout.write(`  ${c('bold', 'WORKFLOW.md')}\n`);
      process.stdout.write(c('dim', `  ${hr('─', 56)}\n`));
      process.stdout.write(workflowSummary(workflow).split('\n').map((line) => `  ${line}`).join('\n'));
      process.stdout.write('\n\n');
      return;
    }

    if (action === 'validate') {
      const loaded = await loadWorkflowMarkdown(workspace);
      const workflow = parseWorkflowMarkdown(loaded.markdown);
      const errors = validateWorkflowDefinition(workflow);
      if (errors.length === 0) {
        process.stdout.write(c('green', `\n  WORKFLOW.md is valid: ${loaded.path}\n\n`));
      } else {
        process.stdout.write(c('red', '\n  WORKFLOW.md validation errors:\n'));
        for (const error of errors) process.stdout.write(c('red', `  - ${error}\n`));
        process.stdout.write('\n');
      }
      return;
    }

    if (action === 'edit') {
      const path = await ensureWorkflowTemplate(workspace);
      const editor = process.env['VISUAL'] || process.env['EDITOR'];
      if (editor && process.stdin.isTTY) {
        const { spawnSync } = await import('child_process');
        const result = spawnSync(editor, [path], { stdio: 'inherit', shell: true });
        if (result.error) {
          process.stdout.write(c('yellow', `\n  Could not open editor: ${result.error.message}\n`));
          process.stdout.write(c('dim', `  Edit this file manually: ${path}\n\n`));
        }
      } else {
        process.stdout.write(c('dim', `\n  Edit this file manually: ${path}\n\n`));
      }
      return;
    }

    if (action === 'run') {
      const result = await runWorkflowFromWorkspace({
        ...(ctx.mcpManager ? { mcpManager: ctx.mcpManager } : {}),
        toolRegistry: ctx.toolRegistry,
        provider: ctx.activeProvider,
        model: ctx.activeModel,
        workspace,
      });
      process.stdout.write('\n');
      process.stdout.write(result.content.split('\n').map((line) => `  ${line}`).join('\n'));
      process.stdout.write('\n\n');
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(c('red', `\n  Workflow error: ${msg}\n\n`));
    return;
  }

  process.stdout.write(c('yellow', '\n  Usage: /workflow [show|run|edit|template|validate]\n\n'));
}

// ─── /tools ───────────────────────────────────────────────────────────────────

export async function cmdTools(ctx: CLIContext, args: string[]): Promise<void> {
  const [action, name] = args;

  // /tools install <name>
  if (action === 'install' && name) {
    const result = await installTool(name);
    if (!result.ok) {
      process.stdout.write(c('red', `\n  ❌ ${result.message}\n\n`));
      return;
    }
    await ctx.toolRegistry.loadTools();
    ctx.mcpManager?.registerRunningTools();
    process.stdout.write(c('green', `\n  ✅ ${result.message}\n`));
    process.stdout.write(c('dim', `  Registry reloaded: ${ctx.toolRegistry.size} tool(s) active.\n\n`));
    return;
  }

  // /tools enable <name>
  if (action === 'enable' && name) {
    try {
      await ctx.toolRegistry.enableTool(name);
      ctx.mcpManager?.registerRunningTools();
      process.stdout.write(c('green', `\n  ✅ Tool "${name}" enabled.\n\n`));
    } catch (e) {
      process.stdout.write(c('red', `\n  ❌ ${String(e)}\n\n`));
    }
    return;
  }

  // /tools disable <name>
  if (action === 'disable' && name) {
    try {
      await ctx.toolRegistry.disableTool(name);
      process.stdout.write(c('yellow', `\n  ⬜ Tool "${name}" disabled.\n\n`));
    } catch (e) {
      process.stdout.write(c('red', `\n  ❌ ${String(e)}\n\n`));
    }
    return;
  }

  // /tools — list all
  const tools = ctx.toolRegistry.listTools();
  const available = listAvailable();

  process.stdout.write('\n');
  process.stdout.write(`  ${c('bold', 'Installed Tools')}\n`);
  process.stdout.write(c('dim', `  ${'─'.repeat(56)}\n`));

  if (tools.length === 0) {
    process.stdout.write(c('dim', '  No tools loaded.\n'));
  } else {
    for (const tool of tools) {
      const m = tool.manifest;
      const status = m.enabled ? c('green', ' ● active') : c('dim', ' ○ off   ');
      process.stdout.write(
        `  ${status}  ${c('bold', m.name.padEnd(16))} ` +
        `${c('dim', `v${m.version}`).padEnd(12)}  ${c('dim', m.description)}\n`
      );
    }
  }

  if (available.length > 0) {
    process.stdout.write('\n');
    process.stdout.write(`  ${c('bold', 'Available to Install')}\n`);
    process.stdout.write(c('dim', `  ${'─'.repeat(56)}\n`));
    for (const name_ of available) {
      const alreadyInstalled = ctx.toolRegistry.has(name_);
      const marker = alreadyInstalled ? c('dim', '  (installed)') : '';
      process.stdout.write(`    ${c('dim', name_)}${marker}\n`);
    }
  }

  process.stdout.write('\n');
  process.stdout.write(c('dim', '  /tools install <name>  |  /tools enable <name>  |  /tools disable <name>\n'));
  process.stdout.write('\n');
}
