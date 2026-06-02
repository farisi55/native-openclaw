/**
 * scheduler/scheduler-store.ts
 * Persistent JSON storage and schedule calculation for internal cronjobs.
 */

import { randomUUID } from 'crypto';
import { mkdir, readFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { JsonStore } from '../storage/json-store';
import type { JsonValue } from '../types/global';
import { getEnvInt, getOptionalEnv } from '../config/env';
import { createLogger } from '../utils/logger';
import type {
  CreateScheduledJobInput,
  ScheduledJob,
  ScheduledJobRun,
  UpdateScheduledJobInput,
} from './scheduler-types';

const logger = createLogger('scheduler:store');
const DEFAULT_TIMEZONE = 'Asia/Jakarta';

type StoredScheduledJob = { id: string } & Record<string, JsonValue>;
type StoredScheduledJobRun = { id: string } & Record<string, JsonValue>;

function nowIso(): string {
  return new Date().toISOString();
}

function asStoredJob(job: ScheduledJob): StoredScheduledJob {
  return job as unknown as StoredScheduledJob;
}

function fromStoredJob(job: StoredScheduledJob): ScheduledJob {
  return job as unknown as ScheduledJob;
}

function asStoredRun(run: ScheduledJobRun): StoredScheduledJobRun {
  return run as unknown as StoredScheduledJobRun;
}

function fromStoredRun(run: StoredScheduledJobRun): ScheduledJobRun {
  return run as unknown as ScheduledJobRun;
}

function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function timeZoneParts(date: Date, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? '0');
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

function timeZoneOffsetMs(date: Date, timezone: string): number {
  const p = timeZoneParts(date, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - date.getTime();
}

function zonedDateToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string
): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  const offset = timeZoneOffsetMs(guess, timezone);
  return new Date(guess.getTime() - offset);
}

function addDaysInZone(date: Date, days: number, timezone: string): {
  year: number;
  month: number;
  day: number;
} {
  const p = timeZoneParts(date, timezone);
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days, 12, 0, 0));
  const shiftedParts = timeZoneParts(shifted, timezone);
  return {
    year: shiftedParts.year,
    month: shiftedParts.month,
    day: shiftedParts.day,
  };
}

function parseTime(value: string | undefined): { hour: number; minute: number } | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function dailyCronExpression(time: string): string {
  const parsed = parseTime(time);
  if (!parsed) throw new Error(`Invalid daily time: ${time}`);
  return `${parsed.minute} ${parsed.hour} * * *`;
}

export function parseDailyCronExpression(expression: string | undefined): { hour: number; minute: number } | null {
  if (!expression) return null;
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  if (parts[2] !== '*' || parts[3] !== '*' || parts[4] !== '*') return null;
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function validateCronPart(part: string, min: number, max: number): boolean {
  if (!part) return false;
  if (part === '*') return true;

  return part.split(',').every((segment) => {
    if (!segment) return false;

    const stepParts = segment.split('/');
    if (stepParts.length > 2) return false;
    const [rangePart, stepPart] = stepParts;
    if (!rangePart) return false;
    if (stepPart !== undefined) {
      const step = Number(stepPart);
      if (!Number.isInteger(step) || step <= 0) return false;
    }

    if (rangePart === '*') return true;

    if (rangePart.includes('-')) {
      const [startRaw, endRaw] = rangePart.split('-');
      const start = Number(startRaw);
      const end = Number(endRaw);
      return (
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start >= min &&
        end <= max &&
        start <= end
      );
    }

    const value = Number(rangePart);
    return Number.isInteger(value) && value >= min && value <= max;
  });
}

export function validateCronExpression(expression: string | undefined): boolean {
  if (!expression || !expression.trim()) return false;
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return (
    validateCronPart(parts[0] ?? '', 0, 59) &&
    validateCronPart(parts[1] ?? '', 0, 23) &&
    validateCronPart(parts[2] ?? '', 1, 31) &&
    validateCronPart(parts[3] ?? '', 1, 12) &&
    validateCronPart(parts[4] ?? '', 0, 7)
  );
}

function assertValidCronSchedule(scheduleType: ScheduledJob['scheduleType'], cronExpression: string | undefined): void {
  if (scheduleType === 'cron' && !cronExpression) {
    throw new Error('Invalid cron expression: missing cron expression.');
  }
  if (cronExpression !== undefined && !validateCronExpression(cronExpression)) {
    throw new Error(`Invalid cron expression: ${cronExpression}`);
  }
}

function intervalMs(job: ScheduledJob): number | null {
  const raw = job.metadata?.['intervalMs'];
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

function nextDailyRun(job: ScheduledJob, now: Date): string | undefined {
  const time = parseDailyCronExpression(job.cronExpression);
  if (!time) return undefined;

  const today = timeZoneParts(now, job.timezone);
  const todayRun = zonedDateToUtc(
    today.year,
    today.month,
    today.day,
    time.hour,
    time.minute,
    job.timezone
  );
  if (todayRun.getTime() > now.getTime()) return todayRun.toISOString();

  const tomorrow = addDaysInZone(now, 1, job.timezone);
  return zonedDateToUtc(
    tomorrow.year,
    tomorrow.month,
    tomorrow.day,
    time.hour,
    time.minute,
    job.timezone
  ).toISOString();
}

function nextIntervalRun(job: ScheduledJob, now: Date): string | undefined {
  const ms = intervalMs(job);
  if (!ms) return undefined;
  const base = job.lastRunAt ? new Date(job.lastRunAt) : now;
  const next = new Date(base.getTime() + ms);
  return (next.getTime() <= now.getTime() ? new Date(now.getTime() + ms) : next).toISOString();
}

export function computeNextRunAt(job: ScheduledJob, now = new Date()): string | undefined {
  if (!job.enabled) return job.nextRunAt;

  if (job.scheduleType === 'once') {
    return job.runAt;
  }

  if (job.scheduleType === 'daily' || job.scheduleType === 'cron') {
    return nextDailyRun(job, now);
  }

  if (job.scheduleType === 'interval') {
    return nextIntervalRun(job, now);
  }

  if (job.scheduleType === 'weekly' || job.scheduleType === 'monthly') {
    return nextDailyRun(job, now);
  }

  return undefined;
}

export function schedulerDataDir(dataDir?: string): string {
  return dataDir ?? getOptionalEnv('APP_DATA_DIR', '.data') ?? '.data';
}

export class SchedulerStore {
  private readonly jobs: JsonStore<StoredScheduledJob>;
  private readonly runs: JsonStore<StoredScheduledJobRun>;
  private readonly dataDir: string;
  private prepared = false;

  constructor(dataDir?: string) {
    this.dataDir = schedulerDataDir(dataDir);
    this.jobs = new JsonStore<StoredScheduledJob>('cronjobs', { dataDir: this.dataDir });
    this.runs = new JsonStore<StoredScheduledJobRun>('cronjob-runs', { dataDir: this.dataDir });
  }

  private async prepare(): Promise<void> {
    if (this.prepared) return;
    await mkdir(this.dataDir, { recursive: true });
    await Promise.all([
      this.backupCorruptJson('cronjobs.json'),
      this.backupCorruptJson('cronjob-runs.json'),
    ]);
    this.prepared = true;
  }

  private async backupCorruptJson(fileName: string): Promise<void> {
    const path = join(this.dataDir, fileName);
    if (!existsSync(path)) return;
    try {
      JSON.parse(await readFile(path, 'utf-8'));
    } catch (err) {
      const backup = `${path}.corrupt-${Date.now()}`;
      await rename(path, backup);
      logger.warn('scheduler: backed up corrupt JSON store', {
        fileName,
        backup,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async listJobs(): Promise<ScheduledJob[]> {
    await this.prepare();
    const result = await this.jobs.list();
    if (!result.ok) throw result.error;
    return result.value
      .map(fromStoredJob)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getJob(idOrName: string): Promise<ScheduledJob | null> {
    const target = idOrName.trim();
    if (!target) return null;
    await this.prepare();

    const byId = await this.jobs.get(target);
    if (!byId.ok) throw byId.error;
    if (byId.value) return fromStoredJob(byId.value);

    const normalized = normalizeName(target);
    const jobs = await this.listJobs();
    return (
      jobs.find((job) => normalizeName(job.name) === normalized) ??
      jobs.find((job) => normalizeName(job.name).includes(normalized)) ??
      null
    );
  }

  async createJob(input: CreateScheduledJobInput): Promise<ScheduledJob> {
    await this.prepare();
    const requestedName = input.name.trim();
    if (!requestedName) throw new Error('Cronjob name is required.');
    if (!input.prompt.trim()) throw new Error('Cronjob prompt is required.');
    assertValidCronSchedule(input.scheduleType, input.cronExpression);

    const existingNames = new Set((await this.listJobs()).map((job) => normalizeName(job.name)));
    let name = requestedName;
    let suffix = 2;
    while (existingNames.has(normalizeName(name))) {
      name = `${requestedName}-${suffix}`;
      suffix += 1;
    }

    const now = nowIso();
    const job: ScheduledJob = {
      id: randomUUID(),
      name,
      enabled: input.enabled ?? true,
      scheduleType: input.scheduleType,
      timezone: input.timezone ?? getOptionalEnv('SCHEDULER_TIMEZONE', DEFAULT_TIMEZONE) ?? DEFAULT_TIMEZONE,
      prompt: input.prompt.trim(),
      source: input.source ?? 'system',
      runCount: 0,
      failureCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    if (input.description) job.description = input.description;
    if (input.cronExpression) job.cronExpression = input.cronExpression;
    if (input.runAt) job.runAt = input.runAt;
    if (input.tags) job.tags = input.tags;
    if (input.createdBy) job.createdBy = input.createdBy;
    if (input.metadata) job.metadata = input.metadata;

    const nextRunAt = computeNextRunAt(job);
    if (nextRunAt) job.nextRunAt = nextRunAt;

    const result = await this.jobs.set(asStoredJob(job));
    if (!result.ok) throw result.error;
    return job;
  }

  async updateJob(idOrName: string, patch: UpdateScheduledJobInput): Promise<ScheduledJob> {
    await this.prepare();
    const existing = await this.getJob(idOrName);
    if (!existing) throw new Error(`Tidak ditemukan cronjob dengan nama: ${idOrName}.`);

    if (patch.name && normalizeName(patch.name) !== normalizeName(existing.name)) {
      const duplicate = await this.getJob(patch.name);
      if (duplicate && duplicate.id !== existing.id) {
        throw new Error(`Cronjob dengan nama "${patch.name}" sudah ada.`);
      }
    }

    assertValidCronSchedule(
      patch.scheduleType ?? existing.scheduleType,
      patch.cronExpression ?? existing.cronExpression
    );

    const updated: ScheduledJob = {
      ...existing,
      ...patch,
      updatedAt: nowIso(),
    };
    if (patch.metadata) {
      updated.metadata = { ...(existing.metadata ?? {}), ...patch.metadata };
    }

    const nextRunAt = computeNextRunAt(updated);
    if (nextRunAt) updated.nextRunAt = nextRunAt;

    const result = await this.jobs.set(asStoredJob(updated));
    if (!result.ok) throw result.error;
    return updated;
  }

  async deleteJob(idOrName: string): Promise<ScheduledJob | null> {
    await this.prepare();
    const existing = await this.getJob(idOrName);
    if (!existing) return null;
    const result = await this.jobs.delete(existing.id);
    if (!result.ok) throw result.error;
    return result.value ? existing : null;
  }

  async enableJob(idOrName: string): Promise<ScheduledJob> {
    return this.updateJob(idOrName, { enabled: true });
  }

  async disableJob(idOrName: string): Promise<ScheduledJob> {
    return this.updateJob(idOrName, { enabled: false });
  }

  async appendRun(run: ScheduledJobRun): Promise<ScheduledJobRun> {
    await this.prepare();
    const result = await this.runs.set(asStoredRun(run));
    if (!result.ok) throw result.error;
    await this.trimRunHistory();
    return run;
  }

  async listRuns(jobId?: string): Promise<ScheduledJobRun[]> {
    await this.prepare();
    const result = await this.runs.list();
    if (!result.ok) throw result.error;
    return result.value
      .map(fromStoredRun)
      .filter((run) => !jobId || run.jobId === jobId)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  }

  async getDueJobs(now = new Date()): Promise<ScheduledJob[]> {
    const jobs = await this.listJobs();
    const nowMs = now.getTime();
    return jobs.filter((job) => {
      if (!job.enabled || !job.nextRunAt) return false;
      return new Date(job.nextRunAt).getTime() <= nowMs;
    });
  }

  async markJobRunResult(
    job: ScheduledJob,
    status: 'success' | 'failed' | 'skipped',
    now: Date,
    error?: string,
    metadata?: Record<string, unknown>
  ): Promise<ScheduledJob> {
    const failed = status === 'failed';
    const updated: ScheduledJob = {
      ...job,
      enabled: job.scheduleType === 'once' ? false : job.enabled,
      runCount: status === 'skipped' ? job.runCount : job.runCount + 1,
      failureCount: failed ? job.failureCount + 1 : job.failureCount,
      lastRunAt: now.toISOString(),
      lastStatus: status,
      updatedAt: now.toISOString(),
    };
    if (metadata) {
      updated.metadata = { ...(job.metadata ?? {}), ...metadata };
    }

    if (error) {
      updated.lastError = error;
    } else {
      delete updated.lastError;
    }

    const nextRunAt = computeNextRunAt(updated, now);
    if (nextRunAt && updated.enabled) {
      updated.nextRunAt = nextRunAt;
    } else {
      delete updated.nextRunAt;
    }

    const result = await this.jobs.set(asStoredJob(updated));
    if (!result.ok) throw result.error;
    return updated;
  }

  private async trimRunHistory(): Promise<void> {
    const limit = Math.max(1, getEnvInt('SCHEDULER_RUN_HISTORY_LIMIT', 100));
    const runs = await this.listRuns();
    for (const run of runs.slice(limit)) {
      const result = await this.runs.delete(run.id);
      if (!result.ok) throw result.error;
    }
  }
}
