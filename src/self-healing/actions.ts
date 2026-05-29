import type { HealingRun } from './healing-types';
import type { SelfHealingEngine } from './self-healing-engine';
import type { SelfUpgradeEngine } from './self-upgrade-engine';

export interface SelfHealingActionContext {
  healingEnabled: boolean;
  upgradeEnabled: boolean;
  runsDir: string;
  healingEngine?: SelfHealingEngine;
  upgradeEngine?: SelfUpgradeEngine;
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

function parseSlash(input: string): { kind: 'heal' | 'upgrade'; action: string; payload: string } | null {
  const trimmed = input.trim();
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

function parseNatural(input: string): { kind: 'heal' | 'upgrade'; payload: string } | null {
  if (/\b(?:fix this bug|perbaiki bug ini|jalankan self healing|heal this error|fix failing test|repair build|solve this error)\b/i.test(input)) {
    return { kind: 'heal', payload: input.trim() };
  }
  if (/\b(?:tambahkan tool baru|fitur belum ada|logic belum ada|capability missing|add new tool|install capability|upgrade yourself|self upgrade)\b/i.test(input)) {
    return { kind: 'upgrade', payload: input.trim() };
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
  if (action === 'run') {
    if (!payload) return { handled: true, response: 'Usage: /upgrade run <instruction>' };
    const run = await ctx.upgradeEngine.run({ userInput: payload, source, missingCapability: payload });
    return { handled: true, response: formatRun(run) };
  }
  return { handled: true, response: upgradeHelp() };
}
