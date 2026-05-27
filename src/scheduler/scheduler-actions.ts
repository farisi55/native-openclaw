/**
 * scheduler/scheduler-actions.ts
 * User-facing scheduler commands for CLI, API, Telegram, and action-handler.
 */

import { SchedulerStore, parseDailyCronExpression } from './scheduler-store';
import { parseSchedulerIntent } from './scheduler-intent';
import { getEnvBool } from '../config/env';
import type {
  CreateScheduledJobInput,
  ScheduledJob,
  ScheduledJobRun,
  ScheduledJobSource,
  SchedulerIntent,
  SchedulerListFilter,
  UpdateScheduledJobInput,
} from './scheduler-types';

export interface SchedulerActionContext {
  store: SchedulerStore;
  runJobNow?: (idOrName: string) => Promise<ScheduledJobRun>;
}

export interface SchedulerActionResult {
  handled: boolean;
  response?: string;
}

function scheduleDescription(job: ScheduledJob): string {
  if (job.scheduleType === 'once' && job.runAt) {
    return `sekali pada ${new Date(job.runAt).toLocaleString('id-ID', { timeZone: job.timezone })} ${job.timezone}`;
  }

  if ((job.scheduleType === 'daily' || job.scheduleType === 'cron') && job.cronExpression) {
    const time = parseDailyCronExpression(job.cronExpression);
    if (time) {
      return `setiap hari ${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')} ${job.timezone}`;
    }
    return `cron ${job.cronExpression}`;
  }

  if (job.scheduleType === 'interval') {
    const intervalMs = job.metadata?.['intervalMs'];
    if (typeof intervalMs === 'number') {
      const minutes = Math.round(intervalMs / 60_000);
      if (minutes >= 60 && minutes % 60 === 0) return `setiap ${minutes / 60} jam`;
      return `setiap ${minutes} menit`;
    }
  }

  return job.scheduleType;
}

function metadataText(job: ScheduledJob, key: string): string | undefined {
  const value = job.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sentence(value: string): string {
  return value.trim().replace(/[.]+$/, '');
}

function formatNextRun(job: ScheduledJob): string {
  if (!job.nextRunAt) return '-';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: job.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(job.nextRunAt));
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')} ${job.timezone}`;
}

function formatCreatedJob(job: ScheduledJob): string {
  const schedule = metadataText(job, 'relativeDescription') ?? scheduleDescription(job);
  const task = metadataText(job, 'taskSummary');
  const firstLine = task
    ? `Cronjob dibuat: ${job.name}. Jadwal: ${sentence(schedule)}. Tugas: ${sentence(task)}.`
    : `Cronjob dibuat: ${job.name}. Jadwal: ${sentence(schedule)}.`;
  return job.nextRunAt ? `${firstLine}\nNext run: ${formatNextRun(job)}` : firstLine;
}

function filterJobs(jobs: ScheduledJob[], filter: SchedulerListFilter): ScheduledJob[] {
  if (filter === 'active') return jobs.filter((job) => job.enabled);
  if (filter === 'disabled') return jobs.filter((job) => !job.enabled);
  return jobs;
}

function numberedJobLine(job: ScheduledJob, index: number, includeStatus: boolean): string {
  const next = job.nextRunAt ?? '-';
  const status = includeStatus ? `   Status: ${job.enabled ? 'enabled' : 'disabled'}\n` : '';
  return [
    `${index + 1}. ${job.name}`,
    status.trimEnd(),
    `   Jadwal: ${scheduleDescription(job)}`,
    `   Next run: ${next}`,
  ].filter(Boolean).join('\n');
}

function listFilterFromText(text: string): SchedulerListFilter {
  if (/\b(nonaktif|disabled|mati)\b/i.test(text)) return 'disabled';
  if (/\b(aktif|active|enabled|sedang\s+aktif|yang\s+aktif)\b/i.test(text)) return 'active';
  return 'all';
}

export function formatJobList(jobs: ScheduledJob[], filter: SchedulerListFilter = 'all'): string {
  const visible = filterJobs(jobs, filter);

  if (visible.length === 0) {
    if (filter === 'active') return 'Belum ada cronjob aktif saat ini.';
    if (filter === 'disabled') return 'Belum ada cronjob nonaktif saat ini.';
    return 'Belum ada cronjob yang terdaftar.';
  }

  if (filter === 'active') {
    return ['Cronjob aktif saat ini:', '', ...visible.map((job, index) => numberedJobLine(job, index, false))].join('\n');
  }

  if (filter === 'disabled') {
    return ['Cronjob nonaktif saat ini:', '', ...visible.map((job, index) => numberedJobLine(job, index, false))].join('\n');
  }

  return ['Cronjob terdaftar:', '', ...visible.map((job, index) => numberedJobLine(job, index, true))].join('\n');
}

function toolsText(run: ScheduledJobRun | undefined): string {
  if (!run?.toolsUsed || run.toolsUsed.length === 0) return 'none';
  return run.toolsUsed.join(', ');
}

function emailText(run: ScheduledJobRun | undefined): string {
  if (!run) return '-';
  if (!run.emailRequired) return 'not required';
  return run.emailSent ? 'sent' : 'required, not sent';
}

function formatRunSummary(run: ScheduledJobRun): string {
  const lines = [
    `${run.startedAt}  ${run.status}  job:${run.jobId.slice(0, 8)}  duration: ${run.durationMs ?? '-'}ms`,
    `Tools: ${toolsText(run)}`,
    `Email: ${emailText(run)}`,
  ];
  if (run.brevoMessageId) lines.push(`Brevo messageId: ${run.brevoMessageId}`);
  if (run.error) lines.push(`Error: ${run.error}`);
  return lines.join('\n');
}

function formatLastRun(run: ScheduledJobRun | undefined): string[] {
  if (!run) return ['Last run: -'];
  const lines = [
    'Last run:',
    `  Status: ${run.status}`,
    `  Tools: ${toolsText(run)}`,
    `  Email: ${emailText(run)}`,
    `  Duration: ${run.durationMs ?? '-'}ms`,
  ];
  if (run.brevoMessageId) lines.push(`  Brevo messageId: ${run.brevoMessageId}`);
  if (run.error) lines.push(`  Error: ${run.error}`);
  return lines;
}

export function formatJobDetails(job: ScheduledJob, lastRun?: ScheduledJobRun): string {
  const lines = [
    `Cronjob: ${job.name}`,
    `ID: ${job.id}`,
    `Status: ${job.enabled ? 'enabled' : 'disabled'}`,
    `Jadwal: ${scheduleDescription(job)}`,
    `Next run: ${job.nextRunAt ?? '-'}`,
    `Run count: ${job.runCount}`,
    `Failure count: ${job.failureCount}`,
    `Prompt: ${job.prompt}`,
  ];
  if (job.lastStatus) lines.push(...formatLastRun(lastRun));
  return lines.join('\n');
}

function createInputFromIntent(intent: SchedulerIntent, source: ScheduledJobSource): CreateScheduledJobInput {
  if (!intent.name || !intent.scheduleType || !intent.prompt) {
    throw new Error('Intent cronjob belum lengkap.');
  }

  const input: CreateScheduledJobInput = {
    name: intent.name,
    scheduleType: intent.scheduleType,
    prompt: intent.prompt,
    source,
    enabled: true,
  };

  if (intent.timezone) input.timezone = intent.timezone;
  if (intent.description) input.description = intent.description;
  if (intent.cronExpression) input.cronExpression = intent.cronExpression;
  if (intent.runAt) input.runAt = intent.runAt;
  if (intent.metadata) input.metadata = intent.metadata;

  return input;
}

function replaceRunAtTime(runAt: string, time: string): string {
  const date = new Date(runAt);
  const [hour, minute] = time.split(':').map(Number);
  date.setUTCHours(hour ?? 0, minute ?? 0, 0, 0);
  return date.toISOString();
}

async function applyUpdateIntent(intent: SchedulerIntent, ctx: SchedulerActionContext): Promise<string> {
  const target = intent.targetJob ?? intent.name;
  if (!target) return 'Sebutkan nama cronjob yang ingin diupdate.';
  const job = await ctx.store.getJob(target);
  if (!job) return `Tidak ditemukan cronjob dengan nama: ${target}.`;

  const patch: UpdateScheduledJobInput = {};
  if (intent.time && intent.cronExpression) {
    if (job.scheduleType === 'once' && job.runAt) {
      patch.runAt = replaceRunAtTime(job.runAt, intent.time);
    } else {
      patch.scheduleType = 'daily';
      patch.cronExpression = intent.cronExpression;
    }
  }
  if (intent.prompt) patch.prompt = intent.prompt;

  const updated = await ctx.store.updateJob(job.id, patch);
  return `Cronjob diperbarui: ${updated.name}. Jadwal: ${scheduleDescription(updated)}.`;
}

async function handleIntent(
  intent: SchedulerIntent,
  ctx: SchedulerActionContext,
  source: ScheduledJobSource
): Promise<SchedulerActionResult> {
  if (intent.intent === 'unknown') return { handled: false };
  if (intent.requiresClarification) {
    return { handled: true, response: intent.clarificationQuestion ?? 'Perlu detail jadwal cronjob.' };
  }

  if (intent.intent === 'list') {
    return { handled: true, response: formatJobList(await ctx.store.listJobs(), intent.filter ?? 'all') };
  }

  if (intent.intent === 'get') {
    const target = intent.targetJob ?? intent.name ?? '';
    const job = await ctx.store.getJob(target);
    const lastRun = job ? (await ctx.store.listRuns(job.id))[0] : undefined;
    return {
      handled: true,
      response: job ? formatJobDetails(job, lastRun) : `Tidak ditemukan cronjob dengan nama: ${target}.`,
    };
  }

  if (intent.intent === 'create') {
    if (!getEnvBool('SCHEDULER_ENABLED', true)) {
      return {
        handled: true,
        response: 'Scheduler sedang nonaktif. Aktifkan SCHEDULER_ENABLED=true untuk membuat cronjob.',
      };
    }

    const job = await ctx.store.createJob(createInputFromIntent(intent, source));
    return {
      handled: true,
      response: formatCreatedJob(job),
    };
  }

  if (intent.intent === 'update') {
    return { handled: true, response: await applyUpdateIntent(intent, ctx) };
  }

  if (intent.intent === 'delete') {
    const target = intent.targetJob ?? intent.name ?? '';
    const deleted = await ctx.store.deleteJob(target);
    return {
      handled: true,
      response: deleted ? `Cronjob dihapus: ${deleted.name}.` : `Tidak ditemukan cronjob dengan nama: ${target}.`,
    };
  }

  if (intent.intent === 'enable') {
    const target = intent.targetJob ?? intent.name ?? '';
    const job = await ctx.store.enableJob(target);
    return { handled: true, response: `Cronjob diaktifkan: ${job.name}.` };
  }

  if (intent.intent === 'disable') {
    const target = intent.targetJob ?? intent.name ?? '';
    const job = await ctx.store.disableJob(target);
    return { handled: true, response: `Cronjob dinonaktifkan: ${job.name}.` };
  }

  if (intent.intent === 'run_now') {
    const target = intent.targetJob ?? intent.name ?? '';
    if (!ctx.runJobNow) {
      return { handled: true, response: 'Scheduler engine belum aktif, tidak bisa menjalankan cronjob sekarang.' };
    }
    const run = await ctx.runJobNow(target);
    return {
      handled: true,
      response: run.status === 'success'
        ? `Cronjob dijalankan: ${target}.`
        : `Cronjob gagal dijalankan: ${run.error ?? 'unknown error'}`,
    };
  }

  return { handled: false };
}

export async function handleSchedulerText(
  input: string,
  ctx: SchedulerActionContext,
  source: ScheduledJobSource
): Promise<SchedulerActionResult> {
  try {
    return await handleIntent(parseSchedulerIntent(input), ctx, source);
  } catch (err) {
    return {
      handled: true,
      response: `Scheduler error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function cronHelp(): string {
  return [
    'Cronjob commands:',
    '/cron list',
    '/cron get <id-or-name>',
    '/cron create <natural language schedule>',
    '/cron update <id-or-name> jam <HH:mm>',
    '/cron delete <id-or-name>',
    '/cron enable <id-or-name>',
    '/cron disable <id-or-name>',
    '/cron run <id-or-name>',
    '/cron runs [id-or-name]',
  ].join('\n');
}

export async function handleCronCommand(
  args: string[],
  ctx: SchedulerActionContext,
  source: ScheduledJobSource = 'cli'
): Promise<string> {
  const [action, target, ...rest] = args;
  if (!action) return cronHelp();

  try {
    if (action === 'list') {
      return formatJobList(await ctx.store.listJobs(), listFilterFromText([target, ...rest].filter(Boolean).join(' ')));
    }

    if (action === 'get' && target) {
      const job = await ctx.store.getJob(target);
      const lastRun = job ? (await ctx.store.listRuns(job.id))[0] : undefined;
      return job ? formatJobDetails(job, lastRun) : `Tidak ditemukan cronjob dengan nama: ${target}.`;
    }

    if (action === 'create') {
      const text = [target, ...rest].filter(Boolean).join(' ');
      if (!text) return 'Usage: /cron create <natural language schedule>';
      const result = await handleSchedulerText(text, ctx, source);
      return result.response ?? 'Cronjob tidak dibuat.';
    }

    if (action === 'update' && target) {
      const text = `update cronjob ${target} menjadi ${rest.join(' ')}`;
      const result = await handleSchedulerText(text, ctx, source);
      return result.response ?? 'Cronjob tidak diperbarui.';
    }

    if (action === 'delete' && target) {
      const deleted = await ctx.store.deleteJob(target);
      return deleted ? `Cronjob dihapus: ${deleted.name}.` : `Tidak ditemukan cronjob dengan nama: ${target}.`;
    }

    if (action === 'enable' && target) {
      const job = await ctx.store.enableJob(target);
      return `Cronjob diaktifkan: ${job.name}.`;
    }

    if (action === 'disable' && target) {
      const job = await ctx.store.disableJob(target);
      return `Cronjob dinonaktifkan: ${job.name}.`;
    }

    if (action === 'run' && target) {
      if (!ctx.runJobNow) return 'Scheduler engine belum aktif, tidak bisa menjalankan cronjob sekarang.';
      const run = await ctx.runJobNow(target);
      return run.status === 'success'
        ? `Cronjob dijalankan: ${target}.`
        : `Cronjob gagal dijalankan: ${run.error ?? 'unknown error'}`;
    }

    if (action === 'runs') {
      const job = target ? await ctx.store.getJob(target) : null;
      const runs = await ctx.store.listRuns(job?.id);
      if (runs.length === 0) return 'Belum ada riwayat eksekusi cronjob.';
      return runs.slice(0, 20).map(formatRunSummary).join('\n\n');
    }
  } catch (err) {
    return `Scheduler error: ${err instanceof Error ? err.message : String(err)}`;
  }

  return cronHelp();
}
