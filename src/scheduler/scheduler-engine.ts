/**
 * scheduler/scheduler-engine.ts
 * In-process cronjob scheduler loop.
 */

import { randomUUID } from 'crypto';
import { getEnvBool, getEnvInt, getOptionalEnv } from '../config/env';
import { createLogger } from '../utils/logger';
import type { WorkspaceManager } from '../workspace';
import type {
  ScheduledJob,
  ScheduledJobExecutor,
  ScheduledJobRun,
  ScheduledJobToolResult,
  SchedulerMisfirePolicy,
  SchedulerSessionMode,
} from './scheduler-types';
import { SchedulerStore } from './scheduler-store';

const logger = createLogger('scheduler:engine');

export interface SchedulerEngineOptions {
  store: SchedulerStore;
  executor?: ScheduledJobExecutor;
  workspace?: WorkspaceManager;
  tickMs?: number;
  enabled?: boolean;
  misfirePolicy?: SchedulerMisfirePolicy;
  sessionMode?: SchedulerSessionMode;
  maxConcurrentJobs?: number;
}

function envMisfirePolicy(): SchedulerMisfirePolicy {
  const raw = getOptionalEnv('SCHEDULER_MISFIRE_POLICY', 'skip') ?? 'skip';
  return raw === 'run_once' || raw === 'disabled' || raw === 'skip' ? raw : 'skip';
}

function envSessionMode(): SchedulerSessionMode {
  const raw = getOptionalEnv('SCHEDULER_SESSION_MODE', 'dedicated') ?? 'dedicated';
  return raw === 'last_active' || raw === 'new_each_run' || raw === 'dedicated' ? raw : 'dedicated';
}

function outputExcerpt(output: string): string {
  return output.length > 5000 ? `${output.slice(0, 5000)}\n[output truncated]` : output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function jobRequiresEmail(job: ScheduledJob): boolean {
  return /\b(kirim\s+email|send\s+email|brevo-email|email\s+default|BREVO_RECIPIENT_EMAIL)\b/i.test(job.prompt) ||
    /\bkirimkan\b[\s\S]*\bke\s+email\b/i.test(job.prompt);
}

function scheduledExecutionPrompt(job: ScheduledJob): string {
  if (!jobRequiresEmail(job)) return job.prompt;

  return [
    'This is a scheduled job. The user explicitly requested email delivery.',
    'You must gather the requested information if needed, then call the brevo-email tool.',
    'Do not only say the email was sent. Actually call brevo-email.',
    'Do not use placeholder recipients.',
    'If no recipient is specified, omit recipientEmail so the tool uses BREVO_RECIPIENT_EMAIL.',
    'Do not claim success unless brevo-email confirms ok=true.',
    '',
    'Scheduled task:',
    job.prompt,
  ].join('\n');
}

function brevoMessageIdFromResult(result: ScheduledJobToolResult | undefined): string | undefined {
  const parsed = result?.parsedResult;
  if (isRecord(parsed) && typeof parsed['messageId'] === 'string' && parsed['messageId'].trim()) {
    return parsed['messageId'].trim();
  }
  return undefined;
}

function verifyEmailDelivery(
  job: ScheduledJob,
  toolsUsed: string[] | undefined,
  toolResults: ScheduledJobToolResult[] | undefined
): { emailRequired: boolean; emailSent: boolean; brevoMessageId?: string; error?: string } {
  const emailRequired = jobRequiresEmail(job);
  if (!emailRequired) return { emailRequired: false, emailSent: false };

  if (!toolsUsed?.includes('brevo-email')) {
    return {
      emailRequired,
      emailSent: false,
      error: 'Email was required but brevo-email tool was not executed.',
    };
  }

  const brevoResult = toolResults?.find((result) => result.tool === 'brevo-email');
  if (!brevoResult) {
    return {
      emailRequired,
      emailSent: false,
      error: 'Email delivery could not be verified.',
    };
  }

  if (brevoResult.ok !== true) {
    return {
      emailRequired,
      emailSent: false,
      error: brevoResult.error || 'Brevo email failed or could not be verified.',
    };
  }

  const brevoMessageId = brevoMessageIdFromResult(brevoResult);
  return {
    emailRequired,
    emailSent: true,
    ...(brevoMessageId ? { brevoMessageId } : {}),
  };
}

export class SchedulerEngine {
  private readonly store: SchedulerStore;
  private readonly executor: ScheduledJobExecutor | undefined;
  private readonly workspace: WorkspaceManager | undefined;
  private readonly tickMs: number;
  private readonly enabled: boolean;
  private readonly misfirePolicy: SchedulerMisfirePolicy;
  private readonly sessionMode: SchedulerSessionMode;
  private readonly maxConcurrentJobs: number;
  private readonly runningJobIds = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(options: SchedulerEngineOptions) {
    this.store = options.store;
    this.executor = options.executor;
    this.workspace = options.workspace;
    this.tickMs = Math.max(1_000, options.tickMs ?? getEnvInt('SCHEDULER_TICK_MS', 30_000));
    this.enabled = options.enabled ?? getEnvBool('SCHEDULER_ENABLED', true);
    this.misfirePolicy = options.misfirePolicy ?? envMisfirePolicy();
    this.sessionMode = options.sessionMode ?? envSessionMode();
    this.maxConcurrentJobs = Math.max(
      1,
      options.maxConcurrentJobs ?? getEnvInt('SCHEDULER_MAX_CONCURRENT_JOBS', 2)
    );
  }

  async start(): Promise<void> {
    if (!this.enabled) {
      logger.info('scheduler disabled');
      return;
    }

    await this.handleStartupMisfires();
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        logger.warn('scheduler tick failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.tickMs);
    this.timer.unref();

    void this.tick().catch((err) => {
      logger.warn('initial scheduler tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    logger.info('scheduler started', {
      tickMs: this.tickMs,
      misfirePolicy: this.misfirePolicy,
      sessionMode: this.sessionMode,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(now = new Date()): Promise<void> {
    if (!this.enabled || this.ticking) return;
    this.ticking = true;
    try {
      const due = await this.store.getDueJobs(now);
      const runs: Array<Promise<ScheduledJobRun>> = [];
      for (const job of due) {
        if (this.runningJobIds.size >= this.maxConcurrentJobs) {
          await this.recordSkipped(job, 'Scheduler concurrency limit reached.');
          continue;
        }
        runs.push(this.runJob(job));
      }
      await Promise.all(runs);
    } finally {
      this.ticking = false;
    }
  }

  async runNow(idOrName: string): Promise<ScheduledJobRun> {
    const job = await this.store.getJob(idOrName);
    if (!job) throw new Error(`Tidak ditemukan cronjob dengan nama: ${idOrName}.`);
    return this.runJob(job);
  }

  private async handleStartupMisfires(): Promise<void> {
    if (this.misfirePolicy === 'disabled' || this.misfirePolicy === 'run_once') return;
    const now = new Date();
    const due = await this.store.getDueJobs(now);
    for (const job of due) {
      await this.recordSkipped(job, 'Missed while scheduler was offline.');
    }
  }

  private async recordSkipped(job: ScheduledJob, reason: string): Promise<ScheduledJobRun> {
    const now = new Date();
    const run: ScheduledJobRun = {
      id: randomUUID(),
      jobId: job.id,
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      status: 'skipped',
      error: reason,
    };
    await this.store.appendRun(run);
    await this.store.markJobRunResult(job, 'skipped', now, reason);
    return run;
  }

  private async runJob(job: ScheduledJob): Promise<ScheduledJobRun> {
    if (this.runningJobIds.has(job.id)) {
      return this.recordSkipped(job, 'Previous run is still active.');
    }

    const startedAt = new Date();
    const run: ScheduledJobRun = {
      id: randomUUID(),
      jobId: job.id,
      startedAt: startedAt.toISOString(),
      status: 'failed',
    };

    this.runningJobIds.add(job.id);
    logger.info('scheduled job started', { jobId: job.id, name: job.name });

    try {
      if (!this.executor) {
        throw new Error('Scheduler executor is not configured.');
      }

      const sessionId = typeof job.metadata?.['sessionId'] === 'string'
        ? job.metadata['sessionId']
        : undefined;
      const executionJob: ScheduledJob = {
        ...job,
        prompt: scheduledExecutionPrompt(job),
      };
      const result = await this.executor(executionJob, {
        sessionMode: this.sessionMode,
        ...(sessionId ? { sessionId } : {}),
      });

      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      const email = verifyEmailDelivery(job, result.toolsUsed, result.toolResults);
      const status: 'success' | 'failed' = email.error ? 'failed' : 'success';
      const completed: ScheduledJobRun = {
        ...run,
        finishedAt: finishedAt.toISOString(),
        status,
        output: outputExcerpt(result.output),
        durationMs,
        emailRequired: email.emailRequired,
        emailSent: email.emailSent,
        ...(result.toolsUsed ? { toolsUsed: result.toolsUsed } : {}),
        ...(result.toolResults ? { toolResults: result.toolResults } : {}),
        ...(email.brevoMessageId ? { brevoMessageId: email.brevoMessageId } : {}),
        ...(email.error ? { error: email.error } : {}),
      };

      await this.store.appendRun(completed);
      await this.store.markJobRunResult(
        job,
        status,
        finishedAt,
        email.error,
        {
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
          lastToolsUsed: result.toolsUsed ?? [],
          lastEmailRequired: email.emailRequired,
          lastEmailSent: email.emailSent,
          ...(email.brevoMessageId ? { lastBrevoMessageId: email.brevoMessageId } : {}),
          lastRunDurationMs: durationMs,
        }
      );
      await this.writeWorkspaceRunLog(job, completed);
      if (status === 'success') {
        logger.info('scheduled job completed', { jobId: job.id, name: job.name });
      } else {
        logger.warn('scheduled job failed verification', { jobId: job.id, name: job.name, error: email.error });
      }
      return completed;
    } catch (err) {
      const finishedAt = new Date();
      const message = err instanceof Error ? err.message : String(err);
      const failed: ScheduledJobRun = {
        ...run,
        finishedAt: finishedAt.toISOString(),
        status: 'failed',
        error: message,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        emailRequired: jobRequiresEmail(job),
        emailSent: false,
      };

      await this.store.appendRun(failed);
      await this.store.markJobRunResult(job, 'failed', finishedAt, message, {
        lastToolsUsed: [],
        lastEmailRequired: jobRequiresEmail(job),
        lastEmailSent: false,
        lastRunDurationMs: finishedAt.getTime() - startedAt.getTime(),
      });
      await this.writeWorkspaceRunLog(job, failed);
      logger.warn('scheduled job failed', { jobId: job.id, name: job.name, error: message });
      return failed;
    } finally {
      this.runningJobIds.delete(job.id);
    }
  }

  private async writeWorkspaceRunLog(job: ScheduledJob, run: ScheduledJobRun): Promise<void> {
    if (!this.workspace) return;
    try {
      await this.workspace.appendDailyMemory({
        type: 'system_event',
        summary: `Cronjob ${job.name} ${run.status}`,
        source: 'system',
        details: run.output ?? run.error ?? '',
      });
    } catch (err) {
      logger.debug('scheduler workspace log failed', {
        jobId: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
