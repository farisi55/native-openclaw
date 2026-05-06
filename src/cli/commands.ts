/**
 * cli/commands.ts
 * Handlers for all slash-commands available inside the chat REPL.
 */

import type { IProvider, ProviderRegistry } from '../types/provider';
import type { SkillRegistry } from '../skills/registry';
import type { SessionManager, Session } from '../storage/session-manager';
import type { SettingsManager } from '../storage/settings-manager';

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
  activeProvider: IProvider;
  activeModel: string;
  activeSessionId: string | null;
  setProvider: (provider: IProvider, model: string) => void;
  setModel: (model: string) => void;
  setSession: (id: string | null) => void;
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
    `  ${c('yellow', '/provider <id>')}                Switch to a different provider`,
    `  ${c('yellow', '/skills')}                       List registered skills`,
    `  ${c('yellow', '/skills on <id>')}               Activate a skill`,
    `  ${c('yellow', '/skills off <id>')}              Deactivate a skill`,
    `  ${c('yellow', '/session')}                      Show current session info`,
    `  ${c('yellow', '/session new')}                  Start a new session`,
    `  ${c('yellow', '/session list')}                 List all saved sessions`,
    `  ${c('yellow', '/session <id>')}                 Resume a session by id`,
    `  ${c('yellow', '/session delete <id>')}          Delete a session by id`,
    `  ${c('yellow', '/settings')}                     Show persistent settings`,
    `  ${c('yellow', '/settings default-model <id>')}   Set default model for current provider`,
    `  ${c('yellow', '/settings default-provider <id>')}  Set default provider`,
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

export async function cmdSession(ctx: CLIContext, args: string[]): Promise<void> {
  const [action, subArg] = args;

  // new
  if (action === 'new') {
    ctx.setSession(null);
    process.stdout.write(c('green', '\n  New session started.\n\n'));
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
    // If deleted the active session → clear it
    if (ctx.activeSessionId && deletedId === ctx.activeSessionId) {
      ctx.setSession(null);
      process.stdout.write(c('yellow', `\n  Session ${deletedId.slice(0, 8)}… deleted (was active). New session started.\n\n`));
    } else {
      process.stdout.write(c('green', `\n  Session ${deletedId.slice(0, 8)}… deleted.\n\n`));
    }
    return;
  }

  // resume by partial id
  if (action && !['new', 'list', 'delete'].includes(action)) {
    const result = await ctx.sessions.list();
    if (!result.ok) { process.stdout.write(c('red', `  Error: ${result.error.message}\n\n`)); return; }
    const match = result.value.find((s) => s.id.startsWith(action));
    if (!match) { process.stdout.write(c('red', `  Session "${action}" not found.\n\n`)); return; }
    ctx.setSession(match.id);
    const turns = match.messages.filter((m) => m.role === 'user').length;
    process.stdout.write(c('green', `\n  Session ${match.id.slice(0, 8)}… resumed (${turns} turn(s)).\n\n`));
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
