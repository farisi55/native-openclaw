/**
 * cli/index.ts
 * Interactive chat REPL — connects all services.
 */

import * as readline from 'readline/promises';
import { stdin as input, stdout as output, exit } from 'process';
import type { ProviderRegistry, IProvider } from '../types/provider';
import type { SkillRegistry } from '../skills/registry';
import type { SessionManager } from '../storage/session-manager';
import type { SettingsManager } from '../storage/settings-manager';
import type { Orchestrator } from '../agents/orchestrator';
import {
  cmdHelp, cmdModels, cmdModel, cmdSkills,
  cmdSession, cmdProvider, cmdSettings,
  type CLIContext,
} from './commands';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  magenta: '\x1b[35m', red: '\x1b[31m', blue: '\x1b[34m',
} as const;

function c(color: keyof typeof C, text: string): string {
  return `${C[color]}${text}${C.reset}`;
}

function printBanner(providerName: string, model: string, skillCount: number): void {
  output.write([
    '',
    c('bold', c('cyan', '  ╔═══════════════════════════════════════╗')),
    c('bold', c('cyan', '  ║        native-openclaw  v1.0.0        ║')),
    c('bold', c('cyan', '  ║   Multi-Provider AI Agent Terminal    ║')),
    c('bold', c('cyan', '  ╚═══════════════════════════════════════╝')),
    '',
    `  ${c('dim', 'Provider')}  ${c('magenta', providerName)}`,
    `  ${c('dim', 'Model   ')}  ${c('cyan', model)}`,
    `  ${c('dim', 'Skills  ')}  ${skillCount > 0 ? c('green', String(skillCount) + ' loaded') : c('dim', 'none')}`,
    '',
    c('dim', '  Type a message, or /help for commands. /exit to quit.'),
    '',
  ].join('\n') + '\n');
}

function buildPrompt(providerId: string, modelId: string): string {
  const short = modelId.length > 22 ? modelId.slice(0, 20) + '…' : modelId;
  return `${C.bold}${C.green}you${C.reset} ${C.dim}(${providerId}/${short})${C.reset} › `;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function startSpinner(label: string): NodeJS.Timeout {
  let i = 0;
  return setInterval(() => {
    const frame = SPINNER_FRAMES[i++ % SPINNER_FRAMES.length] ?? '·';
    process.stdout.write(`\r  ${c('cyan', frame)} ${c('dim', label)}   `);
  }, 80);
}

function stopSpinner(timer: NodeJS.Timeout): void {
  clearInterval(timer);
  process.stdout.write('\r\x1b[2K');
}

function printAssistantReply(
  text: string,
  model: string,
  latencyMs: number,
  usage: { totalTokens: number } | undefined,
  wasAction: boolean
): void {
  const tokens = usage ? c('dim', ` · ${usage.totalTokens} tok`) : '';
  const lat = wasAction ? '' : c('dim', ` · ${latencyMs}ms`);
  const label = wasAction ? c('dim', 'action') : c('dim', model);
  output.write(`\n  ${c('bold', c('blue', 'assistant'))} ${label}${lat}${tokens}\n`);
  const indented = text.split('\n').map((l) => `  ${l}`).join('\n');
  output.write(indented + '\n\n');
}

async function dispatchCommand(raw: string, ctx: CLIContext): Promise<void> {
  const parts = raw.trim().slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase() ?? '';
  const args = parts.slice(1);

  switch (cmd) {
    case 'help': case 'h':      cmdHelp(); break;
    case 'models': case 'm':    await cmdModels(ctx, args); break;
    case 'model':               await cmdModel(ctx, args); break;
    case 'skills': case 'sk':   cmdSkills(ctx, args); break;
    case 'session': case 's':   await cmdSession(ctx, args); break;
    case 'provider': case 'p':  await cmdProvider(ctx, args); break;
    case 'settings':            await cmdSettings(ctx, args); break;
    case 'exit': case 'quit': case 'q':
      output.write(c('dim', '\n  Goodbye.\n\n'));
      exit(0);
      break;
    default:
      output.write(c('yellow', `\n  Unknown command: /${cmd}. Type /help.\n\n`));
  }
}

export interface CLIRunnerOptions {
  providers: ProviderRegistry;
  skillRegistry: SkillRegistry;
  sessions: SessionManager;
  settings: SettingsManager;
  orchestrator: Orchestrator;
}

export async function startCLI(opts: CLIRunnerOptions): Promise<void> {
  const { providers, skillRegistry, sessions, settings, orchestrator } = opts;

  if (providers.size === 0) {
    output.write(c('red', '\n  No providers available. Check your .env configuration.\n\n'));
    exit(1);
  }

  // ── Resolve startup provider (settings.json → priority list → first) ───────
  const savedProvider  = await settings.getDefaultProvider();
  const savedModel     = await settings.getDefaultModel();

  const priority = ['groq', 'openrouter', 'mistral', 'anthropic', 'openai', 'gemini', 'ollama'];
  let activeProvider: IProvider | undefined;

  // Try saved default first
  if (savedProvider && providers.has(savedProvider)) {
    activeProvider = providers.get(savedProvider);
  }
  // Fallback: priority list
  if (!activeProvider) {
    for (const id of priority) {
      const p = providers.get(id);
      if (p) { activeProvider = p; break; }
    }
  }
  // Final fallback: first available
  if (!activeProvider) activeProvider = [...providers.values()][0];

  // ── Resolve startup model (settings.json → listModels → env) ───────────────
  let activeModel = 'unknown';

  if (savedModel && savedProvider === activeProvider!.id) {
    // Saved default matches the active provider — use it directly
    activeModel = savedModel;
  } else {
    try {
      const models = await activeProvider!.listModels();
      if (models[0]) activeModel = models[0].id;
    } catch {
      const envKey = `${activeProvider!.id.toUpperCase()}_DEFAULT_MODEL`;
      activeModel = process.env[envKey] ?? 'unknown';
    }
  }

  let activeSessionId: string | null = null;

  // ── Build context ───────────────────────────────────────────────────────────
  const ctx: CLIContext = {
    providers,
    skillRegistry,
    sessions,
    settings,
    get activeProvider()  { return activeProvider!; },
    get activeModel()     { return activeModel; },
    get activeSessionId() { return activeSessionId; },
    setProvider(p: IProvider, m: string) { activeProvider = p; activeModel = m; },
    setModel(m: string)   { activeModel = m; },
    setSession(id: string | null) { activeSessionId = id; },
  };

  printBanner(activeProvider!.displayName, activeModel, skillRegistry.size);

  const rl = readline.createInterface({ input, output, terminal: true });
  rl.on('close', () => { output.write(c('dim', '\n  Goodbye.\n\n')); exit(0); });

  // ── REPL ───────────────────────────────────────────────────────────────────
  while (true) {
    let userInput: string;
    try {
      userInput = await rl.question(buildPrompt(activeProvider!.id, activeModel));
    } catch {
      output.write(c('dim', '\n  Goodbye.\n\n'));
      exit(0);
    }

    userInput = userInput.trim();
    if (!userInput) continue;

    if (userInput.startsWith('/')) {
      await dispatchCommand(userInput, ctx);
      continue;
    }

    const spinner = startSpinner('Thinking…');
    try {
      const result = await orchestrator.turn({
        userInput,
        provider: activeProvider!,
        model: activeModel,
        ...(activeSessionId !== null && { sessionId: activeSessionId }),
      });

      stopSpinner(spinner);

      if (!activeSessionId || result.newSession) {
        activeSessionId = result.session.id;
      }

      // Sync session id in case action-handler cleared it
      if (result.wasAction && !result.session.id) {
        activeSessionId = null;
      }

      printAssistantReply(
        result.assistantText,
        result.chatResponse?.model ?? activeModel,
        result.chatResponse?.latencyMs ?? 0,
        result.chatResponse?.usage,
        result.wasAction,
      );
    } catch (err) {
      stopSpinner(spinner);
      const msg = err instanceof Error ? err.message : String(err);
      output.write(c('red', `\n  Error: ${msg}\n\n`));
    }
  }
}
