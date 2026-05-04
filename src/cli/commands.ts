/**
 * cli/commands.ts
 * Handlers for all slash-commands available inside the chat REPL.
 *
 * Each handler receives the shared CLIContext and writes directly to
 * process.stdout. Commands never throw — errors are caught and displayed.
 */

import type { IProvider, ProviderRegistry } from '../types/provider';
import type { SkillRegistry } from '../skills/registry';
import type { SessionManager, Session } from '../storage/session-manager';

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  magenta:'\x1b[35m',
  red:    '\x1b[31m',
  white:  '\x1b[37m',
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
  activeProvider: IProvider;
  activeModel: string;
  activeSessionId: string | null;
  setProvider: (provider: IProvider, model: string) => void;
  setSession: (id: string | null) => void;
}

// ─── /help ────────────────────────────────────────────────────────────────────

export function cmdHelp(): void {
  const lines = [
    '',
    c('bold', c('cyan', '  native-openclaw — Command Reference')),
    c('dim', `  ${hr()}`),
    '',
    `  ${c('yellow', '/help')}              Show this help message`,
    `  ${c('yellow', '/models')}            List available models for all providers`,
    `  ${c('yellow', '/models <provider>')} List models for a specific provider`,
    `  ${c('yellow', '/skills')}            List registered skills and their status`,
    `  ${c('yellow', '/skills on <id>')}    Activate a skill by id`,
    `  ${c('yellow', '/skills off <id>')}   Deactivate a skill by id`,
    `  ${c('yellow', '/session')}           Show current session info`,
    `  ${c('yellow', '/session new')}       Start a new session (clears history)`,
    `  ${c('yellow', '/session list')}      List all saved sessions`,
    `  ${c('yellow', '/session <id>')}      Resume a session by id`,
    `  ${c('yellow', '/provider')}          Show current provider and model`,
    `  ${c('yellow', '/provider <id>')}     Switch to a different provider`,
    `  ${c('yellow', '/exit')}              Quit the application`,
    '',
    c('dim', `  ${hr()}`),
    c('dim', '  Any other input is sent to the AI as a chat message.'),
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
          process.stdout.write(c('red', `  Provider "${targetId}" not found.\n`));
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
          const ctx_win = m.contextWindow >= 1000
            ? `${Math.round(m.contextWindow / 1000)}k`
            : String(m.contextWindow);
          const flags = [
            m.supportsTools ? c('cyan', 'tools') : '',
            m.supportsVision ? c('blue', 'vision') : '',
          ].filter(Boolean).join(' ');
          process.stdout.write(
            `${marker} ${c('white', m.id.padEnd(45))} ${c('dim', ctx_win.padStart(5))} ${flags}\n`
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

  // List all skills.
  const all = ctx.skillRegistry.all();
  const activeIds = new Set(ctx.skillRegistry.activeIds);

  if (all.length === 0) {
    process.stdout.write(c('dim', '\n  No skills loaded. Add .md files to the /skills directory.\n\n'));
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
  process.stdout.write(
    c('dim', '\n  Toggle with /skills on <id> or /skills off <id>\n')
  );
  process.stdout.write('\n');
}

// ─── /session ─────────────────────────────────────────────────────────────────

export async function cmdSession(ctx: CLIContext, args: string[]): Promise<void> {
  const [action] = args;

  // Start a new session.
  if (action === 'new') {
    ctx.setSession(null);
    process.stdout.write(c('green', '\n  New session started. Previous history cleared.\n\n'));
    return;
  }

  // List saved sessions.
  if (action === 'list') {
    const result = await ctx.sessions.list();
    if (!result.ok) {
      process.stdout.write(c('red', `  Error: ${result.error.message}\n\n`));
      return;
    }
    const list = result.value;
    if (list.length === 0) {
      process.stdout.write(c('dim', '\n  No saved sessions found.\n\n'));
      return;
    }

    process.stdout.write('\n');
    process.stdout.write(`  ${c('bold', 'Saved Sessions')}\n`);
    process.stdout.write(c('dim', `  ${hr('─', 60)}\n`));

    for (const s of list.slice(0, 15)) {
      const active = s.id === ctx.activeSessionId;
      const marker = active ? c('green', '▶') : ' ';
      const turns = s.messages.filter((m) => m.role === 'user').length;
      const date = new Date(s.updatedAt).toLocaleString();
      process.stdout.write(
        `  ${marker} ${c('cyan', s.id.slice(0, 8))}…  ` +
        `${c('white', s.model.padEnd(30))} ` +
        `${c('dim', `${turns} turn(s)  ${date}`)}\n`
      );
    }
    if (list.length > 15) {
      process.stdout.write(c('dim', `  … and ${list.length - 15} more.\n`));
    }
    process.stdout.write('\n');
    return;
  }

  // Resume session by (partial) id.
  if (action && action !== 'new' && action !== 'list') {
    const result = await ctx.sessions.list();
    if (!result.ok) {
      process.stdout.write(c('red', `  Error: ${result.error.message}\n\n`));
      return;
    }
    const match = result.value.find((s) => s.id.startsWith(action));
    if (!match) {
      process.stdout.write(c('red', `  Session "${action}" not found.\n\n`));
      return;
    }
    ctx.setSession(match.id);
    const turns = match.messages.filter((m) => m.role === 'user').length;
    process.stdout.write(
      c('green', `\n  Session ${match.id.slice(0, 8)}… resumed (${turns} turn(s)).\n\n`)
    );
    return;
  }

  // Show current session info.
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
  if (s.activeSkills.length > 0) {
    process.stdout.write(`  ${c('dim', 'Skills   ')} ${s.activeSkills.join(', ')}\n`);
  }
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
    process.stdout.write(c('dim', '\n  Switch with /provider <id>\n'));
    process.stdout.write('\n');
    return;
  }

  const provider = ctx.providers.get(targetId);
  if (!provider) {
    process.stdout.write(c('red', `\n  Provider "${targetId}" not found.\n\n`));
    return;
  }

  // Pick the first available model for the new provider.
  let model: string;
  try {
    const models = await provider.listModels();
    if (models.length === 0) throw new Error('No models available');
    const firstModel = models[0];
    if (!firstModel) throw new Error('No models available');
    model = firstModel.id;
  } catch {
    const envModel = process.env[`${targetId.toUpperCase()}_DEFAULT_MODEL`];
    if (!envModel) {
      process.stdout.write(c('red', `\n  Could not fetch models for "${targetId}".\n\n`));
      return;
    }
    model = envModel;
  }

  ctx.setProvider(provider, model);
  process.stdout.write(
    c('green', `\n  Switched to ${provider.displayName} — model: ${model}\n\n`)
  );
}
