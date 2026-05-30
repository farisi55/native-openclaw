import type { HealingRun } from './healing-types';
import type { SelfHealingEngine } from './self-healing-engine';
import type { SelfUpgradeEngine } from './self-upgrade-engine';
import type { LifecycleManager } from '../runtime/lifecycle-manager';

export interface SelfHealingActionContext {
  healingEnabled: boolean;
  upgradeEnabled: boolean;
  runsDir: string;
  healingEngine?: SelfHealingEngine;
  upgradeEngine?: SelfUpgradeEngine;
  lifecycleManager?: LifecycleManager;
}

export interface SelfHealingActionResult {
  handled: boolean;
  response?: string;
}

function healHelp(): string {
  return [
    'Self-healing commands:',
    '/heal status',
    '/heal runs',
    '/heal report <runId>',
    '/heal diff <runId>',
    '/heal run <instruction>',
    '',
    'Aliases: /fix, /self-heal',
  ].join('\n');
}

function upgradeHelp(): string {
  return [
    'Self-upgrade commands:',
    '/upgrade status',
    '/upgrade runs',
    '/upgrade report <runId>',
    '/upgrade diff <runId>',
    '/upgrade run <instruction>',
    '',
    'Aliases: /self-upgrade',
  ].join('\n');
}

function formatStatus(status: Record<string, unknown>): string {
  return Object.entries(status).map(([key, value]) => {
    const rendered = Array.isArray(value) ? value.join(', ') : String(value);
    return `${key}: ${rendered}`;
  }).join('\n');
}

function formatRun(run: HealingRun): string {
  return [
    `${run.id} ${run.status}`,
    `type: ${run.type}`,
    `loops: ${run.loops.length}/${run.maxLoops}`,
    `summary: ${run.finalSummary ?? run.error ?? '-'}`,
  ].join('\n');
}

function parseSlash(input: string): { kind: 'heal' | 'upgrade' | 'restart'; action: string; payload: string } | null {
  const trimmed = input.trim();
  const restart = /^\/restart(?:\s+([a-z-]+))?(?:\s+([\s\S]+))?$/i.exec(trimmed);
  if (restart) {
    return {
      kind: 'restart',
      action: (restart[1] ?? 'run').toLowerCase(),
      payload: (restart[2] ?? '').trim(),
    };
  }

  const heal = /^\/(?:heal|self-heal)(?:\s+([a-z-]+))?(?:\s+([\s\S]+))?$/i.exec(trimmed);
  if (heal) {
    return {
      kind: 'heal',
      action: (heal[1] ?? 'help').toLowerCase(),
      payload: (heal[2] ?? '').trim(),
    };
  }

  const fix = /^\/fix(?:\s+([\s\S]+))?$/i.exec(trimmed);
  if (fix) {
    return { kind: 'heal', action: 'run', payload: (fix[1] ?? '').trim() };
  }

  const upgrade = /^\/(?:upgrade|self-upgrade)(?:\s+([a-z-]+))?(?:\s+([\s\S]+))?$/i.exec(trimmed);
  if (upgrade) {
    return {
      kind: 'upgrade',
      action: (upgrade[1] ?? 'help').toLowerCase(),
      payload: (upgrade[2] ?? '').trim(),
    };
  }

  return null;
}

const EXPLICIT_SYSTEM_COMMAND_RE =
  /\b(?:jalankan\s+command|jalankan\s+perintah|execute|run\s+command|restart(?:\s+container|\s+service|\s+process)?|kill\s+process|hapus\s+file|delete\s+file|cek\s+proses|check\s+process|docker\s+logs|docker\s+restart|docker\s+stop|systemctl|pm2|export\s+[A-Z_]+=)\b/i;

const UPGRADE_RE =
  /\b(?:analisa\s+(?:lalu|dan)\s+upgrade|upgrade|self\s*upgrade|upgrade\s+yourself|tingkatkan\s+kemampuan|tambahkan\s+kemampuan|tambahkan\s+fitur|fitur\s+belum\s+ada|logic\s+belum\s+ada|tool\s+belum\s+ada|optimalkan\s+logic|optimalkan\s+penggunaan\s+token|efisiensi\s+penggunaan\s+token|perbaiki\s+arsitektur|buat\s+mekanisme\s+baru|tambahkan\s+mekanisme|tambahkan\s+guard\s+token|add\s+capability|add\s+feature|missing\s+capability|optimi[sz]e\s+token\s+usage|add\s+token\s+guard|add\s+context\s+budgeting|improve\s+context\s+compression)\b/i;

const TOKEN_LIMIT_RE =
  /\b(?:request\s+too\s+large|token\s+terlalu\s+besar|konteks\s+terlalu\s+besar|context\s+terlalu\s+besar|context\s+too\s+large|token\s+budget|context\s+budget|context\s+budgeting|penggunaan\s+token|efisiensi\s+token|efisiensi\s+penggunaan\s+token)\b/i;

const TOKEN_LIMIT_PREVENTION_RE =
  /\b(?:jangan\s+sampai\s+ada\s+(?:notif\s*:?\s*)?request\s+too\s+large|cegah\s+request\s+too\s+large|hindari\s+request\s+too\s+large|prevent\s+request\s+too\s+large|avoid\s+request\s+too\s+large)\b/i;

export function isSelfUpgradeIntent(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  if (parseSlash(trimmed)?.kind === 'upgrade') return true;
  if (EXPLICIT_SYSTEM_COMMAND_RE.test(trimmed)) return false;
  if (UPGRADE_RE.test(trimmed)) return true;
  if (TOKEN_LIMIT_PREVENTION_RE.test(trimmed)) return true;
  if (TOKEN_LIMIT_RE.test(trimmed) && /\b(?:optimalkan|optimi[sz]e|upgrade|tingkatkan|tambahkan|add|improve|cegah|hindari|prevent|avoid)\b/i.test(trimmed)) {
    return true;
  }
  return false;
}

export function buildSelfUpgradeInstruction(input: string): string {
  if (TOKEN_LIMIT_RE.test(input) || TOKEN_LIMIT_PREVENTION_RE.test(input)) {
    return [
      'Analyze and upgrade Native OpenClaw token efficiency to prevent "Request too large for model" errors.',
      'Implement context budgeting, model-aware token limits, tool result truncation, memory/workspace context trimming, and fallback before oversized requests.',
      'Ensure build and tests pass.',
      `Original request: ${input.trim()}`,
    ].join(' ');
  }
  return input.trim();
}

function parseNatural(input: string): { kind: 'heal' | 'upgrade'; payload: string } | null {
  if (isSelfUpgradeIntent(input)) {
    return { kind: 'upgrade', payload: buildSelfUpgradeInstruction(input) };
  }
  if (/\b(?:fix this bug|perbaiki bug ini|jalankan self healing|heal this error|fix failing test|repair build|solve this error)\b/i.test(input)) {
    return { kind: 'heal', payload: input.trim() };
  }
  return null;
}

export async function handleSelfHealingAction(
  input: string,
  ctx: SelfHealingActionContext,
  source: 'cli' | 'api' | 'telegram' | 'system' = 'cli'
): Promise<SelfHealingActionResult> {
  const slash = parseSlash(input);
  const natural = slash ? null : parseNatural(input);
  const parsed = slash ?? (natural ? { kind: natural.kind, action: 'run', payload: natural.payload } : null);
  if (!parsed) return { handled: false };

  if (parsed.kind === 'heal') {
    return handleHeal(parsed.action, parsed.payload, ctx, source);
  }
  if (parsed.kind === 'restart') {
    return handleRestart(parsed.action, ctx);
  }
  return handleUpgrade(parsed.action, parsed.payload, ctx, source);
}

async function handleHeal(
  action: string,
  payload: string,
  ctx: SelfHealingActionContext,
  source: 'cli' | 'api' | 'telegram' | 'system'
): Promise<SelfHealingActionResult> {
  if (action === 'help' || action === '') return { handled: true, response: healHelp() };
  if (!ctx.healingEnabled || !ctx.healingEngine) {
    return { handled: true, response: 'Self-healing is disabled. Set SELF_HEALING_ENABLED=true.' };
  }
  if (action === 'status') {
    return { handled: true, response: ['Self-healing status:', formatStatus(ctx.healingEngine.getStatus())].join('\n') };
  }
  if (action === 'runs') {
    const runs = await ctx.healingEngine.listRuns();
    return { handled: true, response: runs.length ? runs.slice(0, 10).map(formatRun).join('\n\n') : 'No self-healing runs yet.' };
  }
  if (action === 'report') {
    if (!payload) return { handled: true, response: 'Usage: /heal report <runId>' };
    const report = await ctx.healingEngine.getReport(payload);
    return { handled: true, response: report ?? `No report found for ${payload}.` };
  }
  if (action === 'diff') {
    if (!payload) return { handled: true, response: 'Usage: /heal diff <runId>' };
    const diff = await ctx.healingEngine.getDiffReport(payload);
    return { handled: true, response: diff ?? `No diff report found for run ${payload}.` };
  }
  if (action === 'run') {
    if (!payload) return { handled: true, response: 'Usage: /heal run <instruction>' };
    const run = await ctx.healingEngine.run({ userInput: payload, source });
    return { handled: true, response: formatRun(run) };
  }
  return { handled: true, response: healHelp() };
}

async function handleUpgrade(
  action: string,
  payload: string,
  ctx: SelfHealingActionContext,
  source: 'cli' | 'api' | 'telegram' | 'system'
): Promise<SelfHealingActionResult> {
  if (action === 'help' || action === '') return { handled: true, response: upgradeHelp() };
  if (!ctx.upgradeEnabled || !ctx.upgradeEngine) {
    return { handled: true, response: 'Self-upgrade is disabled. Set SELF_UPGRADE_ENABLED=true.' };
  }
  if (action === 'status') {
    return { handled: true, response: ['Self-upgrade status:', formatStatus(ctx.upgradeEngine.getStatus())].join('\n') };
  }
  if (action === 'runs') {
    const runs = await ctx.upgradeEngine.listRuns();
    return { handled: true, response: runs.length ? runs.slice(0, 10).map(formatRun).join('\n\n') : 'No self-upgrade runs yet.' };
  }
  if (action === 'report') {
    if (!payload) return { handled: true, response: 'Usage: /upgrade report <runId>' };
    const report = await ctx.upgradeEngine.getReport(payload);
    return { handled: true, response: report ?? `No report found for ${payload}.` };
  }
  if (action === 'diff') {
    if (!payload) return { handled: true, response: 'Usage: /upgrade diff <runId>' };
    const diff = await ctx.upgradeEngine.getDiffReport(payload);
    return { handled: true, response: diff ?? `No diff report found for run ${payload}.` };
  }
  if (action === 'run') {
    if (!payload) return { handled: true, response: 'Usage: /upgrade run <instruction>' };
    const run = await ctx.upgradeEngine.run({ userInput: payload, source, missingCapability: payload });
    return { handled: true, response: ['Self-upgrade started.', formatRun(run)].join('\n\n') };
  }
  return { handled: true, response: upgradeHelp() };
}

async function handleRestart(
  action: string,
  ctx: SelfHealingActionContext
): Promise<SelfHealingActionResult> {
  if (!ctx.lifecycleManager) {
    return { handled: true, response: 'Restart lifecycle manager is not initialized.' };
  }

  if (action === 'status') {
    return {
      handled: true,
      response: ['Restart status:', formatStatus(ctx.lifecycleManager.getStatus())].join('\n'),
    };
  }

  if (!ctx.lifecycleManager.isManualRestartEnabled()) {
    return {
      handled: true,
      response: 'Manual restart is disabled. Set AUTONOMOUS_RESTART_MANUAL_ENABLED=true to allow /restart.',
    };
  }

  const scheduled = ctx.lifecycleManager.requestManualRestart('manual /restart command');
  return {
    handled: true,
    response: scheduled ? 'Restart scheduled.' : 'Restart was not scheduled.',
  };
}
