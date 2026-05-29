/**
 * skills/self-improving-actions.ts
 * User-facing management commands for the Hermes-style self-improving loop.
 */

import type { SelfImprovingEngine, SelfImprovingSkillStatus } from './self-improving-engine';

export interface SelfImprovingActionContext {
  enabled: boolean;
  autoSkillsDir: string;
  qualityFilePath: string;
  evaluationThreshold: number;
  engine?: SelfImprovingEngine;
}

export interface SelfImprovingActionResult {
  handled: boolean;
  response?: string;
}

function helpText(): string {
  return [
    'Self-improvement commands:',
    '/self-improve status',
    '/self-improve skills',
    '/self-improve stats',
    '/self-improve evaluate',
    '/self-improve enable',
    '/self-improve disable',
    '',
    'Aliases: /self, /improve',
  ].join('\n');
}

function disabledMessage(ctx: SelfImprovingActionContext): string {
  return [
    'Self-improvement belum aktif.',
    `Auto skills dir: ${ctx.autoSkillsDir}`,
    `Quality store: ${ctx.qualityFilePath}`,
    `Evaluation threshold: ${ctx.evaluationThreshold}`,
    '',
    'Set SELF_IMPROVING=true in .env and restart.',
  ].join('\n');
}

function successRate(row: SelfImprovingSkillStatus): string {
  return `${Math.round(row.successRate * 100)}%`;
}

function formatSkillRow(row: SelfImprovingSkillStatus, index: number): string {
  return [
    `${index + 1}. ${row.name}`,
    `   ID: ${row.id}`,
    `   Enabled: ${row.enabled}`,
    `   Usage: ${row.usageCount} | Success: ${row.successCount} | Failure: ${row.failureCount} | Rate: ${successRate(row)}`,
    `   File: ${row.filePath}`,
  ].join('\n');
}

function parseAction(input: string): string | null {
  const trimmed = input.trim();
  const slash = /^\/(?:self-improve|self|improve)(?:\s+(.+))?$/i.exec(trimmed);
  if (slash) return (slash[1] ?? 'help').trim().toLowerCase();

  if (/\b(?:lihat|show)\s+status\s+self[-\s]?improvement\b/i.test(trimmed)) return 'status';
  if (/\b(?:skill|skills)\b[\s\S]*\b(?:otomatis|auto-generated|self[-\s]?improvement)\b/i.test(trimmed)) return 'skills';
  if (/\b(?:jalankan|run)\s+evaluasi\s+self[-\s]?improvement\b/i.test(trimmed)) return 'evaluate';

  return null;
}

export async function handleSelfImprovingAction(
  input: string,
  ctx: SelfImprovingActionContext
): Promise<SelfImprovingActionResult> {
  const action = parseAction(input);
  if (!action) return { handled: false };

  if (action === 'help' || action === '') {
    return { handled: true, response: helpText() };
  }

  if (action === 'enable') {
    return {
      handled: true,
      response: 'Runtime enable belum didukung. Set SELF_IMPROVING=true in .env and restart.',
    };
  }

  if (action === 'disable') {
    return {
      handled: true,
      response: 'Runtime disable belum didukung. Set SELF_IMPROVING=false in .env and restart.',
    };
  }

  if (!ctx.enabled || !ctx.engine) {
    return { handled: true, response: disabledMessage(ctx) };
  }

  if (action === 'status') {
    const status = await ctx.engine.getStatus();
    return {
      handled: true,
      response: [
        'Self-improvement status:',
        `enabled: ${ctx.enabled}`,
        `autoSkillsDir: ${status.autoSkillsDir}`,
        `qualityStore: ${status.qualityFilePath}`,
        `evaluationThreshold: ${status.evaluationThreshold}`,
        `taskCounter: ${status.taskCounter}`,
        `autoSkillsCount: ${status.autoSkillsCount}`,
        `activeAutoSkillsCount: ${status.activeAutoSkillsCount}`,
      ].join('\n'),
    };
  }

  if (action === 'skills') {
    const rows = await ctx.engine.listAutoSkillStats();
    if (rows.length === 0) {
      return { handled: true, response: 'Belum ada auto-generated skill.' };
    }
    return {
      handled: true,
      response: ['Auto-generated skills:', '', ...rows.map(formatSkillRow)].join('\n'),
    };
  }

  if (action === 'stats') {
    const rows = await ctx.engine.listAutoSkillStats();
    const totalUsage = rows.reduce((sum, row) => sum + row.usageCount, 0);
    const totalSuccess = rows.reduce((sum, row) => sum + row.successCount, 0);
    const totalFailure = rows.reduce((sum, row) => sum + row.failureCount, 0);
    return {
      handled: true,
      response: [
        'Self-improvement stats:',
        `skills: ${rows.length}`,
        `usageCount: ${totalUsage}`,
        `successCount: ${totalSuccess}`,
        `failureCount: ${totalFailure}`,
        `qualityStore: ${ctx.qualityFilePath}`,
      ].join('\n'),
    };
  }

  if (action === 'evaluate') {
    const report = await ctx.engine.runEvaluationNow();
    return {
      handled: true,
      response: [
        'Self-improvement evaluation complete:',
        `evaluated: ${report.evaluated}`,
        `improved: ${report.improved}`,
        `disabled: ${report.disabled}`,
        `skipped: ${report.skipped}`,
      ].join('\n'),
    };
  }

  return { handled: true, response: helpText() };
}
