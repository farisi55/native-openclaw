/**
 * scheduler/scheduler-engine.ts
 * In-process cronjob scheduler loop.
 */

import { randomUUID } from 'crypto';
import { getEnvBool, getEnvInt, getOptionalEnv } from '../config/env';
import { createLogger } from '../utils/logger';
import type { ToolRegistry } from '../tools/tool-registry';
import type { WorkspaceManager } from '../workspace';
import type {
  JobOutputNotifier,
  ScheduledJob,
  ScheduledJobExecutor,
  ScheduledJobRun,
  ScheduledSelfImprovementInput,
  ScheduledSelfImprovementNotifier,
  ScheduledJobToolResult,
  SchedulerMisfirePolicy,
  SchedulerSessionMode,
} from './scheduler-types';
import { SchedulerStore } from './scheduler-store';

const logger = createLogger('scheduler:engine');

export interface ScheduledEmailContentInput {
  job: ScheduledJob;
  topic: string;
  searchQuery: string;
  webFetchResult?: string;
  recipientEmail?: string;
  now: Date;
}

export interface ScheduledEmailContent {
  subject: string;
  htmlContent: string;
}

export type ScheduledEmailContentGenerator = (
  input: ScheduledEmailContentInput
) => Promise<ScheduledEmailContent>;

export interface SchedulerEngineOptions {
  store: SchedulerStore;
  executor?: ScheduledJobExecutor;
  toolRegistry?: Pick<ToolRegistry, 'getTool'>;
  emailContentGenerator?: ScheduledEmailContentGenerator;
  workspace?: WorkspaceManager;
  tickMs?: number;
  enabled?: boolean;
  misfirePolicy?: SchedulerMisfirePolicy;
  sessionMode?: SchedulerSessionMode;
  maxConcurrentJobs?: number;
  /** Called after a non-email job completes successfully. Delivers output to user. */
  onJobComplete?: JobOutputNotifier;
  /** Called after any scheduled job run to feed self-improvement. Must not affect run status. */
  selfImprovement?: ScheduledSelfImprovementNotifier;
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

function metadataString(job: ScheduledJob, key: string): string | undefined {
  const value = job.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function metadataBool(job: ScheduledJob, key: string): boolean {
  return job.metadata?.[key] === true;
}

function maskedEmail(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  return `${local[0] ?? '*'}***@${domain}`;
}

export function jobRequiresEmail(job: ScheduledJob): boolean {
  return metadataBool(job, 'emailRequired') ||
    /\b(kirim\s+email|send\s+email|brevo-email|email\s+default|BREVO_RECIPIENT_EMAIL|ke\s+email)\b/i.test(job.prompt) ||
    /\bkirimkan\b[\s\S]*\bke\s+email\b/i.test(job.prompt);
}

export function jobRequiresCurrentData(job: ScheduledJob): boolean {
  if (metadataBool(job, 'requiresCurrentData')) return true;
  const text = [
    job.prompt,
    metadataString(job, 'topic') ?? '',
    metadataString(job, 'searchQuery') ?? '',
  ].join(' ');
  return /\b(hari\s+ini|terbaru|terupdate|current|latest|harga\s+emas|berita|news|market|kurs|cuaca)\b/i.test(text);
}

function topicForJob(job: ScheduledJob): string {
  const explicit = metadataString(job, 'topic');
  if (explicit) return explicit;
  if (/harga\s+emas/i.test(job.prompt)) return 'harga emas';
  if (/arsenal/i.test(job.prompt)) return 'berita Arsenal';
  return job.name;
}

function searchQueryForJob(job: ScheduledJob): string {
  const explicit = metadataString(job, 'searchQuery');
  if (explicit) return explicit;
  const topic = topicForJob(job);
  if (/harga\s+emas/i.test(topic)) return 'harga emas hari ini';
  if (/berita|news|arsenal/i.test(topic)) return `${topic} terbaru hari ini`;
  return `${topic} hari ini`;
}

function scheduledExecutionPrompt(job: ScheduledJob): string {
  if (!jobRequiresEmail(job)) return job.prompt;

  return [
    'SYSTEM INSTRUCTION - READ CAREFULLY:',
    'This is a scheduled job requiring TWO sequential tool calls.',
    'Step 1: Gather information (use web-fetch or search tool).',
    'Step 2: MANDATORY - call brevo-email tool to send the email.',
    'You MUST complete BOTH steps. Do NOT write a final response after step 1.',
    'After step 1 completes, immediately call brevo-email without summarizing first.',
    'Failure to call brevo-email = task failure.',
    '',
    'Rules:',
    '- Do not use placeholder email recipients.',
    '- If no recipient is specified, omit recipientEmail so the tool uses BREVO_RECIPIENT_EMAIL.',
    '- Do not claim the email was sent unless brevo-email returns ok=true.',
    '- Do not add commentary between tool calls.',
    '',
    'Scheduled task (execute now):',
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

function recipientFromResult(result: ScheduledJobToolResult | undefined): string | undefined {
  const parsed = result?.parsedResult;
  if (isRecord(parsed) && typeof parsed['recipientEmail'] === 'string' && parsed['recipientEmail'].trim()) {
    return parsed['recipientEmail'].trim();
  }
  return undefined;
}

function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toolResultError(parsed: unknown, rawResult: string): string | undefined {
  if (isRecord(parsed)) {
    const error = parsed['error'];
    if (typeof error === 'string' && error.trim()) return error.trim();
    const content = parsed['content'];
    if (typeof content === 'string' && /failed|error|not sent|gagal/i.test(content)) return content.trim();
  }
  return rawResult.startsWith('Tool execution failed:') ? rawResult : undefined;
}

function toolResultOk(tool: string, parsed: unknown, rawResult: string): boolean {
  if (rawResult.startsWith('Tool execution failed:')) return false;
  if (tool === 'brevo-email') {
    if (!isRecord(parsed) || parsed['ok'] !== true) return false;
    const status = parsed['status'];
    return typeof status === 'number' ? status >= 200 && status < 300 : true;
  }
  if (isRecord(parsed) && typeof parsed['ok'] === 'boolean') return parsed['ok'];
  return true;
}

function buildToolTrace(tool: string, input: unknown, rawResult: string): ScheduledJobToolResult {
  const parsed = safeJsonParse(rawResult);
  const trace: ScheduledJobToolResult = {
    tool,
    input,
    rawResult: outputExcerpt(rawResult),
    ok: toolResultOk(tool, parsed, rawResult),
  };
  if (parsed !== null) trace.parsedResult = parsed;
  const error = toolResultError(parsed, rawResult);
  if (error) trace.error = error;
  return trace;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fallbackEmailContent(job: ScheduledJob, topic: string, webFetchResult: string | undefined): ScheduledEmailContent {
  const subject = `Laporan Terjadwal: ${topic}`;
  const data = webFetchResult?.trim()
    ? `<h2>Data yang ditemukan</h2><pre>${escapeHtml(outputExcerpt(webFetchResult))}</pre>`
    : '<p>Data terbaru tidak tersedia saat job dijalankan.</p>';
  return {
    subject,
    htmlContent: [
      `<h1>${escapeHtml(subject)}</h1>`,
      `<p>Job: ${escapeHtml(job.name)}</p>`,
      `<p>Instruksi: ${escapeHtml(job.prompt)}</p>`,
      data,
    ].join('\n'),
  };
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
  private readonly toolRegistry: Pick<ToolRegistry, 'getTool'> | undefined;
  private readonly emailContentGenerator: ScheduledEmailContentGenerator | undefined;
  private readonly workspace: WorkspaceManager | undefined;
  private readonly tickMs: number;
  private readonly enabled: boolean;
  private readonly misfirePolicy: SchedulerMisfirePolicy;
  private readonly sessionMode: SchedulerSessionMode;
  private readonly maxConcurrentJobs: number;
  private readonly onJobComplete: JobOutputNotifier | undefined;
  private readonly selfImprovement: ScheduledSelfImprovementNotifier | undefined;
  private readonly runningJobIds = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(options: SchedulerEngineOptions) {
    this.store = options.store;
    this.executor = options.executor;
    this.toolRegistry = options.toolRegistry;
    this.emailContentGenerator = options.emailContentGenerator;
    this.workspace = options.workspace;
    this.tickMs = Math.max(1_000, options.tickMs ?? getEnvInt('SCHEDULER_TICK_MS', 30_000));
    this.enabled = options.enabled ?? getEnvBool('SCHEDULER_ENABLED', true);
    this.misfirePolicy = options.misfirePolicy ?? envMisfirePolicy();
    this.sessionMode = options.sessionMode ?? envSessionMode();
    this.maxConcurrentJobs = Math.max(
      1,
      options.maxConcurrentJobs ?? getEnvInt('SCHEDULER_MAX_CONCURRENT_JOBS', 2)
    );
    this.onJobComplete = options.onJobComplete;
    this.selfImprovement = options.selfImprovement;
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
    if (!this.enabled) return;

    let due: ScheduledJob[];
    try {
      due = await this.store.getDueJobs(now);
    } catch (err) {
      logger.warn('scheduler: getDueJobs failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (due.length === 0) return;

    const runs: Array<Promise<ScheduledJobRun>> = [];
    for (const job of due) {
      if (this.runningJobIds.has(job.id)) {
        continue;
      }
      if (this.runningJobIds.size >= this.maxConcurrentJobs) {
        await this.recordSkipped(job, 'Scheduler concurrency limit reached.');
        continue;
      }
      runs.push(this.runJob(job));
    }

    if (runs.length > 0) {
      await Promise.allSettled(runs);
    }
  }

  async runNow(idOrName: string): Promise<ScheduledJobRun> {
    const job = await this.store.getJob(idOrName);
    if (!job) throw new Error(`Tidak ditemukan cronjob dengan nama: ${idOrName}.`);
    return this.runJob(job);
  }

  private async handleStartupMisfires(): Promise<void> {
    if (this.misfirePolicy === 'disabled') return;
    const now = new Date();
    const due = await this.store.getDueJobs(now);
    for (const job of due) {
      if (this.misfirePolicy === 'run_once') {
        await this.runJob(job).catch((err) => {
          logger.warn('startup misfire run failed', {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        continue;
      }

      if (this.misfirePolicy === 'skip' && job.scheduleType === 'once' && (job.runCount ?? 0) === 0) {
        logger.info('startup: running missed once-job (never executed)', {
          jobId: job.id,
          name: job.name,
          scheduledFor: job.runAt,
        });
        await this.runJob(job).catch((err) => {
          logger.warn('startup missed once-job failed', {
            jobId: job.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        continue;
      }

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
        if (jobRequiresEmail(job) && this.toolRegistry) {
          return await this.executeScheduledEmailJob(job, run, startedAt);
        }
        throw new Error('Scheduler executor is not configured.');
      }

      if (jobRequiresEmail(job) && this.toolRegistry) {
        return await this.executeScheduledEmailJob(job, run, startedAt);
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
      const brevoResult = result.toolResults?.find((trace) => trace.tool === 'brevo-email');
      const recipientEmail = recipientFromResult(brevoResult);
      const completed: ScheduledJobRun = {
        ...run,
        finishedAt: finishedAt.toISOString(),
        status,
        output: outputExcerpt(result.output),
        durationMs,
        emailRequired: email.emailRequired,
        emailSent: email.emailSent,
        ...(recipientEmail ? { recipientEmail } : {}),
        ...(result.toolsUsed ? { toolsUsed: result.toolsUsed } : {}),
        ...(result.toolResults ? { toolResults: result.toolResults } : {}),
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
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
      this.notifySelfImprovement(job, completed);
      if (status === 'success') {
        logger.info('scheduled job completed', { jobId: job.id, name: job.name });
        if (!email.emailRequired && this.onJobComplete && completed.output) {
          void Promise.resolve(this.onJobComplete(job, completed)).catch((err: unknown) => {
            logger.warn('onJobComplete notification failed (non-fatal)', {
              jobId: job.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
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
      this.notifySelfImprovement(job, failed);
      logger.warn('scheduled job failed', { jobId: job.id, name: job.name, error: message });
      return failed;
    } finally {
      this.runningJobIds.delete(job.id);
    }
  }

  private async executeScheduledEmailJob(
    job: ScheduledJob,
    run: ScheduledJobRun,
    startedAt: Date
  ): Promise<ScheduledJobRun> {
    const toolsUsed: string[] = [];
    const toolResults: ScheduledJobToolResult[] = [];
    const explicitRecipientEmail = metadataString(job, 'recipientEmail');
    const topic = topicForJob(job);
    const searchQuery = searchQueryForJob(job);
    const brevoTool = this.toolRegistry?.getTool('brevo-email');

    logger.info('scheduled email job started', {
      jobId: job.id,
      name: job.name,
      recipientEmail: maskedEmail(explicitRecipientEmail),
    });

    if (!brevoTool) {
      return this.completeScheduledEmailRun(job, run, startedAt, {
        status: 'failed',
        output: 'Email was not sent.',
        toolsUsed,
        toolResults,
        emailSent: false,
        ...(explicitRecipientEmail ? { recipientEmail: explicitRecipientEmail } : {}),
        error: 'brevo-email tool is not registered.',
      });
    }

    let webFetchResult: string | undefined;
    if (jobRequiresCurrentData(job)) {
      const webFetchTool = this.toolRegistry?.getTool('web-fetch');
      if (webFetchTool) {
        const input = { query: searchQuery };
        try {
          const raw = await webFetchTool.run(input);
          webFetchResult = raw;
          toolsUsed.push('web-fetch');
          toolResults.push(buildToolTrace('web-fetch', input, raw));
          logger.info('scheduled email web-fetch executed', {
            jobId: job.id,
            name: job.name,
            searchQuery,
          });
        } catch (err) {
          const raw = `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`;
          webFetchResult = raw;
          toolsUsed.push('web-fetch');
          toolResults.push(buildToolTrace('web-fetch', input, raw));
          logger.warn('scheduled email web-fetch failed', {
            jobId: job.id,
            name: job.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        logger.warn('scheduled email current data requested but web-fetch is not registered', {
          jobId: job.id,
          name: job.name,
          searchQuery,
        });
      }
    }

    const content = await this.generateScheduledEmailContent({
      job,
      topic,
      searchQuery,
      ...(webFetchResult ? { webFetchResult } : {}),
      ...(explicitRecipientEmail ? { recipientEmail: explicitRecipientEmail } : {}),
      now: new Date(),
    });

    logger.info('scheduled email content generated', {
      jobId: job.id,
      name: job.name,
      subject: content.subject,
    });

    const brevoInput: Record<string, unknown> = {
      subject: content.subject,
      htmlContent: content.htmlContent,
    };
    if (explicitRecipientEmail) brevoInput['recipientEmail'] = explicitRecipientEmail;

    let brevoRaw: string;
    try {
      brevoRaw = await brevoTool.run(brevoInput);
    } catch (err) {
      brevoRaw = `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    toolsUsed.push('brevo-email');
    const brevoTrace = buildToolTrace('brevo-email', brevoInput, brevoRaw);
    toolResults.push(brevoTrace);
    const messageId = brevoMessageIdFromResult(brevoTrace);
    const resolvedRecipient = explicitRecipientEmail ?? recipientFromResult(brevoTrace);
    const emailSent = brevoTrace.ok === true;

    logger.info('scheduled email brevo executed', {
      jobId: job.id,
      name: job.name,
      recipientEmail: maskedEmail(resolvedRecipient),
      ok: emailSent,
      messageId,
    });

    if (!emailSent) {
      const error = brevoTrace.error ?? 'Brevo email failed or could not be verified.';
      logger.warn('scheduled email failed', {
        jobId: job.id,
        name: job.name,
        recipientEmail: maskedEmail(resolvedRecipient),
        toolsUsed,
        error,
      });
      return this.completeScheduledEmailRun(job, run, startedAt, {
        status: 'failed',
        output: 'Email was not sent.',
        toolsUsed,
        toolResults,
        emailSent: false,
        ...(resolvedRecipient ? { recipientEmail: resolvedRecipient } : {}),
        error,
      });
    }

    logger.info('scheduled email sent', {
      jobId: job.id,
      name: job.name,
      recipientEmail: maskedEmail(resolvedRecipient),
      toolsUsed,
      messageId,
    });

    return this.completeScheduledEmailRun(job, run, startedAt, {
      status: 'success',
      output: `Email berhasil dikirim${resolvedRecipient ? ` ke ${resolvedRecipient}` : ''}.`,
      toolsUsed,
      toolResults,
      emailSent: true,
      ...(resolvedRecipient ? { recipientEmail: resolvedRecipient } : {}),
      ...(messageId ? { brevoMessageId: messageId } : {}),
    });
  }

  private async generateScheduledEmailContent(input: ScheduledEmailContentInput): Promise<ScheduledEmailContent> {
    if (this.emailContentGenerator) {
      try {
        const generated = await this.emailContentGenerator(input);
        if (generated.subject.trim() && generated.htmlContent.trim()) {
          return {
            subject: generated.subject.trim(),
            htmlContent: generated.htmlContent.trim(),
          };
        }
      } catch (err) {
        logger.warn('scheduled email content generator failed, using fallback', {
          jobId: input.job.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return fallbackEmailContent(input.job, input.topic, input.webFetchResult);
  }

  private async completeScheduledEmailRun(
    job: ScheduledJob,
    run: ScheduledJobRun,
    startedAt: Date,
    result: {
      status: 'success' | 'failed';
      output: string;
      toolsUsed: string[];
      toolResults: ScheduledJobToolResult[];
      emailSent: boolean;
      recipientEmail?: string;
      brevoMessageId?: string;
      error?: string;
    }
  ): Promise<ScheduledJobRun> {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    const completed: ScheduledJobRun = {
      ...run,
      finishedAt: finishedAt.toISOString(),
      status: result.status,
      output: outputExcerpt(result.output),
      toolsUsed: result.toolsUsed,
      toolResults: result.toolResults,
      emailRequired: true,
      emailSent: result.emailSent,
      durationMs,
      ...(result.recipientEmail ? { recipientEmail: result.recipientEmail } : {}),
      ...(result.brevoMessageId ? { brevoMessageId: result.brevoMessageId } : {}),
      ...(result.error ? { error: result.error } : {}),
    };

    await this.store.appendRun(completed);
    await this.store.markJobRunResult(job, result.status, finishedAt, result.error, {
      lastToolsUsed: result.toolsUsed,
      lastEmailRequired: true,
      lastEmailSent: result.emailSent,
      ...(result.recipientEmail ? { lastRecipientEmail: result.recipientEmail } : {}),
      ...(result.brevoMessageId ? { lastBrevoMessageId: result.brevoMessageId } : {}),
      lastRunDurationMs: durationMs,
    });
    await this.writeWorkspaceRunLog(job, completed);
    this.notifySelfImprovement(job, completed);
    return completed;
  }

  private selfImprovementInput(job: ScheduledJob, run: ScheduledJobRun): ScheduledSelfImprovementInput {
    const originalUserInput = metadataString(job, 'originalUserInput');
    const recipientEmail = metadataString(job, 'recipientEmail') ?? run.recipientEmail;
    const metadata: Record<string, unknown> = {
      scheduleType: job.scheduleType,
    };
    const topic = metadataString(job, 'topic');
    const searchQuery = metadataString(job, 'searchQuery');
    if (topic) metadata['topic'] = topic;
    if (searchQuery) metadata['searchQuery'] = searchQuery;
    if (recipientEmail) metadata['recipientEmail'] = maskedEmail(recipientEmail);

    const input: ScheduledSelfImprovementInput = {
      userInput: originalUserInput ?? job.prompt,
      agentResponse: run.output ?? run.error ?? '',
      toolsUsed: run.toolsUsed ?? [],
      stepCount: run.toolsUsed?.length ?? 0,
      success: run.status === 'success',
      source: 'scheduler',
      wasSchedulerAction: true,
      scheduledJobId: job.id,
      scheduledJobName: job.name,
      emailRequired: run.emailRequired ?? jobRequiresEmail(job),
      emailSent: run.emailSent ?? false,
      metadata,
    };
    if (run.sessionId) input.sessionId = run.sessionId;
    if (run.error) input.error = run.error;
    return input;
  }

  private notifySelfImprovement(job: ScheduledJob, run: ScheduledJobRun): void {
    if (!this.selfImprovement) {
      logger.debug('scheduler self-improvement disabled', { jobId: job.id, name: job.name });
      return;
    }

    const input = this.selfImprovementInput(job, run);
    if (!input.success) {
      logger.info('scheduler self-improvement skipped extraction for failed job', {
        jobId: job.id,
        name: job.name,
        error: input.error,
      });
    }

    try {
      const result = this.selfImprovement(input);
      void Promise.resolve(result)
        .then(() => {
          if (input.success) {
            logger.info('scheduler self-improvement processed', {
              jobId: job.id,
              name: job.name,
              success: true,
              toolsUsed: input.toolsUsed,
            });
          }
        })
        .catch((err: unknown) => {
          logger.warn('scheduler self-improvement failed (non-fatal)', {
            jobId: job.id,
            name: job.name,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    } catch (err) {
      logger.warn('scheduler self-improvement failed (non-fatal)', {
        jobId: job.id,
        name: job.name,
        error: err instanceof Error ? err.message : String(err),
      });
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
