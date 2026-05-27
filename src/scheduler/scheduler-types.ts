/**
 * scheduler/scheduler-types.ts
 * Shared cronjob scheduler model.
 */

export type CronJobStatus = 'enabled' | 'disabled' | 'running' | 'failed';

export type ScheduleType = 'once' | 'cron' | 'interval' | 'daily' | 'weekly' | 'monthly';

export type ScheduledJobSource = 'cli' | 'api' | 'telegram' | 'system';

export type ScheduledJobLastStatus = 'success' | 'failed' | 'skipped';

export type SchedulerListFilter = 'all' | 'active' | 'disabled';

export interface ScheduledJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  scheduleType: ScheduleType;
  cronExpression?: string;
  runAt?: string;
  timezone: string;
  prompt: string;
  source: ScheduledJobSource;
  tags?: string[];
  lastRunAt?: string;
  nextRunAt?: string;
  runCount: number;
  failureCount: number;
  lastStatus?: ScheduledJobLastStatus;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  metadata?: Record<string, unknown>;
}

export interface ScheduledJobRun {
  id: string;
  jobId: string;
  startedAt: string;
  finishedAt?: string;
  status: ScheduledJobLastStatus;
  output?: string;
  error?: string;
  toolsUsed?: string[];
  toolResults?: ScheduledJobToolResult[];
  emailRequired?: boolean;
  emailSent?: boolean;
  brevoMessageId?: string;
  durationMs?: number;
}

export interface ScheduledJobToolResult {
  tool: string;
  input?: unknown;
  rawResult?: string;
  parsedResult?: unknown;
  ok?: boolean;
  error?: string;
}

export interface CreateScheduledJobInput {
  name: string;
  description?: string;
  enabled?: boolean;
  scheduleType: ScheduleType;
  cronExpression?: string;
  runAt?: string;
  timezone?: string;
  prompt: string;
  source?: ScheduledJobSource;
  tags?: string[];
  createdBy?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateScheduledJobInput {
  name?: string;
  description?: string;
  enabled?: boolean;
  scheduleType?: ScheduleType;
  cronExpression?: string;
  runAt?: string;
  timezone?: string;
  prompt?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface SchedulerIntent {
  intent: 'create' | 'list' | 'get' | 'update' | 'delete' | 'enable' | 'disable' | 'run_now' | 'unknown';
  filter?: SchedulerListFilter;
  name?: string;
  description?: string;
  scheduleType?: ScheduleType;
  runAt?: string;
  time?: string;
  cronExpression?: string;
  timezone?: string;
  prompt?: string;
  targetJob?: string;
  requiresClarification: boolean;
  clarificationQuestion?: string;
  metadata?: Record<string, unknown>;
}

export interface ScheduledJobExecutionContext {
  sessionMode: SchedulerSessionMode;
  sessionId?: string;
}

export interface ScheduledJobExecutionResult {
  output: string;
  toolsUsed?: string[];
  toolResults?: ScheduledJobToolResult[];
  sessionId?: string;
}

export type ScheduledJobExecutor = (
  job: ScheduledJob,
  context: ScheduledJobExecutionContext
) => Promise<ScheduledJobExecutionResult>;

export type SchedulerMisfirePolicy = 'run_once' | 'skip' | 'disabled';

export type SchedulerSessionMode = 'dedicated' | 'last_active' | 'new_each_run';
